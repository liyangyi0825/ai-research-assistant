import assert from "node:assert/strict";
import test from "node:test";

import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import { createBillingSecurityLogger } from "../../lib/billing/security-logger";
import { MockPaymentProvider } from "../../lib/billing/payments/mock";
import type { PaymentProvider } from "../../lib/billing/payments/provider";
import type {
  CreatePaymentInput,
  PaymentReferenceInput,
  PaymentResult,
} from "../../lib/billing/payments/types";
import {
  createPaymentServiceRepository,
  createOrderPayment,
  paymentRequestIdempotencyKey,
  type CompletePaymentIntentInput,
  type PaymentOrderSnapshot,
  type PaymentServiceAdminClient,
  type PaymentServiceRepository,
} from "../../lib/billing/payments/service";

const now = new Date("2026-07-22T03:00:00.000Z");
const config: BillingConfig = {
  featureEnabled: true,
  paymentMode: "mock",
  testUserIds: ["user-1"],
  realPaymentPublicEnabled: false,
  legal: { operatorName: "", operatorCreditCode: "", contactEmail: "" },
  wechatConfigured: false,
  alipayConfigured: false,
  isProduction: false,
};

function order(
  overrides: Partial<PaymentOrderSnapshot> = {},
): PaymentOrderSnapshot {
  return {
    id: "order-id-1",
    userId: "user-1",
    orderNumber: "BILL-00000000000000000000000000000001",
    provider: "MOCK",
    status: "PENDING",
    amountMinor: 1_990,
    currency: "CNY",
    expiresAt: "2026-07-22T03:30:00.000Z",
    snapshotProductName: "Pro Semester",
    ...overrides,
  };
}

class MemoryPaymentRepository implements PaymentServiceRepository {
  failWith: Error | null = null;
  completeFailWith: Error | null = null;
  claimState: "EMPTY" | "CREATING" | "CREATED" | "FAILED" = "EMPTY";
  claimCalls = 0;
  completeCalls = 0;
  failCalls: string[] = [];
  intentPayment: PaymentResult | null = null;

  constructor(readonly storedOrder: PaymentOrderSnapshot | null = order()) {}

  async findOwnedOrder(userId: string, orderId: string) {
    if (this.failWith) throw this.failWith;
    return this.storedOrder?.userId === userId && this.storedOrder.id === orderId
      ? { ...this.storedOrder }
      : null;
  }

  async claimPaymentIntent(input: {
    merchantOrderNumber: string;
    requestIdempotencyKey: string;
  }) {
    this.claimCalls += 1;
    if (this.claimState === "CREATED" && this.intentPayment) {
      return { status: "REUSE" as const, payment: { ...this.intentPayment } };
    }
    if (this.claimState === "CREATING") {
      return { status: "IN_PROGRESS" as const };
    }
    this.claimState = "CREATING";
    return {
      status: "CLAIMED" as const,
      intentId: "intent-1",
      merchantOrderNumber: input.merchantOrderNumber,
      requestIdempotencyKey: input.requestIdempotencyKey,
    };
  }

  async completePaymentIntent(input: CompletePaymentIntentInput) {
    this.completeCalls += 1;
    if (this.completeFailWith) throw this.completeFailWith;
    this.intentPayment = {
      orderNumber: input.payment.orderNumber,
      providerTransactionId: input.payment.providerTransactionId,
      status: input.payment.status,
      amountMinor: input.payment.amountMinor,
      currency: input.payment.currency,
      paymentToken: input.payment.paymentToken,
      expiresAt: input.payment.expiresAt,
      paidAt: input.payment.paidAt,
    };
    this.claimState = "CREATED";
    return { ...this.intentPayment };
  }

  async failPaymentIntent(_intentId: string, _claimToken: string, errorCode: string) {
    this.failCalls.push(errorCode);
    this.claimState = "FAILED";
  }

  async claimMockPaymentConfirmation() {
    if (!this.intentPayment) throw new Error("missing payment intent");
    return { ...this.intentPayment, status: "PAID" as const, paidAt: now.toISOString() };
  }
}

function dependencies(
  repository: PaymentServiceRepository,
  provider = new MockPaymentProvider({
    secret: "payment-service-test-secret",
    now: () => now,
  }),
  billingConfig: BillingConfig = config,
) {
  return {
    repository,
    now: () => now,
    getConfig: () => billingConfig,
    getProvider: () => provider,
  };
}

function expectBillingError(error: unknown, code: string, status: number) {
  return (
    error instanceof BillingError && error.code === code && error.status === status
  );
}

