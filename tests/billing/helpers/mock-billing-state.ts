import type { BillingAdmin } from "../../../lib/billing/auth";
import type { BillingConfig } from "../../../lib/billing/config";
import { BillingError } from "../../../lib/billing/errors";
import type { BillingAdminRepository } from "../../../lib/billing/admin";
import type {
  InternalReconciliationSnapshot,
  ReconciliationRepository,
} from "../../../lib/billing/reconciliation";
import type {
  BillingOrder,
  BillingOrderInsert,
  BillingProduct,
  BillingRepository,
} from "../../../lib/billing/repositories";
import type {
  ClaimPaymentIntentInput,
  CompletePaymentIntentInput,
  PaymentOrderSnapshot,
  MockPaymentConfirmationRepository,
  StoredPaymentResult,
} from "../../../lib/billing/payments/service";
import type {
  WebhookEventInsert,
  WebhookEventRecord,
  WebhookRepository,
  WebhookSettlementArgs,
  WebhookSettlementResult,
} from "../../../lib/billing/payments/webhooks";
import type {
  BillingUsageRpcAdapter,
  UsageReservationInput,
  UsageRpcResult,
} from "../../../lib/billing/usage-quota";
import type {
  BillingSummary,
  BillingUserPageRepository,
  InvoiceRequest,
  InvoiceRequestInsert,
  RefundRequest,
  RefundRequestInsert,
} from "../../../lib/billing/user-pages";
import type {
  RefundClaimResult,
  RefundExecutionRepository,
} from "../../../lib/billing/refunds";
import type { RefundResult } from "../../../lib/billing/payments/types";

export const TEST_NOW = new Date("2026-08-18T08:00:00.000Z");
export const TEST_USER_ID = "00000000-0000-4000-8000-000000000101";
export const TEST_ADMIN_ID = "00000000-0000-4000-8000-000000000201";

export const TEST_CONFIG: BillingConfig = {
  featureEnabled: true,
  paymentMode: "mock",
  testUserIds: [TEST_USER_ID],
  realPaymentPublicEnabled: false,
  legal: { operatorName: "", operatorCreditCode: "", contactEmail: "" },
  wechatConfigured: false,
  alipayConfigured: false,
  isProduction: false,
};

export const TEST_ADMIN: BillingAdmin = {
  id: TEST_ADMIN_ID,
  email: "billing-admin@example.test",
  isAdmin: true,
  role: "BILLING_ADMIN",
};

const semesterEntitlements = [
  ["summarize", 500], ["chat", 5000], ["translate", 150],
  ["ppt_generate", 150], ["concept_explore", 500], ["keyword_gen", 1000],
  ["bibtex_export", 5000], ["extract_refs", 500], ["profile_summarize", 500],
  ["literature_review", 150], ["latex_export", 500], ["data_clean", 500],
  ["polish", 500],
] as const;

export const SEMESTER_PRODUCT: BillingProduct = {
  id: "00000000-0000-4000-8000-000000000301",
  planId: "00000000-0000-4000-8000-000000000302",
  sku: "PRO_SEMESTER",
  name: "Pro Semester",
  description: "150 day research plan",
  productType: "SUBSCRIPTION",
  priceMinor: 7_900,
  currency: "CNY",
  durationDays: 150,
  creditGrant: 0,
  entitlementVersion: "pro-semester-v1",
  isActive: true,
  displayMetadata: {},
  entitlements: semesterEntitlements.map(([featureKey, periodicLimit]) => ({
    featureKey,
    entitlementVersion: "pro-semester-v1",
    periodicLimit,
    creditGrant: 0,
    configuration: {},
  })),
};

export const CREDIT_PRODUCT: BillingProduct = {
  id: "00000000-0000-4000-8000-000000000303",
  planId: null,
  sku: "CREDIT_PACK_100",
  name: "Credit Pack 100",
  description: "100 research credits",
  productType: "CREDIT_PACK",
  priceMinor: 990,
  currency: "CNY",
  durationDays: null,
  creditGrant: 100,
  entitlementVersion: "credit-v1",
  isActive: true,
  displayMetadata: {},
  entitlements: [],
};

type PaymentRow = Omit<
  StoredPaymentResult,
  "providerTransactionId" | "status"
