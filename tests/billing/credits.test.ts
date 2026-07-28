import assert from "node:assert/strict";
import test from "node:test";

import { CreditService } from "../../lib/billing/credits";
import { BillingError } from "../../lib/billing/errors";
import {
  createBillingUsageRpcAdapter,
  type BillingUsageRpcClient,
  type UsageReservationInput,
} from "../../lib/billing/usage-quota";

type RpcResult = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

class InMemoryRpcClient implements BillingUsageRpcClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(private readonly results: RpcResult[]) {}

  async rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<RpcResult> {
    this.calls.push({ name, args });
    const result = this.results.shift();
    assert.ok(result, `Missing RPC result for ${name}`);
    return result;
  }
}

function reservation(
  overrides: Partial<UsageReservationInput> = {},
): UsageReservationInput {
  return {
    userId: "user-1",
    taskKey: "research:user-1:request-1",
    featureKey: "deep_research",
    quotaUnits: 1,
    creditAmount: 25,
    ...overrides,
  };
}

function expectBillingError(
  error: unknown,
  code: string,
  status: number,
): boolean {
  return (
    error instanceof BillingError && error.code === code && error.status === status
  );
}

test("CreditService reserves quota and credits with one atomic RPC and never reads balances", async () => {
  const client = new InMemoryRpcClient([
    {
      data: {
        status: "RESERVED",
        usage_record_id: "usage-1",
        idempotent: false,
      },
      error: null,
    },
  ]);
  const service = new CreditService(createBillingUsageRpcAdapter(client));

  const result = await service.reserve(reservation());

  assert.equal(result.status, "RESERVED");
  assert.deepEqual(client.calls, [
    {
      name: "billing_reserve_usage",
      args: {
        p_user_id: "user-1",
        p_task_idempotency_key: "research:user-1:request-1",
        p_feature_key: "deep_research",
        p_quota_units: 1,
        p_credit_amount: 25,
        p_currency: "CREDITS",
      },
    },
  ]);
});

test("usage RPC errors distinguish exhausted quota from insufficient credits", async () => {
  const quotaClient = new InMemoryRpcClient([
    {
      data: null,
      error: { code: "53000", message: "usage quota exceeded" },
    },
  ]);
  await assert.rejects(
    new CreditService(createBillingUsageRpcAdapter(quotaClient)).reserve(
      reservation(),
    ),
    (error) => expectBillingError(error, "USAGE_QUOTA_EXCEEDED", 429),
  );

  const creditClient = new InMemoryRpcClient([
    {
      data: null,
      error: { code: "53000", message: "insufficient credit balance" },
    },
  ]);
  await assert.rejects(
    new CreditService(createBillingUsageRpcAdapter(creditClient)).reserve(
      reservation(),
    ),
    (error) => expectBillingError(error, "INSUFFICIENT_CREDITS", 402),
  );
});

test("a missing active quota is a provisioning failure, not an exhausted limit", async () => {
  const client = new InMemoryRpcClient([
    {
      data: null,
      error: { code: "53000", message: "active usage quota not found" },
    },
  ]);

  await assert.rejects(
    new CreditService(createBillingUsageRpcAdapter(client)).reserve(
      reservation(),
    ),
    (error) =>
      expectBillingError(error, "USAGE_QUOTA_NOT_PROVISIONED", 503),
  );
});

test("unexpected usage database errors fail closed with a safe error", async () => {
  const client = new InMemoryRpcClient([
    {
      data: null,
      error: { code: "XX000", message: "secret database detail" },
    },
  ]);

  await assert.rejects(
    new CreditService(createBillingUsageRpcAdapter(client)).reserve(
      reservation(),
    ),
    (error) => {
      assert.ok(
        expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
      );
      assert.doesNotMatch((error as Error).message, /secret database detail/);
      return true;
    },
  );
});

test("finalize and release retries use the same task key and accept idempotent replies", async () => {
  const client = new InMemoryRpcClient([
    {
      data: {
        status: "FINALIZED",
        usage_record_id: "usage-1",
        idempotent: false,
      },
      error: null,
    },
    {
      data: {
        status: "FINALIZED",
        usage_record_id: "usage-1",
        idempotent: true,
      },
      error: null,
    },
    {
      data: {
        status: "RELEASED",
        usage_record_id: "usage-2",
        idempotent: false,
      },
      error: null,
    },
    {
      data: {
        status: "RELEASED",
        usage_record_id: "usage-2",
        idempotent: true,
      },
      error: null,
    },
  ]);
  const service = new CreditService(createBillingUsageRpcAdapter(client));

  assert.equal(
    (await service.finalize("user-1", "research:user-1:request-1"))
      .idempotent,
    false,
  );
  assert.equal(
    (await service.finalize("user-1", "research:user-1:request-1"))
      .idempotent,
    true,
  );
  assert.equal(
    (await service.release("user-1", "research:user-1:request-2"))
      .idempotent,
    false,
  );
  assert.equal(
    (await service.release("user-1", "research:user-1:request-2"))
      .idempotent,
    true,
  );

  assert.deepEqual(
    client.calls.map(({ name }) => name),
    [
      "billing_finalize_usage",
      "billing_finalize_usage",
      "billing_release_usage",
      "billing_release_usage",
    ],
  );
});

