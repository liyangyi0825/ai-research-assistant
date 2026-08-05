import assert from "node:assert/strict";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import {
  buildInternalReconciliationReport,
  type InternalReconciliationSnapshot,
  type InternalReconciliationOrder,
} from "../../lib/billing/reconciliation";

const now = new Date("2026-08-05T12:00:00.000Z");

function snapshot(
  overrides: Partial<InternalReconciliationSnapshot> = {},
): InternalReconciliationSnapshot {
  return {
    orders: [],
    payments: [],
    webhookEvents: [],
    subscriptions: [],
    creditLedgerEntries: [],
    refundRequests: [],
    refundRecords: [],
    ...overrides,
  };
}

function order(overrides: Partial<InternalReconciliationOrder> = {}): InternalReconciliationOrder {
  return {
    id: "order-id",
    orderNumber: "ORD-001",
    userId: "user-id",
    provider: "MOCK",
    status: "PAID",
    amountMinor: 100,
    currency: "CNY",
    snapshotProductType: "SUBSCRIPTION",
    snapshotCreditGrant: 0,
    expiresAt: "2026-08-05T13:00:00.000Z",
    refundStatus: "NONE",
    ...overrides,
  };
}

function report(input: InternalReconciliationSnapshot) {
  return buildInternalReconciliationReport({ snapshot: input, now });
}

test("reports every reconciliation code with its safe fixed finding", () => {
  const result = report(
    snapshot({
      orders: [
        order({ id: "expired", orderNumber: "ORD-EXPIRED", status: "PENDING", expiresAt: now.toISOString() }),
        order({ id: "missing-payment", orderNumber: "ORD-MISSING", snapshotProductType: "CREDIT_PACK", snapshotCreditGrant: 0 }),
        order({ id: "mismatch", orderNumber: "ORD-MISMATCH", snapshotProductType: "CREDIT_PACK", snapshotCreditGrant: 0 }),
        order({ id: "missing-subscription", orderNumber: "ORD-SUB" }),
        order({ id: "missing-credit", orderNumber: "ORD-CREDIT", snapshotProductType: "CREDIT_PACK", snapshotCreditGrant: 2 }),
        order({ id: "refund", orderNumber: "ORD-REFUND", status: "REFUNDING", refundStatus: "NONE" }),
      ],
      payments: [
        { id: "payment-mismatch", orderId: "mismatch", userId: "other-user", provider: "MOCK", status: "PAID", amountMinor: 100, currency: "CNY" },
        { id: "payment-sub", orderId: "missing-subscription", userId: "user-id", provider: "MOCK", status: "PAID", amountMinor: 100, currency: "CNY" },
        { id: "payment-credit", orderId: "missing-credit", userId: "user-id", provider: "MOCK", status: "PAID", amountMinor: 100, currency: "CNY" },
        { id: "payment-refund", orderId: "refund", userId: "user-id", provider: "MOCK", status: "PAID", amountMinor: 100, currency: "CNY" },
      ],
      webhookEvents: [{ id: "webhook", status: "PROCESSING", updatedAt: "2026-08-05T11:45:00.000Z" }],
    }),
  );

  assert.deepEqual(new Set(result.items.map((item) => item.code)), new Set([
    "ORDER_EXPIRED_PENDING", "PAID_ORDER_PAYMENT_MISSING", "PAYMENT_ORDER_MISMATCH",
    "WEBHOOK_STALLED", "SUBSCRIPTION_GRANT_MISSING", "CREDIT_GRANT_MISSING",
    "REFUND_STATE_MISMATCH",
  ]));
  assert.deepEqual(result.items.map(({ code, severity, entityType, entityId, orderNumber, message }) => ({ code, severity, entityType, entityId, orderNumber, message })), [
    { code: "CREDIT_GRANT_MISSING", severity: "CRITICAL", entityType: "ORDER", entityId: "missing-credit", orderNumber: "ORD-CREDIT", message: "Paid credit-pack order is missing its purchase credit grant." },
    { code: "PAID_ORDER_PAYMENT_MISSING", severity: "CRITICAL", entityType: "ORDER", entityId: "missing-payment", orderNumber: "ORD-MISSING", message: "Paid order is missing a paid payment record." },
    { code: "PAYMENT_ORDER_MISMATCH", severity: "CRITICAL", entityType: "PAYMENT", entityId: "payment-mismatch", orderNumber: "ORD-MISMATCH", message: "Paid payment does not match its order." },
    { code: "REFUND_STATE_MISMATCH", severity: "CRITICAL", entityType: "REFUND", entityId: "refund", orderNumber: "ORD-REFUND", message: "Order refund state does not match its refund records." },
    { code: "SUBSCRIPTION_GRANT_MISSING", severity: "CRITICAL", entityType: "ORDER", entityId: "missing-subscription", orderNumber: "ORD-SUB", message: "Paid subscription order is missing its subscription grant." },
    { code: "WEBHOOK_STALLED", severity: "WARNING", entityType: "WEBHOOK", entityId: "webhook", orderNumber: null, message: "Webhook processing has stalled." },
    { code: "ORDER_EXPIRED_PENDING", severity: "INFO", entityType: "ORDER", entityId: "expired", orderNumber: "ORD-EXPIRED", message: "Pending order has expired." },
  ]);
  assert.ok(result.items.every((item) => Object.keys(item).sort().join(",") === "code,detectedAt,entityId,entityType,message,orderNumber,severity"));
});