function paymentOrderRow(snapshotProductName: string) {
  return {
    id: "order-id-1",
    user_id: "user-1",
    order_number: "BILL-00000000000000000000000000000001",
    provider: "MOCK",
    status: "PENDING",
    amount_minor: 1_990,
    currency: "CNY",
    expires_at: "2026-07-22T03:30:00.000Z",
    snapshot_product_name: snapshotProductName,
  };
}

test("payment repository selects and maps the immutable product snapshot name", async () => {
  let selectedColumns = "";
  const row = paymentOrderRow("Repository Semester");
  const query = {
    select(columns: string) {
      selectedColumns = columns;
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle() {
      return this;
    },
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      const data = selectedColumns.includes("snapshot_product_name")
        ? row
        : { ...row, snapshot_product_name: undefined };
      return Promise.resolve({ data, error: null }).then(
        onfulfilled,
        onrejected,
      );
    },
  };
  const client = {
    from(table: string) {
      assert.equal(table, "billing_orders");
      return query;
    },
    async rpc() {
      throw new Error("not used");
    },
  } as unknown as PaymentServiceAdminClient;

  const mapped = await createPaymentServiceRepository(client).findOwnedOrder(
    "user-1",
    "order-id-1",
  );

  assert.match(selectedColumns, /snapshot_product_name/);
  assert.equal(mapped?.snapshotProductName, "Repository Semester");
});

async function capturedDescription(snapshotProductName: string): Promise<string> {
  const repository = new MemoryPaymentRepository(order({ snapshotProductName }));
  const provider = new MockPaymentProvider({
    secret: "description-boundary-test-secret",
    now: () => now,
  });
  let description = "";
  const createPayment = provider.createPayment.bind(provider);
  provider.createPayment = async (input) => {
    description = input.description;
    return createPayment(input);
  };

  await createOrderPayment(
    "user-1",
    "order-id-1",
    dependencies(repository, provider),
  );
  return description;
}

test("createOrderPayment normalizes the server snapshot description to NFC", async () => {
  assert.equal(await capturedDescription("Cafe\u0301"), "Café");
});

test("createOrderPayment accepts one and 127 Unicode code point descriptions", async () => {
  assert.equal(await capturedDescription("界"), "界");
  assert.equal(await capturedDescription("界".repeat(127)), "界".repeat(127));
});

test("createOrderPayment rejects blank and 128 code point snapshot descriptions", async () => {
  for (const snapshotProductName of ["   ", "界".repeat(128)]) {
    const repository = new MemoryPaymentRepository(order({ snapshotProductName }));
    let providerCalled = false;
    const provider = new MockPaymentProvider({
      secret: "invalid-description-test-secret",
      now: () => now,
    });
    provider.createPayment = async () => {
      providerCalled = true;
      throw new Error("must not run");
    };

    await assert.rejects(
      () =>
        createOrderPayment(
          "user-1",
          "order-id-1",
          dependencies(repository, provider),
        ),
      (error: unknown) =>
        expectBillingError(error, "PAYMENT_PROVIDER_UNAVAILABLE", 503),
    );
    assert.equal(providerCalled, false);
  }
});

test("createOrderPayment prices a pending payment only from the owned database snapshot", async () => {
  const repository = new MemoryPaymentRepository();
  const provider = new MockPaymentProvider({
    secret: "payment-service-test-secret",
    now: () => now,
  });
  let providerCreateCalls = 0;
  let providerDescription: string | undefined;
  const createPayment = provider.createPayment.bind(provider);
  provider.createPayment = async (input) => {
    providerCreateCalls += 1;
    providerDescription = input.description;
    return createPayment(input);
  };

  const payment = await createOrderPayment(
    "user-1",
    "order-id-1",
    dependencies(repository, provider),
  );

  assert.equal(payment.status, "PENDING");
  assert.equal(payment.orderNumber, order().orderNumber);
  assert.equal(payment.amountMinor, 1_990);
  assert.equal(payment.currency, "CNY");
  assert.equal(payment.expiresAt, order().expiresAt);
  assert.equal(providerDescription, "Pro Semester");
  assert.equal(
    paymentRequestIdempotencyKey("MOCK", order().orderNumber),
    `billing-payment:MOCK:${order().orderNumber}`,
  );

  const repeated = await createOrderPayment(
    "user-1",
    "order-id-1",
    dependencies(repository, provider),
  );
  assert.deepEqual(repeated, payment);
  assert.equal(repository.claimCalls, 2);
  assert.equal(repository.completeCalls, 1);
  assert.equal(providerCreateCalls, 1);
});

