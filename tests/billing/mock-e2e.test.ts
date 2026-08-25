import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdminBillingHandler,
  reviewInvoiceRequest,
  reviewRefundRequest,
} from "../../lib/billing/admin";
import { assertBillingAccess, requireBillingAdmin } from "../../lib/billing/auth";
import {
  BILLING_AGREEMENT_VERSION,
  type BillingConfig,
} from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import { createOrder, createOrderPostHandler } from "../../lib/billing/orders";
import { MockPaymentProvider } from "../../lib/billing/payments/mock";
import {
  createOrderPayment,
  type MockPaymentConfirmationRepository,
} from "../../lib/billing/payments/service";
import { confirmMockOrderPayment } from "../../lib/billing/payments/webhooks";
import { createListPublicProductsHandler } from "../../lib/billing/products";
import { generateInternalReconciliationReport } from "../../lib/billing/reconciliation";
import { executeApprovedRefund } from "../../lib/billing/refunds";
import {
  getBillingSummary,
  getCurrentBillingAvailability,
  submitInvoiceRequest,
  submitRefundRequest,
} from "../../lib/billing/user-pages";
import { ResearchUsageService, researchTaskFailed } from "../../lib/billing/research-usage";
import { UsageQuotaService } from "../../lib/billing/usage-quota";
import {
  CREDIT_PRODUCT,
  MockBillingState,
  SEMESTER_PRODUCT,
  TEST_ADMIN,
  TEST_CONFIG,
  TEST_NOW,
  TEST_USER_ID,
} from "./helpers/mock-billing-state";

class CountingMockPaymentProvider extends MockPaymentProvider {
  refundCalls = 0;
  failNextConfirmation = false;

  override async createPaidPaymentWebhook(
    input: Parameters<MockPaymentProvider["createPaidPaymentWebhook"]>[0],
  ) {
    if (this.failNextConfirmation) {
      this.failNextConfirmation = false;
      throw new BillingError("MOCK_CONFIRM_FAILED", "Mock confirmation failed.", 503);
    }
    return super.createPaidPaymentWebhook(input);
  }

  override async refundPayment(input: Parameters<MockPaymentProvider["refundPayment"]>[0]) {
    this.refundCalls += 1;
    return super.refundPayment(input);
  }
}

function mockProvider() {
  return new MockPaymentProvider({
    secret: "mock-e2e-secret-without-production-value",
    now: () => TEST_NOW,
  });
}

function countingProvider() {
  return new CountingMockPaymentProvider({
    secret: "mock-e2e-counting-secret-without-production-value",
    now: () => TEST_NOW,
  });
}

async function purchase(
  state: MockBillingState,
  provider: MockPaymentProvider,
  productId: string,
) {
  const order = await createOrder(
    {
      userId: TEST_USER_ID,
      productId,
      provider: "mock",
      acceptedAgreementVersion: BILLING_AGREEMENT_VERSION,
    },
    {
      repository: state.billingRepository,
      now: () => TEST_NOW,
      createOrderNumber: () => `BILL-E2E-${state.orders.length + 1}`,
      paymentMode: "mock",
    },
  );
  const payment = await createOrderPayment(TEST_USER_ID, order.id, {
    repository: state.paymentRepository,
    now: () => TEST_NOW,
    getConfig: () => TEST_CONFIG,
    getProvider: () => provider,
  });
  const callback = await confirmMockOrderPayment(
    { id: TEST_USER_ID, email: null, isAdmin: false },
    order.id,
    {
      paymentRepository: state.paymentRepository,
      webhookRepository: state.webhookRepository,
      getConfig: () => TEST_CONFIG,
      getProvider: () => provider,
      now: () => TEST_NOW,
    },
  );
  return { order, payment, callback };
}

test("unused Pro Semester completes the real mock purchase and automatic refund chain", async () => {
  const state = new MockBillingState();
  const provider = mockProvider();
  const { order, callback } = await purchase(state, provider, SEMESTER_PRODUCT.id);

  assert.equal(callback.status, "PROCESSED");
  assert.equal(state.orders[0]?.amountMinor, 7_900);
  assert.equal(state.orders[0]?.snapshotDurationDays, 150);
  assert.equal(state.subscriptions[0]?.status, "ACTIVE");
  assert.equal(state.entitlements.length, 13);
  assert.equal(state.quotas.find((quota) => quota.featureKey === "summarize")?.limit, 500);

  const request = await submitRefundRequest(
    { userId: TEST_USER_ID, orderId: order.id, reasonCode: "NO_LONGER_NEEDED", details: "Not used" },
    { repository: state.userPageRepository },
  );
  await reviewRefundRequest(
    TEST_ADMIN,
    { requestId: request.id, decision: "APPROVED", reason: "Unused purchase", idempotencyKey: "review-refund-1" },
    state.adminRepository,
  );
  const execution = await executeApprovedRefund(request.id, {
    repository: state.refundExecutionRepository,
    getConfig: () => TEST_CONFIG,
    getProvider: () => provider,
    now: () => TEST_NOW,
    createClaimToken: () => "refund-claim-1",
  });

  assert.equal(execution.status, "SUCCEEDED");
  assert.equal(state.orders[0]?.status, "REFUNDED");
  assert.equal(state.orders[0]?.refundStatus, "FULL");
  assert.equal(state.subscriptions[0]?.status, "CANCELLED");
  assert.ok(state.entitlements.every((item) => item.validUntil === TEST_NOW.toISOString()));
  assert.ok(state.quotas.every((item) => item.limit === 0));
});

