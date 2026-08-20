import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as rsaSign,
  verify as rsaVerify,
} from "node:crypto";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import type { WechatPayConfig } from "../../lib/billing/payments/wechat-config";
import {
  WechatHttpClient,
  type WechatFetch,
} from "../../lib/billing/payments/wechat-transport";

const NOW = new Date("2026-08-20T00:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1_000));
const RESPONSE_NONCE = "response-nonce";
const VERIFIER_ID = "PUB_KEY_ID_1";
const MAX_RESPONSE_BYTES = 256 * 1_024;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
});
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

type FetchCall = {
  input: string;
  init: RequestInit;
};

function config(): WechatPayConfig {
  return {
    mchId: "1900000001",
    appId: "wx-test",
    apiV3Key: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
    merchantPrivateKeyPem: privateKeyPem,
    merchantCertificateSerialNumber: "MERCHANT_SERIAL",
    notifyUrl: "https://merchant.example.test/wechat/notify",
    verifier: {
      mode: "PUBLIC_KEY",
      keyId: VERIFIER_ID,
      publicKeyPem,
    },
  };
}

function responseSignature(body: string, overrides: {
  timestamp?: string;
  nonce?: string;
} = {}): string {
  const timestamp = overrides.timestamp ?? TIMESTAMP;
  const nonce = overrides.nonce ?? RESPONSE_NONCE;
  return rsaSign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, "utf8"),
    privateKey,
  ).toString("base64");
}

function signedResponse(input: {
  status: number;
  body: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  verifierId?: string;
  headers?: HeadersInit;
}): Response {
  const timestamp = input.timestamp ?? TIMESTAMP;
  const nonce = input.nonce ?? RESPONSE_NONCE;
  return new Response(input.body, {
    status: input.status,
    headers: {
      "Content-Type": "application/json",
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Signature":
        input.signature ?? responseSignature(input.body, { timestamp, nonce }),
      "Wechatpay-Serial": input.verifierId ?? VERIFIER_ID,
      ...input.headers,
    },
  });
}

function recordingFetch(
  calls: FetchCall[],
  response: () => Response | Promise<Response>,
): WechatFetch {
  return async (input, init) => {
    calls.push({ input, init });
    return response();
  };
}

function client(fetchImpl: WechatFetch, overrides: {
  timeoutMs?: number;
  maxResponseBytes?: number;
} = {}): WechatHttpClient {
  return new WechatHttpClient({
    config: config(),
    fetchImpl,
    now: () => new Date(NOW),
    nonce: () => "request-nonce",
    ...overrides,
  });
}

function expectFixedError(
  error: unknown,
  expected: { code: string; status: number; message: string },
  sensitiveValues: readonly string[] = [],
): boolean {
  assert.equal(error instanceof BillingError, true);
  if (!(error instanceof BillingError)) return false;
  assert.equal(error.code === expected.code, true);
  assert.equal(error.status, expected.status);
  assert.equal(error.message === expected.message, true);
  const serialized = `${error.name} ${error.code} ${error.status} ${error.message}`;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) {
      assert.equal(serialized.includes(sensitiveValue), false);
    }
  }
  return true;
}

test("request sends the once-serialized body to the fixed WeChat HTTPS origin and signs those exact bytes", async () => {
  const calls: FetchCall[] = [];
  const responseBody = JSON.stringify({ code_url: "weixin://wxpay/test-only" });
  const requestBody = {
    appid: "wx-test",
    mchid: "1900000001",
    amount: { total: 7_900 },
  };
  const expectedBody = JSON.stringify(requestBody);
  const result = await client(
    recordingFetch(calls, () =>
      signedResponse({ status: 200, body: responseBody }),
    ),
  ).request<{ code_url: string }>({
    method: "POST",
    pathWithQuery: "/v3/pay/transactions/native?source=web",
    body: requestBody,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.code_url === "weixin://wxpay/test-only", true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(
    call.input,
    "https://api.mch.weixin.qq.com/v3/pay/transactions/native?source=web",
  );
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body === expectedBody, true);
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.signal instanceof AbortSignal, true);

  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.has("User-Agent"), false);
  const authorization = headers.get("Authorization");
  assert.ok(authorization);
  const fields = authorization.match(
    /^WECHATPAY2-SHA256-RSA2048 mchid="1900000001",nonce_str="request-nonce",timestamp="(\d+)",serial_no="MERCHANT_SERIAL",signature="([A-Za-z0-9+/]+={0,2})"$/,
  );
  assert.ok(fields);
  assert.equal(fields[1], TIMESTAMP);
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(
        `POST\n/v3/pay/transactions/native?source=web\n${TIMESTAMP}\nrequest-nonce\n${expectedBody}\n`,
        "utf8",
      ),
      publicKey,
      Buffer.from(fields[2], "base64"),
    ),
    true,
  );
});