test("continuation lifecycle delegates the bound operation, stage, hash, and claim token", async () => {
  const client = new InMemoryRpcClient([
    {
      data: {
        status: "PROVISIONED",
        usage_record_id: "usage-1",
        continuation_count: 1,
      },
      error: null,
    },
    {
      data: {
        status: "CLAIMED",
        continuation_id: "continuation-1",
        claim_token: "claim-1",
        idempotent: false,
      },
      error: null,
    },
    {
      data: {
        status: "COMPLETED",
        continuation_id: "continuation-1",
        idempotent: false,
      },
      error: null,
    },
    {
      data: {
        status: "AVAILABLE",
        continuation_id: "continuation-1",
        idempotent: false,
      },
      error: null,
    },
  ]);
  const adapter = createBillingUsageRpcAdapter(client);
  const root = {
    userId: "user-1",
    taskKey: "ai:user-1:concept_explorer:operation-1",
    featureKey: "concept_explore",
    operationKey: "concept_explorer",
  };
  const stage = {
    ...root,
    stageKey: "block:2",
    requestHash: "a".repeat(64),
  };

  await adapter.provision({
    ...root,
    stages: [{ stageKey: "block:2", requestHash: "a".repeat(64) }],
    finalizeUsage: true,
  });
  await adapter.claim(stage);
  await adapter.complete({ ...stage, claimToken: "claim-1" });
  await adapter.releaseContinuation({ ...stage, claimToken: "claim-1" });

  assert.deepEqual(client.calls, [
    {
      name: "billing_provision_usage_continuations",
      args: {
        p_user_id: "user-1",
        p_root_task_idempotency_key:
          "ai:user-1:concept_explorer:operation-1",
        p_feature_key: "concept_explore",
        p_operation_key: "concept_explorer",
        p_stages: [
          { stage_key: "block:2", request_hash: "a".repeat(64) },
        ],
        p_finalize_usage: true,
      },
    },
    {
      name: "billing_claim_usage_continuation",
      args: {
        p_user_id: "user-1",
        p_root_task_idempotency_key:
          "ai:user-1:concept_explorer:operation-1",
        p_feature_key: "concept_explore",
        p_operation_key: "concept_explorer",
        p_stage_key: "block:2",
        p_request_hash: "a".repeat(64),
        p_lease_seconds: 300,
      },
    },
    {
      name: "billing_complete_usage_continuation",
      args: {
        p_user_id: "user-1",
        p_root_task_idempotency_key:
          "ai:user-1:concept_explorer:operation-1",
        p_feature_key: "concept_explore",
        p_operation_key: "concept_explorer",
        p_stage_key: "block:2",
        p_request_hash: "a".repeat(64),
        p_claim_token: "claim-1",
      },
    },
    {
      name: "billing_release_usage_continuation",
      args: {
        p_user_id: "user-1",
        p_root_task_idempotency_key:
          "ai:user-1:concept_explorer:operation-1",
        p_feature_key: "concept_explore",
        p_operation_key: "concept_explorer",
        p_stage_key: "block:2",
        p_request_hash: "a".repeat(64),
        p_claim_token: "claim-1",
      },
    },
  ]);
});

test("continuation payload mismatch is a safe 409 conflict", async () => {
  const client = new InMemoryRpcClient([
    {
      data: null,
      error: { code: "23505", message: "continuation request payload mismatch" },
    },
  ]);
  const adapter = createBillingUsageRpcAdapter(client);

  await assert.rejects(
    adapter.claim({
      userId: "user-1",
      taskKey: "ai:user-1:concept_explorer:operation-1",
      featureKey: "concept_explore",
      operationKey: "concept_explorer",
      stageKey: "block:2",
      requestHash: "b".repeat(64),
    }),
    (error) =>
      expectBillingError(
        error,
        "USAGE_CONTINUATION_PAYLOAD_CONFLICT",
        409,
      ),
  );
});
