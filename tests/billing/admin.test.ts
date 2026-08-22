import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminBillingView } from "../../app/admin/billing/AdminBillingView";
import { ReconciliationReportView } from "../../components/billing/ReconciliationReportView";
import { BillingError } from "../../lib/billing/errors";
import type { InternalReconciliationReport } from "../../lib/billing/reconciliation";
import {
  adjustUserCredit,
  createBillingAdminRepository,
  createAdminBillingHandler,
  grantUserSubscription,
  reviewRefundRequest,
  upsertBillingPlan,
  upsertBillingProduct,
  type BillingAdminRepository,
} from "../../lib/billing/admin";
import type { BillingConfig } from "../../lib/billing/config";

type QueryResponse = { data: unknown; error: { message: string } | null };

class QueryStub implements PromiseLike<QueryResponse> {
  constructor(
    private readonly table: string,
    private readonly response: QueryResponse,
    private readonly selections: Array<{ table: string; columns: string }> ,
  ) {}

  select(columns: string): this {
    this.selections.push({ table: this.table, columns });
    return this;
  }

  eq(): this { return this; }
  order(): this { return this; }
  limit(): this { return this; }
  maybeSingle(): this { return this; }

  then<TResult1 = QueryResponse, TResult2 = never>(
    onfulfilled?: ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.response).then(onfulfilled, onrejected);
  }
}

function queryClient(rows: Record<string, unknown>): {
  selections: Array<{ table: string; columns: string }>;
  from(table: string): QueryStub;
  rpc(): Promise<QueryResponse>;
} {
  const selections: Array<{ table: string; columns: string }> = [];
  return {
    selections,
    from(table) {
      return new QueryStub(table, { data: rows[table] ?? [], error: null }, selections);
    },
    async rpc() { return { data: null, error: { message: "not used" } }; },
  };
}

const admin = {
  id: "admin-1",
  email: "admin@example.test",
  isAdmin: true as const,
  role: "BILLING_ADMIN" as const,
};

const enabledBillingConfig: BillingConfig = {
  featureEnabled: true,
  paymentMode: "mock",
  testUserIds: ["admin-1"],
  legal: {
    operatorName: "",
    operatorCreditCode: "",
    contactEmail: "",
  },
  wechatConfigured: false,
  alipayConfigured: false,
  isProduction: false,
};

const disabledBillingConfig: BillingConfig = {
  ...enabledBillingConfig,
  featureEnabled: false,
};

const reconciliationReport: InternalReconciliationReport = {
  generatedAt: "2026-08-05T00:00:00.000Z",
  scope: "INTERNAL_DATABASE_ONLY",
  summary: {
    total: 2,
    critical: 1,
    warning: 1,
    info: 0,
    byCode: {
      ORDER_EXPIRED_PENDING: 0,
      PAID_ORDER_PAYMENT_MISSING: 1,
      PAYMENT_ORDER_MISMATCH: 0,
      WEBHOOK_STALLED: 1,
      SUBSCRIPTION_GRANT_MISSING: 0,
      CREDIT_GRANT_MISSING: 0,
      REFUND_STATE_MISMATCH: 0,
    },
  },
  items: [
    {
      code: "PAID_ORDER_PAYMENT_MISSING",
      severity: "CRITICAL",
      entityType: "ORDER",
      entityId: "order-1",
      orderNumber: "ORD-20260805-001",
      detectedAt: "2026-08-05T00:00:00.000Z",
      message: "Paid order is missing a paid payment record.",
    },
    {
      code: "WEBHOOK_STALLED",
      severity: "WARNING",
      entityType: "WEBHOOK",
      entityId: "webhook-1",
      orderNumber: null,
      detectedAt: "2026-08-05T00:00:00.000Z",
      message: "Webhook processing has stalled.",
    },
  ],
  truncated: false,
};

