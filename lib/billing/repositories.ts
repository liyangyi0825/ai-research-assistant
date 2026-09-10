import { getSupabaseAdminClient } from "../supabase";
import type {
  BillingOrderEntitlementSnapshot,
  Json,
} from "./database.types";
import { BillingError } from "./errors";

export type { BillingOrderEntitlementSnapshot } from "./database.types";

export type BillingProductType = "SUBSCRIPTION" | "CREDIT_PACK";
export type BillingProvider = "MOCK" | "WECHAT" | "ALIPAY";
export type BillingOrderStatus =
  | "PENDING"
  | "PAID"
  | "FAILED"
  | "CANCELLED"
  | "CLOSED"
  | "REFUNDING"
  | "REFUNDED";

export type BillingEntitlementSnapshot = {
  featureKey: string;
  entitlementVersion: string;
  periodicLimit: number | null;
  creditGrant: number;
  configuration: Json;
};

export type BillingProduct = {
  id: string;
  planId: string | null;
  sku: string;
  name: string;
  description: string | null;
  productType: BillingProductType;
  priceMinor: number;
  currency: "CNY";
  durationDays: number | null;
  creditGrant: number;
  entitlementVersion: string;
  isActive: boolean;
  displayMetadata: Json;
  entitlements: BillingEntitlementSnapshot[];
};

export type BillingOrderInsert = {
  orderNumber: string;
  userId: string;
  productId: string;
  provider: BillingProvider;
  amountMinor: number;
  currency: "CNY";
  snapshotProductName: string;
  snapshotProductType: BillingProductType;
  snapshotPlanId: string | null;
  snapshotDurationDays: number | null;
  snapshotCreditGrant: number;
  snapshotEntitlementVersion: string;
  snapshotEntitlements: BillingOrderEntitlementSnapshot[];
  snapshotDetails: Json;
  acceptedAgreementVersion: string;
  expiresAt: string;
};

export type BillingOrder = BillingOrderInsert & {
  id: string;
  status: BillingOrderStatus;
  paidAt: string | null;
  closedAt: string | null;
  refundStatus: "NONE" | "REQUESTED" | "PARTIAL" | "FULL";
  createdAt: string;
  updatedAt: string;
};

export type BillingRepository = {
  listActiveProducts(): Promise<BillingProduct[]>;
  findActiveProduct(productId: string): Promise<BillingProduct | null>;
  hasActiveSubscription(userId: string, nowIso: string): Promise<boolean>;
  insertOrder(input: BillingOrderInsert): Promise<BillingOrder>;
  findUserOrder(userId: string, orderId: string): Promise<BillingOrder | null>;
};

type BillingDatabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

export type BillingSupabaseQuery = PromiseLike<BillingDatabaseResult> & {
  select(columns: string): BillingSupabaseQuery;
  insert(values: Record<string, unknown>): BillingSupabaseQuery;
  eq(column: string, value: unknown): BillingSupabaseQuery;
  gt(column: string, value: unknown): BillingSupabaseQuery;
  limit(count: number): BillingSupabaseQuery;
  order(
    column: string,
    options?: { ascending?: boolean },
  ): BillingSupabaseQuery;
  maybeSingle(): BillingSupabaseQuery;
  single(): BillingSupabaseQuery;
};

export type BillingAdminClient = {
  from(table: string): BillingSupabaseQuery;
};

const PRODUCT_COLUMNS = [
  "id",
  "plan_id",
  "sku",
  "name",
  "description",
  "product_type",
  "price_minor",
  "currency",
  "duration_days",
  "credit_grant",
  "entitlement_version",
  "is_active",
  "display_metadata",
].join(", ");

const ENTITLEMENT_COLUMNS = [
  "feature_key",
  "entitlement_version",
  "periodic_limit",
  "credit_grant",
  "configuration",
].join(", ");

const ORDER_COLUMNS = [
  "id",
  "order_number",
  "user_id",
  "product_id",
  "provider",
  "status",
  "amount_minor",
  "currency",
  "snapshot_product_name",
  "snapshot_product_type",
  "snapshot_plan_id",
  "snapshot_duration_days",
  "snapshot_credit_grant",
  "snapshot_entitlement_version",
  "snapshot_entitlements",
  "snapshot_details",
  "accepted_agreement_version",
  "expires_at",
  "paid_at",
  "closed_at",
  "refund_status",
  "created_at",
  "updated_at",
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

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw storageError();
  }

  return value;
}

