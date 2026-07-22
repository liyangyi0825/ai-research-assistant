import { getSupabaseAdminClient } from "../../supabase";
import { assertBillingAccess } from "../auth";
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
    expiresAt: requiredString(row.expires_at),
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

  assertPayable(order, (dependencies.now ?? (() => new Date()))());
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

  return provider.createPayment({
    orderNumber: order.orderNumber,
    amountMinor: order.amountMinor,
    currency: order.currency,
    expiresAt: order.expiresAt,
    idempotencyKey: paymentRequestIdempotencyKey(
      order.provider,
      order.orderNumber,
    ),
  });
}