function repository(
  overrides: Partial<BillingAdminRepository> = {},
): BillingAdminRepository {
  return {
    getOverview: async () => ({
      counts: { pendingOrders: 1, pendingRefunds: 2, pendingInvoices: 3 },
      recentAuditLogs: [],
    }),
    listOrders: async () => [],
    getUser: async () => null,
    listRefunds: async () => [],
    listInvoices: async () => [],
    listWebhookEvents: async () => [],
    listCatalog: async () => ({ plans: [], products: [] }),
    adjustCredit: async () => ({
      status: "APPLIED",
      auditId: "audit-credit",
      resourceId: "ledger-1",
    }),
    grantSubscription: async () => ({
      status: "APPLIED",
      auditId: "audit-subscription",
      resourceId: "subscription-1",
    }),
    reviewRefund: async () => ({
      status: "APPLIED",
      auditId: "audit-refund",
      resourceId: "refund-1",
    }),
    reviewInvoice: async () => ({
      status: "APPLIED",
      auditId: "audit-invoice",
      resourceId: "invoice-1",
    }),
    upsertPlan: async () => ({
      status: "APPLIED",
      auditId: "audit-plan",
      resourceId: "plan-1",
    }),
    upsertProduct: async () => ({
      status: "APPLIED",
      auditId: "audit-product",
      resourceId: "product-1",
    }),
    ...overrides,
  };
}

test("every admin handler rejects a regular user before repository access", async () => {
  let accessed = false;
  const handler = createAdminBillingHandler({
    requireAdmin: async () => {
      throw new BillingError("BILLING_ADMIN_REQUIRED", "forbidden", 403);
    },
    operation: async () => {
      accessed = true;
      return { ok: true };
    },
  });

  const response = await handler(new Request("http://localhost/admin"));
  assert.equal(response.status, 403);
  assert.equal(accessed, false);
  assert.deepEqual(await response.json(), {
    error: { code: "BILLING_ADMIN_REQUIRED", message: "forbidden" },
  });
});

test("reconciliation route rejects a regular user before generating a report", async () => {
  const { createReconciliationGetHandler } = await import("../../app/api/admin/billing/reconciliation/server");
  let generated = false;
  const handler = createReconciliationGetHandler({
    requireAdmin: async () => {
      throw new BillingError("BILLING_ADMIN_REQUIRED", "forbidden", 403);
    },
    generateReport: async () => {
      generated = true;
      return reconciliationReport;
    },
  });

  const response = await handler(new Request("http://localhost/api/admin/billing/reconciliation"));
  assert.equal(response.status, 403);
  assert.equal(generated, false);
});

test("reconciliation route returns the exact report DTO to an administrator", async () => {
  const { createReconciliationGetHandler } = await import("../../app/api/admin/billing/reconciliation/server");
  const handler = createReconciliationGetHandler({
    requireAdmin: async () => admin,
    generateReport: async () => reconciliationReport,
  });

  const response = await handler(new Request("http://localhost/api/admin/billing/reconciliation"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), reconciliationReport);
});

test("reconciliation route exposes only GET and delegates to the guarded server factory", async () => {
  const route = await import("../../app/api/admin/billing/reconciliation/route");
  assert.deepEqual(Object.keys(route).sort(), ["GET"]);

  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile("app/api/admin/billing/reconciliation/route.ts", "utf8"));
  assert.match(
    source,
    /import \{ createReconciliationGetHandler \} from "\.\/server";/,
  );
  assert.match(
    source,
    /export async function GET\(request: Request\) \{\s*return createReconciliationGetHandler\(\)\(request\);\s*\}/,
  );
});

test("reconciliation report view renders safe report fields and read-only scope", () => {
  const markup = renderToStaticMarkup(createElement(ReconciliationReportView, { report: reconciliationReport }));

  for (const text of [
    "内部数据库一致性报告",
    "只读报告，不会自动修改账务",
    "不代表已与微信或支付宝完成对账",
    "ORD-20260805-001",
    "order-1",
    "webhook-1",
    "PAID_ORDER_PAYMENT_MISSING",
    "WEBHOOK_STALLED",
    "CRITICAL",
    "WARNING",
    "Paid order is missing a paid payment record.",
    "Webhook processing has stalled.",
  ]) assert.match(markup, new RegExp(text));

  for (const [name, label, count] of [
    ["total", "总计", 2],
    ["critical", "严重", 1],
    ["warning", "警告", 1],
    ["info", "提示", 0],
  ]) assert.match(markup, new RegExp(`<dt id="summary-${name}-label"[^>]*>${label}</dt><dd[^>]*aria-labelledby="summary-${name}-label"[^>]*>${count}</dd>`));

  for (const [code, count] of Object.entries(reconciliationReport.summary.byCode)) {
    assert.match(markup, new RegExp(`<dt id="finding-count-${code}"[^>]*>${code}</dt><dd[^>]*aria-labelledby="finding-count-${code}"[^>]*>${count}</dd>`));
  }
  assert.match(markup, /<tr data-finding-code="PAID_ORDER_PAYMENT_MISSING" data-entity-id="order-1"/);
  assert.match(markup, /<tr data-finding-code="WEBHOOK_STALLED" data-entity-id="webhook-1"/);
  assert.doesNotMatch(markup, /<button|<form|自动修复|一键修复|payload_summary|signature|token|email|tax/i);
});