test("createOrderPayment reuses a persisted result across provider instances", async () => {
  const repository = new MemoryPaymentRepository();
  const first = await createOrderPayment(
    "user-1",
    "order-id-1",
    dependencies(
      repository,
      new MockPaymentProvider({ secret: "first-instance", now: () => now }),
    ),
  );
  const replacement = new MockPaymentProvider({
    secret: "replacement-instance",
    now: () => now,
  });
  let replacementCalls = 0;
  const replacementCreate = replacement.createPayment.bind(replacement);
  replacement.createPayment = async (input) => {
    replacementCalls += 1;
    return replacementCreate(input);
  };

  const repeated = await createOrderPayment(
    "user-1",
    "order-id-1",
    dependencies(repository, replacement),
  );

  assert.deepEqual(repeated, first);
  assert.equal(replacementCalls, 0);
});

test("createOrderPayment treats equivalent database and provider expiration offsets as one instant", async () => {
  const repository = new MemoryPaymentRepository(
    order({ expiresAt: "2026-07-22T03:30:00+00:00" }),
  );
  const payment = await createOrderPayment(
    "user-1",
    "order-id-1",
    dependencies(repository),
  );

  assert.equal(payment.expiresAt, "2026-07-22T03:30:00.000Z");
  assert.equal(repository.completeCalls, 1);
  assert.deepEqual(repository.failCalls, []);
});

test("createOrderPayment allows only the database claim holder to call the provider", async () => {
  const repository = new MemoryPaymentRepository();
  let releaseProvider!: () => void;
  let providerEntered!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const providerStarted = new Promise<void>((resolve) => {
    providerEntered = resolve;
  });
  const provider = new MockPaymentProvider({
    secret: "concurrent-instance",
    now: () => now,
  });
  let providerCreateCalls = 0;
  const createPayment = provider.createPayment.bind(provider);
  provider.createPayment = async (input) => {
    providerCreateCalls += 1;
    providerEntered();
    await providerGate;
    return createPayment(input);
  };

  const first = createOrderPayment(
    "user-1",
    "order-id-1",
    dependencies(repository, provider),
  );
  await providerStarted;
  const second = createOrderPayment(
    "user-1",
    "order-id-1",
    dependencies(repository, provider),
  );
  releaseProvider();
  await assert.rejects(
    second,
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_CREATION_IN_PROGRESS", 409),
  );
  await first;

  assert.equal(providerCreateCalls, 1);
});

test("createOrderPayment safely releases a failed claim without persisting provider details", async () => {
  const repository = new MemoryPaymentRepository();
  const logs: string[] = [];
  const provider = new MockPaymentProvider({
    secret: "provider-secret-do-not-leak",
    now: () => now,
  });
  provider.createPayment = async () => {
    throw new Error("provider token=do-not-leak");
  };

  await assert.rejects(
    () =>
      createOrderPayment(
        "user-1",
        "order-id-1",
        {
          ...dependencies(repository, provider),
          logger: createBillingSecurityLogger((line) => logs.push(line)),
        },
      ),
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_PROVIDER_UNAVAILABLE", 503) &&
      error instanceof BillingError &&
      !error.message.includes("do-not-leak"),
  );
  assert.deepEqual(repository.failCalls, ["PROVIDER_CREATE_FAILED"]);
  assert.equal(repository.intentPayment, null);
  assert.equal(logs.length, 1);
  assert.deepEqual(
    JSON.parse(logs[0].slice("billing_security_event ".length)),
    {
      eventCode: "PAYMENT_CREATE_FAILED",
      provider: "MOCK",
      orderNumber: order().orderNumber,
      errorCode: "PROVIDER_CREATE_FAILED",
      status: "FAILED",
    },
  );
  assert.equal(logs[0].includes("provider-secret-do-not-leak"), false);
});

