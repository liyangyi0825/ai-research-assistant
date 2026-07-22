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