test("reconciliation API exposes GET only", async () => {
  const route = await import("../../app/api/admin/billing/reconciliation/route");
  assert.equal(typeof route.GET, "function");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(method in route, false);
});

test("admin query handlers return repository data without exposing secrets", async () => {
  const handler = createAdminBillingHandler({
    requireAdmin: async () => admin,
    operation: async () => ({
      provider: "wechat",
      payloadHash: "sha256:abc",
      rawPayload: undefined,
    }),
  });

  const response = await handler(new Request("http://localhost/admin"));
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes("private_key"), false);
});

test("admin webhook list selects the actual schema and exposes only a validated payload hash", async () => {
  const client = queryClient({
    billing_webhook_events: [{
      id: "event-1",
      provider: "MOCK",
      provider_event_id: "provider-event-1",
      order_id: "order-1",
      payload_summary: {
        payload_hash: "a".repeat(64),
        provider_secret: "must-not-leak",
        nested: { raw_payload: "must-not-leak" },
      },
      status: "PROCESSED",
      error_code: null,
      created_at: "2026-08-05T00:00:00.000Z",
      processed_at: "2026-08-05T00:01:00.000Z",
    }, {
      id: "event-2",
      provider: "MOCK",
      provider_event_id: "provider-event-2",
      order_id: "order-2",
      payload_summary: { payload_hash: "not-a-sha256" },
      status: "FAILED",
      error_code: "INVALID_SIGNATURE",
      created_at: "2026-08-05T00:02:00.000Z",
      processed_at: null,
    }],
  });

  const events = await createBillingAdminRepository(client).listWebhookEvents();

  assert.deepEqual(client.selections, [{
    table: "billing_webhook_events",
    columns: "id, provider, provider_event_id, order_id, payload_summary, status, error_code, created_at, processed_at",
  }]);
  assert.deepEqual(events, [{
    id: "event-1", provider: "MOCK", provider_event_id: "provider-event-1", order_id: "order-1",
    payload_hash: "a".repeat(64), status: "PROCESSED", error_code: null,
    created_at: "2026-08-05T00:00:00.000Z", processed_at: "2026-08-05T00:01:00.000Z",
  }, {
    id: "event-2", provider: "MOCK", provider_event_id: "provider-event-2", order_id: "order-2",
    payload_hash: null, status: "FAILED", error_code: "INVALID_SIGNATURE",
    created_at: "2026-08-05T00:02:00.000Z", processed_at: null,
  }]);
  assert.equal(JSON.stringify(events).includes("must-not-leak"), false);
});

test("admin invoice list masks tax identifiers and delivery email before returning rows to the UI", async () => {
  const rawTaxIdentifier = "91310000MA1K123456";
  const rawEmail = "student.research@example.edu.cn";
  const client = queryClient({
    billing_invoice_requests: [{
      id: "invoice-1", user_id: "user-1", order_id: "order-1", invoice_title: "Research Lab",
      tax_identifier: rawTaxIdentifier, amount_minor: 1990, currency: "CNY",
      delivery_email: rawEmail, status: "PENDING", created_at: "2026-08-05T00:00:00.000Z",
    }],
  });

  const invoices = await createBillingAdminRepository(client).listInvoices();
  const rendered = JSON.stringify(invoices);
  const managementUi = renderToStaticMarkup(createElement(AdminBillingView, {
    title: "Invoice requests",
    description: "Masked billing fields only.",
    data: invoices,
  }));

  assert.deepEqual(client.selections, [{
    table: "billing_invoice_requests",
    columns: "id, user_id, order_id, invoice_title, tax_identifier, amount_minor, currency, delivery_email, status, created_at",
  }]);
  assert.equal(rendered.includes(rawTaxIdentifier), false);
  assert.equal(rendered.includes(rawEmail), false);
  assert.equal(managementUi.includes(rawTaxIdentifier), false);
  assert.equal(managementUi.includes(rawEmail), false);
  assert.deepEqual(invoices, [{
    id: "invoice-1", user_id: "user-1", order_id: "order-1", invoice_title: "Research Lab",
    tax_identifier: "9131**********3456", amount_minor: 1990, currency: "CNY",
    delivery_email: "s**************h@example.edu.cn", status: "PENDING",
    created_at: "2026-08-05T00:00:00.000Z",
  }]);
});

