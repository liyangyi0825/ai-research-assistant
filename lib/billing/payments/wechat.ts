import { BillingError } from "../errors";
import type { PaymentProvider } from "./provider";
import type { WechatPayConfig } from "./wechat-config";
import {
  decryptWechatResource,
  verifyWechatSignature,
  verifyWechatTimestamp,
} from "./wechat-crypto";
import {
  parseWechatNativeCreateResponse,
  parseWechatNativeTransaction,
  parseWechatPaidNotification,
  normalizeWechatRfc3339,
} from "./wechat-mapping";
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

  async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    const dependencies = this.callbackDependencies();
    const description = this.nativeDescription(input.description);
    this.assertNativeCreateInput(input, description, dependencies);

    let response: { body: unknown };
    try {
      response = await dependencies.httpClient.request<unknown>({
        method: "POST",
        pathWithQuery: "/v3/pay/transactions/native",
        body: {
          appid: dependencies.config.appId,
          mchid: dependencies.config.mchId,
          description,
          out_trade_no: input.orderNumber,
          time_expire: input.expiresAt,
          notify_url: dependencies.config.notifyUrl,
          amount: { total: input.amountMinor, currency: "CNY" },
        },
      });
    } catch (error) {
      if (!this.isUncertain(error)) throw error;
      return this.queryNativePayment(
        {
          orderNumber: input.orderNumber,
          providerTransactionId: null,
          amountMinor: input.amountMinor,
          currency: "CNY",
          expiresAt: input.expiresAt,
          paymentToken: null,
        },
      );
    }

    const { paymentToken } = parseWechatNativeCreateResponse(response.body);
    return {
      providerTransactionId: null,
      orderNumber: input.orderNumber,
      status: "PENDING",
      amountMinor: input.amountMinor,
      currency: "CNY",
      paymentToken,
      expiresAt: input.expiresAt,
      paidAt: null,
    };
  }

  async queryPayment(input: PaymentReferenceInput): Promise<PaymentResult> {
    return this.queryNativePayment(input);
  }

  async closePayment(input: PaymentReferenceInput): Promise<PaymentResult> {
    const dependencies = this.callbackDependencies();
    const orderNumber = this.nativeOrderNumber(input.orderNumber);
    this.optionalNativeTransactionId(input.providerTransactionId);
    const current = await this.queryNativePayment(input);
    if (
      current.status !== "PENDING" &&
      current.status !== "REQUIRES_NEW_PAYMENT"
    ) {
      return current;
    }
    try {
      await dependencies.httpClient.request<unknown>({
        method: "POST",
        pathWithQuery: `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNumber)}/close`,
        body: { mchid: dependencies.config.mchId },
      });
    } catch (error) {
      if (!this.isUncertain(error) && !this.isStateConflict(error)) throw error;
    }
    return this.queryNativePayment(input);
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

  private async queryNativePayment(
    input: PaymentReferenceInput,
  ): Promise<PaymentResult> {
    const dependencies = this.callbackDependencies();
    const orderNumber = this.nativeOrderNumber(input.orderNumber);
    const transactionId = this.optionalNativeTransactionId(
      input.providerTransactionId,
    );
    const queryByOrder = transactionId === null;
    const pathWithQuery = queryByOrder
      ? `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNumber)}?mchid=${encodeURIComponent(dependencies.config.mchId)}`
      : `/v3/pay/transactions/id/${encodeURIComponent(transactionId)}?mchid=${encodeURIComponent(dependencies.config.mchId)}`;
    const response = await dependencies.httpClient.request<unknown>({
      method: "GET",
      pathWithQuery,
    });
    return parseWechatNativeTransaction({
      response: response.body,
      expectedMchId: dependencies.config.mchId,
      expectedAppId: dependencies.config.appId,
      orderNumber,
      providerTransactionId: queryByOrder ? null : transactionId,
      expectedAmountMinor: input.amountMinor,
      expectedCurrency: input.currency,
      expectedExpiresAt: input.expiresAt,
      paymentToken: input.paymentToken,
    });
  }

  private nativeDescription(value: string): string {
    if (typeof value !== "string") {
      throw new BillingError(
        "PAYMENT_PROVIDER_REQUEST_INVALID",
        "The WeChat Pay request is invalid.",
        400,
      );
    }
    return Array.from(value).slice(0, 127).join("").trim();
  }

  private assertNativeCreateInput(
    input: CreatePaymentInput,
    description: string,
    dependencies: CallbackDependencies,
  ): void {
    if (
      !this.isNativeIdentifier(input.orderNumber) ||
      !this.isNativeIdentifier(input.idempotencyKey) ||
      description.length === 0 ||
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0 ||
      input.currency !== "CNY" ||
      normalizeWechatRfc3339(input.expiresAt) === null ||
      Date.parse(input.expiresAt) <= dependencies.now().getTime()
    ) {
      throw new BillingError(
        "PAYMENT_PROVIDER_REQUEST_INVALID",
        "The WeChat Pay request is invalid.",
        400,
      );
    }
  }

  private nativeOrderNumber(value: string): string {
    if (!this.isNativeIdentifier(value)) {
      throw new BillingError(
        "PAYMENT_PROVIDER_REQUEST_INVALID",
        "The WeChat Pay request is invalid.",
        400,
      );
    }
    return value;
  }

  private optionalNativeTransactionId(value: string | null): string | null {
    if (value === null) return null;
    if (!this.isNativeIdentifier(value)) {
      throw new BillingError(
        "PAYMENT_PROVIDER_REQUEST_INVALID",
        "The WeChat Pay request is invalid.",
        400,
      );
    }
    return value;
  }

  private isNativeIdentifier(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      [...value].length <= 64 &&
      Buffer.byteLength(value, "utf8") <= 64 * 4 &&
      value === value.trim() &&
      !/\p{C}/u.test(value)
    );
  }

  private isUncertain(error: unknown): boolean {
    return (
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_UNAVAILABLE"
    );
  }

  private isStateConflict(error: unknown): boolean {
    return (
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_STATE_CONFLICT"
    );
  }

  private invalidNativeResponse(): BillingError {
    return new BillingError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "WeChat Pay returned an invalid response.",
      502,
    );
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