test("createOrderPayment logs one safe event when payment-intent persistence fails", async () => {
  const repository = new MemoryPaymentRepository();
  const logs: string[] = [];
  repository.completeFailWith = new Error("database password=do-not-log");

  await assert.rejects(
    () =>
      createOrderPayment("user-1", "order-id-1", {
        ...dependencies(repository),
        logger: createBillingSecurityLogger((line) => logs.push(line)),
      }),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );

  assert.equal(repository.completeCalls, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(
    JSON.parse(logs[0].slice("billing_security_event ".length)),
    {
      eventCode: "PAYMENT_INTENT_PERSIST_FAILED",
      provider: "MOCK",
      orderNumber: order().orderNumber,
      errorCode: "PAYMENT_INTENT_PERSIST_FAILED",
      status: "FAILED",
    },
  );
  assert.equal(logs[0].includes("database password=do-not-log"), false);
});

test("createOrderPayment preserves safe failures when the security log sink throws", async () => {
  const providerRepository = new MemoryPaymentRepository();
  const provider = new MockPaymentProvider({
    secret: "provider-secret-do-not-leak",
    now: () => now,
  });
  provider.createPayment = async () => {
    throw new Error("provider token=do-not-leak");
  };
  const throwingLogger = createBillingSecurityLogger(() => {
    throw new Error("log sink unavailable");
  });

  await assert.rejects(
    () =>
      createOrderPayment("user-1", "order-id-1", {
        ...dependencies(providerRepository, provider),
        logger: throwingLogger,
      }),
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_PROVIDER_UNAVAILABLE", 503),
  );
  assert.deepEqual(providerRepository.failCalls, ["PROVIDER_CREATE_FAILED"]);

  const persistenceRepository = new MemoryPaymentRepository();
  persistenceRepository.completeFailWith = new Error("database password=do-not-log");
  await assert.rejects(
    () =>
      createOrderPayment("user-1", "order-id-1", {
        ...dependencies(persistenceRepository),
        logger: throwingLogger,
      }),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );
  assert.equal(persistenceRepository.completeCalls, 1);
});

test("createOrderPayment does not reveal whether another user's order exists", async () => {
  const repository = new MemoryPaymentRepository();

  await assert.rejects(
    () =>
      createOrderPayment(
        "attacker-user",
        "order-id-1",
        dependencies(repository),
      ),
    (error: unknown) => expectBillingError(error, "ORDER_NOT_FOUND", 404),
  );
});

test("createOrderPayment rejects paid, closed, cancelled, refunded, and failed orders", async () => {
  for (const status of [
    "PAID",
    "CLOSED",
    "CANCELLED",
    "REFUNDING",
    "REFUNDED",
    "FAILED",
  ] as const) {
    const repository = new MemoryPaymentRepository(order({ status }));
    await assert.rejects(
      () => createOrderPayment("user-1", "order-id-1", dependencies(repository)),
      (error: unknown) =>
        expectBillingError(
          error,
          status === "PAID" ? "ORDER_ALREADY_PAID" : "ORDER_NOT_PAYABLE",
          409,
        ),
    );
  }
});

test("createOrderPayment rejects an order whose database expiration has passed", async () => {
  const repository = new MemoryPaymentRepository(
    order({ expiresAt: now.toISOString() }),
  );

  await assert.rejects(
    () => createOrderPayment("user-1", "order-id-1", dependencies(repository)),
    (error: unknown) => expectBillingError(error, "ORDER_EXPIRED", 409),
  );
});

test("createOrderPayment uses only the server payment mode", async () => {
  const repository = new MemoryPaymentRepository();

  await assert.rejects(
    () =>
      createOrderPayment(
        "user-1",
        "order-id-1",
        dependencies(repository, undefined, {
          ...config,
          paymentMode: "alipay",
          alipayConfigured: true,
        }),
      ),
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_PROVIDER_MISMATCH", 400),
  );
});

test("createOrderPayment enforces the server feature flag and production Mock allowlist", async () => {
  const repository = new MemoryPaymentRepository();

  await assert.rejects(
    () =>
      createOrderPayment(
        "user-1",
        "order-id-1",
        dependencies(repository, undefined, {
          ...config,
          featureEnabled: false,
        }),
      ),
    (error: unknown) =>
      expectBillingError(error, "BILLING_FEATURE_DISABLED", 403),
  );

  const productionConfig = {
    ...config,
    isProduction: true,
    testUserIds: [],
  };
  await assert.rejects(
    () =>
      createOrderPayment(
        "user-1",
        "order-id-1",
        dependencies(repository, undefined, productionConfig),
      ),
    (error: unknown) =>
      expectBillingError(error, "MOCK_PAYMENT_NOT_ALLOWED", 403),
  );

  const payment = await createOrderPayment("user-1", "order-id-1", {
    ...dependencies(repository, undefined, productionConfig),
    isAdmin: true,
  });
  assert.equal(payment.status, "PENDING");
});

test("createOrderPayment fails closed without leaking database errors", async () => {
  const repository = new MemoryPaymentRepository();
  repository.failWith = new Error("database password=do-not-log");

  await assert.rejects(
    () => createOrderPayment("user-1", "order-id-1", dependencies(repository)),
    (error: unknown) =>
      error instanceof BillingError &&
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503) &&
      !error.message.includes("do-not-log"),
  );
});

