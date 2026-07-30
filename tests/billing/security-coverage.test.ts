import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { assertBillingAccess } from "../../lib/billing/auth";
import {
  assertPaymentRuntimeSafe,
  BILLING_AGREEMENT_VERSION,
  getBillingConfig,
} from "../../lib/billing/config";
import { CreditService } from "../../lib/billing/credits";
import { BillingError } from "../../lib/billing/errors";
import { createOrder, ORDER_EXPIRATION_MS } from "../../lib/billing/orders";
import { MockPaymentProvider } from "../../lib/billing/payments/mock";
import {
  ResearchUsageService,
  type ResearchUsageReservationService,
} from "../../lib/billing/research-usage";
import type {
  BillingOrder,
  BillingOrderInsert,
  BillingProduct,
  BillingRepository,
} from "../../lib/billing/repositories";
import {
  SubscriptionService,
  type SubscriptionRepository,
} from "../../lib/billing/subscriptions";
import {
  createBillingUsageRpcAdapter,
  type UsageRpcResult,
} from "../../lib/billing/usage-quota";

const root = new URL("../../", import.meta.url);

function readProjectFile(path: string) {
  const file = new URL(path, root);
  assert.ok(existsSync(file), `missing required project file: ${path}`);
  return readFileSync(file, "utf8");
}

