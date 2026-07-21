import assert from "node:assert/strict";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import {
  createOrder,
  getUserOrder,
  type CreateOrderInput,
} from "../../lib/billing/orders";
import { listPublicProducts } from "../../lib/billing/products";
import type {
  BillingAdminClient,
  BillingOrder,
  BillingOrderInsert,
  BillingProduct,
  BillingRepository,
} from "../../lib/billing/repositories";
import { createBillingRepository } from "../../lib/billing/repositories";

const now = new Date("2026-07-22T02:00:00.000Z");

function product(overrides: Partial<BillingProduct> = {}): BillingProduct {
  return {
    id: "product-pro-monthly",
    planId: "plan-pro",
    sku: "PRO_MONTHLY",
    name: "Pro 月度会员",
    description: "适合持续科研工作",
    productType: "SUBSCRIPTION",
    priceMinor: 1_990,
    currency: "CNY",
    durationDays: 30,
    creditGrant: 0,
    entitlementVersion: "pro-v1",
    isActive: true,
    displayMetadata: { badge: "推荐" },
    entitlements: [
      {
        featureKey: "deep_research",
        entitlementVersion: "pro-v1",
        periodicLimit: 100,
        creditGrant: 0,
        configuration: { model: "standard" },
      },
    ],
    ...overrides,
  };
}

class InMemoryBillingRepository implements BillingRepository {
  readonly orders: BillingOrder[] = [];
  failOperation: "list" | "find-product" | "insert" | "find-order" | null =
    null;

  constructor(readonly products: BillingProduct[] = [product()]) {}

  async listActiveProducts(): Promise<BillingProduct[]> {
    if (this.failOperation === "list") {
      throw new Error("database unavailable");
    }

    return this.products;
  }

  async findActiveProduct(productId: string): Promise<BillingProduct | null> {
    if (this.failOperation === "find-product") {
      throw new Error("database unavailable");
    }

    return this.products.find((item) => item.id === productId) ?? null;
  }

  async insertOrder(input: BillingOrderInsert): Promise<BillingOrder> {
    if (this.failOperation === "insert") {
      throw new Error("database unavailable");
    }

    const createdAt = now.toISOString();
    const order: BillingOrder = {
      id: `order-id-${this.orders.length + 1}`,
      ...input,
      status: "PENDING",
      paidAt: null,
      closedAt: null,
      refundStatus: "NONE",
      createdAt,
      updatedAt: createdAt,
    };
    this.orders.push(order);
    return order;
  }

  async findUserOrder(
    userId: string,
    orderId: string,
  ): Promise<BillingOrder | null> {
    if (this.failOperation === "find-order") {
      throw new Error("database unavailable");
    }

    return (
      this.orders.find(
        (order) => order.id === orderId && order.userId === userId,
      ) ?? null
    );
  }
}

type DatabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

class InMemorySupabaseQuery {
  readonly operations: Array<{
    operation: string;
    args: unknown[];
  }> = [];

  constructor(private readonly result: DatabaseResult) {}

  select(...args: unknown[]): this {
    this.operations.push({ operation: "select", args });
    return this;
  }

  insert(...args: unknown[]): this {
    this.operations.push({ operation: "insert", args });
    return this;
  }

  eq(...args: unknown[]): this {
    this.operations.push({ operation: "eq", args });
    return this;
  }

  order(...args: unknown[]): this {
    this.operations.push({ operation: "order", args });
    return this;
  }

  maybeSingle(): this {
    this.operations.push({ operation: "maybeSingle", args: [] });
    return this;
  }

  single(): this {
    this.operations.push({ operation: "single", args: [] });
    return this;
  }

