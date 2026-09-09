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

export type ContinuationStageProvision = {
  stageKey: string;
  requestHash?: string;
};

export type ContinuationRootInput = {
  userId: string;
  taskKey: string;
  featureKey: string;
  operationKey: string;
  stages: readonly ContinuationStageProvision[];
  finalizeUsage: boolean;
};

export type ContinuationStageInput = {
  userId: string;
  taskKey: string;
  featureKey: string;
  operationKey: string;
  stageKey: string;
  requestHash: string;
};

export type ContinuationSettlementInput = ContinuationStageInput & {
  claimToken: string;
};

export type ContinuationProvisionResult = {
  status: "PROVISIONED";
  usageRecordId: string | null;
  continuationCount: number;
};

export type ContinuationClaimResult = {
  status: "CLAIMED" | "COMPLETED";
  continuationId: string;
  claimToken: string | null;
  idempotent: boolean;
};

export type ContinuationSettlementResult = {
  status: "AVAILABLE" | "COMPLETED";
  continuationId: string;
  idempotent: boolean;
};

export type BillingUsageRpcAdapter = {
  reserve(input: UsageReservationInput): Promise<UsageRpcResult>;
  finalize(userId: string, taskKey: string): Promise<UsageRpcResult>;
  release(userId: string, taskKey: string): Promise<UsageRpcResult>;
  provision(input: ContinuationRootInput): Promise<ContinuationProvisionResult>;
  claim(input: ContinuationStageInput): Promise<ContinuationClaimResult>;
  complete(
    input: ContinuationSettlementInput,
  ): Promise<ContinuationSettlementResult>;
  releaseContinuation(
    input: ContinuationSettlementInput,
  ): Promise<ContinuationSettlementResult>;
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
  if (message.includes("active usage quota not found")) {
    return new BillingError(
      "USAGE_QUOTA_NOT_PROVISIONED",
      "The research usage quota is temporarily unavailable.",
      503,
    );
  }
  if (message.includes("usage quota exceeded")) {
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
    message.includes("usage continuation stage not found") ||
    message.includes("finalized usage continuation root not found")
  ) {
    return new BillingError(
      "INVALID_USAGE_CONTINUATION",
      "This continuation stage is not available for this operation.",
      409,
    );
  }
  if (message.includes("continuation request payload mismatch")) {
    return new BillingError(
      "USAGE_CONTINUATION_PAYLOAD_CONFLICT",
      "This continuation stage was already bound to different request data.",
      409,
    );
  }
  if (
    message.includes("continuation claim token mismatch") ||
    message.includes("usage continuation is already completed")
  ) {
    return new BillingError(
      "USAGE_CONTINUATION_STATE_CONFLICT",
      "This continuation stage is no longer held by this request.",
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

async function continuationRpc<T>(
  client: BillingUsageRpcClient,
  name: string,
  args: Record<string, unknown>,
  map: (value: unknown) => T,
): Promise<T> {
  try {
    const result = await client.rpc(name, args);
    if (result.error) throw mapRpcError(result.error);
    return map(result.data);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
}

function continuationId(row: Record<string, unknown>): string {
  if (
    typeof row.continuation_id !== "string" ||
    !row.continuation_id.trim()
  ) {
    throw storageError();
  }
  return row.continuation_id;
}

function mapProvisionResult(value: unknown): ContinuationProvisionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  const row = value as Record<string, unknown>;
  if (
    row.status !== "PROVISIONED" ||
    (row.usage_record_id !== null &&
      typeof row.usage_record_id !== "string") ||
    typeof row.continuation_count !== "number" ||
    !Number.isSafeInteger(row.continuation_count) ||
    row.continuation_count < 1
  ) {
    throw storageError();
  }
  return {
    status: "PROVISIONED",
    usageRecordId: row.usage_record_id,
    continuationCount: row.continuation_count,
  };
}

function mapClaimResult(value: unknown): ContinuationClaimResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  const row = value as Record<string, unknown>;
  if (
    (row.status !== "CLAIMED" && row.status !== "COMPLETED") ||
    (row.claim_token !== null && typeof row.claim_token !== "string") ||
    typeof row.idempotent !== "boolean"
  ) {
    throw storageError();
  }
  return {
    status: row.status,
    continuationId: continuationId(row),
    claimToken: row.claim_token,
    idempotent: row.idempotent,
  };
}

function mapSettlementResult(value: unknown): ContinuationSettlementResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  const row = value as Record<string, unknown>;
  if (
    (row.status !== "AVAILABLE" && row.status !== "COMPLETED") ||
    typeof row.idempotent !== "boolean"
  ) {
    throw storageError();
  }
  return {
    status: row.status,
    continuationId: continuationId(row),
    idempotent: row.idempotent,
  };
}

const SAFE_CONTINUATION_KEY = /^[a-z0-9][a-z0-9._:-]{1,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function continuationKey(value: unknown, name: string): string {
  const normalized = requiredString(value, `${name} is required.`);
  if (!SAFE_CONTINUATION_KEY.test(normalized)) {
    throw invalidUsage(`${name} is invalid.`);
  }
  return normalized;
}

function requestHash(value: unknown): string {
  const normalized = requiredString(
    value,
    "A continuation request hash is required.",
  ).toLowerCase();
  if (!SHA256.test(normalized)) {
    throw invalidUsage("The continuation request hash must be SHA-256.");
  }
  return normalized;
}

function normalizeContinuationStage(
  input: ContinuationStageInput,
): ContinuationStageInput {
  return {
    userId: requiredString(input.userId, "A user ID is required."),
    taskKey: requiredString(input.taskKey, "A root task key is required."),
    featureKey: requiredString(input.featureKey, "A feature key is required."),
    operationKey: continuationKey(input.operationKey, "An operation key"),
    stageKey: continuationKey(input.stageKey, "A stage key"),
    requestHash: requestHash(input.requestHash),
  };
}

function stageRpcArgs(input: ContinuationStageInput) {
  return {
    p_user_id: input.userId,
    p_root_task_idempotency_key: input.taskKey,
    p_feature_key: input.featureKey,
    p_operation_key: input.operationKey,
    p_stage_key: input.stageKey,
    p_request_hash: input.requestHash,
  };
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
    provision(rawInput) {
      const input = {
        userId: requiredString(rawInput.userId, "A user ID is required."),
        taskKey: requiredString(rawInput.taskKey, "A root task key is required."),
        featureKey: requiredString(
          rawInput.featureKey,
          "A feature key is required.",
        ),
        operationKey: continuationKey(
          rawInput.operationKey,
          "An operation key",
        ),
        stages: rawInput.stages.map((stage) => ({
          stageKey: continuationKey(stage.stageKey, "A stage key"),
          requestHash:
            stage.requestHash === undefined
              ? undefined
              : requestHash(stage.requestHash),
        })),
        finalizeUsage: rawInput.finalizeUsage,
      };
      if (
        input.stages.length < 1 ||
        input.stages.length > 32 ||
        new Set(input.stages.map(({ stageKey }) => stageKey)).size !==
          input.stages.length
      ) {
        throw invalidUsage("Continuation stages must be 1-32 unique entries.");
      }
      return continuationRpc(
        client,
        "billing_provision_usage_continuations",
        {
          p_user_id: input.userId,
          p_root_task_idempotency_key: input.taskKey,
          p_feature_key: input.featureKey,
          p_operation_key: input.operationKey,
          p_stages: input.stages.map((stage) => ({
            stage_key: stage.stageKey,
            ...(stage.requestHash
              ? { request_hash: stage.requestHash }
              : {}),
          })),
          p_finalize_usage: input.finalizeUsage,
        },
        mapProvisionResult,
      );
    },
    claim(rawInput) {
      const input = normalizeContinuationStage(rawInput);
      return continuationRpc(
        client,
        "billing_claim_usage_continuation",
        { ...stageRpcArgs(input), p_lease_seconds: 300 },
        mapClaimResult,
      );
    },
    complete(rawInput) {
      const input = normalizeContinuationStage(rawInput);
      return continuationRpc(
        client,
        "billing_complete_usage_continuation",
        {
          ...stageRpcArgs(input),
          p_claim_token: requiredString(
            rawInput.claimToken,
            "A continuation claim token is required.",
          ),
        },
        mapSettlementResult,
      );
    },
    releaseContinuation(rawInput) {
      const input = normalizeContinuationStage(rawInput);
      return continuationRpc(
        client,
        "billing_release_usage_continuation",
        {
          ...stageRpcArgs(input),
          p_claim_token: requiredString(
            rawInput.claimToken,
            "A continuation claim token is required.",
          ),
        },
        mapSettlementResult,
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
  provision(input) {
    return defaultAdapter().provision(input);
  },
  claim(input) {
    return defaultAdapter().claim(input);
  },
  complete(input) {
    return defaultAdapter().complete(input);
  },
  releaseContinuation(input) {
    return defaultAdapter().releaseContinuation(input);
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

  provision(
    input: ContinuationRootInput,
  ): Promise<ContinuationProvisionResult> {
    return this.adapter.provision(input);
  }

  claim(input: ContinuationStageInput): Promise<ContinuationClaimResult> {
    return this.adapter.claim(input);
  }

  complete(
    input: ContinuationSettlementInput,
  ): Promise<ContinuationSettlementResult> {
    return this.adapter.complete(input);
  }

  releaseContinuation(
    input: ContinuationSettlementInput,
  ): Promise<ContinuationSettlementResult> {
    return this.adapter.releaseContinuation(input);
  }
}