test("payment repository durably carries the merchant reference and nullable verified fields", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    from() {
      throw new Error("not used");
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "billing_claim_payment_intent") {
        return {
          data: {
            status: "CLAIMED",
            intent_id: "intent-1",
            merchant_order_number: "WX-MERCHANT-ATTEMPT-1",
            request_idempotency_key: "billing-payment:WECHAT:WX-MERCHANT-ATTEMPT-1",
          },
          error: null,
        };
      }
      if (name === "billing_bind_verified_payment_query") {
        return {
          data: {
            merchant_order_number: args.p_merchant_order_number,
            provider_transaction_id: args.p_provider_transaction_id,
            payment_status: args.p_payment_status,
            amount_minor: args.p_amount_minor,
            currency: args.p_currency,
            payment_token: null,
            expires_at: args.p_expires_at,
            paid_at: args.p_paid_at,
          },
          error: null,
        };
      }
      return {
        data: {
          merchant_order_number: "WX-MERCHANT-ATTEMPT-1",
          provider_transaction_id: null,
          payment_status: "PENDING",
          amount_minor: 7_900,
          currency: "CNY",
          payment_token: "weixin://verified-test-token",
          expires_at: "2026-08-19T02:30:00.000Z",
          paid_at: null,
        },
        error: null,
      };
    },
  } as unknown as PaymentServiceAdminClient;
  const repository = createPaymentServiceRepository(client);

  const claim = await repository.claimPaymentIntent({
    userId: "user-1",
    orderId: "order-id-1",
    provider: "WECHAT",
    merchantOrderNumber: "WX-MERCHANT-ATTEMPT-1",
    requestIdempotencyKey: "billing-payment:WECHAT:WX-MERCHANT-ATTEMPT-1",
    claimToken: "00000000-0000-4000-8000-000000000001",
  } as never);
  assert.deepEqual(claim, {
    status: "CLAIMED",
    intentId: "intent-1",
    merchantOrderNumber: "WX-MERCHANT-ATTEMPT-1",
    requestIdempotencyKey: "billing-payment:WECHAT:WX-MERCHANT-ATTEMPT-1",
  });

  const pending: PaymentResult = {
    orderNumber: "WX-MERCHANT-ATTEMPT-1",
    providerTransactionId: null,
    status: "PENDING",
    amountMinor: 7_900,
    currency: "CNY",
    paymentToken: "weixin://verified-test-token",
    expiresAt: "2026-08-19T02:30:00.000Z",
    paidAt: null,
  } as PaymentResult;
  assert.deepEqual(
    await repository.completePaymentIntent({
      intentId: "intent-1",
      claimToken: "00000000-0000-4000-8000-000000000001",
      payment: pending,
    }),
    pending,
  );
  const paid: PaymentResult = {
    ...pending,
    providerTransactionId: "4200000000099",
    status: "PAID",
    paymentToken: null,
    paidAt: "2026-08-19T02:00:00.000Z",
  };
  assert.deepEqual(
    await repository.bindVerifiedPaymentQuery({
      userId: "user-1",
      orderId: "order-id-1",
      provider: "WECHAT",
      payment: paid,
    }),
    paid,
  );
  assert.deepEqual(calls, [
    {
      name: "billing_claim_payment_intent",
      args: {
        p_user_id: "user-1",
        p_order_id: "order-id-1",
        p_provider: "WECHAT",
        p_merchant_order_number: "WX-MERCHANT-ATTEMPT-1",
        p_request_idempotency_key: "billing-payment:WECHAT:WX-MERCHANT-ATTEMPT-1",
        p_claim_token: "00000000-0000-4000-8000-000000000001",
      },
    },
    {
      name: "billing_complete_payment_intent",
      args: {
        p_intent_id: "intent-1",
        p_claim_token: "00000000-0000-4000-8000-000000000001",
        p_merchant_order_number: "WX-MERCHANT-ATTEMPT-1",
        p_provider_transaction_id: null,
        p_payment_token: "weixin://verified-test-token",
        p_payment_status: "PENDING",
        p_expires_at: "2026-08-19T02:30:00.000Z",
        p_paid_at: null,
      },
    },
    {
      name: "billing_bind_verified_payment_query",
      args: {
        p_user_id: "user-1",
        p_order_id: "order-id-1",
        p_provider: "WECHAT",
        p_merchant_order_number: "WX-MERCHANT-ATTEMPT-1",
        p_provider_transaction_id: "4200000000099",
        p_payment_status: "PAID",
        p_amount_minor: 7_900,
        p_currency: "CNY",
        p_expires_at: "2026-08-19T02:30:00.000Z",
        p_paid_at: "2026-08-19T02:00:00.000Z",
      },
    },
  ]);
});

