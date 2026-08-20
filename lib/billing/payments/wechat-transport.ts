import { BillingError } from "../errors";
import type { WechatPayConfig } from "./wechat-config";
import {
  signWechatRequest,
  verifyWechatSignature,
  verifyWechatTimestamp,
} from "./wechat-crypto";

export type WechatFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const WECHAT_ORIGIN = "https://api.mch.weixin.qq.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1_024;
const RESPONSE_TIMESTAMP_TOLERANCE_SECONDS = 300;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

type RequestInput = {
  method: "GET" | "POST";
  pathWithQuery: string;
  body?: Readonly<Record<string, unknown>>;
};

function requestInvalid(): BillingError {
  return new BillingError(
    "PAYMENT_PROVIDER_REQUEST_INVALID",
    "The WeChat Pay request is invalid.",
    400,
  );
}

function requestRejected(): BillingError {
  return new BillingError(
    "PAYMENT_PROVIDER_REQUEST_REJECTED",
    "WeChat Pay rejected the request.",
    400,
  );
}

function stateConflict(): BillingError {
  return new BillingError(
    "PAYMENT_PROVIDER_STATE_CONFLICT",
    "The WeChat Pay request conflicts with payment state.",
    409,
  );
}

function invalidResponse(): BillingError {
  return new BillingError(
    "PAYMENT_PROVIDER_INVALID_RESPONSE",
    "WeChat Pay returned an invalid response.",
    502,
  );
}

function unavailable(): BillingError {
  return new BillingError(
    "PAYMENT_PROVIDER_UNAVAILABLE",
    "WeChat Pay is temporarily unavailable.",
    503,
  );
}

function validatedPath(pathWithQuery: string): string {
  if (
    !pathWithQuery.startsWith("/v3/") ||
    ASCII_CONTROL_PATTERN.test(pathWithQuery) ||
    pathWithQuery.includes("\\") ||
    pathWithQuery.includes("#")
  ) {
    throw requestInvalid();
  }

  let parsed: URL;
  try {
    parsed = new URL(`${WECHAT_ORIGIN}${pathWithQuery}`);
  } catch {
    throw requestInvalid();
  }

  if (
    parsed.origin !== WECHAT_ORIGIN ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.startsWith("/v3/") ||
    parsed.href !== `${WECHAT_ORIGIN}${pathWithQuery}`
  ) {
    throw requestInvalid();
  }
  return pathWithQuery;
}

function serializeBody(
  body: Readonly<Record<string, unknown>> | undefined,
): string {
  if (body === undefined) return "";
  try {
    const serialized = JSON.stringify(body);
    if (typeof serialized !== "string") throw requestInvalid();
    return serialized;
  } catch {
    throw requestInvalid();
  }
}

function providerCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function mappedClientError(body: unknown): BillingError {
  switch (providerCode(body)) {
    case "PARAM_ERROR":
    case "INVALID_REQUEST":
      return requestInvalid();
    case "ORDERPAID":
    case "ORDER_CLOSED":
    case "ORDER_REVERSED":
    case "OUT_TRADE_NO_USED":
      return stateConflict();
    case "APPID_MCHID_NOT_MATCH":
    case "MCH_NOT_EXISTS":
    case "NO_AUTH":
    case "SIGN_ERROR":
      return requestRejected();
    default:
      return requestRejected();
  }
}

async function boundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      throw unavailable();
    }
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The bounded failure is authoritative even if stream cancellation fails.
      }
      throw invalidResponse();
    }
    chunks.push(result.value);
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    totalBytes,
  ).toString("utf8");
}

export class WechatHttpClient {
  private readonly config: WechatPayConfig;
  private readonly fetchImpl: WechatFetch;
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(input: {
    config: WechatPayConfig;
    fetchImpl?: WechatFetch;
    now?: () => Date;
    nonce?: () => string;
    timeoutMs?: number;
    maxResponseBytes?: number;
  }) {
    this.config = input.config;
    this.fetchImpl =
      input.fetchImpl ??
      ((requestInput, init) => globalThis.fetch(requestInput, init));
    this.now = input.now ?? (() => new Date());
    this.nonce = input.nonce ?? (() => crypto.randomUUID().replaceAll("-", ""));
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes =
      input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 0 ||
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1
    ) {
      throw requestInvalid();
    }
  }

  async request<T>(input: RequestInput): Promise<{ status: number; body: T }> {
    const pathWithQuery = validatedPath(input.pathWithQuery);
    const body = serializeBody(input.body);
    const now = this.now();
    const timestamp = Math.floor(now.getTime() / 1_000);
    const signed = signWechatRequest({
      method: input.method,
      pathWithQuery,
      body,
      timestamp,
      nonce: this.nonce(),
      mchId: this.config.mchId,
      certificateSerialNumber: this.config.merchantCertificateSerialNumber,
      privateKeyPem: this.config.merchantPrivateKeyPem,
    });
    const headers = new Headers({
      Accept: "application/json",
      Authorization: signed.authorization,
    });
    if (input.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const abortController = new AbortController();
    const timeoutError = new Error("wechat-timeout");
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        reject(timeoutError);
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.performRequest<T>({
          input,
          pathWithQuery,
          body,
          headers,
          signal: abortController.signal,
          now,
        }),
        timeout,
      ]);
    } catch (error) {
      if (error === timeoutError) throw unavailable();
      throw error;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private async performRequest<T>(input: {
    input: RequestInput;
    pathWithQuery: string;
    body: string;
    headers: Headers;
    signal: AbortSignal;
    now: Date;
  }): Promise<{ status: number; body: T }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${WECHAT_ORIGIN}${input.pathWithQuery}`, {
        method: input.input.method,
        headers: input.headers,
        body: input.input.body === undefined ? undefined : input.body,
        redirect: "error",
        signal: input.signal,
      });
    } catch {
      throw unavailable();
    }

    const responseTimestamp = response.headers.get("Wechatpay-Timestamp");
    const responseNonce = response.headers.get("Wechatpay-Nonce");
    const responseSignature = response.headers.get("Wechatpay-Signature");
    const responseVerifierId = response.headers.get("Wechatpay-Serial");
    if (
      !responseTimestamp ||
      !responseNonce ||
      !responseSignature ||
      !responseVerifierId
    ) {
      throw invalidResponse();
    }

    const responseBody = await boundedResponseBody(
      response,
      this.maxResponseBytes,
    );
    verifyWechatTimestamp({
      timestamp: responseTimestamp,
      now: input.now,
      toleranceSeconds: RESPONSE_TIMESTAMP_TOLERANCE_SECONDS,
    });
    verifyWechatSignature({
      timestamp: responseTimestamp,
      nonce: responseNonce,
      body: responseBody,
      signatureBase64: responseSignature,
      verifierId: responseVerifierId,
      verifier: this.config.verifier,
    });

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(responseBody) as unknown;
    } catch {
      throw invalidResponse();
    }

    if (response.status >= 500 && response.status <= 599) {
      throw unavailable();
    }
    if (response.status >= 400 && response.status <= 499) {
      throw mappedClientError(parsedBody);
    }
    if (response.status < 200 || response.status > 299) {
      throw invalidResponse();
    }
    return { status: response.status, body: parsedBody as T };
  }
}