> & {
  providerTransactionId: string;
  status: "PENDING" | "PAID" | "CLOSED" | "REFUNDED" | "FAILED";
  id: string;
  orderId: string;
  userId: string;
  provider: "MOCK";
  requestIdempotencyKey: string;
};

type SubscriptionRow = {
  id: string;
  userId: string;
  planId: string;
  sourceOrderId: string;
  status: "ACTIVE" | "CANCELLED";
  startsAt: string;
  endsAt: string;
};

type EntitlementRow = {
  id: string;
  userId: string;
  sourceOrderId: string;
  featureKey: string;
  periodicLimit: number | null;
  validFrom: string;
  validUntil: string;
};

type QuotaRow = {
  id: string;
  userId: string;
  subscriptionId: string;
  featureKey: string;
  limit: number;
  reserved: number;
  used: number;
  periodStart: string;
  periodEnd: string;
};

type UsageRow = {
  id: string;
  userId: string;
  taskKey: string;
  featureKey: string;
  status: "RESERVED" | "FINALIZED" | "RELEASED";
  quotaUnits: number;
  creditAmount: number;
  quotaId: string | null;
};

type RefundRow = {
  id: string;
  requestId: string;
  orderId: string;
  paymentId: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  claimToken: string | null;
  result: RefundResult | null;
};

export class MockBillingState {
  private sequence = 0;
  readonly products = new Map([SEMESTER_PRODUCT, CREDIT_PRODUCT].map((item) => [item.id, structuredClone(item)]));
  readonly orders: BillingOrder[] = [];
  readonly paymentIntents = new Map<string, StoredPaymentResult>();
  readonly payments: PaymentRow[] = [];
  readonly webhookEvents = new Map<string, WebhookEventRecord>();
  readonly subscriptions: SubscriptionRow[] = [];
  readonly entitlements: EntitlementRow[] = [];
  readonly quotas: QuotaRow[] = [];
  readonly creditAccounts = new Map<string, { available: number; reserved: number }>();
  readonly creditLedger: Array<{ id: string; userId: string; entryType: "PURCHASE" | "GRANT" | "RESERVE" | "CONSUME" | "RELEASE" | "ADJUSTMENT"; referenceOrderId: string | null }> = [];
  readonly usage: UsageRow[] = [];
  readonly refundRequests: RefundRequest[] = [];
  readonly refunds: RefundRow[] = [];
  readonly invoiceRequests: InvoiceRequest[] = [];
  readonly audits: Array<{ id: string; action: "REVIEW_REFUND" | "REVIEW_INVOICE"; resourceId: string; idempotencyKey: string }> = [];