test("createOrderPayment persists a WeChat pending intent without fabricating a transaction ID", async () => {
  const storedOrder = order({
    provider: "WECHAT",
    amountMinor: 7_900,
    expiresAt: "2026-08-19T02:30:00.000Z",
  });
  let providerInputOrder = "";
  let completed: PaymentResult | null = null;
  const repository = {
    async findOwnedOrder() { return storedOrder; },
    async claimPaymentIntent() {
      return {
        status: "CLAIMED" as const,
        intentId: "intent-1",
        merchantOrderNumber: "WX-MERCHANT-ATTEMPT-1",
        requestIdempotencyKey: "billing-payment:WECHAT:WX-MERCHANT-ATTEMPT-1",
      };
    },
    async completePaymentIntent(input: { payment: PaymentResult }) {
      completed = input.payment;
      return input.payment;
    },
    async failPaymentIntent() { throw new Error("must not fail"); },
    async claimMockPaymentConfirmation() { throw new Error("not used"); },
  } as unknown as PaymentServiceRepository;
  const provider = {
    async createPayment(input: CreatePaymentInput) {
      providerInputOrder = input.orderNumber;
      return {
        providerTransactionId: null,
        orderNumber: input.orderNumber,
        status: "PENDING",
        amountMinor: input.amountMinor,
        currency: input.currency,
        paymentToken: "weixin://verified-test-token",
        expiresAt: input.expiresAt,
        paidAt: null,
      };
    },
  } as unknown as PaymentProvider;

  const payment = await createOrderPayment("user-1", "order-id-1", {
    repository,
    now: () => now,
    getConfig: () => ({
      ...config,
      paymentMode: "wechat",
      wechatConfigured: true,
    }),
    getProvider: () => provider,
    createMerchantOrderNumber: () => "WX-MERCHANT-ATTEMPT-1",
  } as never);

  assert.equal(providerInputOrder, "WX-MERCHANT-ATTEMPT-1");
  assert.equal(payment.providerTransactionId, null);
  assert.equal(payment.orderNumber, "WX-MERCHANT-ATTEMPT-1");
  assert.deepEqual(completed, payment);
});

test("createOrderPayment default WeChat merchant number satisfies the official 6-32 character contract", async () => {
  const storedOrder = order({
    provider: "WECHAT",
    amountMinor: 7_900,
    expiresAt: "2026-08-19T02:30:00.000Z",
  });
  let claimedMerchantOrderNumber = "";
  const repository = {
    async findOwnedOrder() { return storedOrder; },
    async claimPaymentIntent(input: { merchantOrderNumber: string; requestIdempotencyKey: string }) {
      claimedMerchantOrderNumber = input.merchantOrderNumber;
      return {
        status: "CLAIMED" as const,
        intentId: "intent-default-number",
        merchantOrderNumber: input.merchantOrderNumber,
        requestIdempotencyKey: input.requestIdempotencyKey,
      };
    },
    async completePaymentIntent(input: { payment: PaymentResult }) { return input.payment; },
    async failPaymentIntent() { throw new Error("must not fail"); },
    async claimMockPaymentConfirmation() { throw new Error("not used"); },
  } as unknown as PaymentServiceRepository;
  const provider = {
    async createPayment(input: CreatePaymentInput): Promise<PaymentResult> {
      return {
        providerTransactionId: null,
        orderNumber: input.orderNumber,
        status: "PENDING",
        amountMinor: input.amountMinor,
        currency: input.currency,
        paymentToken: "weixin://wxpay/bizpayurl?pr=default-number",
        expiresAt: input.expiresAt,
        paidAt: null,
      };
    },
  } as unknown as PaymentProvider;

  await createOrderPayment("user-1", "order-id-1", {
    repository,
    now: () => now,
    getConfig: () => ({
      ...config,
      paymentMode: "wechat",
      wechatConfigured: true,
    }),
    getProvider: () => provider,
  });

  assert.match(claimedMerchantOrderNumber, /^[0-9A-Za-z_\-|*]{6,32}$/);
  assert.equal(claimedMerchantOrderNumber.startsWith("WX"), true);
});