test("Pro Semester uses backend price, grants once, settles usage, releases failures, and blocks automatic refund after use", async () => {
  const state = new MockBillingState();
  const provider = countingProvider();
  const { order } = await purchase(state, provider, SEMESTER_PRODUCT.id);

  const replay = await confirmMockOrderPayment(
    { id: TEST_USER_ID, email: null, isAdmin: false },
    order.id,
    {
      paymentRepository: state.paymentRepository,
      webhookRepository: state.webhookRepository,
      getConfig: () => TEST_CONFIG,
      getProvider: () => provider,
      now: () => TEST_NOW,
    },
  );
  assert.equal(replay.status, "ALREADY_PROCESSED");
  assert.equal(state.subscriptions.length, 1);
  assert.equal(state.entitlements.length, 13);
  assert.equal(state.quotas.length, 13);
  assert.equal(state.payments.length, 1);

  const usage = new UsageQuotaService(state.usageAdapter);
  const research = new ResearchUsageService({
    entitlements: state.entitlementAuthorizer,
    usage,
  });
  const completed = await research.run(
    { userId: TEST_USER_ID, taskKey: "task-success", featureKey: "summarize", quotaUnits: 1, creditAmount: 0 },
    async () => "research-result",
  );
  assert.equal(completed, "research-result");
  await assert.rejects(
    research.run(
      { userId: TEST_USER_ID, taskKey: "task-failed", featureKey: "summarize", quotaUnits: 1, creditAmount: 0 },
      async () => researchTaskFailed(new Error("research task failed")),
    ),
    /research task failed/,
  );
  const summarize = state.quotas.find((quota) => quota.featureKey === "summarize");
  assert.deepEqual(
    { limit: summarize?.limit, reserved: summarize?.reserved, used: summarize?.used },
    { limit: 500, reserved: 0, used: 1 },
  );
  assert.deepEqual(state.usage.map((item) => item.status), ["FINALIZED", "RELEASED"]);

  const request = await submitRefundRequest(
    { userId: TEST_USER_ID, orderId: order.id, reasonCode: "SERVICE_ISSUE", details: "Used order" },
    { repository: state.userPageRepository },
  );
  await reviewRefundRequest(
    TEST_ADMIN,
    { requestId: request.id, decision: "APPROVED", reason: "Review used order", idempotencyKey: "review-used-refund" },
    state.adminRepository,
  );
  await assert.rejects(
    executeApprovedRefund(request.id, {
      repository: state.refundExecutionRepository,
      getConfig: () => TEST_CONFIG,
      getProvider: () => provider,
      now: () => TEST_NOW,
      createClaimToken: () => "used-refund-claim",
    }),
    (error: unknown) => error instanceof BillingError && error.code === "REFUND_REQUIRES_MANUAL_REVIEW",
  );
  assert.equal(provider.refundCalls, 0);
  assert.equal(state.subscriptions[0]?.status, "ACTIVE");
});

test("Credit Pack 100 grants exactly 100 credits once and remains manual-only for refunds", async () => {
  const state = new MockBillingState();
  const provider = countingProvider();
  const { order } = await purchase(state, provider, CREDIT_PRODUCT.id);

  await confirmMockOrderPayment(
    { id: TEST_USER_ID, email: null, isAdmin: false },
    order.id,
    {
      paymentRepository: state.paymentRepository,
      webhookRepository: state.webhookRepository,
      getConfig: () => TEST_CONFIG,
      getProvider: () => provider,
      now: () => TEST_NOW,
    },
  );
  assert.deepEqual(state.creditAccounts.get(TEST_USER_ID), { available: 100, reserved: 0 });
  assert.equal(state.creditLedger.filter((item) => item.entryType === "PURCHASE").length, 1);
  assert.equal(state.payments.length, 1);

  const request = await submitRefundRequest(
    { userId: TEST_USER_ID, orderId: order.id, reasonCode: "NO_LONGER_NEEDED", details: "Credit pack" },
    { repository: state.userPageRepository },
  );
  await reviewRefundRequest(
    TEST_ADMIN,
    { requestId: request.id, decision: "APPROVED", reason: "Manual credit review", idempotencyKey: "review-credit-refund" },
    state.adminRepository,
  );
  await assert.rejects(
    executeApprovedRefund(request.id, {
      repository: state.refundExecutionRepository,
      getConfig: () => TEST_CONFIG,
      getProvider: () => provider,
      now: () => TEST_NOW,
      createClaimToken: () => "credit-refund-claim",
    }),
    (error: unknown) => error instanceof BillingError && error.code === "REFUND_REQUIRES_MANUAL_REVIEW",
  );
  assert.equal(provider.refundCalls, 0);
  assert.deepEqual(state.creditAccounts.get(TEST_USER_ID), { available: 100, reserved: 0 });
});

