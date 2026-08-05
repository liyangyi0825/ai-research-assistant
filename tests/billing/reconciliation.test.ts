import assert from "node:assert/strict";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import {
  buildInternalReconciliationReport,
  createReconciliationRepository,
  generateInternalReconciliationReport,
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

const reconciliationRows = {
  billing_orders: [{ id: "order-id", order_number: "ORD-001", user_id: "user-id", provider: "MOCK", status: "PAID", amount_minor: 100, currency: "CNY", snapshot_product_type: "SUBSCRIPTION", snapshot_credit_grant: 0, expires_at: "2026-08-05T13:00:00.000Z", paid_at: "2026-08-05T12:00:00.000Z", refund_status: "NONE" }],
  billing_payments: [{ id: "payment-id", order_id: "order-id", user_id: "user-id", provider: "MOCK", status: "PAID", amount_minor: 100, currency: "CNY" }],
  billing_webhook_events: [{ id: "webhook-id", order_id: "order-id", provider_event_id: "event-id", status: "PROCESSED", created_at: "2026-08-05T11:00:00.000Z", updated_at: "2026-08-05T11:30:00.000Z" }],
  billing_subscriptions: [{ id: "subscription-id", source_order_id: "order-id" }],
  billing_credit_ledger: [{ id: "ledger-id", entry_type: "PURCHASE", reference_type: "ORDER", reference_id: "order-id" }],
  billing_refund_requests: [{ id: "refund-request-id", order_id: "order-id", status: "APPROVED" }],
  billing_refunds: [{ id: "refund-id", refund_request_id: "refund-request-id", order_id: "order-id", status: "SUCCEEDED" }],
};

type ReadResult = { data: unknown; error: unknown | null };

function createReadClient(rows: Record<string, ReadResult> = Object.fromEntries(
  Object.entries(reconciliationRows).map(([table, data]) => [table, { data, error: null }]),
)): {
  client: { from(table: string): { select(columns: string): { order(column: string, options: { ascending: boolean }): { limit(count: number): Promise<ReadResult> } } } };
  calls: Array<{ table: string; columns: string; column: string; ascending: boolean; count: number }>;
} {
  const calls: Array<{ table: string; columns: string; column: string; ascending: boolean; count: number }> = [];
  return {
    client: {
      from(table) {
        return {
          select(columns) {
            return {
              order(column, options) {
                return {
                  async limit(count) {
                    calls.push({ table, columns, column, ascending: options.ascending, count });
                    return rows[table] ?? { data: null, error: { message: "missing fixture" } };
                  },
                };
              },
            };
          },
        };
      },
    },
    calls,
  };
}

test("loads exactly the seven read-only reconciliation sources with bounded deterministic queries", async () => {
  const { client, calls } = createReadClient();
  assert.equal("insert" in client, false);
  assert.equal("update" in client, false);
  assert.equal("delete" in client, false);
  assert.equal("upsert" in client, false);
  assert.equal("rpc" in client, false);

  await createReconciliationRepository(client).loadSnapshot();

  assert.deepEqual(calls, [
    { table: "billing_orders", columns: "id, order_number, user_id, provider, status, amount_minor, currency, snapshot_product_type, snapshot_credit_grant, expires_at, paid_at, refund_status", column: "id", ascending: true, count: 1000 },
    { table: "billing_payments", columns: "id, order_id, user_id, provider, status, amount_minor, currency", column: "id", ascending: true, count: 1000 },
    { table: "billing_webhook_events", columns: "id, order_id, provider_event_id, status, created_at, updated_at", column: "id", ascending: true, count: 1000 },
    { table: "billing_subscriptions", columns: "id, source_order_id", column: "id", ascending: true, count: 1000 },
    { table: "billing_credit_ledger", columns: "id, entry_type, reference_type, reference_id", column: "id", ascending: true, count: 1000 },
    { table: "billing_refund_requests", columns: "id, order_id, status", column: "id", ascending: true, count: 1000 },
    { table: "billing_refunds", columns: "id, refund_request_id, order_id, status", column: "id", ascending: true, count: 1000 },
  ]);
});

test("maps selected snake_case rows to the engine snapshot contracts", async () => {
  const { client } = createReadClient();
  const result = await createReconciliationRepository(client).loadSnapshot();
  assert.deepEqual(result, {
    orders: [{ id: "order-id", orderNumber: "ORD-001", userId: "user-id", provider: "MOCK", status: "PAID", amountMinor: 100, currency: "CNY", snapshotProductType: "SUBSCRIPTION", snapshotCreditGrant: 0, expiresAt: "2026-08-05T13:00:00.000Z", refundStatus: "NONE" }],
    payments: [{ id: "payment-id", orderId: "order-id", userId: "user-id", provider: "MOCK", status: "PAID", amountMinor: 100, currency: "CNY" }],
    webhookEvents: [{ id: "webhook-id", status: "PROCESSED", updatedAt: "2026-08-05T11:30:00.000Z" }],
    subscriptions: [{ id: "subscription-id", sourceOrderId: "order-id" }],
    creditLedgerEntries: [{ id: "ledger-id", entryType: "PURCHASE", referenceOrderId: "order-id" }],
    refundRequests: [{ id: "refund-request-id", orderId: "order-id", status: "APPROVED" }],
    refundRecords: [{ id: "refund-id", orderId: "order-id", status: "SUCCEEDED" }],
  });
});

test("fails closed when a reconciliation read errors, is not an array, or contains a malformed row", async () => {
  const fixtures: Record<string, ReadResult>[] = [
    { ...Object.fromEntries(Object.entries(reconciliationRows).map(([table, data]) => [table, { data, error: null }])), billing_orders: { data: null, error: { message: "query failed" } } },
    { ...Object.fromEntries(Object.entries(reconciliationRows).map(([table, data]) => [table, { data, error: null }])), billing_payments: { data: {}, error: null } },
    { ...Object.fromEntries(Object.entries(reconciliationRows).map(([table, data]) => [table, { data, error: null }])), billing_refunds: { data: [{ id: "refund-id", refund_request_id: "refund-request-id", order_id: "order-id", status: "INVALID" }], error: null } },
  ];
  for (const rows of fixtures) {
    await assert.rejects(
      createReconciliationRepository(createReadClient(rows).client).loadSnapshot(),
      (error: unknown) => error instanceof BillingError && error.code === "BILLING_STORAGE_UNAVAILABLE" && error.message === "Billing data is temporarily unavailable." && error.status === 503,
    );
  }
});

test("generates a report from one loaded snapshot and the injected clock", async () => {
  let loads = 0;
  const generatedAt = "2026-08-05T12:00:00.000Z";
  const result = await generateInternalReconciliationReport({
    repository: {
      async loadSnapshot() {
        loads += 1;
        return snapshot({ orders: [order({ status: "PENDING", expiresAt: generatedAt })] });
      },
    },
    now: () => new Date(generatedAt),
  });
  assert.equal(loads, 1);
  assert.equal(result.generatedAt, generatedAt);
  assert.equal(result.items[0]?.code, "ORDER_EXPIRED_PENDING");
});

test("normalizes valid PostgREST timestamptz values before passing them to the reconciliation engine", async () => {
  const rows = Object.fromEntries(Object.entries(reconciliationRows).map(([table, data]) => [table, { data, error: null }])) as Record<string, ReadResult>;
  rows.billing_orders = {
    data: [{ ...reconciliationRows.billing_orders[0], expires_at: "2026-08-05T13:00:00+00:00", paid_at: "2026-08-05T12:00:00.123456+08:00" }],
    error: null,
  };
  rows.billing_webhook_events = {
    data: [{ ...reconciliationRows.billing_webhook_events[0], created_at: "2026-08-05T11:00:00.123456+00:00", updated_at: "2026-08-05T11:30:00.123456+08:00" }],
    error: null,
  };

  const result = await createReconciliationRepository(createReadClient(rows).client).loadSnapshot();

  assert.equal(result.orders[0]?.expiresAt, "2026-08-05T13:00:00.000Z");
  assert.equal(result.webhookEvents[0]?.updatedAt, "2026-08-05T03:30:00.123Z");
});

test("fails closed for impossible PostgREST timestamptz calendar and offset values", async () => {
  const fixtures: Record<string, ReadResult>[] = [
    { ...Object.fromEntries(Object.entries(reconciliationRows).map(([table, data]) => [table, { data, error: null }])), billing_orders: { data: [{ ...reconciliationRows.billing_orders[0], expires_at: "2026-02-30T12:00:00+00:00" }], error: null } },
    { ...Object.fromEntries(Object.entries(reconciliationRows).map(([table, data]) => [table, { data, error: null }])), billing_webhook_events: { data: [{ ...reconciliationRows.billing_webhook_events[0], updated_at: "2026-08-05T11:30:00+24:00" }], error: null } },
  ];
  for (const rows of fixtures) {
    await assert.rejects(
      createReconciliationRepository(createReadClient(rows).client).loadSnapshot(),
      (error: unknown) => error instanceof BillingError && error.code === "BILLING_STORAGE_UNAVAILABLE" && error.message === "Billing data is temporarily unavailable." && error.status === 503,
    );
  }
});

test("normalizes non-storage repository and clock errors to the safe storage error", async () => {
  const unsafeErrors = [
    new BillingError("UNSAFE_CODE", "unsafe billing detail", 400),
    new BillingError("BILLING_STORAGE_UNAVAILABLE", "unsafe storage detail", 503),
    new Error("unsafe implementation detail"),
  ];
  for (const unsafeError of unsafeErrors) {
    await assert.rejects(
      generateInternalReconciliationReport({ repository: { async loadSnapshot() { throw unsafeError; } } }),
      (error: unknown) => error instanceof BillingError && error.code === "BILLING_STORAGE_UNAVAILABLE" && error.message === "Billing data is temporarily unavailable." && error.status === 503,
    );
    await assert.rejects(
      generateInternalReconciliationReport({ repository: { async loadSnapshot() { return snapshot(); } }, now: () => { throw unsafeError; } }),
      (error: unknown) => error instanceof BillingError && error.code === "BILLING_STORAGE_UNAVAILABLE" && error.message === "Billing data is temporarily unavailable." && error.status === 503,
    );
  }
});