test("createOrderPayment retires a verified closed uncertain attempt and explicitly requests a new payment", async () => {
  const storedOrder = order({
    provider: "WECHAT",
    amountMinor: 7_900,
    expiresAt: "2026-08-19T02:30:00.000Z",
  });
  const failures: string[] = [];
  let closeCalls = 0;
  const repository = {
    async findOwnedOrder() { return storedOrder; },
    async claimPaymentIntent() {
      return {
        status: "CLAIMED" as const,
        intentId: "intent-1",
        merchantOrderNumber: "WX-MERCHANT-ATTEMPT-1",
        requestIdempotencyKey: "billing-payment:WECHAT:WX-MERCHANT-ATTEMPT-1",
      };
    },
    async completePaymentIntent() { throw new Error("must not persist payable state"); },
    async failPaymentIntent(_intentId: string, _claimToken: string, code: string) {
      failures.push(code);
    },
    async claimMockPaymentConfirmation() { throw new Error("not used"); },
  } as unknown as PaymentServiceRepository;
  const requiresNewPayment = {
    providerTransactionId: "4200000000001",
    orderNumber: "WX-MERCHANT-ATTEMPT-1",
    status: "REQUIRES_NEW_PAYMENT",
    amountMinor: 7_900,
    currency: "CNY",
    paymentToken: null,
    expiresAt: "2026-08-19T02:30:00.000Z",
    paidAt: null,
  } as PaymentResult;
  const provider = {
    async createPayment() { return requiresNewPayment; },
    async closePayment(input: PaymentReferenceInput) {
      closeCalls += 1;
      assert.equal(input.paymentToken, null);
      return { ...requiresNewPayment, status: "CLOSED" } as PaymentResult;
    },
  } as unknown as PaymentProvider;

  await assert.rejects(
    () => createOrderPayment("user-1", "order-id-1", {
      repository,
      now: () => now,
      getConfig: () => ({
        ...config,
        paymentMode: "wechat",
        wechatConfigured: true,
      }),
      getProvider: () => provider,
      createMerchantOrderNumber: () => "WX-MERCHANT-ATTEMPT-1",
    } as never),
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_REQUIRES_NEW_PAYMENT", 409),
  );
  assert.equal(closeCalls, 1);
  assert.deepEqual(failures, ["PAYMENT_REQUIRES_NEW_PAYMENT"]);
});

test("verified provider query binds the complete durable payment through one service RPC", async () => {
  const paymentService = (await import("../../lib/billing/payments/service")) as {
    queryAndBindOrderPayment?: (
      userId: string,
      orderId: string,
      dependencies: Record<string, unknown>,
    ) => Promise<PaymentResult>;
  };
  assert.equal(typeof paymentService.queryAndBindOrderPayment, "function");

  const durable: PaymentResult = {
    orderNumber: "WX-MERCHANT-QUERY-1",
    providerTransactionId: null,
    status: "PENDING",
    amountMinor: 7_900,
    currency: "CNY",
    paymentToken: "weixin://verified-query-token",
    expiresAt: "2026-08-19T02:30:00.000Z",
    paidAt: null,
  };
  const verified: PaymentResult = {
    ...durable,
    providerTransactionId: "4200000000099",
    status: "PAID",
    paymentToken: null,
    paidAt: "2026-08-19T02:00:00.000Z",
  };
  const operations: string[] = [];
  const repository = {
    async findOwnedOrder() {
      operations.push("order");
      return order({
        provider: "WECHAT",
        amountMinor: 7_900,
        expiresAt: durable.expiresAt,
      });
    },
    async findOwnedPaymentIntent() {
      operations.push("intent");
      return durable;
    },
    async bindVerifiedPaymentQuery(input: Record<string, unknown>) {
      operations.push("bind");
      assert.deepEqual(input, {
        userId: "user-1",
        orderId: "order-id-1",
        provider: "WECHAT",
        payment: verified,
      });
      return verified;
    },
  };
  const provider = {
    async queryPayment(input: PaymentReferenceInput) {
      operations.push("provider-query");
      assert.deepEqual(input, {
        orderNumber: durable.orderNumber,
        providerTransactionId: null,
        amountMinor: 7_900,
        currency: "CNY",
        expiresAt: durable.expiresAt,
        paymentToken: durable.paymentToken,
      });
      return verified;
    },
  };

  const result = await paymentService.queryAndBindOrderPayment!(
    "user-1",
    "order-id-1",
    {
      repository,
      now: () => now,
      getConfig: () => ({
        ...config,
        paymentMode: "wechat",
        wechatConfigured: true,
      }),
      getProvider: () => provider,
    },
  );

  assert.deepEqual(result, verified);
  assert.deepEqual(operations, ["order", "intent", "provider-query", "bind"]);
});