  then<TResult1 = DatabaseResult, TResult2 = never>(
    onfulfilled?: ((value: DatabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

class InMemorySupabaseClient implements BillingAdminClient {
  readonly queries: Array<{ table: string; query: InMemorySupabaseQuery }> = [];

  constructor(private readonly results: DatabaseResult[]) {}

  from(table: string): InMemorySupabaseQuery {
    const result = this.results.shift();
    assert.ok(result, `Missing database result for ${table}`);
    const query = new InMemorySupabaseQuery(result);
    this.queries.push({ table, query });
    return query;
  }
}

function databaseProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-pro-monthly",
    plan_id: "plan-pro",
    sku: "PRO_MONTHLY",
    name: "Pro 月度会员",
    description: "适合持续科研工作",
    product_type: "SUBSCRIPTION",
    price_minor: 1_990,
    currency: "CNY",
    duration_days: 30,
    credit_grant: 0,
    entitlement_version: "pro-v1",
    is_active: true,
    display_metadata: { badge: "推荐" },
    ...overrides,
  };
}

function dependencies(repository: BillingRepository) {
  return {
    repository,
    now: () => now,
  };
}

function validInput(
  overrides: Partial<CreateOrderInput> = {},
): CreateOrderInput {
  return {
    userId: "user-1",
    productId: "product-pro-monthly",
    provider: "mock",
    acceptedAgreementVersion: "membership-v1",
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

test("listPublicProducts returns only enabled sellable fields", async () => {
  const repository = new InMemoryBillingRepository([
    product(),
    product({ id: "disabled-product", sku: "DISABLED", isActive: false }),
  ]);

  const products = await listPublicProducts(repository);

  assert.equal(products.length, 1);
  assert.deepEqual(Object.keys(products[0]).sort(), [
    "creditGrant",
    "currency",
    "description",
    "displayMetadata",
    "durationDays",
    "id",
    "name",
    "priceMinor",
    "productType",
    "sku",
  ]);
  assert.equal(products[0].id, "product-pro-monthly");
  assert.equal(products[0].priceMinor, 1_990);
  assert.equal("entitlementVersion" in products[0], false);
  assert.equal("entitlements" in products[0], false);
});

test("createOrder prices and snapshots the order from the enabled database product", async () => {
  const repository = new InMemoryBillingRepository();

  const order = await createOrder(validInput(), dependencies(repository));

  assert.equal(order.userId, "user-1");
  assert.equal(order.productId, "product-pro-monthly");
  assert.equal(order.provider, "MOCK");
  assert.equal(order.amountMinor, 1_990);
  assert.equal(order.currency, "CNY");
  assert.equal(order.snapshotProductName, "Pro 月度会员");
  assert.equal(order.snapshotProductType, "SUBSCRIPTION");
  assert.equal(order.snapshotPlanId, "plan-pro");
  assert.equal(order.snapshotDurationDays, 30);
  assert.equal(order.snapshotCreditGrant, 0);
  assert.equal(order.snapshotEntitlementVersion, "pro-v1");
  assert.deepEqual(order.snapshotEntitlements, [
    {
      feature_key: "deep_research",
      entitlement_version: "pro-v1",
      periodic_limit: 100,
      credit_grant: 0,
      configuration: { model: "standard" },
    },
  ]);
  assert.deepEqual(order.snapshotDetails, {
    sku: "PRO_MONTHLY",
    displayMetadata: { badge: "推荐" },
  });
  assert.equal(order.acceptedAgreementVersion, "membership-v1");
  assert.equal(order.status, "PENDING");
});

test("createOrder trims entitlement feature keys before persisting the snapshot", async () => {
  const repository = new InMemoryBillingRepository([
    product({
      entitlements: [
        {
          ...product().entitlements[0],
          featureKey: "  deep_research  ",
        },
      ],
    }),
  ]);

  const order = await createOrder(validInput(), dependencies(repository));

  assert.equal(order.snapshotEntitlements[0].feature_key, "deep_research");
});

test("createOrder fails closed before insertion for a blank entitlement feature key", async () => {
  const repository = new InMemoryBillingRepository([
    product({
      entitlements: [
        {
          ...product().entitlements[0],
          featureKey: " \t ",
        },
      ],
    }),
  ]);

  await assert.rejects(
    () => createOrder(validInput(), dependencies(repository)),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );
  assert.equal(repository.orders.length, 0);
});

test("client supplied amount and currency cannot affect order pricing", async () => {
  const repository = new InMemoryBillingRepository();
  const forgedInput = {
    ...validInput(),
    amount: 1,
    amountMinor: 1,
    currency: "USD",
  } as CreateOrderInput & {
    amount: number;
    amountMinor: number;
    currency: string;
  };

  const order = await createOrder(forgedInput, dependencies(repository));

  assert.equal(order.amountMinor, 1_990);
  assert.equal(order.currency, "CNY");
});

test("createOrder rejects a missing or blank agreement version", async () => {
  const repository = new InMemoryBillingRepository();

  await assert.rejects(
    () =>
      createOrder(
        validInput({ acceptedAgreementVersion: "  " }),
        dependencies(repository),
      ),
    (error: unknown) => expectBillingError(error, "AGREEMENT_REQUIRED", 400),
  );
  await assert.rejects(
    () =>
      createOrder(
        {
          userId: "user-1",
          productId: "product-pro-monthly",
          provider: "mock",
        } as CreateOrderInput,
        dependencies(repository),
      ),
    (error: unknown) => expectBillingError(error, "AGREEMENT_REQUIRED", 400),
  );
  assert.equal(repository.orders.length, 0);
});

test("createOrder rejects inactive products and unknown providers", async () => {
  const repository = new InMemoryBillingRepository([
    product({ isActive: false }),
  ]);

  await assert.rejects(
    () => createOrder(validInput(), dependencies(repository)),
    (error: unknown) => expectBillingError(error, "PRODUCT_NOT_AVAILABLE", 404),
  );
  await assert.rejects(
    () =>
      createOrder(
        validInput({ provider: "paypal" as CreateOrderInput["provider"] }),
        dependencies(repository),
      ),
    (error: unknown) => expectBillingError(error, "INVALID_PROVIDER", 400),
  );
  assert.equal(repository.orders.length, 0);
});

test("createOrder rejects providers that differ from the server payment mode", async () => {
  for (const [provider, paymentMode] of [
    ["wechat", "mock"],
    ["alipay", "mock"],
    ["mock", "wechat"],
  ] as const) {
    const repository = new InMemoryBillingRepository();

    await assert.rejects(
      () =>
        createOrder(validInput({ provider }), {
          ...dependencies(repository),
          paymentMode,
        }),
      (error: unknown) =>
        expectBillingError(error, "PAYMENT_PROVIDER_MISMATCH", 400),
    );
    assert.equal(repository.orders.length, 0);
  }
});

test("createOrder expires pending orders after thirty minutes", async () => {
  const repository = new InMemoryBillingRepository();

  const order = await createOrder(validInput(), dependencies(repository));

  assert.equal(order.expiresAt, "2026-07-22T02:30:00.000Z");
});

test("createOrder generates a unique order number for each order", async () => {
  const repository = new InMemoryBillingRepository();

  const first = await createOrder(validInput(), dependencies(repository));
  const second = await createOrder(validInput(), dependencies(repository));

  assert.match(first.orderNumber, /^BILL-[A-F0-9]{32}$/);
  assert.match(second.orderNumber, /^BILL-[A-F0-9]{32}$/);
  assert.notEqual(first.orderNumber, second.orderNumber);
});

test("getUserOrder rejects access to another user's order without leaking it", async () => {
  const repository = new InMemoryBillingRepository();
  const order = await createOrder(validInput(), dependencies(repository));

  await assert.rejects(
    () => getUserOrder("user-2", order.id, repository),
    (error: unknown) => expectBillingError(error, "ORDER_NOT_FOUND", 404),
  );
  assert.equal(await getUserOrder("user-1", order.id, repository), order);
});

test("billing repository failures are fail-closed", async () => {
  const repository = new InMemoryBillingRepository();
  repository.failOperation = "find-product";

  await assert.rejects(
    () => createOrder(validInput(), dependencies(repository)),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );

  repository.failOperation = "list";
  await assert.rejects(
    () => listPublicProducts(repository),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );
});

test("the Supabase repository injects the admin client and reads only active products", async () => {
  const client = new InMemorySupabaseClient([
    { data: [databaseProduct()], error: null },
  ]);
  const repository = createBillingRepository(client);

  const products = await repository.listActiveProducts();

  assert.equal(products[0].priceMinor, 1_990);
  assert.equal(products[0].entitlements.length, 0);
  assert.equal(client.queries[0].table, "billing_products");
  assert.ok(
    client.queries[0].query.operations.some(
      ({ operation, args }) =>
        operation === "eq" && args[0] === "is_active" && args[1] === true,
    ),
  );
});

test("the Supabase repository reads the matching entitlement version for an order snapshot", async () => {
  const client = new InMemorySupabaseClient([
    { data: databaseProduct(), error: null },
    {
      data: [
        {
          feature_key: "  deep_research  ",
          entitlement_version: "pro-v1",
          periodic_limit: 100,
          credit_grant: 0,
          configuration: { model: "standard" },
        },
      ],
      error: null,
    },
  ]);
  const repository = createBillingRepository(client);

  const found = await repository.findActiveProduct("product-pro-monthly");

  assert.equal(found?.entitlements[0].featureKey, "deep_research");
  assert.equal(client.queries[1].table, "billing_plan_entitlements");
  assert.deepEqual(
    client.queries[1].query.operations
      .filter(({ operation }) => operation === "eq")
      .map(({ args }) => args),
    [
      ["plan_id", "plan-pro"],
      ["entitlement_version", "pro-v1"],
    ],
  );
});

test("the Supabase repository fails closed on a blank entitlement feature key", async () => {
  const client = new InMemorySupabaseClient([
    { data: databaseProduct(), error: null },
    {
      data: [
        {
          feature_key: " \t ",
          entitlement_version: "pro-v1",
          periodic_limit: 100,
          credit_grant: 0,
          configuration: { model: "standard" },
        },
      ],
      error: null,
    },
  ]);
  const repository = createBillingRepository(client);

  await assert.rejects(
    () => repository.findActiveProduct("product-pro-monthly"),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );
});

test("the Supabase repository maps immutable order snapshots to database columns", async () => {
  const input: BillingOrderInsert = {
    orderNumber: "BILL-00000000000000000000000000000001",
    userId: "user-1",
    productId: "product-pro-monthly",
    provider: "MOCK",
    amountMinor: 1_990,
    currency: "CNY",
    snapshotProductName: "Pro 月度会员",
    snapshotProductType: "SUBSCRIPTION",
    snapshotPlanId: "plan-pro",
    snapshotDurationDays: 30,
    snapshotCreditGrant: 0,
    snapshotEntitlementVersion: "pro-v1",
    snapshotEntitlements: [
      {
        feature_key: "deep_research",
        entitlement_version: "pro-v1",
        periodic_limit: 100,
        credit_grant: 0,
        configuration: { model: "standard" },
      },
    ],
    snapshotDetails: { sku: "PRO_MONTHLY" },
    acceptedAgreementVersion: "membership-v1",
    expiresAt: "2026-07-22T02:30:00.000Z",
  };
  const row = {
    id: "order-id-1",
    order_number: input.orderNumber,
    user_id: input.userId,
    product_id: input.productId,
    provider: input.provider,
    status: "PENDING",
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
    paid_at: null,
    closed_at: null,
    refund_status: "NONE",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const client = new InMemorySupabaseClient([{ data: row, error: null }]);
  const repository = createBillingRepository(client);

  const order = await repository.insertOrder(input);

  assert.deepEqual(order.snapshotEntitlements, input.snapshotEntitlements);
  const insert = client.queries[0].query.operations.find(
    ({ operation }) => operation === "insert",
  );
  assert.deepEqual(insert?.args[0], {
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
  });
});

test("the Supabase repository fails closed on database errors", async () => {
  const client = new InMemorySupabaseClient([
    { data: null, error: { message: "connection failed secret=value" } },
  ]);
  const repository = createBillingRepository(client);

  await assert.rejects(
    () => repository.listActiveProducts(),
    (error: unknown) =>
      error instanceof BillingError &&
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503) &&
      !error.message.includes("secret=value"),
  );

  const throwingRepository = createBillingRepository({
    from() {
      throw new Error("network failed password=secret");
    },
  });
  await assert.rejects(
    () => throwingRepository.listActiveProducts(),
    (error: unknown) =>
      error instanceof BillingError &&
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503) &&
      !error.message.includes("password=secret"),
  );
});
