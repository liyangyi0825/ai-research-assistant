import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { BillingError } from "../errors";
import type { PaymentProvider } from "./provider";
import type {
  CreatePaymentInput,
  PaymentReferenceInput,
  PaymentResult,
  PaymentWebhookEvent,
  PaymentWebhookInput,
  RefundPaymentInput,
  RefundResult,
} from "./types";

type MockPaymentProviderOptions = {
  secret?: string;
  now?: () => Date;
};

type StoredPayment = PaymentResult & {
  createInput: CreatePaymentInput;
};

type StoredRefund = {
  input: RefundPaymentInput;
  result: RefundResult;
};

function requiredString(value: string, code: string, message: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new BillingError(code, message, 400);
  }

  return normalized;
}

function validAmount(amountMinor: number): boolean {
  return Number.isSafeInteger(amountMinor) && amountMinor >= 0;
}

function clonePayment(payment: PaymentResult): PaymentResult {
  return {
    providerTransactionId: payment.providerTransactionId,
    orderNumber: payment.orderNumber,
    status: payment.status,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    paymentToken: payment.paymentToken,
    expiresAt: payment.expiresAt,
    paidAt: payment.paidAt,
  };
}

function equalCreateInput(
  first: CreatePaymentInput,
  second: CreatePaymentInput,
): boolean {
  return (
    first.orderNumber === second.orderNumber &&
    first.amountMinor === second.amountMinor &&
    first.currency === second.currency &&
    first.expiresAt === second.expiresAt &&
    first.idempotencyKey === second.idempotencyKey
  );
}

function equalRefundInput(
  first: RefundPaymentInput,
  second: RefundPaymentInput,
): boolean {
  return (
    first.providerTransactionId === second.providerTransactionId &&
    first.amountMinor === second.amountMinor &&
    first.currency === second.currency &&
    first.idempotencyKey === second.idempotencyKey
  );
}

function invalidWebhook(): BillingError {
  return new BillingError(
    "INVALID_WEBHOOK",
    "The payment webhook payload is invalid.",
    400,
  );
}

export class MockPaymentProvider implements PaymentProvider {
  readonly #secret: string;
  private readonly now: () => Date;
  private readonly payments = new Map<string, StoredPayment>();
  private readonly paymentsByOrder = new Map<string, string>();
  private readonly createRequests = new Map<string, string>();
  private readonly refunds = new Map<string, StoredRefund>();

