import { randomUUID } from "node:crypto";
import QRCode from "qrcode";

import { getSupabaseAdminClient } from "../../supabase";
import {
  assertBillingAccess,
  requireBillingActor,
  type BillingActor,
} from "../auth";
import { getBillingConfig, type BillingConfig } from "../config";
import { BillingError } from "../errors";
import type {
  BillingOrderStatus,
  BillingProvider,
} from "../repositories";
import {
  billingSecurityLogger,
  type BillingSecurityLogger,
  warnBillingSecurity,
} from "../security-logger";
import { getPaymentProvider } from "./registry";
import type { PaymentProvider } from "./provider";
import type { PaymentReferenceInput, PaymentResult } from "./types";

export type PaymentOrderSnapshot = {
  id: string;
  userId: string;
  orderNumber: string;
  provider: BillingProvider;
  status: BillingOrderStatus;
  amountMinor: number;
  currency: "CNY";
  expiresAt: string;
  snapshotProductName: string;
};

export type PaymentServiceRepository = {
  findOwnedOrder(
    userId: string,
    orderId: string,
  ): Promise<PaymentOrderSnapshot | null>;
  claimPaymentIntent(input: ClaimPaymentIntentInput): Promise<PaymentIntentClaim>;
  completePaymentIntent(input: CompletePaymentIntentInput): Promise<StoredPaymentResult>;
  failPaymentIntent(
    intentId: string,
    claimToken: string,
    errorCode: string,
  ): Promise<void>;
  claimMockPaymentConfirmation(input: {
    userId: string;
    orderId: string;
    providerTransactionId: string;
    paidAt: string;
  }): Promise<StoredPaymentResult>;
};

export type MockPaymentConfirmationRepository = PaymentServiceRepository & {
  findOwnedPaymentIntent(
    userId: string,
    orderId: string,
  ): Promise<StoredPaymentResult | null>;
};

export type PaymentQueryRepository = MockPaymentConfirmationRepository & {
  bindVerifiedPaymentQuery(
    input: BindVerifiedPaymentQueryInput,
  ): Promise<StoredPaymentResult>;
};

export type StoredPaymentResult = PaymentResult;

export type ClaimPaymentIntentInput = {
  userId: string;
  orderId: string;
  provider: BillingProvider;
  merchantOrderNumber: string;
  requestIdempotencyKey: string;
  claimToken: string;
};

export type PaymentIntentClaim =
  | {
      status: "CLAIMED";
      intentId: string;
      merchantOrderNumber: string;
      requestIdempotencyKey: string;
    }
  | { status: "IN_PROGRESS" }
  | { status: "REUSE"; payment: StoredPaymentResult };

export type CompletePaymentIntentInput = {
  intentId: string;
  claimToken: string;
  payment: PaymentResult;
};

export type BindVerifiedPaymentQueryInput = {
  userId: string;
  orderId: string;
  provider: BillingProvider;
  payment: PaymentResult;
};

type DatabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

type DatabaseQuery = PromiseLike<DatabaseResult> & {
  select(columns: string): DatabaseQuery;
  eq(column: string, value: unknown): DatabaseQuery;
  maybeSingle(): DatabaseQuery;
};

export type PaymentServiceAdminClient = {
  from(table: string): DatabaseQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<DatabaseResult>;
};

export type CreateOrderPaymentDependencies = {
  repository?: PaymentServiceRepository;
  now?: () => Date;
  getConfig?: () => BillingConfig;
  getProvider?: (
    mode: BillingConfig["paymentMode"],
    config: BillingConfig,
  ) => PaymentProvider;
  logger?: BillingSecurityLogger;
  isAdmin?: boolean;
  createMerchantOrderNumber?: (
    provider: BillingProvider,
    billingOrderNumber: string,
  ) => string;
};

export type QueryOrderPaymentDependencies = Omit<
  CreateOrderPaymentDependencies,
  "repository" | "createMerchantOrderNumber" | "logger"
> & {
  repository?: PaymentQueryRepository;
};