function requiredTrimmedString(value: unknown): string {
  const normalized = stringValue(value).trim();

  if (!normalized) {
    throw storageError();
  }

  return normalized;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : stringValue(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw storageError();
  }

  return value;
}

function integerValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageError();
  }

  return value;
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integerValue(value);
}

function jsonValue(value: unknown): Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        jsonValue(item),
      ]),
    );
  }

  throw storageError();
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw storageError();
  }

  return value as T;
}

function entitlementSnapshot(value: unknown): BillingEntitlementSnapshot {
  const row = record(value);
  return {
    featureKey: requiredTrimmedString(row.feature_key),
    entitlementVersion: stringValue(row.entitlement_version),
    periodicLimit: nullableInteger(row.periodic_limit),
    creditGrant: integerValue(row.credit_grant),
    configuration: jsonValue(row.configuration),
  };
}

function orderEntitlementSnapshot(
  value: unknown,
): BillingOrderEntitlementSnapshot {
  const row = record(value);
  return {
    feature_key: requiredTrimmedString(row.feature_key),
    entitlement_version: stringValue(row.entitlement_version),
    periodic_limit: nullableInteger(row.periodic_limit),
    credit_grant: integerValue(row.credit_grant),
    configuration: jsonValue(row.configuration),
  };
}

function billingProduct(
  value: unknown,
  entitlements: BillingEntitlementSnapshot[] = [],
): BillingProduct {
  const row = record(value);
  return {
    id: stringValue(row.id),
    planId: nullableString(row.plan_id),
    sku: stringValue(row.sku),
    name: stringValue(row.name),
    description: nullableString(row.description),
    productType: enumValue(row.product_type, ["SUBSCRIPTION", "CREDIT_PACK"]),
    priceMinor: integerValue(row.price_minor),
    currency: enumValue(row.currency, ["CNY"]),
    durationDays: nullableInteger(row.duration_days),
    creditGrant: integerValue(row.credit_grant),
    entitlementVersion: stringValue(row.entitlement_version),
    isActive: booleanValue(row.is_active),
    displayMetadata: jsonValue(row.display_metadata),
    entitlements,
  };
}

function billingOrder(value: unknown): BillingOrder {
  const row = record(value);
  const snapshots = jsonValue(row.snapshot_entitlements);

  if (!Array.isArray(snapshots)) {
    throw storageError();
  }

  return {
    id: stringValue(row.id),
    orderNumber: stringValue(row.order_number),
    userId: stringValue(row.user_id),
    productId: stringValue(row.product_id),
    provider: enumValue(row.provider, ["MOCK", "WECHAT", "ALIPAY"]),
    status: enumValue(row.status, [
      "PENDING",
      "PAID",
      "FAILED",
      "CANCELLED",
      "CLOSED",
      "REFUNDING",
      "REFUNDED",
    ]),
    amountMinor: integerValue(row.amount_minor),
    currency: enumValue(row.currency, ["CNY"]),
    snapshotProductName: stringValue(row.snapshot_product_name),
    snapshotProductType: enumValue(row.snapshot_product_type, [
      "SUBSCRIPTION",
      "CREDIT_PACK",
    ]),
    snapshotPlanId: nullableString(row.snapshot_plan_id),
    snapshotDurationDays: nullableInteger(row.snapshot_duration_days),
    snapshotCreditGrant: integerValue(row.snapshot_credit_grant),
    snapshotEntitlementVersion: stringValue(row.snapshot_entitlement_version),
    snapshotEntitlements: snapshots.map(orderEntitlementSnapshot),
    snapshotDetails: jsonValue(row.snapshot_details),
    acceptedAgreementVersion: stringValue(row.accepted_agreement_version),
    expiresAt: stringValue(row.expires_at),
    paidAt: nullableString(row.paid_at),
    closedAt: nullableString(row.closed_at),
    refundStatus: enumValue(row.refund_status, [
      "NONE",
      "REQUESTED",
      "PARTIAL",
      "FULL",
    ]),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function assertDatabaseResult(result: BillingDatabaseResult): unknown {
  if (result.error) {
    if (
      typeof result.error === "object" && result.error !== null &&
      "code" in result.error && result.error.code === "P2201" &&
      "message" in result.error && result.error.message === "ACTIVE_SUBSCRIPTION_EXISTS"
    ) {
      throw new BillingError(
        "ACTIVE_SUBSCRIPTION_EXISTS",
        "An active subscription or pending subscription order already exists.",
        409,
      );
    }
    throw storageError();
  }

  return result.data;
}

async function failClosed<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof BillingError &&
      (error.code === "BILLING_STORAGE_UNAVAILABLE" || error.code === "ACTIVE_SUBSCRIPTION_EXISTS")
    ) {
      throw error;
    }

    throw storageError();
  }
}