test("admin invoice list never exposes one- or two-character email local parts", async () => {
  const oneCharacterEmail = "a@example.com";
  const twoCharacterEmail = "ab@example.com";
  const client = queryClient({
    billing_invoice_requests: [{
      id: "invoice-2", user_id: "user-2", order_id: "order-2", invoice_title: "One character",
      tax_identifier: null, amount_minor: 100, currency: "CNY", delivery_email: oneCharacterEmail,
      status: "PENDING", created_at: "2026-08-05T00:00:00.000Z",
    }, {
      id: "invoice-3", user_id: "user-3", order_id: "order-3", invoice_title: "Two characters",
      tax_identifier: null, amount_minor: 100, currency: "CNY", delivery_email: twoCharacterEmail,
      status: "PENDING", created_at: "2026-08-05T00:00:00.000Z",
    }],
  });

  const invoices = await createBillingAdminRepository(client).listInvoices();
  const managementUi = renderToStaticMarkup(createElement(AdminBillingView, {
    title: "Invoice requests",
    description: "Masked billing fields only.",
    data: invoices,
  }));
  const returned = JSON.stringify(invoices);

  assert.equal(returned.includes(oneCharacterEmail), false);
  assert.equal(returned.includes(twoCharacterEmail), false);
  assert.equal(managementUi.includes(oneCharacterEmail), false);
  assert.equal(managementUi.includes(twoCharacterEmail), false);
  assert.deepEqual(invoices.map((invoice) => (invoice as { delivery_email: string }).delivery_email), [
    "***@example.com",
    "a***@example.com",
  ]);
});

test("manual credit adjustment requires a non-empty reason", async () => {
  await assert.rejects(
    () =>
      adjustUserCredit(
        admin,
        {
          userId: "user-1",
          amount: 100,
          reason: " ",
          idempotencyKey: "credit-1",
        },
        repository(),
      ),
    (error: BillingError) => error.code === "ADMIN_REASON_REQUIRED",
  );
});

test("manual credit adjustment preserves bigint integer input and returns audit id", async () => {
  let received: unknown;
  const result = await adjustUserCredit(
    admin,
    {
      userId: "user-1",
      amount: BigInt(125),
      reason: "service recovery",
      idempotencyKey: "credit-2",
    },
    repository({
      adjustCredit: async (input) => {
        received = input;
        return {
          status: "APPLIED",
          auditId: "audit-2",
          resourceId: "ledger-2",
        };
      },
    }),
  );

  assert.equal((received as { amount: bigint }).amount, BigInt(125));
  assert.equal(result.auditId, "audit-2");
});

test("manual subscription requires a reason and positive whole duration", async () => {
  await assert.rejects(
    () =>
      grantUserSubscription(
        admin,
        {
          userId: "user-1",
          planId: "plan-1",
          durationDays: 0,
          reason: "support",
          idempotencyKey: "sub-1",
        },
        repository(),
      ),
    (error: BillingError) => error.code === "INVALID_ADMIN_INPUT",
  );
});

test("admin catalog accepts a semester billing period and exposes it in the writer UI", async () => {
  let received: unknown;
  await upsertBillingPlan(
    admin,
    {
      code: "PRO_SEMESTER",
      name: "Pro Semester",
      billingPeriod: "SEMESTER",
      isActive: false,
      reason: "configure semester catalog",
      idempotencyKey: "semester-plan-1",
    },
    repository({
      upsertPlan: async (input) => {
        received = input;
        return {
          status: "APPLIED",
          auditId: "audit-semester-plan",
          resourceId: "plan-semester",
        };
      },
    }),
  );

  assert.equal(
    (received as { p_billing_period: string }).p_billing_period,
    "SEMESTER",
  );
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile("app/admin/billing/AdminBillingActions.tsx", "utf8"),
  );
  assert.match(source, /options: \["FREE", "MONTHLY", "YEARLY", "SEMESTER"\]/);
});