test("a transient mock webhook failure never settles and is safely retryable", async () => {
  const state = new MockBillingState();
  const provider = countingProvider();
  provider.failNextConfirmation = true;
  const order = await createOrder(
    { userId: TEST_USER_ID, productId: SEMESTER_PRODUCT.id, provider: "mock", acceptedAgreementVersion: BILLING_AGREEMENT_VERSION },
    { repository: state.billingRepository, now: () => TEST_NOW, createOrderNumber: () => "BILL-E2E-RETRY", paymentMode: "mock" },
  );
  await createOrderPayment(TEST_USER_ID, order.id, {
    repository: state.paymentRepository,
    now: () => TEST_NOW,
    getConfig: () => TEST_CONFIG,
    getProvider: () => provider,
  });
  const confirm = () => confirmMockOrderPayment(
    { id: TEST_USER_ID, email: null, isAdmin: false }, order.id,
    { paymentRepository: state.paymentRepository, webhookRepository: state.webhookRepository, getConfig: () => TEST_CONFIG, getProvider: () => provider, now: () => TEST_NOW },
  );

  await assert.rejects(
    confirm,
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "MOCK_CONFIRM_FAILED" &&
      error.status === 503,
  );
  assert.equal(state.paymentIntents.get(order.id)?.status, "PAID");
  assert.equal(state.orders[0]?.status, "PENDING");
  assert.equal(state.webhookEvents.size, 0);
  assert.equal(state.subscriptions.length, 0);
  assert.equal((await confirm()).status, "PROCESSED");
  assert.equal(state.subscriptions.length, 1);
});

test("a database claim failure remains recoverable without granting before retry", async () => {
  const state = new MockBillingState();
  const provider = countingProvider();
  const order = await createOrder(
    { userId: TEST_USER_ID, productId: SEMESTER_PRODUCT.id, provider: "mock", acceptedAgreementVersion: BILLING_AGREEMENT_VERSION },
    { repository: state.billingRepository, now: () => TEST_NOW, createOrderNumber: () => "BILL-E2E-CLAIM-RETRY", paymentMode: "mock" },
  );
  const payment = await createOrderPayment(TEST_USER_ID, order.id, {
    repository: state.paymentRepository,
    now: () => TEST_NOW,
    getConfig: () => TEST_CONFIG,
    getProvider: () => provider,
  });
  let failClaim = true;
  const paymentRepository: MockPaymentConfirmationRepository = {
    ...state.paymentRepository,
    async claimMockPaymentConfirmation(input) {
      if (failClaim) {
        failClaim = false;
        throw new BillingError("BILLING_STORAGE_UNAVAILABLE", "Billing data is temporarily unavailable.", 503);
      }
      return state.paymentRepository.claimMockPaymentConfirmation(input);
    },
  };
  const confirm = () => confirmMockOrderPayment(
    { id: TEST_USER_ID, email: null, isAdmin: false }, order.id,
    { paymentRepository, webhookRepository: state.webhookRepository, getConfig: () => TEST_CONFIG, getProvider: () => provider, now: () => TEST_NOW },
  );

  await assert.rejects(confirm, (error: unknown) => error instanceof BillingError && error.code === "BILLING_STORAGE_UNAVAILABLE");
  assert.equal((await provider.queryPayment({ orderNumber: payment.orderNumber, providerTransactionId: payment.providerTransactionId })).status, "PAID");
  assert.equal(state.paymentIntents.get(order.id)?.status, "PENDING");
  assert.equal(state.orders[0]?.status, "PENDING");
  assert.equal(state.webhookEvents.size, 0);
  assert.equal(state.subscriptions.length, 0);

  assert.equal((await confirm()).status, "PROCESSED");
  assert.equal(state.payments.length, 1);
  assert.equal(state.subscriptions.length, 1);
  assert.equal(state.entitlements.length, 13);
});