  constructor(options: MockPaymentProviderOptions = {}) {
    this.#secret = options.secret ?? randomBytes(32).toString("base64url");
    this.now = options.now ?? (() => new Date());

    if (!this.#secret) {
      throw new BillingError(
        "PROVIDER_NOT_CONFIGURED",
        "Mock payment webhook signing is not configured.",
        503,
      );
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
    const normalized = this.normalizeCreateInput(input);
    const priorTransactionId = this.createRequests.get(
      normalized.idempotencyKey,
    );

    if (priorTransactionId) {
      const prior = this.requiredPayment(priorTransactionId);
      if (!equalCreateInput(prior.createInput, normalized)) {
        throw new BillingError(
          "IDEMPOTENCY_CONFLICT",
          "The payment idempotency key was reused with different data.",
          409,
        );
      }

      return clonePayment(prior);
    }

    if (this.paymentsByOrder.has(normalized.orderNumber)) {
      throw new BillingError(
        "PAYMENT_ALREADY_EXISTS",
        "A payment already exists for this order.",
        409,
      );
    }

    this.assertFutureExpiration(normalized.expiresAt);

    const providerTransactionId = `mock_tx_${randomUUID().replaceAll("-", "")}`;
    const payment: StoredPayment = {
      providerTransactionId,
      orderNumber: normalized.orderNumber,
      status: "PENDING",
      amountMinor: normalized.amountMinor,
      currency: normalized.currency,
      paymentToken: `mock_test_${randomBytes(24).toString("base64url")}`,
      expiresAt: normalized.expiresAt,
      paidAt: null,
      createInput: normalized,
    };

    this.payments.set(providerTransactionId, payment);
    this.paymentsByOrder.set(payment.orderNumber, providerTransactionId);
    this.createRequests.set(normalized.idempotencyKey, providerTransactionId);
    return clonePayment(payment);
  }

  async queryPayment(input: PaymentReferenceInput): Promise<PaymentResult> {
    return clonePayment(this.requiredPayment(input.providerTransactionId));
  }

  async closePayment(input: PaymentReferenceInput): Promise<PaymentResult> {
    const payment = this.requiredPayment(input.providerTransactionId);

    if (payment.status === "CLOSED") {
      return clonePayment(payment);
    }
    if (payment.status !== "PENDING") {
      throw this.invalidState(payment.status, "close");
    }

    payment.status = "CLOSED";
    return clonePayment(payment);
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundResult> {
    const normalized = this.normalizeRefundInput(input);
    const prior = this.refunds.get(normalized.idempotencyKey);

    if (prior) {
      if (!equalRefundInput(prior.input, normalized)) {
        throw new BillingError(
          "IDEMPOTENCY_CONFLICT",
          "The refund idempotency key was reused with different data.",
          409,
        );
      }

      return { ...prior.result };
    }

    const payment = this.requiredPayment(normalized.providerTransactionId);
    if (payment.status !== "PAID") {
      throw this.invalidState(payment.status, "refund");
    }
    if (normalized.amountMinor !== payment.amountMinor) {
      throw new BillingError(
        "INVALID_REFUND_AMOUNT",
        "Mock payments support only a full refund of the paid amount.",
        400,
      );
    }

    const result: RefundResult = {
      providerRefundId: `mock_refund_${randomUUID().replaceAll("-", "")}`,
      providerTransactionId: payment.providerTransactionId,
      status: "SUCCEEDED",
      refundedAmountMinor: normalized.amountMinor,
      currency: "CNY",
    };
    payment.status = "REFUNDED";
    this.refunds.set(normalized.idempotencyKey, { input: normalized, result });
    return { ...result };
  }

  async verifyWebhook(input: PaymentWebhookInput): Promise<boolean> {
    const supplied = input.headers["x-mock-signature"];
    if (!supplied?.startsWith("sha256=")) {
      return false;
    }

    const suppliedDigest = supplied.slice("sha256=".length);
    if (!/^[a-f0-9]{64}$/i.test(suppliedDigest)) {
      return false;
    }

    const expected = createHmac("sha256", this.#secret)
      .update(input.rawBody)
      .digest();
    const actual = Buffer.from(suppliedDigest, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async parseWebhook(input: PaymentWebhookInput): Promise<PaymentWebhookEvent> {
    let value: unknown;

    try {
      value = JSON.parse(input.rawBody);
    } catch {
      throw invalidWebhook();
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidWebhook();
    }

    const event = value as Record<string, unknown>;
    if (
      typeof event.eventId !== "string" ||
      !event.eventId.trim() ||
      event.eventType !== "PAYMENT.PAID" ||
      typeof event.providerTransactionId !== "string" ||
      !event.providerTransactionId.trim() ||
      typeof event.orderNumber !== "string" ||
      !event.orderNumber.trim() ||
      typeof event.amountMinor !== "number" ||
      !validAmount(event.amountMinor) ||
      event.currency !== "CNY" ||
      typeof event.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(event.occurredAt))
    ) {
      throw invalidWebhook();
    }

    return {
      eventId: event.eventId.trim(),
      eventType: "PAYMENT.PAID",
      providerTransactionId: event.providerTransactionId.trim(),
      orderNumber: event.orderNumber.trim(),
      amountMinor: event.amountMinor,
      currency: "CNY",
      occurredAt: event.occurredAt,
    };
  }

  async confirmPayment(input: PaymentReferenceInput): Promise<PaymentResult> {
    const payment = this.requiredPayment(input.providerTransactionId);

    if (payment.status === "PAID") {
      return clonePayment(payment);
    }
    if (payment.status !== "PENDING") {
      throw this.invalidState(payment.status, "confirm");
    }
    if (Date.parse(payment.expiresAt) <= this.now().getTime()) {
      throw new BillingError(
        "PAYMENT_EXPIRED",
        "The mock payment has expired.",
        409,
      );
    }

    payment.status = "PAID";
    payment.paidAt = this.now().toISOString();
    return clonePayment(payment);
  }

  private normalizeCreateInput(input: CreatePaymentInput): CreatePaymentInput {
    const orderNumber = requiredString(
      input.orderNumber,
      "INVALID_PAYMENT_ORDER",
      "A backend order number is required.",
    );
    const idempotencyKey = requiredString(
      input.idempotencyKey,
      "INVALID_IDEMPOTENCY_KEY",
      "A payment idempotency key is required.",
    );

    if (!validAmount(input.amountMinor)) {
      throw new BillingError(
        "INVALID_PAYMENT_AMOUNT",
        "Payment amount must be a non-negative safe integer in minor units.",
        400,
      );
    }
    if (input.currency !== "CNY") {
      throw new BillingError(
        "INVALID_PAYMENT_CURRENCY",
        "Payment currency must be CNY.",
        400,
      );
    }

    const expiration = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiration)) {
      throw new BillingError(
        "INVALID_PAYMENT_EXPIRATION",
        "Payment expiration must be a valid timestamp.",
        400,
      );
    }

    return {
      orderNumber,
      amountMinor: input.amountMinor,
      currency: "CNY",
      expiresAt: new Date(expiration).toISOString(),
      idempotencyKey,
    };
  }

  private assertFutureExpiration(expiresAt: string): void {
    if (Date.parse(expiresAt) <= this.now().getTime()) {
      throw new BillingError(
        "INVALID_PAYMENT_EXPIRATION",
        "Payment expiration must be a future timestamp.",
        400,
      );
    }
  }

  private normalizeRefundInput(input: RefundPaymentInput): RefundPaymentInput {
    const providerTransactionId = requiredString(
      input.providerTransactionId,
      "PAYMENT_NOT_FOUND",
      "The payment was not found.",
    );
    const idempotencyKey = requiredString(
      input.idempotencyKey,
      "INVALID_IDEMPOTENCY_KEY",
      "A refund idempotency key is required.",
    );

    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new BillingError(
        "INVALID_REFUND_AMOUNT",
        "Refund amount must be a positive safe integer in minor units.",
        400,
      );
    }
    if (input.currency !== "CNY") {
      throw new BillingError(
        "INVALID_PAYMENT_CURRENCY",
        "Refund currency must be CNY.",
        400,
      );
    }

    return {
      providerTransactionId,
      amountMinor: input.amountMinor,
      currency: "CNY",
      idempotencyKey,
    };
  }

  private requiredPayment(providerTransactionId: string): StoredPayment {
    const payment = this.payments.get(providerTransactionId.trim());
    if (!payment) {
      throw new BillingError(
        "PAYMENT_NOT_FOUND",
        "The payment was not found.",
        404,
      );
    }

    return payment;
  }

  private invalidState(status: PaymentResult["status"], action: string) {
    return new BillingError(
      "INVALID_PAYMENT_STATE",
      `A ${status} payment cannot be ${action}ed.`,
      409,
    );
  }
}