test("plan activation requires enabled billing and the approved semester identity", async () => {
  const approved = {
    code: "PRO_SEMESTER",
    name: "Pro Semester",
    billingPeriod: "SEMESTER",
    isActive: true,
    reason: "activate approved semester",
    idempotencyKey: "activate-plan-semester",
  };
  await assert.rejects(
    () => upsertBillingPlan(admin, approved, repository(), disabledBillingConfig),
    (error: BillingError) => error.code === "BILLING_FEATURE_DISABLED",
  );
  for (const drift of [
    { code: "FREE" },
    { code: "PRO", billingPeriod: "MONTHLY" },
    { code: "PRO_YEARLY", billingPeriod: "YEARLY" },
    { code: "PRO_SEMESTER", name: "Wrong name" },
  ]) {
    await assert.rejects(
      () => upsertBillingPlan(admin, { ...approved, ...drift }, repository(), enabledBillingConfig),
      (error: BillingError) => error.code === "PLAN_ACTIVATION_NOT_APPROVED",
    );
  }
});

test("inactive plan maintenance remains allowed while billing is disabled", async () => {
  let received: Record<string, unknown> | undefined;
  await upsertBillingPlan(admin, {
    code: "PRO",
    name: "Pro",
    billingPeriod: "MONTHLY",
    isActive: false,
    reason: "keep monthly inactive",
    idempotencyKey: "inactive-plan-maintenance",
  }, repository({ upsertPlan: async (input) => {
    received = input;
    return { status: "APPLIED", auditId: "audit-plan", resourceId: "plan-pro" };
  }}), disabledBillingConfig);
  assert.equal(received?.p_is_active, false);
});

test("catalog UUID inputs reject malformed non-empty identifiers", async () => {
  await assert.rejects(
    () => upsertBillingPlan(admin, {
      planId: "not-a-uuid", code: "PRO", name: "Pro", billingPeriod: "MONTHLY",
      isActive: false, reason: "invalid", idempotencyKey: "invalid-plan-id",
    }, repository(), disabledBillingConfig),
    (error: BillingError) => error.code === "INVALID_ADMIN_INPUT" && error.status === 400,
  );
  for (const ids of [{ productId: "bad" }, { planId: "bad" }]) {
    await assert.rejects(
      () => upsertBillingProduct(admin, {
        ...ids, sku: "PRO_MONTHLY", name: "Pro Monthly", productType: "SUBSCRIPTION",
        priceMinor: 1990, durationDays: 30, creditGrant: 0,
        entitlementVersion: "pro-v1", isActive: false, reason: "invalid",
        idempotencyKey: `invalid-${Object.keys(ids)[0]}`,
      }, repository(), disabledBillingConfig),
      (error: BillingError) => error.code === "INVALID_ADMIN_INPUT" && error.status === 400,
    );
  }
});

test("admin cannot activate any product while the billing feature is disabled", async () => {
  let written = false;

  await assert.rejects(
    () =>
      upsertBillingProduct(
        admin,
        {
          sku: "PRO_SEMESTER",
          name: "Pro Semester",
          productType: "SUBSCRIPTION",
          priceMinor: 7_900,
          durationDays: 150,
          creditGrant: 0,
          entitlementVersion: "pro-semester-v1",
          isActive: true,
          reason: "attempt early activation",
          idempotencyKey: "activate-semester-early",
        },
        repository({
          upsertProduct: async () => {
            written = true;
            return {
              status: "APPLIED",
              auditId: "audit-activation",
              resourceId: "product-semester",
            };
          },
        }),
        disabledBillingConfig,
      ),
    (error: BillingError) => error.code === "BILLING_FEATURE_DISABLED",
  );

  assert.equal(written, false);
});