test("feature gates hide the catalog, reject forged prices and production public mock, but allow explicit testers and admins", async () => {
  const state = new MockBillingState();
  const disabled = { ...TEST_CONFIG, featureEnabled: false };
  let catalogReads = 0;
  const catalogResponse = await createListPublicProductsHandler({
    getConfig: () => disabled,
    listProducts: async () => { catalogReads += 1; return []; },
  })();
  assert.deepEqual(await catalogResponse.json(), { products: [] });
  assert.equal(catalogReads, 0);

  const disabledOrderHandler = createOrderPostHandler({
    requireActor: async () => ({ id: TEST_USER_ID, email: null, isAdmin: false }),
    getConfig: () => disabled,
    assertAccess: assertBillingAccess,
    consumeRateLimit: async () => undefined,
    createOrder: async () => { throw new Error("disabled billing must not create an order"); },
  });
  const disabledOrder = await disabledOrderHandler(new Request("http://localhost/api/billing/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: SEMESTER_PRODUCT.id, provider: "mock", acceptedAgreementVersion: BILLING_AGREEMENT_VERSION }),
  }));
  assert.equal(disabledOrder.status, 403);
  assert.equal((await disabledOrder.json() as { error: { code: string } }).error.code, "BILLING_FEATURE_DISABLED");

  const orderHandler = createOrderPostHandler({
    requireActor: async () => ({ id: TEST_USER_ID, email: null, isAdmin: false }),
    getConfig: () => TEST_CONFIG,
    assertAccess: assertBillingAccess,
    consumeRateLimit: async () => undefined,
    createOrder: (input, dependencies) => createOrder(input, { ...dependencies, repository: state.billingRepository, now: () => TEST_NOW }),
  });
  const forged = await orderHandler(new Request("http://localhost/api/billing/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: SEMESTER_PRODUCT.id, provider: "mock", acceptedAgreementVersion: BILLING_AGREEMENT_VERSION, amountMinor: 1 }),
  }));
  assert.equal(forged.status, 400);
  assert.equal(state.orders.length, 0);

  const production: BillingConfig = { ...TEST_CONFIG, isProduction: true, testUserIds: [TEST_USER_ID] };
  const publicUser = { id: "ordinary-user", email: null, isAdmin: false };
  assert.throws(() => assertBillingAccess(publicUser, production), (error: unknown) => error instanceof BillingError && error.code === "MOCK_PAYMENT_NOT_ALLOWED");
  assert.doesNotThrow(() => assertBillingAccess({ id: TEST_USER_ID, email: null, isAdmin: false }, production));
  assert.doesNotThrow(() => assertBillingAccess(TEST_ADMIN, production));
  assert.equal((await getCurrentBillingAvailability({ getConfig: () => production, requireActor: async () => publicUser })).available, false);
  assert.equal((await getCurrentBillingAvailability({ getConfig: () => production, requireActor: async () => TEST_ADMIN })).available, true);
});

test("ordinary users cannot enter admin handlers while invoice review and reconciliation finish cleanly", async () => {
  const state = new MockBillingState();
  const provider = mockProvider();
  const { order } = await purchase(state, provider, SEMESTER_PRODUCT.id);
  const denied = createAdminBillingHandler({
    requireAdmin: () => requireBillingAdmin({
      getUser: async () => ({ id: TEST_USER_ID, email: "student@example.test", isAdmin: false }),
      findAdmin: async () => null,
    }),
    operation: async () => ({ secret: true }),
  });
  const deniedResponse = await denied(new Request("http://localhost/api/admin/billing"));
  assert.equal(deniedResponse.status, 403);
  assert.equal((await deniedResponse.json() as { error: { code: string } }).error.code, "BILLING_ADMIN_REQUIRED");

  const invoice = await submitInvoiceRequest(
    { userId: TEST_USER_ID, orderId: order.id, titleType: "ORGANIZATION", invoiceTitle: "Research Lab", taxIdentifier: "91130100MA00000001", deliveryEmail: "finance@example.test" },
    { repository: state.userPageRepository },
  );
  const review = await reviewInvoiceRequest(
    TEST_ADMIN,
    { requestId: invoice.id, decision: "ISSUED", reason: "Verified", idempotencyKey: "review-invoice-1" },
    state.adminRepository,
  );
  assert.equal(review.status, "APPLIED");
  assert.equal(state.invoiceRequests[0]?.status, "ISSUED");
  assert.equal(state.audits.filter((item) => item.action === "REVIEW_INVOICE").length, 1);
  const summary = await getBillingSummary(TEST_USER_ID, state.userPageRepository);
  assert.equal(summary.subscription?.planName, "Pro Semester");
  assert.equal(summary.invoices[0]?.status, "ISSUED");

  const reconciliation = await generateInternalReconciliationReport({
    repository: state.reconciliationRepository,
    now: () => TEST_NOW,
  });
  assert.deepEqual(reconciliation.items, []);
  assert.equal(reconciliation.summary.total, 0);
});