test("GET signs and sends an empty body without a content type", async () => {
  const calls: FetchCall[] = [];
  await client(
    recordingFetch(calls, () =>
      signedResponse({ status: 200, body: JSON.stringify({ state: "SUCCESS" }) }),
    ),
  ).request<{ state: string }>({
    method: "GET",
    pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1?mchid=1900000001",
  });

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.init.body, undefined);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.has("Content-Type"), false);
  const authorization = headers.get("Authorization");
  assert.ok(authorization);
  const signatureBase64 = authorization.match(/signature="([^"]+)"$/)?.[1];
  assert.ok(signatureBase64);
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(
        `GET\n/v3/pay/transactions/out-trade-no/order-1?mchid=1900000001\n${TIMESTAMP}\nrequest-nonce\n\n`,
        "utf8",
      ),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    ),
    true,
  );
});

test("request rejects non-v3, authority, fragment, backslash, dot-segment, and control-character path escapes before fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl: WechatFetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  const invalidPaths = [
    "https://evil.example/v3/pay",
    "//evil.example/v3/pay",
    "/v2/pay/transactions/native",
    "/v3/pay/transactions/native#fragment",
    "/v3/\\evil.example/pay",
    "/v3/../merchant-secrets",
    "/v3/%2e%2e/merchant-secrets",
    "/v3/pay\r\nX-Evil: 1",
  ];

  for (const pathWithQuery of invalidPaths) {
    await assert.rejects(
      client(fetchImpl).request({ method: "GET", pathWithQuery }),
      (error: unknown) =>
        expectFixedError(error, {
          code: "PAYMENT_PROVIDER_REQUEST_INVALID",
          status: 400,
          message: "The WeChat Pay request is invalid.",
        }),
    );
  }
  assert.equal(fetchCalls, 0);
});

test("verified 4xx provider codes map through a fixed local allowlist", async () => {
  const cases = [
    {
      providerCode: "PARAM_ERROR",
      localCode: "PAYMENT_PROVIDER_REQUEST_INVALID",
      status: 400,
      message: "The WeChat Pay request is invalid.",
    },
    {
      providerCode: "ORDERPAID",
      localCode: "PAYMENT_PROVIDER_STATE_CONFLICT",
      status: 409,
      message: "The WeChat Pay request conflicts with payment state.",
    },
    {
      providerCode: "NO_AUTH",
      localCode: "PAYMENT_PROVIDER_REQUEST_REJECTED",
      status: 400,
      message: "WeChat Pay rejected the request.",
    },
    {
      providerCode: "UNRECOGNIZED_SECRET_CODE",
      localCode: "PAYMENT_PROVIDER_REQUEST_REJECTED",
      status: 400,
      message: "WeChat Pay rejected the request.",
    },
  ] as const;

  for (const entry of cases) {
    const providerMessage = `provider-secret-message-${entry.providerCode}`;
    const codeUrl = `weixin://sensitive/${entry.providerCode}`;
    const body = JSON.stringify({
      code: entry.providerCode,
      message: providerMessage,
      code_url: codeUrl,
    });
    await assert.rejects(
      client(async () => signedResponse({ status: 400, body })).request({
        method: "POST",
        pathWithQuery: "/v3/pay/transactions/native",
        body: { out_trade_no: "order-1" },
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: entry.localCode,
            status: entry.status,
            message: entry.message,
          },
          [entry.providerCode, providerMessage, codeUrl, body],
        ),
    );
  }
});

test("unsigned responses are rejected before status bodies are trusted or parsed", async () => {
  const secret = "unsigned-provider-secret";
  for (const status of [200, 400, 503]) {
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(
              Buffer.from(`{\"code\":\"${secret}\",\"message\":`, "utf8"),
            );
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      {
        status,
        headers: { "Wechatpay-Timestamp": TIMESTAMP },
      },
    );
    await assert.rejects(
      client(async () => response).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) =>
        expectFixedError(
          error,
          {
            code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
            status: 502,
            message: "WeChat Pay returned an invalid response.",
          },
          [secret],
        ),
    );
    assert.equal(pulls, 0);
  }
});