test("admin cannot activate products outside the approved fast-launch catalog", async () => {
  for (const sku of ["PRO_MONTHLY", "PRO_YEARLY", "FREE"]) {
    let written = false;

    await assert.rejects(
      () =>
        upsertBillingProduct(
          admin,
          {
            sku,
            name: sku,
            productType: "SUBSCRIPTION",
            priceMinor: 1_990,
            durationDays: 30,
            creditGrant: 0,
            entitlementVersion: "not-launch-v1",
            isActive: true,
            reason: "attempt unapproved activation",
            idempotencyKey: `activate-${sku.toLowerCase()}`,
          },
          repository({
            upsertProduct: async () => {
              written = true;
              return {
                status: "APPLIED",
                auditId: "audit-activation",
                resourceId: "product-not-approved",
              };
            },
          }),
          enabledBillingConfig,
        ),
      (error: BillingError) => error.code === "PRODUCT_ACTIVATION_NOT_APPROVED",
    );

    assert.equal(written, false);
  }
});

test("approved fast-launch products may be activated only through the admin service gate", async () => {
  for (const sku of ["PRO_SEMESTER", "CREDIT_PACK_100"]) {
    let received: Record<string, unknown> | undefined;

    await upsertBillingProduct(
      admin,
      {
        sku,
        name: sku === "PRO_SEMESTER" ? "Pro Semester" : "Credit Pack 100",
        productType: sku === "PRO_SEMESTER" ? "SUBSCRIPTION" : "CREDIT_PACK",
        planId: sku === "PRO_SEMESTER" ? "00000000-0000-4000-8000-000000000001" : null,
        priceMinor: sku === "PRO_SEMESTER" ? 7_900 : 990,
        durationDays: sku === "PRO_SEMESTER" ? 150 : null,
        creditGrant: sku === "PRO_SEMESTER" ? 0 : 100,
        entitlementVersion:
          sku === "PRO_SEMESTER" ? "pro-semester-v1" : "credit-v1",
        isActive: true,
        reason: "approved activation",
        idempotencyKey: `activate-${sku.toLowerCase()}`,
      },
      repository({
        upsertProduct: async (input) => {
          received = input;
          return {
            status: "APPLIED",
            auditId: "audit-activation",
            resourceId: `product-${sku.toLowerCase()}`,
          };
        },
      }),
      enabledBillingConfig,
    );

    assert.equal(received?.p_sku, sku);
    assert.equal(received?.p_is_active, true);
  }
});

test("admin cannot activate an approved SKU with drifted price or benefits", async () => {
  for (const product of [
    {
      sku: "PRO_SEMESTER",
      name: "Pro Semester",
      planId: "plan-semester",
      productType: "SUBSCRIPTION",
      priceMinor: 1,
      durationDays: 150,
      creditGrant: 0,
      entitlementVersion: "pro-semester-v1",
    },
    {
      sku: "CREDIT_PACK_100",
      name: "Credit Pack 100",
      planId: null,
      productType: "CREDIT_PACK",
      priceMinor: 990,
      durationDays: null,
      creditGrant: 101,
      entitlementVersion: "credit-v1",
    },
  ]) {
    await assert.rejects(
      () =>
        upsertBillingProduct(
          admin,
          {
            ...product,
            isActive: true,
            reason: "attempt drifted activation",
            idempotencyKey: `activate-drifted-${product.sku.toLowerCase()}`,
          },
          repository(),
          enabledBillingConfig,
        ),
      (error: BillingError) => error.code === "PRODUCT_ACTIVATION_CONFIG_MISMATCH",
    );
  }
});

test("inactive catalog maintenance remains allowed for non-launch products", async () => {
  let received: Record<string, unknown> | undefined;

  await upsertBillingProduct(
    admin,
    {
      sku: "PRO_MONTHLY",
      name: "Pro Monthly",
      productType: "SUBSCRIPTION",
      priceMinor: 1_990,
      durationDays: 30,
      creditGrant: 0,
      entitlementVersion: "pro-v1",
      isActive: false,
      reason: "keep monthly disabled",
      idempotencyKey: "maintain-monthly-disabled",
    },
    repository({
      upsertProduct: async (input) => {
        received = input;
        return {
          status: "APPLIED",
          auditId: "audit-monthly",
          resourceId: "product-monthly",
        };
      },
    }),
    disabledBillingConfig,
  );

  assert.equal(received?.p_sku, "PRO_MONTHLY");
  assert.equal(received?.p_is_active, false);
});

