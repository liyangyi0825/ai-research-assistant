import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EntitlementService,
  type EntitlementRepository,
} from "../../lib/billing/entitlements";
import { BillingError } from "../../lib/billing/errors";
import {
  SubscriptionService,
  createSubscriptionRepository,
  type Subscription,
  type SubscriptionDatabaseClient,
  type SubscriptionRepository,
} from "../../lib/billing/subscriptions";

const databaseNow = new Date("2026-07-22T08:00:00.000Z");

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "subscription-1",
    userId: "user-1",
    planId: "plan-pro",
    sourceOrderId: "order-1",
    status: "ACTIVE",
    startsAt: "2026-07-01T08:00:00.000Z",
    endsAt: "2026-08-01T08:00:00.000Z",
    ...overrides,
  };
}

class InMemorySubscriptionRepository implements SubscriptionRepository {
  fail = false;

  constructor(
    private readonly subscriptions: Subscription[],
    private readonly now: Date = databaseNow,
  ) {}

  async findCurrentSubscription(userId: string): Promise<Subscription | null> {
    if (this.fail) throw new Error("database unavailable");
    const now = this.now.getTime();
    return (
      this.subscriptions.find(
        (item) =>
          item.userId === userId &&
          item.status === "ACTIVE" &&
          Date.parse(item.startsAt) <= now &&
          Date.parse(item.endsAt) > now,
      ) ?? null
    );
  }
}

type DatabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

class SubscriptionQuery {
  readonly operations: Array<{ operation: string; args: unknown[] }> = [];

  constructor(private readonly result: DatabaseResult) {}

  select(...args: unknown[]): this {
    this.operations.push({ operation: "select", args });
    return this;
  }

  eq(...args: unknown[]): this {
    this.operations.push({ operation: "eq", args });
    return this;
  }

  lte(...args: unknown[]): this {
    this.operations.push({ operation: "lte", args });
    return this;
  }

  gt(...args: unknown[]): this {
    this.operations.push({ operation: "gt", args });
    return this;
  }

  order(...args: unknown[]): this {
    this.operations.push({ operation: "order", args });
    return this;
  }

  limit(...args: unknown[]): this {
    this.operations.push({ operation: "limit", args });
    return this;
  }

  maybeSingle(): this {
    this.operations.push({ operation: "maybeSingle", args: [] });
    return this;
  }

  then<TResult1 = DatabaseResult, TResult2 = never>(
    onfulfilled?:
      | ((value: DatabaseResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

class SubscriptionClient implements SubscriptionDatabaseClient {
  readonly query: SubscriptionQuery;
  table: string | null = null;

  constructor(result: DatabaseResult) {
    this.query = new SubscriptionQuery(result);
  }

  from(table: string): SubscriptionQuery {
    this.table = table;
    return this.query;
  }
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

test("SubscriptionService excludes a subscription whose end equals database now", async () => {
  const repository = new InMemorySubscriptionRepository([
    subscription({ endsAt: databaseNow.toISOString() }),
  ]);
  const service = new SubscriptionService(repository);

  assert.equal(await service.getCurrentSubscription("user-1"), null);
  await assert.rejects(
    service.requireActiveSubscription("user-1"),
    (error) => expectBillingError(error, "SUBSCRIPTION_REQUIRED", 403),
  );
});

test("subscription repository asks Postgres to compare starts_at and ends_at with database now", async () => {
  const client = new SubscriptionClient({
    data: {
      id: "subscription-1",
      user_id: "user-1",
      plan_id: "plan-pro",
      source_order_id: "order-1",
      status: "ACTIVE",
      starts_at: "2026-07-01T08:00:00.000Z",
      ends_at: "2026-08-01T08:00:00.000Z",
    },
    error: null,
  });

  const result = await createSubscriptionRepository(client)
    .findCurrentSubscription("user-1");

  assert.equal(result?.id, "subscription-1");
  assert.equal(client.table, "billing_subscriptions");
  assert.ok(
    client.query.operations.some(
      ({ operation, args }) =>
        operation === "lte" && args[0] === "starts_at" && args[1] === "now",
    ),
  );
  assert.ok(
    client.query.operations.some(
      ({ operation, args }) =>
        operation === "gt" && args[0] === "ends_at" && args[1] === "now",
    ),
  );
});

test("SubscriptionService fails closed when subscription storage fails", async () => {
  const repository = new InMemorySubscriptionRepository([]);
  repository.fail = true;

  await assert.rejects(
    new SubscriptionService(repository).getCurrentSubscription("user-1"),
    (error) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );
});

test("EntitlementService accepts an active immutable plan snapshot", async () => {
  const repository: EntitlementRepository = {
    async findCurrentEntitlement() {
      return {
        id: "entitlement-1",
        userId: "user-1",
        featureKey: "deep_research",
        sourceType: "PLAN",
        sourceOrderId: "order-1",
        value: {
          feature_key: "deep_research",
          entitlement_version: "pro-v1",
          periodic_limit: 100,
          configuration: { model: "standard" },
        },
        validFrom: "2026-07-01T08:00:00.000Z",
        validUntil: "2026-08-01T08:00:00.000Z",
      };
    },
  };

  const entitlement = await new EntitlementService(repository)
    .requireEntitlement("user-1", "deep_research");

  assert.equal(entitlement.sourceType, "PLAN");
  assert.equal(entitlement.sourceOrderId, "order-1");
});

test("EntitlementService denies missing entitlements and fails closed for malformed plan sources", async () => {
  const missing: EntitlementRepository = {
    async findCurrentEntitlement() {
      return null;
    },
  };
  await assert.rejects(
    new EntitlementService(missing).requireEntitlement(
      "user-1",
      "deep_research",
    ),
    (error) => expectBillingError(error, "ENTITLEMENT_REQUIRED", 403),
  );

  const malformed: EntitlementRepository = {
    async findCurrentEntitlement() {
      return {
        id: "entitlement-1",
        userId: "user-1",
        featureKey: "deep_research",
        sourceType: "PLAN",
        sourceOrderId: null,
        value: {},
        validFrom: "2026-07-01T08:00:00.000Z",
        validUntil: "2026-08-01T08:00:00.000Z",
      };
    },
  };
  await assert.rejects(
    new EntitlementService(malformed).requireEntitlement(
      "user-1",
      "deep_research",
    ),
    (error) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );
});

test("Task 2 settlement remains the only membership and credit grant path", async () => {
  const sql = (
    await readFile(
      "supabase/migrations/202607210003_billing_functions.sql",
      "utf8",
    )
  ).toLowerCase();
  const start = sql.indexOf("create or replace function public.billing_settle_paid_order");
  const end = sql.indexOf("create or replace function public.billing_reserve_usage");
  const settlement = sql.slice(start, end);

  assert.match(settlement, /insert into public\.billing_subscriptions/);
  assert.match(settlement, /insert into public\.billing_user_entitlements/);
  assert.match(settlement, /update public\.billing_credit_accounts/);
  assert.match(settlement, /status', 'already_processed'/);
});