export function createBillingRepository(
  client: BillingAdminClient,
): BillingRepository {
  return {
    listActiveProducts() {
      return failClosed(async () => {
        const result = await client
          .from("billing_products")
          .select(PRODUCT_COLUMNS)
          .eq("is_active", true)
          .order("price_minor", { ascending: true });
        const data = assertDatabaseResult(result);

        if (!Array.isArray(data)) {
          throw storageError();
        }

        return data.map((item) => billingProduct(item));
      });
    },

    findActiveProduct(productId) {
      return failClosed(async () => {
        const productResult = await client
          .from("billing_products")
          .select(PRODUCT_COLUMNS)
          .eq("id", productId)
          .eq("is_active", true)
          .maybeSingle();
        const productData = assertDatabaseResult(productResult);

        if (productData === null) {
          return null;
        }

        const mappedProduct = billingProduct(productData);
        if (!mappedProduct.isActive) {
          return null;
        }

        if (mappedProduct.planId === null) {
          return mappedProduct;
        }

        const entitlementResult = await client
          .from("billing_plan_entitlements")
          .select(ENTITLEMENT_COLUMNS)
          .eq("plan_id", mappedProduct.planId)
          .eq("entitlement_version", mappedProduct.entitlementVersion)
          .order("feature_key", { ascending: true });
        const entitlementData = assertDatabaseResult(entitlementResult);

        if (!Array.isArray(entitlementData)) {
          throw storageError();
        }

        return {
          ...mappedProduct,
          entitlements: entitlementData.map(entitlementSnapshot),
        };
      });
    },

    hasActiveSubscription(userId, nowIso) {
      return failClosed(async () => {
        const result = await client
          .from("billing_subscriptions")
          .select("id")
          .eq("user_id", userId)
          .eq("status", "ACTIVE")
          .gt("ends_at", nowIso)
          .limit(1)
          .maybeSingle();
        const data = assertDatabaseResult(result);

        if (data === null) {
          return false;
        }

        record(data);
        return true;
      });
    },

    insertOrder(input) {
      return failClosed(async () => {
        const result = await client
          .from("billing_orders")
          .insert({
            order_number: input.orderNumber,
            user_id: input.userId,
            product_id: input.productId,
            provider: input.provider,
            amount_minor: input.amountMinor,
            currency: input.currency,
            snapshot_product_name: input.snapshotProductName,
            snapshot_product_type: input.snapshotProductType,
            snapshot_plan_id: input.snapshotPlanId,
            snapshot_duration_days: input.snapshotDurationDays,
            snapshot_credit_grant: input.snapshotCreditGrant,
            snapshot_entitlement_version: input.snapshotEntitlementVersion,
            snapshot_entitlements: input.snapshotEntitlements,
            snapshot_details: input.snapshotDetails,
            accepted_agreement_version: input.acceptedAgreementVersion,
            expires_at: input.expiresAt,
          })
          .select(ORDER_COLUMNS)
          .single();

        return billingOrder(assertDatabaseResult(result));
      });
    },

    findUserOrder(userId, orderId) {
      return failClosed(async () => {
        const result = await client
          .from("billing_orders")
          .select(ORDER_COLUMNS)
          .eq("id", orderId)
          .eq("user_id", userId)
          .maybeSingle();
        const data = assertDatabaseResult(result);
        return data === null ? null : billingOrder(data);
      });
    },
  };
}

function getDefaultRepository(): BillingRepository {
  const client = getSupabaseAdminClient();

  if (!client) {
    throw storageError();
  }

  return createBillingRepository(client as unknown as BillingAdminClient);
}

export const billingRepository: BillingRepository = {
  listActiveProducts() {
    return getDefaultRepository().listActiveProducts();
  },
  findActiveProduct(productId) {
    return getDefaultRepository().findActiveProduct(productId);
  },
  hasActiveSubscription(userId, nowIso) {
    return getDefaultRepository().hasActiveSubscription(userId, nowIso);
  },
  insertOrder(input) {
    return getDefaultRepository().insertOrder(input);
  },
  findUserOrder(userId, orderId) {
    return getDefaultRepository().findUserOrder(userId, orderId);
  },
};