test("refund review ignores client amounts and delegates only request id and decision", async () => {
  let received: unknown;
  const result = await reviewRefundRequest(
    admin,
    {
      requestId: "refund-request-1",
      decision: "APPROVED",
      reason: "verified",
      idempotencyKey: "refund-review-1",
    },
    repository({
      reviewRefund: async (input) => {
        received = input;
        return {
          status: "APPLIED",
          auditId: "audit-refund",
          resourceId: "refund-1",
        };
      },
    }),
  );

  assert.deepEqual(received, {
    adminUserId: "admin-1",
    requestId: "refund-request-1",
    decision: "APPROVED",
    reason: "verified",
    idempotencyKey: "refund-review-1",
  });
  assert.equal(result.auditId, "audit-refund");
});

test("reviewer role can query but cannot mutate billing state", async () => {
  await assert.rejects(
    () =>
      adjustUserCredit(
        { ...admin, role: "BILLING_REVIEWER" },
        {
          userId: "user-1",
          amount: 1,
          reason: "test",
          idempotencyKey: "credit-reviewer",
        },
        repository(),
      ),
    (error: BillingError) => error.code === "BILLING_ADMIN_WRITE_REQUIRED",
  );
});

test("paid order snapshots are read-only in the admin contract", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile("lib/billing/admin.ts", "utf8"),
  );
  assert.equal(source.includes("updateOrderAmount"), false);
  assert.equal(source.includes("amountMinor:"), false);
});

test("admin mutation SQL is service-role-only, transactional, idempotent, and audited", async () => {
  const sql = (
    await import("node:fs/promises")
  ).readFile("supabase/migrations/202607290005_billing_admin_functions.sql", "utf8");
  const text = (await sql).toLowerCase();
  for (const name of [
    "billing_admin_grant_subscription",
    "billing_admin_review_refund",
    "billing_admin_review_invoice",
    "billing_admin_upsert_plan",
    "billing_admin_upsert_product",
  ]) {
    assert.match(text, new RegExp(`function public\\.${name}`));
  }
  assert.match(text, /security definer/g);
  assert.match(text, /billing_admin_audit_logs/g);
  assert.match(text, /idempotency_key/g);
  assert.match(text, /revoke all on function/g);
  assert.match(text, /grant execute on function[\s\S]+service_role/g);
});

test("admin pages and routes enforce the server administrator boundary", async () => {
  const fs = await import("node:fs/promises");
  const pages = [
    "app/admin/billing/page.tsx",
    "app/admin/billing/orders/page.tsx",
    "app/admin/billing/users/[id]/page.tsx",
    "app/admin/billing/refunds/page.tsx",
    "app/admin/billing/invoices/page.tsx",
    "app/admin/billing/webhooks/page.tsx",
    "app/admin/billing/reconciliation/page.tsx",
  ];
  for (const file of pages) {
    assert.match(await fs.readFile(file, "utf8"), /requireBillingAdmin\(\)/);
  }
  const routes = [
    "app/api/admin/billing/route.ts",
    "app/api/admin/billing/orders/route.ts",
    "app/api/admin/billing/users/[id]/route.ts",
    "app/api/admin/billing/credits/route.ts",
    "app/api/admin/billing/subscriptions/route.ts",
    "app/api/admin/billing/refunds/route.ts",
    "app/api/admin/billing/invoices/route.ts",
    "app/api/admin/billing/webhooks/route.ts",
    "app/api/admin/billing/catalog/route.ts",
  ];
  for (const file of routes) {
    assert.match(await fs.readFile(file, "utf8"), /createAdminBillingHandler/);
  }
  assert.match(
    await fs.readFile(
      "app/api/admin/billing/reconciliation/server.ts",
      "utf8",
    ),
    /createAdminBillingHandler/,
  );
});

test("admin repositories use real schema names and include payment records", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile("lib/billing/admin.ts", "utf8"));
  assert.match(source, /amount_minor, currency, provider/);
  assert.match(source, /provider_transaction_id, status, amount_minor/);
  assert.match(source, /sku, name, product_type, price_minor/);
  assert.match(source, /credit_grant/);
  assert.match(source, /from\("billing_payments"\)/);
  assert.match(source, /payments/);
  assert.doesNotMatch(source, /payment_provider/);
  assert.doesNotMatch(source, /\bcode, name, product_type/);
  assert.doesNotMatch(source, /\bcredit_amount\b/);
});