  id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence).padStart(4, "0")}`;
  }

  readonly billingRepository: BillingRepository = {
    listActiveProducts: async () => [...this.products.values()].filter((item) => item.isActive).map((item) => structuredClone(item)),
    findActiveProduct: async (id) => {
      const item = this.products.get(id);
      return item?.isActive ? structuredClone(item) : null;
    },
    hasActiveSubscription: async () => false,
    insertOrder: async (input: BillingOrderInsert) => {
      const timestamp = TEST_NOW.toISOString();
      const order: BillingOrder = {
        ...structuredClone(input), id: this.id("order"), status: "PENDING",
        paidAt: null, closedAt: null, refundStatus: "NONE", createdAt: timestamp, updatedAt: timestamp,
      };
      this.orders.push(order);
      return structuredClone(order);
    },
    findUserOrder: async (userId, orderId) => structuredClone(this.orders.find((item) => item.userId === userId && item.id === orderId) ?? null),
  };

  readonly paymentRepository: MockPaymentConfirmationRepository = {
    findOwnedOrder: async (userId, orderId): Promise<PaymentOrderSnapshot | null> => {
      const order = this.orders.find((item) => item.userId === userId && item.id === orderId);
      return order ? { id: order.id, userId: order.userId, orderNumber: order.orderNumber, provider: order.provider, status: order.status, amountMinor: order.amountMinor, currency: order.currency, expiresAt: order.expiresAt, snapshotProductName: order.snapshotProductName } : null;
    },
    findOwnedPaymentIntent: async (userId, orderId) => {
      const order = this.orders.find((item) => item.id === orderId && item.userId === userId);
      const intent = this.paymentIntents.get(orderId);
      return order && intent ? structuredClone(intent) : null;
    },
    claimPaymentIntent: async (input: ClaimPaymentIntentInput) => {
      const stored = this.paymentIntents.get(input.orderId);
      return stored
        ? { status: "REUSE" as const, payment: structuredClone(stored) }
        : {
            status: "CLAIMED" as const,
            intentId: input.orderId,
            merchantOrderNumber: input.merchantOrderNumber,
            requestIdempotencyKey: input.requestIdempotencyKey,
          };
    },
    completePaymentIntent: async (input: CompletePaymentIntentInput) => {
      const stored: StoredPaymentResult = {
        orderNumber: input.payment.orderNumber,
        providerTransactionId: input.payment.providerTransactionId, status: input.payment.status,
        amountMinor: input.payment.amountMinor, currency: input.payment.currency,
        paymentToken: input.payment.paymentToken, expiresAt: input.payment.expiresAt, paidAt: input.payment.paidAt,
      };
      this.paymentIntents.set(input.intentId, stored);
      return structuredClone(stored);
    },
    failPaymentIntent: async () => undefined,
    claimMockPaymentConfirmation: async ({ userId, orderId, providerTransactionId, paidAt }) => {
      const order = this.orders.find((item) => item.id === orderId && item.userId === userId);
      const intent = this.paymentIntents.get(orderId);
      if (!order || !intent || intent.providerTransactionId !== providerTransactionId) throw new Error("payment confirmation mismatch");
      const paid = { ...intent, status: "PAID" as const, paidAt };
      this.paymentIntents.set(orderId, paid);
      return structuredClone(paid);
    },
  };

  readonly webhookRepository: WebhookRepository = {
    persistEvent: async (input: WebhookEventInsert) => {
      const key = `${input.provider}:${input.providerEventId}`;
      const current = this.webhookEvents.get(key);
      if (current) return structuredClone(current);
      const event: WebhookEventRecord = { id: this.id("webhook"), orderId: null, userId: null, ...structuredClone(input) };
      this.webhookEvents.set(key, event);
      return structuredClone(event);
    },
    markEventFailed: async (provider, providerEventId, errorCode) => {
      const event = this.webhookEvents.get(`${provider}:${providerEventId}`);
      if (!event) throw new Error("missing webhook event");
      if (event.status !== "PROCESSED") { event.status = "FAILED"; event.errorCode = errorCode; }
      return structuredClone(event);
    },
    markEventRetryable: async (provider, providerEventId, errorCode) => {
      const event = this.webhookEvents.get(`${provider}:${providerEventId}`);
      if (!event) throw new Error("missing webhook event");
      if (event.status === "RECEIVED" || event.status === "RETRYABLE") {
        event.status = "RETRYABLE";
        event.errorCode = errorCode;
      }
      return structuredClone(event);
    },
    prepareEventForSettlement: async (provider, providerEventId) => {
      const event = this.webhookEvents.get(`${provider}:${providerEventId}`);
      if (!event) throw new Error("missing webhook event");
      if (event.status === "RETRYABLE") {
        event.status = "RECEIVED";
        event.errorCode = null;
      }
      return structuredClone(event);
    },
    settlePaidOrder: async (args) => this.settlePaidOrder(args),
  };

  private settlePaidOrder(args: WebhookSettlementArgs): WebhookSettlementResult {
    const event = this.webhookEvents.get(`${args.p_provider}:${args.p_provider_event_id}`);
    if (!event) throw new Error("missing webhook event");
    if (event.status === "PROCESSED") return { status: "ALREADY_PROCESSED", eventStatus: "PROCESSED", orderId: event.orderId };
    const order = this.orders.find((item) => item.orderNumber === args.p_order_number);
    if (!order || order.status !== "PENDING" || order.provider !== args.p_provider || order.amountMinor !== args.p_amount_minor || order.currency !== args.p_currency) {
      throw new BillingError("PAYMENT_CONTRACT_MISMATCH", "Payment settlement contract mismatch.", 400);
    }
    const intent = this.paymentIntents.get(order.id);
    if (!intent || intent.providerTransactionId !== args.p_provider_transaction_id) throw new Error("payment intent mismatch");
    const payment: PaymentRow = {
      id: this.id("payment"), orderId: order.id, userId: order.userId, provider: "MOCK",
      requestIdempotencyKey: args.p_request_idempotency_key,
      ...structuredClone(intent),
      providerTransactionId: intent.providerTransactionId,
      status: "PAID",
      paidAt: args.p_paid_at,
    };
    this.payments.push(payment);
    order.status = "PAID"; order.paidAt = args.p_paid_at; order.updatedAt = args.p_paid_at;
    event.status = "PROCESSED"; event.orderId = order.id; event.userId = order.userId;
    if (order.snapshotProductType === "SUBSCRIPTION") this.grantSubscription(order, args.p_paid_at);
    else this.grantCredits(order.userId, order.snapshotCreditGrant, order.id, "PURCHASE");
    return { status: "PROCESSED", eventStatus: "PROCESSED", orderId: order.id };
  }

  private grantSubscription(order: BillingOrder, paidAt: string) {
    const startsAt = paidAt;
    const endsAt = new Date(Date.parse(paidAt) + (order.snapshotDurationDays ?? 0) * 86_400_000).toISOString();
    const subscription: SubscriptionRow = { id: this.id("subscription"), userId: order.userId, planId: order.snapshotPlanId!, sourceOrderId: order.id, status: "ACTIVE", startsAt, endsAt };
    this.subscriptions.push(subscription);
    for (const item of order.snapshotEntitlements) {
      this.entitlements.push({ id: this.id("entitlement"), userId: order.userId, sourceOrderId: order.id, featureKey: item.feature_key, periodicLimit: item.periodic_limit, validFrom: startsAt, validUntil: endsAt });
      if (item.periodic_limit !== null) this.quotas.push({ id: this.id("quota"), userId: order.userId, subscriptionId: subscription.id, featureKey: item.feature_key, limit: item.periodic_limit, reserved: 0, used: 0, periodStart: startsAt, periodEnd: endsAt });
      if (item.credit_grant > 0) this.grantCredits(order.userId, item.credit_grant, order.id, "GRANT");
    }
  }

  private grantCredits(userId: string, amount: number, orderId: string, entryType: "PURCHASE" | "GRANT") {
    if (amount <= 0) return;
    const account = this.creditAccounts.get(userId) ?? { available: 0, reserved: 0 };
    account.available += amount; this.creditAccounts.set(userId, account);
    this.creditLedger.push({ id: this.id("ledger"), userId, entryType, referenceOrderId: orderId });
  }

  readonly entitlementAuthorizer = {
    requireEntitlement: async (userId: string, featureKey: string) => {
      const current = this.entitlements.find((item) => item.userId === userId && item.featureKey === featureKey && Date.parse(item.validUntil) > TEST_NOW.getTime());
      if (!current) throw new BillingError("ENTITLEMENT_REQUIRED", "Feature entitlement is required.", 403);
      return structuredClone(current);
    },
  };

  readonly usageAdapter: BillingUsageRpcAdapter = {
    reserve: async (input) => this.reserveUsage(input),
    finalize: async (userId, taskKey) => this.settleUsage(userId, taskKey, "FINALIZED"),
    release: async (userId, taskKey) => this.settleUsage(userId, taskKey, "RELEASED"),
    provision: async () => { throw new Error("continuations not used by this test helper"); },
    claim: async () => { throw new Error("continuations not used by this test helper"); },
    complete: async () => { throw new Error("continuations not used by this test helper"); },
    releaseContinuation: async () => { throw new Error("continuations not used by this test helper"); },
  };

  private reserveUsage(input: UsageReservationInput): UsageRpcResult {
    const existing = this.usage.find((item) => item.userId === input.userId && item.taskKey === input.taskKey);
    if (existing) return { status: existing.status, usageRecordId: existing.id, idempotent: true };
    const quota = input.quotaUnits > 0 ? this.quotas.find((item) => item.userId === input.userId && item.featureKey === input.featureKey) : undefined;
    if (input.quotaUnits > 0 && (!quota || quota.used + quota.reserved + input.quotaUnits > quota.limit)) throw new BillingError("USAGE_QUOTA_EXCEEDED", "The research usage limit has been reached.", 429);
    const account = this.creditAccounts.get(input.userId) ?? { available: 0, reserved: 0 };
    if (input.creditAmount > account.available) throw new BillingError("INSUFFICIENT_CREDITS", "There are not enough credits for this research task.", 402);
    if (quota) quota.reserved += input.quotaUnits;
    if (input.creditAmount > 0) { account.available -= input.creditAmount; account.reserved += input.creditAmount; this.creditAccounts.set(input.userId, account); this.creditLedger.push({ id: this.id("ledger"), userId: input.userId, entryType: "RESERVE", referenceOrderId: null }); }
    const usage: UsageRow = { id: this.id("usage"), ...structuredClone(input), status: "RESERVED", quotaId: quota?.id ?? null };
    this.usage.push(usage);
    return { status: "RESERVED", usageRecordId: usage.id, idempotent: false };
  }

  private settleUsage(userId: string, taskKey: string, target: "FINALIZED" | "RELEASED"): UsageRpcResult {
    const usage = this.usage.find((item) => item.userId === userId && item.taskKey === taskKey);
    if (!usage) throw new Error("usage not reserved");
    if (usage.status !== "RESERVED") return { status: usage.status, usageRecordId: usage.id, idempotent: true };
    const quota = this.quotas.find((item) => item.id === usage.quotaId);
    if (quota) { quota.reserved -= usage.quotaUnits; if (target === "FINALIZED") quota.used += usage.quotaUnits; }
    if (usage.creditAmount > 0) {
      const account = this.creditAccounts.get(userId)!; account.reserved -= usage.creditAmount;
      if (target === "RELEASED") account.available += usage.creditAmount;
      this.creditLedger.push({ id: this.id("ledger"), userId, entryType: target === "FINALIZED" ? "CONSUME" : "RELEASE", referenceOrderId: null });
    }
    usage.status = target;
    return { status: target, usageRecordId: usage.id, idempotent: false };
  }

  readonly userPageRepository: BillingUserPageRepository = {
    getSummary: async (userId) => this.summary(userId),
    requestRefund: async (input) => this.requestRefund(input),
    requestInvoice: async (input) => this.requestInvoice(input),
  };

  private summary(userId: string): BillingSummary {
    const subscription = [...this.subscriptions].reverse().find((item) => item.userId === userId && item.status === "ACTIVE");
    const account = this.creditAccounts.get(userId) ?? { available: 0, reserved: 0 };
    return {
      subscription: subscription ? { planId: subscription.planId, planName: "Pro Semester", startsAt: subscription.startsAt, endsAt: subscription.endsAt } : null,
      credits: structuredClone(account),
      quotas: this.quotas.filter((item) => item.userId === userId).map((item) => ({ featureKey: item.featureKey, periodStart: item.periodStart, periodEnd: item.periodEnd, limit: item.limit, reserved: item.reserved, used: item.used })),
      orders: this.orders.filter((item) => item.userId === userId).map((item) => ({ id: item.id, orderNumber: item.orderNumber, status: item.status, productName: item.snapshotProductName, amountMinor: item.amountMinor, currency: item.currency, refundStatus: item.refundStatus, createdAt: item.createdAt, paidAt: item.paidAt })),
      usage: this.usage.filter((item) => item.userId === userId).map((item) => ({ id: item.id, featureKey: item.featureKey, status: item.status, quotaUnits: item.quotaUnits, creditAmount: item.creditAmount, createdAt: TEST_NOW.toISOString() })),
      refunds: structuredClone(this.refundRequests), invoices: structuredClone(this.invoiceRequests),
    };
  }

  private requestRefund(input: RefundRequestInsert): RefundRequest {
    const existing = this.refundRequests.find((item) => item.orderId === input.orderId);
    if (existing) return structuredClone(existing);
    const order = this.orders.find((item) => item.id === input.orderId && item.userId === input.userId && item.status === "PAID");
    if (!order) throw new BillingError("REFUND_NOT_ALLOWED", "The order cannot be refunded.", 409);
    const request: RefundRequest = { id: this.id("refund-request"), orderId: order.id, status: "PENDING", requestedAmountMinor: order.amountMinor, currency: "CNY", reasonCode: input.reasonCode, details: input.details, createdAt: TEST_NOW.toISOString() };
    this.refundRequests.push(request); return structuredClone(request);
  }

  private requestInvoice(input: InvoiceRequestInsert): InvoiceRequest {
    const existing = this.invoiceRequests.find((item) => item.orderId === input.orderId);
    if (existing) return structuredClone(existing);
    const order = this.orders.find((item) => item.id === input.orderId && item.userId === input.userId && item.status === "PAID");
    if (!order) throw new BillingError("INVOICE_NOT_ALLOWED", "The order cannot be invoiced.", 409);
    const request: InvoiceRequest = { id: this.id("invoice-request"), orderId: order.id, status: "PENDING", titleType: input.titleType, invoiceTitle: input.invoiceTitle, taxIdentifier: input.taxIdentifier, amountMinor: order.amountMinor, currency: "CNY", deliveryEmail: input.deliveryEmail, createdAt: TEST_NOW.toISOString() };
    this.invoiceRequests.push(request); return structuredClone(request);
  }

  readonly adminRepository: BillingAdminRepository = {
    getOverview: async () => ({}), listOrders: async () => structuredClone(this.orders), getUser: async () => ({}),
    listRefunds: async () => structuredClone(this.refundRequests), listInvoices: async () => structuredClone(this.invoiceRequests),
    listWebhookEvents: async () => [...this.webhookEvents.values()].map((item) => structuredClone(item)), listCatalog: async () => ({ plans: [], products: [...this.products.values()] }),
    adjustCredit: async () => { throw new Error("not used"); }, grantSubscription: async () => { throw new Error("not used"); },
    reviewRefund: async (input) => this.reviewRefund(input.requestId, input.decision, input.idempotencyKey),
    reviewInvoice: async (input) => this.reviewInvoice(input.requestId, input.decision, input.idempotencyKey),
    upsertPlan: async () => { throw new Error("not used"); }, upsertProduct: async () => { throw new Error("not used"); },
  };

  private mutation(action: "REVIEW_REFUND" | "REVIEW_INVOICE", resourceId: string, idempotencyKey: string) {
    const existing = this.audits.find((item) => item.action === action && item.idempotencyKey === idempotencyKey);
    if (existing) return { status: "ALREADY_APPLIED" as const, auditId: existing.id, resourceId: existing.resourceId };
    const audit = { id: this.id("audit"), action, resourceId, idempotencyKey }; this.audits.push(audit);
    return { status: "APPLIED" as const, auditId: audit.id, resourceId };
  }

  private reviewRefund(requestId: string, decision: "APPROVED" | "REJECTED", idempotencyKey: string) {
    const replay = this.audits.find((item) => item.action === "REVIEW_REFUND" && item.idempotencyKey === idempotencyKey);
    if (replay) return { status: "ALREADY_APPLIED" as const, auditId: replay.id, resourceId: replay.resourceId };
    const request = this.refundRequests.find((item) => item.id === requestId && item.status === "PENDING");
    if (!request) throw new Error("refund unavailable");
    request.status = decision; const order = this.orders.find((item) => item.id === request.orderId)!;
    if (decision === "APPROVED") { order.status = "REFUNDING"; order.refundStatus = "REQUESTED"; }
    return this.mutation("REVIEW_REFUND", requestId, idempotencyKey);
  }

  private reviewInvoice(requestId: string, decision: "ISSUED" | "REJECTED", idempotencyKey: string) {
    const replay = this.audits.find((item) => item.action === "REVIEW_INVOICE" && item.idempotencyKey === idempotencyKey);
    if (replay) return { status: "ALREADY_APPLIED" as const, auditId: replay.id, resourceId: replay.resourceId };
    const request = this.invoiceRequests.find((item) => item.id === requestId && item.status === "PENDING");
    if (!request) throw new Error("invoice unavailable"); request.status = decision;
    return this.mutation("REVIEW_INVOICE", requestId, idempotencyKey);
  }

  readonly refundExecutionRepository: RefundExecutionRepository = {
    claimApprovedRefund: async ({ requestId, claimToken }) => this.claimRefund(requestId, claimToken),
    completeRefund: async ({ refundId, claimToken, result }) => this.completeRefund(refundId, claimToken, result),
    failRefundClaim: async ({ refundId, claimToken }) => { const refund = this.refunds.find((item) => item.id === refundId && item.claimToken === claimToken); if (refund) { refund.status = "FAILED"; refund.claimToken = null; } },
  };

  private claimRefund(requestId: string, claimToken: string): RefundClaimResult {
    const request = this.refundRequests.find((item) => item.id === requestId && item.status === "APPROVED");
    if (!request) throw new Error("approved refund unavailable");
    const order = this.orders.find((item) => item.id === request.orderId)!;
    if (order.snapshotProductType === "CREDIT_PACK") return { status: "MANUAL_REVIEW_REQUIRED" };
    const current = this.refunds.find((item) => item.requestId === requestId);
    if (current?.status === "SUCCEEDED" && current.result) return { status: "SUCCEEDED", refund: structuredClone(current.result) };
    const hasUsage = this.usage.some((item) => this.quotas.find((quota) => quota.id === item.quotaId)?.subscriptionId === this.subscriptions.find((sub) => sub.sourceOrderId === order.id)?.id && item.status !== "RELEASED");
    if (hasUsage) return { status: "MANUAL_REVIEW_REQUIRED" };
    const payment = this.payments.find((item) => item.orderId === order.id && item.status === "PAID")!;
    const row = current ?? { id: this.id("refund"), requestId, orderId: order.id, paymentId: payment.id, status: "PENDING" as const, claimToken, result: null };
    row.claimToken = claimToken; if (!current) this.refunds.push(row);
    return { status: "CLAIMED", refundId: row.id, requestId, orderId: order.id, paymentId: payment.id, provider: "MOCK", providerTransactionId: payment.providerTransactionId, amountMinor: order.amountMinor, currency: "CNY", idempotencyKey: `billing-refund:${requestId}` };
  }

  private completeRefund(refundId: string, claimToken: string, result: RefundResult) {
    const refund = this.refunds.find((item) => item.id === refundId && item.claimToken === claimToken)!;
    const order = this.orders.find((item) => item.id === refund.orderId)!;
    const payment = this.payments.find((item) => item.id === refund.paymentId)!;
    const subscription = this.subscriptions.find((item) => item.sourceOrderId === order.id)!;
    refund.status = "SUCCEEDED"; refund.claimToken = null; refund.result = structuredClone(result);
    payment.status = "REFUNDED"; order.status = "REFUNDED"; order.refundStatus = "FULL"; subscription.status = "CANCELLED";
    for (const entitlement of this.entitlements.filter((item) => item.sourceOrderId === order.id)) entitlement.validUntil = TEST_NOW.toISOString();
    for (const quota of this.quotas.filter((item) => item.subscriptionId === subscription.id)) { quota.limit = 0; quota.periodEnd = TEST_NOW.toISOString(); }
    return { status: "SUCCEEDED" as const, refund: structuredClone(result) };
  }

  readonly reconciliationRepository: ReconciliationRepository = {
    loadSnapshot: async () => this.reconciliationSnapshot(),
  };

  private reconciliationSnapshot(): InternalReconciliationSnapshot {
    return {
      orders: this.orders.map((item) => ({ id: item.id, orderNumber: item.orderNumber, userId: item.userId, provider: item.provider, status: item.status, amountMinor: item.amountMinor, currency: item.currency, snapshotProductType: item.snapshotProductType, snapshotCreditGrant: item.snapshotCreditGrant, expiresAt: item.expiresAt, refundStatus: item.refundStatus })),
      payments: this.payments.map((item) => ({ id: item.id, orderId: item.orderId, userId: item.userId, provider: item.provider, status: item.status, amountMinor: item.amountMinor, currency: item.currency })),
      webhookEvents: [...this.webhookEvents.values()].map((item) => ({ id: item.id, status: item.status, updatedAt: TEST_NOW.toISOString() })),
      subscriptions: this.subscriptions.map((item) => ({ id: item.id, sourceOrderId: item.sourceOrderId })),
      creditLedgerEntries: this.creditLedger.map((item) => ({ id: item.id, entryType: item.entryType, referenceOrderId: item.referenceOrderId })),
      refundRequests: this.refundRequests.map((item) => ({ id: item.id, orderId: item.orderId, status: item.status })),
      refundRecords: this.refunds.map((item) => ({ id: item.id, orderId: item.orderId, status: item.status })),
    };
  }
}