test("tampered signed 4xx and 5xx responses never use their status or body classification", async () => {
  const signedBody = JSON.stringify({ code: "PARAM_ERROR" });
  const tamperedBody = JSON.stringify({
    code: "ORDERPAID",
    message: "tampered-provider-message",
    code_url: "weixin://tampered/secret",
  });
  const signature = responseSignature(signedBody);

  for (const status of [400, 500]) {
    await assert.rejects(
      client(async () =>
        signedResponse({ status, body: tamperedBody, signature }),
      ).request({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
      }),
      (error: unknown) => {
        assert.equal(error instanceof BillingError, true);
        if (!(error instanceof BillingError)) return false;
        assert.equal(error.code === "WECHAT_SIGNATURE_INVALID", true);
        assert.equal(error.status, 400);
        const serialized = `${error.code} ${error.message}`;
        assert.equal(serialized.includes("ORDERPAID"), false);
        assert.equal(serialized.includes("tampered-provider-message"), false);
        assert.equal(serialized.includes("weixin://tampered/secret"), false);
        assert.equal(serialized.includes(signature), false);
        return true;
      },
    );
  }
});

test("response timestamps use the injected server clock and a fixed replay window", async () => {
  const staleTimestamp = String(Number(TIMESTAMP) - 301);
  const body = JSON.stringify({ state: "SUCCESS" });

  await assert.rejects(
    client(async () =>
      signedResponse({ status: 200, body, timestamp: staleTimestamp }),
    ).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) => {
      assert.equal(error instanceof BillingError, true);
      if (!(error instanceof BillingError)) return false;
      assert.equal(error.code === "WECHAT_TIMESTAMP_INVALID", true);
      assert.equal(error.status, 400);
      assert.equal(error.message.includes(staleTimestamp), false);
      return true;
    },
  );
});

test("only a verified 5xx response is classified as retryable", async () => {
  const providerCode = "SYSTEM_ERROR_SECRET";
  const providerMessage = "backend-secret-detail";
  const body = JSON.stringify({ code: providerCode, message: providerMessage });

  await assert.rejects(
    client(async () => signedResponse({ status: 503, body })).request({
      method: "POST",
      pathWithQuery: "/v3/pay/transactions/native",
      body: { out_trade_no: "order-1" },
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_UNAVAILABLE",
          status: 503,
          message: "WeChat Pay is temporarily unavailable.",
        },
        [providerCode, providerMessage, body],
      ),
  );
});

test("connection failures are fixed retryable errors without dependency details", async () => {
  const dependencySecret = "connection-error-with-secret-key-material";
  await assert.rejects(
    client(async () => {
      throw new Error(dependencySecret);
    }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_UNAVAILABLE",
          status: 503,
          message: "WeChat Pay is temporarily unavailable.",
        },
        [dependencySecret],
      ),
  );
});

test("timeout aborts the injected fetch and becomes a fixed retryable error", async () => {
  let observedSignal: AbortSignal | undefined;
  const fetchImpl: WechatFetch = async (_input, init) => {
    observedSignal = init.signal ?? undefined;
    assert.ok(observedSignal);
    return new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener(
        "abort",
        () => reject(new DOMException("secret-abort-reason", "AbortError")),
        { once: true },
      );
    });
  };

  await assert.rejects(
    client(fetchImpl, { timeoutMs: 0 }).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_UNAVAILABLE",
          status: 503,
          message: "WeChat Pay is temporarily unavailable.",
        },
        ["secret-abort-reason"],
      ),
  );
  assert.equal(observedSignal?.aborted, true);
});

test("stream reading cancels immediately after crossing the 256 KiB response limit", async () => {
  let pulls = 0;
  let canceled = false;
  const firstChunk = Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20);
  const neverReadSecret = "stream-secret-code_url";
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(firstChunk);
          return;
        }
        controller.enqueue(Buffer.from(neverReadSecret, "utf8"));
        controller.close();
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const oversizedBody = firstChunk.toString("utf8") + neverReadSecret;
  const response = new Response(stream, {
    status: 200,
    headers: {
      "Wechatpay-Timestamp": TIMESTAMP,
      "Wechatpay-Nonce": RESPONSE_NONCE,
      "Wechatpay-Signature": responseSignature(oversizedBody),
      "Wechatpay-Serial": VERIFIER_ID,
    },
  });

  await assert.rejects(
    client(async () => response).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
          status: 502,
          message: "WeChat Pay returned an invalid response.",
        },
        [neverReadSecret],
      ),
  );
  assert.equal(canceled, true);
  assert.equal(pulls, 1);
});

test("a verified non-JSON success is a fixed permanent invalid-response failure", async () => {
  const body = "non-json-provider-secret-code_url";
  await assert.rejects(
    client(async () => signedResponse({ status: 200, body })).request({
      method: "GET",
      pathWithQuery: "/v3/pay/transactions/out-trade-no/order-1",
    }),
    (error: unknown) =>
      expectFixedError(
        error,
        {
          code: "PAYMENT_PROVIDER_INVALID_RESPONSE",
          status: 502,
          message: "WeChat Pay returned an invalid response.",
        },
        [body],
      ),
  );
});