test("all admin RPC replays bind the complete request payload", async () => {
  const sql = await import("node:fs/promises").then((fs) =>
    fs.readFile("supabase/migrations/202607290005_billing_admin_functions.sql", "utf8"));
  assert.equal((sql.match(/request_hash/g) ?? []).length >= 15, true);
  assert.equal((sql.match(/IDEMPOTENCY_CONFLICT/g) ?? []).length >= 5, true);
  assert.match(sql, /p_admin_user_id/);
  assert.match(sql, /p_decision/);
  assert.match(sql, /p_price_minor/);
});

test("after-sales reviews lock and verify the associated order contract", async () => {
  const sql = (await import("node:fs/promises")).readFile(
    "supabase/migrations/202607290005_billing_admin_functions.sql", "utf8");
  const text = await sql;
  assert.equal((text.match(/billing_orders%ROWTYPE/g) ?? []).length >= 2, true);
  assert.equal((text.match(/WHERE id=v_request\.order_id FOR UPDATE/g) ?? []).length >= 2, true);
  assert.match(text, /v_order\.user_id IS DISTINCT FROM v_request\.user_id/);
  assert.match(text, /v_order\.amount_minor IS DISTINCT FROM v_request\.requested_amount_minor/);
  assert.match(text, /GET DIAGNOSTICS v_updated = ROW_COUNT/);
});

test("forward hardening restricts credit writers and makes audit logs immutable", async () => {
  const sql = await import("node:fs/promises").then((fs) =>
    fs.readFile("supabase/migrations/202607290006_billing_admin_hardening.sql", "utf8"));
  assert.match(sql, /role = 'BILLING_ADMIN'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.billing_adjust_credit/);
  assert.match(sql, /IDEMPOTENCY_CONFLICT/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.billing_admin_audit_logs/);
  assert.match(sql, /billing_reject_audit_log_mutation/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.billing_adjust_credit_legacy[\s\S]*TO service_role/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.billing_adjust_credit_legacy[\s\S]*service_role/);
});

test("007 forward migration reapplies all corrected admin RPC definitions for upgraded databases", async () => {
  const sql = await import("node:fs/promises").then((fs) =>
    fs.readFile("supabase/migrations/202607290007_billing_admin_rpc_hardening.sql", "utf8"));
  for (const name of [
    "billing_admin_grant_subscription",
    "billing_admin_review_refund",
    "billing_admin_review_invoice",
    "billing_admin_upsert_plan",
    "billing_admin_upsert_product",
  ]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}`));
  }
  assert.equal((sql.match(/IDEMPOTENCY_CONFLICT/g) ?? []).length >= 5, true);
  assert.match(sql, /GET DIAGNOSTICS v_updated = ROW_COUNT/);
  assert.match(sql, /REVOKE ALL ON FUNCTION/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]+service_role/);
});

test("008 revokes the exact legacy credit RPC signature for databases that applied old 006", async () => {
  const sql = await import("node:fs/promises").then((fs) =>
    fs.readFile("supabase/migrations/202607290008_revoke_legacy_billing_credit_rpc.sql", "utf8"));
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.billing_adjust_credit_legacy\(UUID, BIGINT, TEXT, TEXT, UUID, TEXT\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
  );
  assert.doesNotMatch(sql, /GRANT\s+EXECUTE/i);
});

test("billing admin UI exposes writer actions while reviewers remain read-only", async () => {
  const fs = await import("node:fs/promises");
  const actions = await fs.readFile("app/admin/billing/AdminBillingActions.tsx", "utf8");
  for (const label of ["人工调整额度", "人工开通会员", "保存套餐", "保存商品", "审核退款", "审核发票"]) {
    assert.match(actions, new RegExp(label));
  }
  assert.match(actions, /canWrite/);
  assert.match(actions, /disabled=\{!canWrite/);
  const overview = await fs.readFile("app/admin/billing/page.tsx", "utf8");
  assert.match(overview, /admin\.role === "BILLING_ADMIN"/);
});
