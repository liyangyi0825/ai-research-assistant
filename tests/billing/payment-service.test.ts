import assert from "node:assert/strict";
import test from "node:test";

import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import { MockPaymentProvider } from "../../lib/billing/payments/mock";
import {
  createOrderPayment,
  paymentRequestIdempotencyKey,
  type PaymentOrderSnapshot,
  type PaymentServiceRepository,
} from "../../lib/billing/payments/service";

const now = new Date("2026-07-22T03:00:00.000Z");
const config: BillingConfig = {
  featureEnabled: true,
  paymentMode: "mock",
  testUserIds: ["user-1"],
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
    ...overrides,
  };
}

class MemoryPaymentRepository implements PaymentServiceRepository {
  failWith: Error | null = null;
  claimState: "EMPTY" | "CREATING" | "CREATED" | "FAILED" = "EMPTY";
  claimCalls = 0;
  completeCalls = 0;
  failCalls: string[] = [];
  intentPayment: Omit<Awaited<ReturnType<MockPaymentProvider["createPayment"]>>, "orderNumber"> | null = null;

  constructor(readonly storedOrder: PaymentOrderSnapshot | null = order()) {}

  async findOwnedOrder(userId: string, orderId: string) {
    if (this.failWith) throw this.failWith;
    return this.storedOrder?.userId === userId && this.storedOrder.id === orderId
      ? { ...this.storedOrder }
      : null;
  }

  async claimPaymentIntent() {
    this.claimCalls += 1;
    if (this.claimState === "CREATED" && this.intentPayment) {
      return { status: "REUSE" as const, payment: { ...this.intentPayment } };
    }
    if (this.claimState === "CREATING") {
      return { status: "IN_PROGRESS" as const };
    }
    this.claimState = "CREATING";
    return { status: "CLAIMED" as const, intentId: "intent-1" };
  }

  async completePaymentIntent(input: { payment: Awaited<ReturnType<MockPaymentProvider["createPayment"]>> }) {
    this.completeCalls += 1;
    this.intentPayment = {
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

test("createOrderPayment prices a pending payment only from the owned database snapshot", async () => {
  const repository = new MemoryPaymentRepository();
  const provider = new MockPaymentProvider({
    secret: "payment-service-test-secret",
    now: () => now,
  });
  let providerCreateCalls = 0;
  const createPayment = provider.createPayment.bind(provider);
  provider.createPayment = async (input) => {
    providerCreateCalls += 1;
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
        dependencies(repository, provider),
      ),
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_PROVIDER_UNAVAILABLE", 503) &&
      error instanceof BillingError &&
      !error.message.includes("do-not-leak"),
  );
  assert.deepEqual(repository.failCalls, ["PROVIDER_CREATE_FAILED"]);
  assert.equal(repository.intentPayment, null);
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