function compactSql(path: string) {
  return readProjectFile(path)
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sqlFunction(name: string) {
  const match = compactSql(
    "supabase/migrations/202607210003_billing_functions.sql",
  ).match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`,
    ),
  );
  assert.ok(match, `missing SQL function: ${name}`);
  return match[0];
}

type CoverageLevel = "behavioral" | "static-contract";

const securityMatrix: ReadonlyArray<{
  scenario: string;
  coverageLevel: CoverageLevel;
  evidence: string;
}> = [
  { scenario: "创建订单", coverageLevel: "behavioral", evidence: "order-contract" },
  { scenario: "前端伪造价格无效", coverageLevel: "behavioral", evidence: "order-contract" },
  { scenario: "商品价格以后端为准", coverageLevel: "behavioral", evidence: "order-contract" },
  { scenario: "订单过期", coverageLevel: "behavioral", evidence: "order-contract" },
  { scenario: "Mock 支付成功", coverageLevel: "behavioral", evidence: "mock-state-machine" },
  { scenario: "重复回调幂等", coverageLevel: "static-contract", evidence: "settlement-contract" },
  { scenario: "金额不一致时拒绝处理", coverageLevel: "static-contract", evidence: "settlement-contract" },
  { scenario: "已支付订单不能重复支付", coverageLevel: "behavioral", evidence: "mock-state-machine" },
  { scenario: "支付成功开通会员", coverageLevel: "static-contract", evidence: "settlement-contract" },
  { scenario: "支付成功增加额度", coverageLevel: "static-contract", evidence: "settlement-contract" },
  { scenario: "重复通知不重复增加额度", coverageLevel: "static-contract", evidence: "settlement-contract" },
  { scenario: "会员到期", coverageLevel: "behavioral", evidence: "subscription-expiry" },
  { scenario: "额度原子扣减", coverageLevel: "static-contract", evidence: "usage-atomicity" },
  { scenario: "额度不足", coverageLevel: "behavioral", evidence: "credit-errors" },
  { scenario: "并发扣减不产生负余额", coverageLevel: "static-contract", evidence: "usage-atomicity" },
  { scenario: "科研任务失败后额度返还", coverageLevel: "behavioral", evidence: "research-release" },
  { scenario: "普通用户不能访问管理员接口", coverageLevel: "static-contract", evidence: "admin-guards" },
  { scenario: "未勾选协议不能创建订单", coverageLevel: "behavioral", evidence: "agreement-required" },
  { scenario: "功能关闭时公开支付入口不可用", coverageLevel: "behavioral", evidence: "feature-gate" },
  { scenario: "生产环境普通用户不能使用 Mock", coverageLevel: "behavioral", evidence: "feature-gate" },
];

const evidenceIds = new Set([
  "order-contract",
  "mock-state-machine",
  "settlement-contract",
  "subscription-expiry",
  "usage-atomicity",
  "credit-errors",
  "research-release",
  "admin-guards",
  "agreement-required",
  "feature-gate",
]);

function product(): BillingProduct {
  return {
    id: "product-pro",
    planId: "plan-pro",
    sku: "PRO_MONTHLY",
    name: "Pro Monthly",
    description: "Test product",
    productType: "SUBSCRIPTION",
    priceMinor: 1_990,
    currency: "CNY",
    durationDays: 30,
    creditGrant: 0,
    entitlementVersion: "pro-v1",
    isActive: true,
    displayMetadata: {},
    entitlements: [],
  };
}

class CapturingOrderRepository implements BillingRepository {
  inserted: BillingOrderInsert | null = null;

  async listActiveProducts() {
    return [product()];
  }

  async findActiveProduct() {
    return product();
  }

  async insertOrder(input: BillingOrderInsert): Promise<BillingOrder> {
    this.inserted = input;
    return {
      id: "order-id",
      ...input,
      status: "PENDING",
      paidAt: null,
      closedAt: null,
      refundStatus: "NONE",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
  }

  async findUserOrder() {
    return null;
  }
}

test("the security matrix has 20 executable behavioral or explicit static-contract entries", () => {
  assert.equal(securityMatrix.length, 20);
  assert.equal(new Set(securityMatrix.map(({ scenario }) => scenario)).size, 20);
  for (const entry of securityMatrix) {
    assert.ok(
      entry.coverageLevel === "behavioral" ||
        entry.coverageLevel === "static-contract",
    );
    assert.ok(evidenceIds.has(entry.evidence), `unknown evidence: ${entry.evidence}`);
  }
  assert.ok(securityMatrix.some(({ coverageLevel }) => coverageLevel === "behavioral"));
  assert.ok(
    securityMatrix.some(({ coverageLevel }) => coverageLevel === "static-contract"),
  );
});

test("order behavior uses the database product price and creates a finite expiration", async () => {
  const repository = new CapturingOrderRepository();
  const now = new Date("2026-07-30T00:00:00.000Z");
  const forged = {
    amountMinor: 1,
    currency: "USD",
  };

  const order = await createOrder(
    {
      userId: "user-1",
      productId: "product-pro",
      provider: "mock",
      acceptedAgreementVersion: BILLING_AGREEMENT_VERSION,
      ...forged,
    },
    {
      repository,
      paymentMode: "mock",
      now: () => now,
      createOrderNumber: () => "BILL-SECURITY-1",
    },
  );

  assert.equal(order.amountMinor, 1_990);
  assert.equal(order.currency, "CNY");
  assert.equal(order.userId, "user-1");
  assert.equal(
    Date.parse(order.expiresAt) - now.getTime(),
    ORDER_EXPIRATION_MS,
  );
  assert.equal(repository.inserted?.amountMinor, 1_990);
});

test("an unchecked agreement cannot create an order", async () => {
  await assert.rejects(
    createOrder(
      {
        userId: "user-1",
        productId: "product-pro",
        provider: "mock",
        acceptedAgreementVersion: "",
      },
      {
        repository: new CapturingOrderRepository(),
        paymentMode: "mock",
      },
    ),
    (error: unknown) =>
      error instanceof BillingError && error.code === "AGREEMENT_REQUIRED",
  );
});

test("Mock payment succeeds idempotently and cannot create a second payment", async () => {
  const provider = new MockPaymentProvider({
    secret: "test-only-secret",
    now: () => new Date("2026-07-30T00:00:00.000Z"),
  });
  const pending = await provider.createPayment({
    orderNumber: "BILL-MOCK-1",
    amountMinor: 1_990,
    currency: "CNY",
    expiresAt: "2026-07-30T00:30:00.000Z",
    idempotencyKey: "mock-create-1",
  });
  const paid = await provider.confirmPayment({
    providerTransactionId: pending.providerTransactionId,
  });

  assert.equal(paid.status, "PAID");
  assert.equal(paid.amountMinor, 1_990);
  const replay = await provider.confirmPayment({
    providerTransactionId: pending.providerTransactionId,
  });
  assert.deepEqual(replay, paid);
  await assert.rejects(
    provider.createPayment({
      orderNumber: "BILL-MOCK-1",
      amountMinor: 1_990,
      currency: "CNY",
      expiresAt: "2026-07-30T00:30:00.000Z",
      idempotencyKey: "mock-create-2",
    }),
    (error: unknown) =>
      error instanceof BillingError && error.code === "PAYMENT_ALREADY_EXISTS",
  );
});

test("settlement static contract locks and validates before idempotent grants", () => {
  const settle = sqlFunction("billing_settle_paid_order");
  const schema = compactSql(
    "supabase/migrations/202607210001_billing_schema.sql",
  );

  assert.match(settle, /from public\.billing_webhook_events[\s\S]*?for update/);
  assert.match(settle, /from public\.billing_orders[\s\S]*?for update/);
  assert.match(settle, /v_order\.amount_minor is distinct from p_amount_minor/);
  assert.match(settle, /v_order\.currency is distinct from upper\(p_currency\)/);
  assert.match(settle, /v_existing_event\.status = 'processed'/);
  assert.match(settle, /insert into public\.billing_subscriptions/);
  assert.match(settle, /insert into public\.billing_user_entitlements/);
  assert.match(
    settle,
    /from public\.billing_credit_accounts[\s\S]*?for update[\s\S]*?available_balance = available_balance \+ v_credit_grant/,
  );
  assert.match(settle, /insert into public\.billing_credit_ledger/);
  assert.match(
    settle,
    /'settlement:' \|\| upper\(p_provider\) \|\| ':' \|\| p_provider_event_id \|\| ':credit'/,
  );
  assert.ok(
    settle.indexOf("v_existing_event.status = 'processed'") <
      settle.indexOf("insert into public.billing_subscriptions"),
  );
  assert.match(schema, /unique \(provider, provider_event_id\)/);
  assert.match(schema, /idempotency_key text not null unique/);
});

test("usage static contract serializes reservations and prevents negative balances", () => {
  const reserve = sqlFunction("billing_reserve_usage");
  const release = sqlFunction("billing_release_usage");
  const schema = compactSql(
    "supabase/migrations/202607210001_billing_schema.sql",
  );

  assert.match(reserve, /pg_advisory_xact_lock/);
  assert.match(reserve, /from public\.billing_usage_records[\s\S]*?for update/);
  assert.match(reserve, /from public\.billing_usage_quotas[\s\S]*?for update/);
  assert.match(reserve, /from public\.billing_credit_accounts[\s\S]*?for update/);
  assert.match(
    reserve,
    /available_balance = available_balance - p_credit_amount[\s\S]*?reserved_balance = reserved_balance \+ p_credit_amount/,
  );
  assert.match(reserve, /and available_balance >= p_credit_amount/);
  assert.match(
    reserve,
    /reserved_units \+ used_units \+ p_quota_units <= quota_limit/,
  );
  assert.match(release, /pg_advisory_xact_lock/);
  assert.match(
    release,
    /available_balance = available_balance \+ v_record\.credit_amount[\s\S]*?reserved_balance = reserved_balance - v_record\.credit_amount/,
  );
  assert.match(release, /and reserved_balance >= v_record\.credit_amount/);
  assert.match(schema, /check \(available_balance >= 0\)/);
  assert.match(schema, /check \(reserved_balance >= 0\)/);
});

test("insufficient credit database errors map to a closed behavioral denial", async () => {
  const adapter = createBillingUsageRpcAdapter({
    rpc: async () => ({
      data: null,
      error: { message: "insufficient credit balance" },
    }),
  });

  await assert.rejects(
    new CreditService(adapter).reserve({
      userId: "user-1",
      taskKey: "task-1",
      featureKey: "deep-research",
      quotaUnits: 1,
      creditAmount: 10,
    }),
    (error: unknown) =>
      error instanceof BillingError && error.code === "INSUFFICIENT_CREDITS",
  );
});

test("expired membership is denied by the subscription service", async () => {
  const repository: SubscriptionRepository = {
    async findCurrentSubscription() {
      return null;
    },
  };

  await assert.rejects(
    new SubscriptionService(repository).requireActiveSubscription("user-1"),
    (error: unknown) =>
      error instanceof BillingError && error.code === "SUBSCRIPTION_REQUIRED",
  );
});

test("a failed research task behavior releases the exact reservation", async () => {
  const events: string[] = [];
  const usage: ResearchUsageReservationService = {
    async reserve(): Promise<UsageRpcResult> {
      events.push("reserve");
      return {
        status: "RESERVED",
        usageRecordId: "usage-1",
        idempotent: false,
      };
    },
    async finalize(): Promise<UsageRpcResult> {
      events.push("finalize");
      return {
        status: "FINALIZED",
        usageRecordId: "usage-1",
        idempotent: false,
      };
    },
    async release(userId, taskKey): Promise<UsageRpcResult> {
      events.push(`release:${userId}:${taskKey}`);
      return {
        status: "RELEASED",
        usageRecordId: "usage-1",
        idempotent: false,
      };
    },
  };
  const service = new ResearchUsageService({
    entitlements: { requireEntitlement: async () => undefined },
    usage,
  });

  await assert.rejects(
    service.run(
      {
        userId: "user-1",
        taskKey: "task-failed",
        featureKey: "deep-research",
        quotaUnits: 1,
        creditAmount: 10,
      },
      async () => {
        throw new Error("provider failed");
      },
    ),
    /provider failed/,
  );
  assert.deepEqual(events, ["reserve", "release:user-1:task-failed"]);
});

test("every billing admin route delegates through the server-side admin guard", () => {
  const routes = [
    "app/api/admin/billing/route.ts",
    "app/api/admin/billing/catalog/route.ts",
    "app/api/admin/billing/credits/route.ts",
    "app/api/admin/billing/invoices/route.ts",
    "app/api/admin/billing/orders/route.ts",
    "app/api/admin/billing/refunds/route.ts",
    "app/api/admin/billing/subscriptions/route.ts",
    "app/api/admin/billing/users/[id]/route.ts",
    "app/api/admin/billing/webhooks/route.ts",
  ];
  const guard = readProjectFile("lib/billing/admin.ts");

  assert.match(
    guard,
    /dependencies\.requireAdmin \?\? requireBillingAdmin/,
  );
  for (const route of routes) {
    const source = readProjectFile(route);
    assert.match(source, /createAdminBillingHandler/);
    assert.doesNotMatch(source, /requireBillingUser/);
  }
});

test("disabled billing and production Mock both fail closed for unauthorized users", () => {
  const disabled = getBillingConfig({
    BILLING_FEATURE_ENABLED: "false",
    PAYMENT_MODE: "mock",
  });
  assert.throws(
    () =>
      assertBillingAccess(
        { id: "user-1", email: "user@example.test", isAdmin: false },
        disabled,
      ),
    (error: unknown) =>
      error instanceof BillingError && error.code === "BILLING_FEATURE_DISABLED",
  );

  const productionMock = getBillingConfig({
    NODE_ENV: "production",
    BILLING_FEATURE_ENABLED: "true",
    PAYMENT_MODE: "mock",
    BILLING_TEST_USER_IDS: "test-user",
  });
  assert.throws(
    () =>
      assertPaymentRuntimeSafe(productionMock, {
        userId: "ordinary-user",
        isAdmin: false,
      }),
    (error: unknown) =>
      error instanceof BillingError && error.code === "MOCK_PAYMENT_NOT_ALLOWED",
  );

  const pricing = readProjectFile("components/billing/PricingProducts.tsx");
  assert.match(pricing, /availability\?\.available/);
  assert.match(pricing, /当前账号暂未开放购买/);
});

test("operator docs distinguish static SQL contracts from real PostgreSQL verification", () => {
  const setup = readProjectFile("docs/billing-setup.md");
  const security = readProjectFile("docs/billing-security.md");
  const rollback = readProjectFile("docs/billing-rollback.md");
  const combined = `${setup}\n${security}\n${rollback}`;

  for (const variable of [
    "BILLING_FEATURE_ENABLED",
    "PAYMENT_MODE",
    "BILLING_TEST_USER_IDS",
    "LEGAL_OPERATOR_NAME",
    "LEGAL_OPERATOR_CREDIT_CODE",
    "LEGAL_CONTACT_EMAIL",
    "WECHAT_PAY_MCH_ID",
    "WECHAT_PAY_APP_ID",
    "WECHAT_PAY_API_V3_KEY",
    "WECHAT_PAY_MCH_PRIVATE_KEY",
    "WECHAT_PAY_MCH_SERIAL_NO",
    "WECHAT_PAY_PLATFORM_CERT",
    "WECHAT_PAY_NOTIFY_URL",
    "ALIPAY_APP_ID",
    "ALIPAY_APP_PRIVATE_KEY",
    "ALIPAY_PUBLIC_KEY",
    "ALIPAY_NOTIFY_URL",
    "ALIPAY_RETURN_URL",
  ]) {
    assert.match(combined, new RegExp(`\\b${variable}\\b`));
  }

  assert.match(setup, /未连接真实 PostgreSQL\/Supabase/);
  assert.match(setup, /静态 SQL 合约测试/);
  assert.match(security, /日志脱敏/);
  assert.match(security, /备案/);
  assert.match(rollback, /BILLING_FEATURE_ENABLED=false/);
  assert.match(rollback, /向前修复/);
  assert.match(rollback, /不得删除.*账务/);
});

test("protected filing, deployment, and user-dirty files remain identical to the audited base", () => {
  const protectedPaths = [
    "components/SiteFilingFooter.tsx",
    "public/beian-police.png",
    "app/layout.tsx",
    ".github/workflows/deploy.yml",
    "deploy.sh",
    "app/api/translate-page/route.ts",
    "components/PdfTranslationView.tsx",
  ];
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "1138955", "--", ...protectedPaths],
    { cwd: root, encoding: "utf8" },
  )
    .split(/\r?\n/)
    .filter(Boolean);

  assert.deepEqual(changed, []);
});
