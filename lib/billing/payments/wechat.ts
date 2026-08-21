import { BillingError } from "../errors";
import type { PaymentProvider } from "./provider";
import type { WechatPayConfig } from "./wechat-config";
import {
  decryptWechatResource,
  verifyWechatSignature,
  verifyWechatTimestamp,
} from "./wechat-crypto";
import { parseWechatPaidNotification } from "./wechat-mapping";
import { parseStrictWechatJson } from "./wechat-json";
import type { WechatHttpClient } from "./wechat-transport";
import type {
  CreatePaymentInput,
  PaymentReferenceInput,
  PaymentResult,
  PaymentWebhookEvent,
  PaymentWebhookInput,
  RefundPaymentInput,
  RefundResult,
} from "./types";

export type WechatPayProviderDependencies = {
  config: WechatPayConfig;
  httpClient: WechatHttpClient;
  now?: () => Date;
  webhookToleranceSeconds?: number;
  maxWebhookBytes?: number;
};

type CallbackDependencies = {
  config: WechatPayConfig;
  httpClient: WechatHttpClient;
  now: () => Date;
  webhookToleranceSeconds: number;
  maxWebhookBytes: number;
};

type WechatCallbackHeaders = {
  timestamp: string;
  nonce: string;
  signature: string;
  verifierId: string;
};

const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;
const DEFAULT_MAX_WEBHOOK_BYTES = 256 * 1024;

function invalidSignature(): BillingError {
  return new BillingError(
    "INVALID_WEBHOOK_SIGNATURE",
    "The WeChat Pay webhook signature is invalid.",
    401,
  );
}

function invalidWebhook(): BillingError {
  return new BillingError(
    "INVALID_WEBHOOK",
    "The WeChat Pay webhook payload is invalid.",
    400,
  );
}

function webhookTooLarge(): BillingError {
  return new BillingError(
    "WEBHOOK_BODY_TOO_LARGE",
    "The payment webhook body is too large.",
    413,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedCallbackHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): WechatCallbackHeaders {
  const normalized = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (normalized.has(normalizedName)) throw invalidSignature();
    normalized.set(normalizedName, value);
  }

  const required = [
    "wechatpay-timestamp",
    "wechatpay-nonce",
    "wechatpay-signature",
    "wechatpay-serial",
  ] as const;
  const values = required.map((name) => normalized.get(name));
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value !== value.trim() ||
        value.includes(","),
    )
  ) {
    throw invalidSignature();
  }

  return {
    timestamp: values[0]!,
    nonce: values[1]!,
    signature: values[2]!,
    verifierId: values[3]!,
  };
}

export class WechatPayProvider implements PaymentProvider {
  private readonly dependencies: CallbackDependencies | null;
  private readonly legacyConfigured: boolean;

  constructor(configured: boolean);
  constructor(dependencies: WechatPayProviderDependencies);
  constructor(input: boolean | WechatPayProviderDependencies) {
    if (typeof input === "boolean") {
      this.dependencies = null;
      this.legacyConfigured = input;
      return;
    }

    this.legacyConfigured = true;
    this.dependencies = {
      config: input.config,
      httpClient: input.httpClient,
      now: input.now ?? (() => new Date()),
      webhookToleranceSeconds:
        input.webhookToleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
      maxWebhookBytes: input.maxWebhookBytes ?? DEFAULT_MAX_WEBHOOK_BYTES,
    };
  }

  async createPayment(_input: CreatePaymentInput): Promise<PaymentResult> {
    void _input;
    return this.unavailable();
  }

  async queryPayment(_input: PaymentReferenceInput): Promise<PaymentResult> {
    void _input;
    return this.unavailable();
  }

  async closePayment(_input: PaymentReferenceInput): Promise<PaymentResult> {
    void _input;
    return this.unavailable();
  }

  async refundPayment(_input: RefundPaymentInput): Promise<RefundResult> {
    void _input;
    return this.unavailable();
  }

  async verifyWebhook(input: PaymentWebhookInput): Promise<boolean> {
    const dependencies = this.callbackDependencies();
    this.verifyCallback(input, dependencies);
    return true;
  }

  async parseWebhook(input: PaymentWebhookInput): Promise<PaymentWebhookEvent> {
    const dependencies = this.callbackDependencies();
    this.verifyCallback(input, dependencies);

    try {
      const outer = parseStrictWechatJson(input.rawBody);
      if (!isRecord(outer)) throw invalidWebhook();
      if (
        ("create_time" in outer && typeof outer.create_time !== "string") ||
        outer.resource_type !== "encrypt-resource" ||
        ("summary" in outer && typeof outer.summary !== "string") ||
        typeof outer.id !== "string" ||
        typeof outer.event_type !== "string" ||
        !isRecord(outer.resource)
      ) {
        throw invalidWebhook();
      }

      const resource = outer.resource;
      if (
        resource.algorithm !== "AEAD_AES_256_GCM" ||
        typeof resource.nonce !== "string" ||
        typeof resource.associated_data !== "string" ||
        typeof resource.ciphertext !== "string" ||
        resource.original_type !== "transaction"
      ) {
        throw invalidWebhook();
      }

      const decryptedResource = decryptWechatResource({
        apiV3Key: dependencies.config.apiV3Key,
        nonce: resource.nonce,
        associatedData: resource.associated_data,
        ciphertextBase64: resource.ciphertext,
      });
      return parseWechatPaidNotification({
        decryptedResource,
        expectedMchId: dependencies.config.mchId,
        expectedAppId: dependencies.config.appId,
        eventId: outer.id,
        eventType: outer.event_type,
      });
    } catch {
      throw invalidWebhook();
    }
  }

  private callbackDependencies(): CallbackDependencies {
    if (this.dependencies === null) return this.unavailable();
    return this.dependencies;
  }

  private verifyCallback(
    input: PaymentWebhookInput,
    dependencies: CallbackDependencies,
  ): void {
    if (
      !Number.isSafeInteger(dependencies.maxWebhookBytes) ||
      dependencies.maxWebhookBytes < 1 ||
      Buffer.byteLength(input.rawBody, "utf8") > dependencies.maxWebhookBytes
    ) {
      throw webhookTooLarge();
    }

    const headers = normalizedCallbackHeaders(input.headers);
    try {
      if (
        !Number.isSafeInteger(dependencies.webhookToleranceSeconds) ||
        dependencies.webhookToleranceSeconds < 0
      ) {
        throw invalidSignature();
      }
      verifyWechatTimestamp({
        timestamp: headers.timestamp,
        now: dependencies.now(),
        toleranceSeconds: dependencies.webhookToleranceSeconds,
      });
      verifyWechatSignature({
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        body: input.rawBody,
        signatureBase64: headers.signature,
        verifierId: headers.verifierId,
        verifier: dependencies.config.verifier,
      });
    } catch {
      throw invalidSignature();
    }
  }

  private unavailable(): never {
    if (!this.legacyConfigured) {
      throw new BillingError(
        "PROVIDER_NOT_CONFIGURED",
        "WeChat Pay is not configured.",
        503,
      );
    }

    throw new BillingError(
      "NOT_IMPLEMENTED",
      "WeChat Pay is configured but not implemented.",
      501,
    );
  }
}