type PaymentRouteContext = {
  params: Promise<{ id: string }>;
};

export type CreateOrderPaymentPostHandlerDependencies = {
  requireActor: () => Promise<BillingActor>;
  getConfig: () => BillingConfig;
  assertAccess: (actor: BillingActor, config: BillingConfig) => void;
  createPayment: typeof createOrderPayment;
};

export type CreateOrderPaymentGetHandlerDependencies = {
  requireActor: () => Promise<BillingActor>;
  getConfig: () => BillingConfig;
  assertAccess: (actor: BillingActor, config: BillingConfig) => void;
  queryPayment: typeof queryAndBindOrderPayment;
};

const PAYMENT_ORDER_COLUMNS = [
  "id",
  "user_id",
  "order_number",
  "provider",
  "status",
  "amount_minor",
  "currency",
  "expires_at",
  "snapshot_product_name",
].join(", ");

const PAYMENT_INTENT_COLUMNS = [
  "merchant_order_number",
  "provider_transaction_id",
  "payment_status",
  "amount_minor",
  "currency",
  "payment_token",
  "expires_at",
  "paid_at",
].join(", ");

function storageError(): BillingError {
  return new BillingError(
    "BILLING_STORAGE_UNAVAILABLE",
    "Billing data is temporarily unavailable.",
    503,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw storageError();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function normalizedTimestamp(value: unknown): string {
  const timestamp = requiredString(value);
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) throw storageError();
  return new Date(epoch).toISOString();
}

function mapStoredPayment(value: unknown): StoredPaymentResult {
  const row = record(value);
  const status = row.payment_status;
  const amountMinor = row.amount_minor;
  if (
    (status !== "PENDING" &&
      status !== "PAID" &&
      status !== "FAILED" &&
      status !== "CLOSED" &&
      status !== "REFUNDED") ||
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    row.currency !== "CNY"
  ) {
    throw storageError();
  }
  return {
    orderNumber: requiredString(row.merchant_order_number),
    providerTransactionId: nullableString(row.provider_transaction_id),
    status,
    amountMinor,
    currency: "CNY",
    paymentToken: nullableString(row.payment_token),
    expiresAt: normalizedTimestamp(row.expires_at),
    paidAt:
      nullableString(row.paid_at) === null
        ? null
        : normalizedTimestamp(row.paid_at),
  };
}

function mapPaymentIntentClaim(value: unknown): PaymentIntentClaim {
  const row = record(value);
  if (row.status === "CLAIMED") {
    return {
      status: "CLAIMED",
      intentId: requiredString(row.intent_id),
      merchantOrderNumber: requiredString(row.merchant_order_number),
      requestIdempotencyKey: requiredString(row.request_idempotency_key),
    };
  }
  if (row.status === "IN_PROGRESS") return { status: "IN_PROGRESS" };
  if (row.status === "REUSE") {
    return { status: "REUSE", payment: mapStoredPayment(row) };
  }
  throw storageError();
}

function mapOrder(value: unknown): PaymentOrderSnapshot {
  const row = record(value);
  const provider = row.provider;
  const status = row.status;
  const amountMinor = row.amount_minor;

  if (
    (provider !== "MOCK" && provider !== "WECHAT" && provider !== "ALIPAY") ||
    (status !== "PENDING" &&
      status !== "PAID" &&
      status !== "FAILED" &&
      status !== "CANCELLED" &&
      status !== "CLOSED" &&
      status !== "REFUNDING" &&
      status !== "REFUNDED") ||
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    row.currency !== "CNY"
  ) {
    throw storageError();
  }

  return {
    id: requiredString(row.id),
    userId: requiredString(row.user_id),
    orderNumber: requiredString(row.order_number),
    provider,
    status,
    amountMinor,
    currency: "CNY",
    expiresAt: normalizedTimestamp(row.expires_at),
    snapshotProductName: requiredString(row.snapshot_product_name),
  };
}

export function createPaymentServiceRepository(
  client: PaymentServiceAdminClient,
): PaymentQueryRepository {
  return {
    async findOwnedOrder(userId, orderId) {
      try {
        const result = await client
          .from("billing_orders")
          .select(PAYMENT_ORDER_COLUMNS)
          .eq("id", orderId)
          .eq("user_id", userId)
          .maybeSingle();

        if (result.error) throw storageError();
        return result.data === null ? null : mapOrder(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
    async findOwnedPaymentIntent(userId, orderId) {
      try {
        const result = await client
          .from("billing_payment_intents")
          .select(PAYMENT_INTENT_COLUMNS)
          .eq("order_id", orderId)
          .eq("user_id", userId)
          .maybeSingle();

        if (result.error) throw storageError();
        return result.data === null ? null : mapStoredPayment(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
    async claimPaymentIntent(input) {
      try {
        const result = await client.rpc("billing_claim_payment_intent", {
          p_user_id: input.userId,
          p_order_id: input.orderId,
          p_provider: input.provider,
          p_merchant_order_number: input.merchantOrderNumber,
          p_request_idempotency_key: input.requestIdempotencyKey,
          p_claim_token: input.claimToken,
        });
        if (result.error) throw storageError();
        return mapPaymentIntentClaim(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
    async completePaymentIntent(input) {
      try {
        const result = await client.rpc("billing_complete_payment_intent", {
          p_intent_id: input.intentId,
          p_claim_token: input.claimToken,
          p_merchant_order_number: input.payment.orderNumber,
          p_provider_transaction_id: input.payment.providerTransactionId,
          p_payment_token: input.payment.paymentToken,
          p_payment_status: input.payment.status,
          p_expires_at: input.payment.expiresAt,
          p_paid_at: input.payment.paidAt,
        });
        if (result.error) throw storageError();
        return mapStoredPayment(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
    async failPaymentIntent(intentId, claimToken, errorCode) {
      try {
        const result = await client.rpc("billing_fail_payment_intent", {
          p_intent_id: intentId,
          p_claim_token: claimToken,
          p_error_code: errorCode,
        });
        if (result.error) throw storageError();
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
    async bindVerifiedPaymentQuery(input) {
      try {
        const result = await client.rpc(
          "billing_bind_verified_payment_query",
          {
            p_user_id: input.userId,
            p_order_id: input.orderId,
            p_provider: input.provider,
            p_merchant_order_number: input.payment.orderNumber,
            p_provider_transaction_id:
              input.payment.providerTransactionId,
            p_payment_status: input.payment.status,
            p_amount_minor: input.payment.amountMinor,
            p_currency: input.payment.currency,
            p_expires_at: input.payment.expiresAt,
            p_paid_at: input.payment.paidAt,
          },
        );
        if (result.error) throw storageError();
        return mapStoredPayment(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
    async claimMockPaymentConfirmation(input) {
      try {
        const result = await client.rpc(
          "billing_claim_mock_payment_confirmation",
          {
            p_user_id: input.userId,
            p_order_id: input.orderId,
            p_provider_transaction_id: input.providerTransactionId,
            p_paid_at: input.paidAt,
          },
        );
        if (result.error) throw storageError();
        return mapStoredPayment(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
  };
}

function defaultRepository(): PaymentQueryRepository {
  const client = getSupabaseAdminClient();
  if (!client) throw storageError();
  return createPaymentServiceRepository(
    client as unknown as PaymentServiceAdminClient,
  );
}

export function paymentRequestIdempotencyKey(
  provider: BillingProvider,
  orderNumber: string,
): string {
  return `billing-payment:${provider}:${orderNumber}`;
}

function paymentMode(provider: BillingProvider): BillingConfig["paymentMode"] {
  return provider.toLowerCase() as BillingConfig["paymentMode"];
}

function assertPayable(order: PaymentOrderSnapshot, now: Date): void {
  if (order.status === "PAID") {
    throw new BillingError(
      "ORDER_ALREADY_PAID",
      "The billing order is already paid.",
      409,
    );
  }
  if (order.status !== "PENDING") {
    throw new BillingError(
      "ORDER_NOT_PAYABLE",
      "The billing order cannot accept a payment in its current state.",
      409,
    );
  }
  const expiration = Date.parse(order.expiresAt);
  if (!Number.isFinite(expiration)) throw storageError();
  if (expiration <= now.getTime()) {
    throw new BillingError(
      "ORDER_EXPIRED",
      "The billing order has expired.",
      409,
    );
  }
}

function assertQueryable(order: PaymentOrderSnapshot): void {
  if (order.status !== "PENDING" && order.status !== "PAID") {
    throw new BillingError(
      "ORDER_NOT_PAYABLE",
      "The billing order cannot accept a payment in its current state.",
      409,
    );
  }
}

function paymentFromStored(payment: StoredPaymentResult): PaymentResult {
  return { ...payment };
}

function assertCreatedPayment(
  expected: {
    orderNumber: string;
    amountMinor: number;
    currency: "CNY";
    expiresAt: string;
  },
  payment: PaymentResult,
): void {
  const commonValid =
    payment.orderNumber === expected.orderNumber &&
    payment.amountMinor === expected.amountMinor &&
    payment.currency === expected.currency &&
    Date.parse(payment.expiresAt) === Date.parse(expected.expiresAt);
  const stateValid =
    (payment.status === "PENDING" &&
      payment.paymentToken !== null &&
      payment.paymentToken.trim().length > 0 &&
      payment.paidAt === null) ||
    (payment.status === "PAID" &&
      payment.providerTransactionId !== null &&
      payment.providerTransactionId.trim().length > 0 &&
      payment.paymentToken === null &&
      payment.paidAt !== null) ||
    (payment.status === "REQUIRES_NEW_PAYMENT" &&
      payment.providerTransactionId !== null &&
      payment.providerTransactionId.trim().length > 0 &&
      payment.paymentToken === null &&
      payment.paidAt === null);
  if (!commonValid || !stateValid) {
    throw new BillingError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid response.",
      503,
    );
  }
}

function paymentReference(payment: PaymentResult): PaymentReferenceInput {
  return {
    orderNumber: payment.orderNumber,
    providerTransactionId: payment.providerTransactionId,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    expiresAt: payment.expiresAt,
    paymentToken: payment.paymentToken,
  };
}

function assertVerifiedQueryPayment(
  expected: StoredPaymentResult,
  payment: PaymentResult,
): PaymentResult {
  const expiresAt = normalizedTimestamp(payment.expiresAt);
  const paidAt =
    payment.paidAt === null ? null : normalizedTimestamp(payment.paidAt);
  const hasProviderTransactionId =
    typeof payment.providerTransactionId === "string" &&
    payment.providerTransactionId.trim().length > 0;
  const commonValid =
    payment.orderNumber === expected.orderNumber &&
    payment.amountMinor === expected.amountMinor &&
    payment.currency === expected.currency &&
    expiresAt === normalizedTimestamp(expected.expiresAt) &&
    (payment.providerTransactionId === null || hasProviderTransactionId);
  const stateValid =
    (payment.status === "PENDING" &&
      expected.paymentToken !== null &&
      payment.paymentToken === expected.paymentToken &&
      paidAt === null) ||
    (payment.status === "PAID" &&
      hasProviderTransactionId &&
      payment.paymentToken === null &&
      paidAt !== null) ||
    ((payment.status === "FAILED" || payment.status === "CLOSED") &&
      hasProviderTransactionId &&
      payment.paymentToken === null &&
      paidAt === null) ||
    (payment.status === "REQUIRES_NEW_PAYMENT" &&
      hasProviderTransactionId &&
      payment.paymentToken === null &&
      paidAt === null);
  if (!commonValid || !stateValid) {
    throw new BillingError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid response.",
      503,
    );
  }
  return { ...payment, expiresAt, paidAt };
}

function defaultMerchantOrderNumber(
  provider: BillingProvider,
  billingOrderNumber: string,
): string {
  return provider === "WECHAT"
    ? `WX${randomUUID().replaceAll("-", "").slice(0, 30)}`
    : billingOrderNumber;
}

function normalizedProductDescription(value: string): string {
  const normalized = value.normalize("NFC").trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > 127) throw storageError();
  return normalized;
}

export async function createOrderPayment(
  userId: string,
  orderId: string,
  dependencies: CreateOrderPaymentDependencies = {},
): Promise<PaymentResult> {
  const repository = dependencies.repository ?? defaultRepository();
  const logger = dependencies.logger ?? billingSecurityLogger;
  let order: PaymentOrderSnapshot | null;

  try {
    order = await repository.findOwnedOrder(userId, orderId);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }

  if (!order) {
    throw new BillingError(
      "ORDER_NOT_FOUND",
      "The billing order was not found.",
      404,
    );
  }

  order = {
    ...order,
    expiresAt: normalizedTimestamp(order.expiresAt),
  };

  const now = (dependencies.now ?? (() => new Date()))();
  assertPayable(order, now);
  const config = (dependencies.getConfig ?? getBillingConfig)();
  assertBillingAccess(
    {
      id: userId,
      email: null,
      isAdmin: dependencies.isAdmin ?? false,
    },
    config,
  );
  const mode = paymentMode(order.provider);
  if (mode !== config.paymentMode) {
    throw new BillingError(
      "PAYMENT_PROVIDER_MISMATCH",
      "Requested payment provider does not match the server payment mode.",
      400,
    );
  }
  const provider = (dependencies.getProvider ?? getPaymentProvider)(mode, config);
  const proposedMerchantOrderNumber = (
    dependencies.createMerchantOrderNumber ?? defaultMerchantOrderNumber
  )(order.provider, order.orderNumber);
  const proposedRequestIdempotencyKey = paymentRequestIdempotencyKey(
    order.provider,
    proposedMerchantOrderNumber,
  );
  const claimToken = randomUUID();
  let claim: PaymentIntentClaim;
  try {
    claim = await repository.claimPaymentIntent({
      userId,
      orderId: order.id,
      provider: order.provider,
      merchantOrderNumber: proposedMerchantOrderNumber,
      requestIdempotencyKey: proposedRequestIdempotencyKey,
      claimToken,
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
  if (claim.status === "REUSE") {
    return paymentFromStored(claim.payment);
  }
  if (claim.status === "IN_PROGRESS") {
    throw new BillingError(
      "PAYMENT_CREATION_IN_PROGRESS",
      "Payment creation is already in progress. Please retry shortly.",
      409,
    );
  }

  let payment: PaymentResult;
  try {
    payment = await provider.createPayment({
      orderNumber: claim.merchantOrderNumber,
      description: normalizedProductDescription(order.snapshotProductName),
      amountMinor: order.amountMinor,
      currency: order.currency,
      expiresAt: order.expiresAt,
      idempotencyKey: claim.requestIdempotencyKey,
    });
    assertCreatedPayment(
      {
        orderNumber: claim.merchantOrderNumber,
        amountMinor: order.amountMinor,
        currency: order.currency,
        expiresAt: order.expiresAt,
      },
      payment,
    );
    payment = {
      ...payment,
      expiresAt: normalizedTimestamp(payment.expiresAt),
    };
  } catch {
    warnBillingSecurity(logger, {
      eventCode: "PAYMENT_CREATE_FAILED",
      provider: order.provider,
      orderNumber: order.orderNumber,
      errorCode: "PROVIDER_CREATE_FAILED",
      status: "FAILED",
    });
    try {
      await repository.failPaymentIntent(
        claim.intentId,
        claimToken,
        "PROVIDER_CREATE_FAILED",
      );
    } catch {
      // The claim lease expires, so a storage outage cannot permanently wedge it.
    }
    throw new BillingError(
      "PAYMENT_PROVIDER_UNAVAILABLE",
      "The payment provider is temporarily unavailable.",
      503,
    );
  }

  if (payment.status === "REQUIRES_NEW_PAYMENT") {
    let closed: PaymentResult;
    try {
      closed = await provider.closePayment(paymentReference(payment));
      assertCreatedPayment(
        {
          orderNumber: claim.merchantOrderNumber,
          amountMinor: order.amountMinor,
          currency: order.currency,
          expiresAt: order.expiresAt,
        },
        closed.status === "CLOSED"
          ? { ...closed, status: "REQUIRES_NEW_PAYMENT" }
          : closed,
      );
      if (closed.status !== "CLOSED" && closed.status !== "PAID") {
        throw new Error("invalid Native close recovery state");
      }
    } catch {
      warnBillingSecurity(logger, {
        eventCode: "PAYMENT_CREATE_FAILED",
        provider: order.provider,
        orderNumber: order.orderNumber,
        errorCode: "PROVIDER_CREATE_FAILED",
        status: "FAILED",
      });
      try {
        await repository.failPaymentIntent(
          claim.intentId,
          claimToken,
          "PROVIDER_CREATE_FAILED",
        );
      } catch {
        // A retry reuses this merchant reference until a close is verified.
      }
      throw new BillingError(
        "PAYMENT_PROVIDER_UNAVAILABLE",
        "The payment provider is temporarily unavailable.",
        503,
      );
    }
    if (closed.status === "CLOSED") {
      try {
        await repository.failPaymentIntent(
          claim.intentId,
          claimToken,
          "PAYMENT_REQUIRES_NEW_PAYMENT",
        );
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
      throw new BillingError(
        "PAYMENT_REQUIRES_NEW_PAYMENT",
        "The previous payment attempt cannot be paid. Please create a new payment.",
        409,
      );
    }
    payment = closed;
  }

  let persisted: StoredPaymentResult;
  try {
    persisted = await repository.completePaymentIntent({
      intentId: claim.intentId,
      claimToken,
      payment,
    });
  } catch (error) {
    warnBillingSecurity(logger, {
      eventCode: "PAYMENT_INTENT_PERSIST_FAILED",
      provider: order.provider,
      orderNumber: order.orderNumber,
      errorCode: "PAYMENT_INTENT_PERSIST_FAILED",
      status: "FAILED",
    });
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
  return paymentFromStored(persisted);
}

export async function queryAndBindOrderPayment(
  userId: string,
  orderId: string,
  dependencies: QueryOrderPaymentDependencies = {},
): Promise<PaymentResult> {
  const repository = dependencies.repository ?? defaultRepository();
  const order = await repository.findOwnedOrder(userId, orderId);
  if (!order) {
    throw new BillingError(
      "ORDER_NOT_FOUND",
      "The billing order was not found.",
      404,
    );
  }
  assertQueryable(order);
  const intent = await repository.findOwnedPaymentIntent(userId, order.id);
  if (!intent) {
    throw new BillingError(
      "PAYMENT_NOT_FOUND",
      "The payment attempt was not found.",
      404,
    );
  }

  const config = (dependencies.getConfig ?? getBillingConfig)();
  assertBillingAccess(
    {
      id: userId,
      email: null,
      isAdmin: dependencies.isAdmin ?? false,
    },
    config,
  );
  const mode = paymentMode(order.provider);
  if (mode !== config.paymentMode) {
    throw new BillingError(
      "PAYMENT_PROVIDER_MISMATCH",
      "Requested payment provider does not match the server payment mode.",
      400,
    );
  }
  const provider = (dependencies.getProvider ?? getPaymentProvider)(mode, config);
  const durableReference = paymentReference(intent);
  let verified = assertVerifiedQueryPayment(
    intent,
    await provider.queryPayment(durableReference),
  );

  if (verified.status === "REQUIRES_NEW_PAYMENT") {
    verified = assertVerifiedQueryPayment(
      intent,
      await provider.closePayment(durableReference),
    );
    if (verified.status !== "CLOSED" && verified.status !== "PAID") {
      throw new BillingError(
        "PAYMENT_PROVIDER_INVALID_RESPONSE",
        "The payment provider returned an invalid response.",
        503,
      );
    }
  }

  if (verified.status === "REFUNDED") {
    throw new BillingError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid response.",
      503,
    );
  }
  if (verified.status === "PENDING") {
    return paymentFromStored(verified);
  }
  const persisted = await repository.bindVerifiedPaymentQuery({
    userId,
    orderId: order.id,
    provider: order.provider,
    payment: verified,
  });
  if (persisted.status === "CLOSED" || persisted.status === "FAILED") {
    throw new BillingError(
      "PAYMENT_REQUIRES_NEW_PAYMENT",
      "The previous payment attempt cannot be paid. Please create a new payment.",
      409,
    );
  }
  return paymentFromStored(persisted);
}

function paymentErrorResponse(error: unknown): Response {
  const billingError =
    error instanceof BillingError
      ? error
      : new BillingError(
          "INTERNAL_BILLING_ERROR",
          "Billing request failed.",
          500,
        );
  return Response.json(
    {
      error: {
        code: billingError.code,
        message: billingError.message,
      },
    },
    { status: billingError.status },
  );
}

async function paymentRouteDto(
  payment: PaymentResult,
  config: BillingConfig,
): Promise<{
  status: PaymentResult["status"];
  expiresAt: string;
  qrCodeDataUrl?: string;
}> {
  if (
    config.paymentMode !== "wechat" ||
    payment.status !== "PENDING" ||
    payment.paymentToken === null
  ) {
    return { status: payment.status, expiresAt: payment.expiresAt };
  }

  let codeUrl: URL;
  try {
    codeUrl = new URL(payment.paymentToken);
  } catch {
    throw new BillingError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid response.",
      503,
    );
  }
  if (codeUrl.protocol !== "weixin:") {
    throw new BillingError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid response.",
      503,
    );
  }

  try {
    const svg = await QRCode.toString(payment.paymentToken, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 256,
    });
    return {
      status: payment.status,
      expiresAt: payment.expiresAt,
      qrCodeDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
    };
  } catch {
    throw new BillingError(
      "PAYMENT_QR_GENERATION_FAILED",
      "The payment QR code could not be generated.",
      503,
    );
  }
}

export function createOrderPaymentPostHandler(
  dependencies: CreateOrderPaymentPostHandlerDependencies = {
    requireActor: requireBillingActor,
    getConfig: getBillingConfig,
    assertAccess: assertBillingAccess,
    createPayment: createOrderPayment,
  },
): (request: Request, context: PaymentRouteContext) => Promise<Response> {
  return async function postOrderPaymentHandler(
    _request: Request,
    context: PaymentRouteContext,
  ): Promise<Response> {
    try {
      const actor = await dependencies.requireActor();
      const config = dependencies.getConfig();
      dependencies.assertAccess(actor, config);
      const { id } = await context.params;
      const payment = await dependencies.createPayment(actor.id, id, {
        getConfig: () => config,
        isAdmin: actor.isAdmin,
      });

      return Response.json(
        { payment: await paymentRouteDto(payment, config) },
        { status: 201 },
      );
    } catch (error) {
      return paymentErrorResponse(error);
    }
  };
}

export function createOrderPaymentGetHandler(
  dependencies: CreateOrderPaymentGetHandlerDependencies = {
    requireActor: requireBillingActor,
    getConfig: getBillingConfig,
    assertAccess: assertBillingAccess,
    queryPayment: queryAndBindOrderPayment,
  },
): (request: Request, context: PaymentRouteContext) => Promise<Response> {
  return async function getOrderPaymentHandler(
    _request: Request,
    context: PaymentRouteContext,
  ): Promise<Response> {
    try {
      const actor = await dependencies.requireActor();
      const config = dependencies.getConfig();
      dependencies.assertAccess(actor, config);
      const { id } = await context.params;
      const payment = await dependencies.queryPayment(actor.id, id, {
        getConfig: () => config,
        isAdmin: actor.isAdmin,
      });
      return Response.json({ payment: await paymentRouteDto(payment, config) });
    } catch (error) {
      return paymentErrorResponse(error);
    }
  };
}