test("verified pending query without a provider transaction id remains payable", async () => {
  const paymentService = (await import("../../lib/billing/payments/service")) as {
    queryAndBindOrderPayment: (
      userId: string,
      orderId: string,
      dependencies: Record<string, unknown>,
    ) => Promise<PaymentResult>;
  };
  const pending: PaymentResult = {
    orderNumber: "WX-MERCHANT-QUERY-NOTPAY",
    providerTransactionId: null,
    status: "PENDING",
    amountMinor: 990,
    currency: "CNY",
    paymentToken: "weixin://verified-query-token",
    expiresAt: "2026-08-19T02:30:00.000Z",
    paidAt: null,
  };
  const operations: string[] = [];
  const repository = {
    async findOwnedOrder() {
      operations.push("order");
      return order({
        provider: "WECHAT",
        amountMinor: pending.amountMinor,
        expiresAt: pending.expiresAt,
      });
    },
    async findOwnedPaymentIntent() {
      operations.push("intent");
      return pending;
    },
    async bindVerifiedPaymentQuery(input: { payment: PaymentResult }) {
      operations.push("bind");
      assert.deepEqual(input.payment, pending);
      return input.payment;
    },
  };
  const provider = {
    async queryPayment(input: PaymentReferenceInput) {
      operations.push("provider-query");
      assert.deepEqual(input, {
        orderNumber: pending.orderNumber,
        providerTransactionId: null,
        amountMinor: 990,
        currency: "CNY",
        expiresAt: pending.expiresAt,
        paymentToken: pending.paymentToken,
      });
      return pending;
    },
  };

  const result = await paymentService.queryAndBindOrderPayment(
    "user-1",
    "order-id-1",
    {
      repository,
      getConfig: () => ({
        ...config,
        paymentMode: "wechat",
        wechatConfigured: true,
      }),
      getProvider: () => provider,
    },
  );

  assert.deepEqual(result, pending);
  assert.deepEqual(operations, ["order", "intent", "provider-query", "bind"]);
});

test("verified unpaid query closes from durable context before retiring the attempt", async () => {
  const paymentService = (await import("../../lib/billing/payments/service")) as {
    queryAndBindOrderPayment: (
      userId: string,
      orderId: string,
      dependencies: Record<string, unknown>,
    ) => Promise<PaymentResult>;
  };
  const durable: PaymentResult = {
    orderNumber: "WX-MERCHANT-QUERY-2",
    providerTransactionId: null,
    status: "PENDING",
    amountMinor: 7_900,
    currency: "CNY",
    paymentToken: null,
    expiresAt: "2026-08-19T02:30:00.000Z",
    paidAt: null,
  };
  const requiresNewPayment: PaymentResult = {
    ...durable,
    providerTransactionId: "4200000000100",
    status: "REQUIRES_NEW_PAYMENT",
  };
  const closed: PaymentResult = {
    ...requiresNewPayment,
    status: "CLOSED",
  };
  const references: PaymentReferenceInput[] = [];
  const bound: PaymentResult[] = [];
  const repository = {
    async findOwnedOrder() {
      return order({
        provider: "WECHAT",
        amountMinor: durable.amountMinor,
        expiresAt: durable.expiresAt,
      });
    },
    async findOwnedPaymentIntent() { return durable; },
    async bindVerifiedPaymentQuery(input: { payment: PaymentResult }) {
      bound.push(input.payment);
      return input.payment;
    },
  };
  const provider = {
    async queryPayment(input: PaymentReferenceInput) {
      references.push(input);
      return requiresNewPayment;
    },
    async closePayment(input: PaymentReferenceInput) {
      references.push(input);
      return closed;
    },
  };

  await assert.rejects(
    () => paymentService.queryAndBindOrderPayment("user-1", "order-id-1", {
      repository,
      now: () => now,
      getConfig: () => ({
        ...config,
        paymentMode: "wechat",
        wechatConfigured: true,
      }),
      getProvider: () => provider,
    }),
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_REQUIRES_NEW_PAYMENT", 409),
  );
  assert.deepEqual(references, [
    {
      orderNumber: durable.orderNumber,
      providerTransactionId: null,
      amountMinor: durable.amountMinor,
      currency: durable.currency,
      expiresAt: durable.expiresAt,
      paymentToken: null,
    },
    {
      orderNumber: durable.orderNumber,
      providerTransactionId: null,
      amountMinor: durable.amountMinor,
      currency: durable.currency,
      expiresAt: durable.expiresAt,
      paymentToken: null,
    },
  ]);
  assert.deepEqual(bound, [closed]);
});
