import assert from "node:assert/strict";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import {
  adjustUserCredit,
  createAdminBillingHandler,
  grantUserSubscription,
  reviewRefundRequest,
  type BillingAdminRepository,
} from "../../lib/billing/admin";

const admin = {
  id: "admin-1",
  email: "admin@example.test",
  isAdmin: true as const,
  role: "BILLING_ADMIN" as const,
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
