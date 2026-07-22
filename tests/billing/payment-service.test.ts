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

  constructor(readonly storedOrder: PaymentOrderSnapshot | null = order()) {}

  async findOwnedOrder(userId: string, orderId: string) {
    if (this.failWith) throw this.failWith;
    return this.storedOrder?.userId === userId && this.storedOrder.id === orderId
      ? { ...this.storedOrder }
      : null;
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
