import { randomUUID } from "node:crypto";

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
import { getPaymentProvider } from "./registry";
import type { PaymentProvider } from "./provider";
import type { PaymentResult } from "./types";

export type PaymentOrderSnapshot = {
  id: string;
  userId: string;
  orderNumber: string;
  provider: BillingProvider;
  status: BillingOrderStatus;
  amountMinor: number;
  currency: "CNY";
  expiresAt: string;
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

export type StoredPaymentResult = Omit<PaymentResult, "orderNumber">;

export type ClaimPaymentIntentInput = {
  userId: string;
  orderId: string;
  provider: BillingProvider;
  requestIdempotencyKey: string;
  claimToken: string;
};

export type PaymentIntentClaim =
  | { status: "CLAIMED"; intentId: string }
  | { status: "IN_PROGRESS" }
  | { status: "REUSE"; payment: StoredPaymentResult };

export type CompletePaymentIntentInput = {
  intentId: string;
  claimToken: string;
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
  isAdmin?: boolean;
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

const PAYMENT_ORDER_COLUMNS = [
  "id",
  "user_id",
  "order_number",
  "provider",
  "status",
  "amount_minor",
  "currency",
  "expires_at",
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
    providerTransactionId: requiredString(row.provider_transaction_id),
    status,
    amountMinor,
    currency: "CNY",
    paymentToken: requiredString(row.payment_token),
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
    return { status: "CLAIMED", intentId: requiredString(row.intent_id) };
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
  };
}

export function createPaymentServiceRepository(
  client: PaymentServiceAdminClient,
): PaymentServiceRepository {
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
    async claimPaymentIntent(input) {
      try {
        const result = await client.rpc("billing_claim_payment_intent", {
          p_user_id: input.userId,
          p_order_id: input.orderId,
          p_provider: input.provider,
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

function defaultRepository(): PaymentServiceRepository {
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

function paymentFromStored(
  orderNumber: string,
  payment: StoredPaymentResult,
): PaymentResult {
  return { orderNumber, ...payment };
}

function assertCreatedPayment(
  order: PaymentOrderSnapshot,
  payment: PaymentResult,
): void {
  if (
    payment.orderNumber !== order.orderNumber ||
    payment.status !== "PENDING" ||
    payment.amountMinor !== order.amountMinor ||
    payment.currency !== order.currency ||
    Date.parse(payment.expiresAt) !== Date.parse(order.expiresAt) ||
    payment.paidAt !== null ||
    !payment.providerTransactionId.trim() ||
    !payment.paymentToken.trim()
  ) {
    throw new BillingError(
      "PAYMENT_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid response.",
      503,
    );
  }
}

export async function createOrderPayment(
  userId: string,
  orderId: string,
  dependencies: CreateOrderPaymentDependencies = {},
): Promise<PaymentResult> {
  const repository = dependencies.repository ?? defaultRepository();
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
  const requestIdempotencyKey = paymentRequestIdempotencyKey(
    order.provider,
    order.orderNumber,
  );
  const claimToken = randomUUID();
  let claim: PaymentIntentClaim;
  try {
    claim = await repository.claimPaymentIntent({
      userId,
      orderId: order.id,
      provider: order.provider,
      requestIdempotencyKey,
      claimToken,
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
  if (claim.status === "REUSE") {
    return paymentFromStored(order.orderNumber, claim.payment);
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
      orderNumber: order.orderNumber,
      amountMinor: order.amountMinor,
      currency: order.currency,
      expiresAt: order.expiresAt,
      idempotencyKey: requestIdempotencyKey,
    });
    assertCreatedPayment(order, payment);
    payment = {
      ...payment,
      expiresAt: normalizedTimestamp(payment.expiresAt),
    };
  } catch {
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

  let persisted: StoredPaymentResult;
  try {
    persisted = await repository.completePaymentIntent({
      intentId: claim.intentId,
      claimToken,
      payment,
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
  return paymentFromStored(order.orderNumber, persisted);
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
        {
          payment: {
            status: payment.status,
            expiresAt: payment.expiresAt,
          },
        },
        { status: 201 },
      );
    } catch (error) {
      return paymentErrorResponse(error);
    }
  };
}