test("returns a clean report for matching grants and refund state", () => {
  const result = report(snapshot({
    orders: [
      order({ id: "subscription", orderNumber: "ORD-SUB" }),
      order({ id: "credits", orderNumber: "ORD-CREDITS", snapshotProductType: "CREDIT_PACK", snapshotCreditGrant: 5 }),
      order({ id: "refunding", orderNumber: "ORD-REFUNDING", status: "REFUNDING", refundStatus: "REQUESTED" }),
      order({ id: "refunded", orderNumber: "ORD-REFUNDED", status: "REFUNDED", refundStatus: "FULL" }),
    ],
    payments: ["subscription", "credits", "refunding", "refunded"].map((orderId) => ({ id: `payment-${orderId}`, orderId, userId: "user-id", provider: "MOCK", status: "PAID", amountMinor: 100, currency: "CNY" })),
    subscriptions: [{ id: "subscription-id", sourceOrderId: "subscription" }],
    creditLedgerEntries: [{ id: "credit-entry", entryType: "PURCHASE", referenceOrderId: "credits" }],
    refundRequests: [{ id: "request", orderId: "refunding", status: "APPROVED" }],
    refundRecords: [{ id: "refund-record", orderId: "refunded", status: "SUCCEEDED" }],
  }));
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.summary, { total: 0, critical: 0, warning: 0, info: 0, byCode: { ORDER_EXPIRED_PENDING: 0, PAID_ORDER_PAYMENT_MISSING: 0, PAYMENT_ORDER_MISMATCH: 0, WEBHOOK_STALLED: 0, SUBSCRIPTION_GRANT_MISSING: 0, CREDIT_GRANT_MISSING: 0, REFUND_STATE_MISMATCH: 0 } });
});

test("treats a webhook exactly fifteen minutes old as stalled", () => {
  const result = report(snapshot({ webhookEvents: [{ id: "boundary", status: "RECEIVED", updatedAt: "2026-08-05T11:45:00.000Z" }] }));
  assert.equal(result.items[0]?.code, "WEBHOOK_STALLED");
});

test("summarizes all 201 findings before truncating at the hard limit", () => {
  const orders = Array.from({ length: 201 }, (_, index) => order({ id: `order-${index}`, orderNumber: `ORD-${index}`, status: "PENDING", expiresAt: now.toISOString() }));
  const result = report(snapshot({ orders }));
  assert.equal(result.items.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.summary.total, 201);
  assert.equal(result.summary.info, 201);
});

test("uses a deterministic severity, code, type, and identifier order", () => {
  const result = report(snapshot({
    orders: [
      order({ id: "z", orderNumber: "Z", status: "PENDING", expiresAt: now.toISOString() }),
      order({ id: "b", orderNumber: "B", snapshotProductType: "CREDIT_PACK" }),
      order({ id: "a", orderNumber: "A", snapshotProductType: "CREDIT_PACK" }),
    ],
  }));
  assert.deepEqual(result.items.map((item) => `${item.code}:${item.entityId}`), ["PAID_ORDER_PAYMENT_MISSING:a", "PAID_ORDER_PAYMENT_MISSING:b", "ORDER_EXPIRED_PENDING:z"]);
});

test("fails closed for invalid limits and malformed snapshot data", () => {
  const malformed = [
    () => buildInternalReconciliationReport({ snapshot: snapshot(), now, maxItems: 0 }),
    () => buildInternalReconciliationReport({ snapshot: snapshot(), now, maxItems: 201 }),
    () => report(snapshot({ orders: [order({ expiresAt: "not-a-date" })] })),
    () => report(snapshot({ orders: [order({ amountMinor: -1 })] })),
    () => report(snapshot({ orders: [order({ amountMinor: 1.5 })] })),
    () => report(snapshot({ orders: [order({ id: "" })] })),
  ];
  for (const run of malformed) {
    assert.throws(run, (error: unknown) => error instanceof BillingError && error.code === "BILLING_STORAGE_UNAVAILABLE" && error.message === "Billing data is temporarily unavailable." && error.status === 503);
  }
});

test("fails closed for impossible and noncanonical UTC timestamps", () => {
  const malformed = [
    "2026-02-30T12:00:00.000Z",
    "2026-08-05T12:00:00Z",
  ];
  for (const expiresAt of malformed) {
    assert.throws(
      () => report(snapshot({ orders: [order({ expiresAt })] })),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "BILLING_STORAGE_UNAVAILABLE" &&
        error.status === 503,
    );
  }
});

test("uses indexed relationships instead of repeatedly scanning snapshot rows", () => {
  const originalSome = Array.prototype.some;
  Array.prototype.some = function unexpectedRelationshipScan() {
    throw new Error("relationship arrays must be indexed before evaluation");
  };
  try {
    assert.doesNotThrow(() => report(snapshot({
      orders: [order()],
      payments: [{ id: "payment", orderId: "order-id", userId: "user-id", provider: "MOCK", status: "PAID", amountMinor: 100, currency: "CNY" }],
      subscriptions: [{ id: "subscription", sourceOrderId: "order-id" }],
    })));
  } finally {
    Array.prototype.some = originalSome;
  }
});
