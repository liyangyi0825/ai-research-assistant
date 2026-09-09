import { getSupabaseAdminClient } from "../supabase";
import type { Json } from "./database.types";
import { BillingError } from "./errors";

export type Entitlement = {
  id: string;
  userId: string;
  featureKey: string;
  sourceType: "PLAN" | "ADMIN";
  sourceOrderId: string | null;
  value: Json;
  validFrom: string;
  validUntil: string | null;
};

export type EntitlementRepository = {
  findCurrentEntitlement(
    userId: string,
    featureKey: string,
  ): Promise<Entitlement | null>;
};

type EntitlementDatabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

export type EntitlementDatabaseQuery =
  PromiseLike<EntitlementDatabaseResult> & {
    select(columns: string): EntitlementDatabaseQuery;
    eq(column: string, value: unknown): EntitlementDatabaseQuery;
    lte(column: string, value: unknown): EntitlementDatabaseQuery;
    or(filters: string): EntitlementDatabaseQuery;
    order(
      column: string,
      options?: { ascending?: boolean; nullsFirst?: boolean },
    ): EntitlementDatabaseQuery;
    limit(count: number): EntitlementDatabaseQuery;
    maybeSingle(): EntitlementDatabaseQuery;
  };

export type EntitlementDatabaseClient = {
  from(table: string): EntitlementDatabaseQuery;
};

const ENTITLEMENT_COLUMNS = [
  "id",
  "user_id",
  "feature_key",
  "source_type",
  "source_order_id",
  "entitlement_value",
  "valid_from",
  "valid_until",
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
  if (typeof value !== "string" || !value.trim()) throw storageError();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : requiredString(value);
}

function timestamp(value: unknown): string {
  const result = requiredString(value);
  if (!Number.isFinite(Date.parse(result))) throw storageError();
  return result;
}

function isJson(value: unknown): value is Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(
    (item) => item === undefined || isJson(item),
  );
}

function mapEntitlement(value: unknown): Entitlement {
  const row = record(value);
  if (row.source_type !== "PLAN" && row.source_type !== "ADMIN") {
    throw storageError();
  }
  if (!isJson(row.entitlement_value)) throw storageError();
  const validFrom = timestamp(row.valid_from);
  const validUntil =
    row.valid_until === null ? null : timestamp(row.valid_until);
  if (validUntil !== null && Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw storageError();
  }

  return {
    id: requiredString(row.id),
    userId: requiredString(row.user_id),
    featureKey: requiredString(row.feature_key),
    sourceType: row.source_type,
    sourceOrderId: nullableString(row.source_order_id),
    value: structuredClone(row.entitlement_value),
    validFrom,
    validUntil,
  };
}

export function createEntitlementRepository(
  client: EntitlementDatabaseClient,
): EntitlementRepository {
  return {
    async findCurrentEntitlement(userId, featureKey) {
      try {
        const result = await client
          .from("billing_user_entitlements")
          .select(ENTITLEMENT_COLUMNS)
          .eq("user_id", userId)
          .eq("feature_key", featureKey)
          .lte("valid_from", "now")
          .or("valid_until.is.null,valid_until.gt.now")
          .order("valid_until", { ascending: false, nullsFirst: true })
          .limit(1)
          .maybeSingle();

        if (result.error) throw storageError();
        return result.data === null ? null : mapEntitlement(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
  };
}

function defaultRepository(): EntitlementRepository {
  const database = getSupabaseAdminClient();
  if (!database) throw storageError();
  return createEntitlementRepository(
    database as unknown as EntitlementDatabaseClient,
  );
}

const supabaseEntitlementRepository: EntitlementRepository = {
  findCurrentEntitlement(userId, featureKey) {
    return defaultRepository().findCurrentEntitlement(userId, featureKey);
  },
};

function assertPlanSnapshot(entitlement: Entitlement): void {
  const value = record(entitlement.value);
  if (
    entitlement.sourceOrderId === null ||
    value.feature_key !== entitlement.featureKey ||
    typeof value.entitlement_version !== "string" ||
    !value.entitlement_version.trim() ||
    (value.periodic_limit !== null &&
      (typeof value.periodic_limit !== "number" ||
        !Number.isSafeInteger(value.periodic_limit) ||
        value.periodic_limit < 0)) ||
    !isJson(value.configuration)
  ) {
    throw storageError();
  }
}

function assertSource(entitlement: Entitlement): void {
  if (entitlement.sourceType === "PLAN") {
    if (entitlement.validUntil === null) throw storageError();
    assertPlanSnapshot(entitlement);
    return;
  }
  if (
    entitlement.sourceOrderId !== null ||
    !entitlement.value ||
    typeof entitlement.value !== "object" ||
    Array.isArray(entitlement.value)
  ) {
    throw storageError();
  }
}

export class EntitlementService {
  constructor(
    private readonly repository: EntitlementRepository =
      supabaseEntitlementRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getEntitlement(
    userId: string,
    featureKey: string,
  ): Promise<Entitlement | null> {
    let entitlement: Entitlement | null;
    try {
      entitlement = await this.repository.findCurrentEntitlement(
        userId,
        featureKey,
      );
    } catch (error) {
      if (error instanceof BillingError) throw error;
      throw storageError();
    }

    if (!entitlement) return null;
    if (
      entitlement.userId !== userId ||
      entitlement.featureKey !== featureKey
    ) {
      throw storageError();
    }
    assertSource(entitlement);

    const now = this.now().getTime();
    if (!Number.isFinite(now)) throw storageError();
    if (
      Date.parse(entitlement.validFrom) > now ||
      (entitlement.validUntil !== null &&
        Date.parse(entitlement.validUntil) <= now)
    ) {
      return null;
    }
    return entitlement;
  }

  async requireEntitlement(
    userId: string,
    featureKey: string,
  ): Promise<Entitlement> {
    const entitlement = await this.getEntitlement(userId, featureKey);
    if (!entitlement) {
      throw new BillingError(
        "ENTITLEMENT_REQUIRED",
        "This research feature is not included in the current entitlement.",
        403,
      );
    }
    return entitlement;
  }
}
