import { getSupabaseAdminClient } from "../supabase";
import { BillingError } from "./errors";

export type UsageReservationInput = {
  userId: string;
  taskKey: string;
  featureKey: string;
  quotaUnits: number;
  creditAmount: number;
};

export type UsageRpcResult = {
  status: "RESERVED" | "FINALIZED" | "RELEASED";
  usageRecordId: string;
  idempotent: boolean;
};

export type BillingUsageRpcAdapter = {
  reserve(input: UsageReservationInput): Promise<UsageRpcResult>;
  finalize(userId: string, taskKey: string): Promise<UsageRpcResult>;
  release(userId: string, taskKey: string): Promise<UsageRpcResult>;
};

type UsageRpcDatabaseResult = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

export type BillingUsageRpcClient = {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<UsageRpcDatabaseResult>;
};

function storageError(): BillingError {
  return new BillingError(
    "BILLING_STORAGE_UNAVAILABLE",
    "Billing data is temporarily unavailable.",
    503,
  );
}

function invalidUsage(message: string): BillingError {
  return new BillingError("INVALID_USAGE_RESERVATION", message, 400);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidUsage(message);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidUsage(message);
  }
  return value;
}

export function normalizeUsageReservation(
  input: UsageReservationInput,
): UsageReservationInput {
  const normalized = {
    userId: requiredString(input.userId, "A user ID is required."),
    taskKey: requiredString(
      input.taskKey,
      "A stable task idempotency key is required.",
    ),
    featureKey: requiredString(input.featureKey, "A feature key is required."),
    quotaUnits: nonNegativeInteger(
      input.quotaUnits,
      "Quota units must be a non-negative integer.",
    ),
    creditAmount: nonNegativeInteger(
      input.creditAmount,
      "Credit amount must be a non-negative integer.",
    ),
  };
  if (normalized.quotaUnits === 0 && normalized.creditAmount === 0) {
    throw invalidUsage("A usage reservation must be positive.");
  }
  return normalized;
}

function mapRpcError(error: { code?: string; message: string }): BillingError {
  const message = error.message.toLowerCase();
  if (
    message.includes("usage quota exceeded") ||
    message.includes("active usage quota not found")
  ) {
    return new BillingError(
      "USAGE_QUOTA_EXCEEDED",
      "The research usage limit has been reached.",
      429,
    );
  }
  if (
    message.includes("insufficient credit balance") ||
    message.includes("credit account not found")
  ) {
    return new BillingError(
      "INSUFFICIENT_CREDITS",
      "There are not enough credits for this research task.",
      402,
    );
  }
  if (message.includes("task idempotency key payload mismatch")) {
    return new BillingError(
      "USAGE_IDEMPOTENCY_CONFLICT",
      "The research task key was already used with different usage data.",
      409,
    );
  }
  if (
    message.includes("cannot be finalized") ||
    message.includes("cannot be released")
  ) {
    return new BillingError(
      "USAGE_STATE_CONFLICT",
      "The research usage reservation is already in a terminal state.",
      409,
    );
  }
  return storageError();
}

function mapRpcResult(
  value: unknown,
  allowed: readonly UsageRpcResult["status"][],
): UsageRpcResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  const row = value as Record<string, unknown>;
  if (
    (row.status !== "RESERVED" &&
      row.status !== "FINALIZED" &&
      row.status !== "RELEASED") ||
    !allowed.includes(row.status) ||
    typeof row.usage_record_id !== "string" ||
    !row.usage_record_id.trim() ||
    typeof row.idempotent !== "boolean"
  ) {
    throw storageError();
  }
  return {
    status: row.status,
    usageRecordId: row.usage_record_id,
    idempotent: row.idempotent,
  };
}

async function rpc(
  client: BillingUsageRpcClient,
  name: string,
  args: Record<string, unknown>,
  allowed: readonly UsageRpcResult["status"][],
): Promise<UsageRpcResult> {
  try {
    const result = await client.rpc(name, args);
    if (result.error) throw mapRpcError(result.error);
    return mapRpcResult(result.data, allowed);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
}

export function createBillingUsageRpcAdapter(
  client: BillingUsageRpcClient,
): BillingUsageRpcAdapter {
  return {
    reserve(input) {
      return rpc(
        client,
        "billing_reserve_usage",
        {
          p_user_id: input.userId,
          p_task_idempotency_key: input.taskKey,
          p_feature_key: input.featureKey,
          p_quota_units: input.quotaUnits,
          p_credit_amount: input.creditAmount,
          p_currency: "CREDITS",
        },
        ["RESERVED", "FINALIZED", "RELEASED"],
      );
    },
    finalize(userId, taskKey) {
      return rpc(
        client,
        "billing_finalize_usage",
        {
          p_user_id: userId,
          p_task_idempotency_key: taskKey,
        },
        ["FINALIZED"],
      );
    },
    release(userId, taskKey) {
      return rpc(
        client,
        "billing_release_usage",
        {
          p_user_id: userId,
          p_task_idempotency_key: taskKey,
        },
        ["RELEASED"],
      );
    },
  };
}

function defaultAdapter(): BillingUsageRpcAdapter {
  const database = getSupabaseAdminClient();
  if (!database) throw storageError();
  return createBillingUsageRpcAdapter(
    database as unknown as BillingUsageRpcClient,
  );
}

const supabaseUsageRpcAdapter: BillingUsageRpcAdapter = {
  reserve(input) {
    return defaultAdapter().reserve(input);
  },
  finalize(userId, taskKey) {
    return defaultAdapter().finalize(userId, taskKey);
  },
  release(userId, taskKey) {
    return defaultAdapter().release(userId, taskKey);
  },
};

export class UsageQuotaService {
  constructor(
    private readonly adapter: BillingUsageRpcAdapter = supabaseUsageRpcAdapter,
  ) {}

  reserve(input: UsageReservationInput): Promise<UsageRpcResult> {
    return this.adapter.reserve(normalizeUsageReservation(input));
  }

  finalize(userId: string, taskKey: string): Promise<UsageRpcResult> {
    return this.adapter.finalize(
      requiredString(userId, "A user ID is required."),
      requiredString(taskKey, "A stable task idempotency key is required."),
    );
  }

  release(userId: string, taskKey: string): Promise<UsageRpcResult> {
    return this.adapter.release(
      requiredString(userId, "A user ID is required."),
      requiredString(taskKey, "A stable task idempotency key is required."),
    );
  }
}
