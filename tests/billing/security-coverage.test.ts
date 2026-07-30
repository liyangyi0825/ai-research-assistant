import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const root = new URL("../../", import.meta.url);

function readProjectFile(path: string) {
  const file = new URL(path, root);
  assert.ok(existsSync(file), `missing required project file: ${path}`);
  return readFileSync(file, "utf8");
}

function declaredTestNames(path: string) {
  const source = ts.createSourceFile(
    path,
    readProjectFile(path),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();

  source.forEachChild(function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "test" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      names.add(node.arguments[0].text);
    }
    node.forEachChild(visit);
  });

  return names;
}

const securityMatrix = [
  ["创建订单", "tests/billing/orders.test.ts", "createOrder prices and snapshots the order from the enabled database product"],
  ["前端伪造价格无效", "tests/billing/order-routes.test.ts", "POST orders rejects client amount, currency, and userId fields before product access"],
  ["商品价格以后端为准", "tests/billing/orders.test.ts", "client supplied amount and currency cannot affect order pricing"],
  ["订单过期", "tests/billing/payment-service.test.ts", "createOrderPayment rejects an order whose database expiration has passed"],
  ["Mock 支付成功", "tests/billing/webhooks.test.ts", "Mock confirmation creates a stable signed callback and settles only through the webhook pipeline"],
  ["重复回调幂等", "tests/billing/webhooks.test.ts", "an identical callback is idempotent while a reused event ID with different payload is rejected"],
  ["金额不一致时拒绝处理", "tests/billing/webhooks.test.ts", "amount, order, state, and expiration failures remain audited without settlement"],
  ["已支付订单不能重复支付", "tests/billing/payment-service.test.ts", "createOrderPayment rejects paid, closed, cancelled, refunded, and failed orders"],
  ["支付成功开通会员", "tests/billing/migrations.test.ts", "settlement grants the immutable entitlement snapshot stored on the order"],
  ["支付成功增加额度", "tests/billing/migrations.test.ts", "settlement credit ledger idempotency includes the provider namespace"],
  ["重复通知不重复增加额度", "tests/billing/migrations.test.ts", "webhook replay validates request idempotency and paid timestamp"],
  ["会员到期", "tests/billing/subscriptions.test.ts", "SubscriptionService excludes a subscription whose end equals database now"],
  ["额度原子扣减", "tests/billing/credits.test.ts", "CreditService reserves quota and credits with one atomic RPC and never reads balances"],
  ["额度不足", "tests/billing/credits.test.ts", "usage RPC errors distinguish exhausted quota from insufficient credits"],
  ["并发扣减不产生负余额", "tests/billing/migrations.test.ts", "usage RPCs reserve, finalize, and release atomically by one task key"],
  ["科研任务失败后额度返还", "tests/billing/research-usage.test.ts", "ResearchUsageService releases reservations for synchronous throws and async rejection"],
  ["普通用户不能访问管理员接口", "tests/billing/admin.test.ts", "every admin handler rejects a regular user before repository access"],
  ["未勾选协议不能创建订单", "tests/billing/order-routes.test.ts", "POST orders rejects blank agreements and invalid providers"],
  ["功能关闭时公开支付入口不可用", "tests/billing/user-pages.test.ts", "disabled billing has no purchase action and production mock confirmation is gated"],
  ["生产环境普通用户不能使用 Mock", "tests/billing/config.test.ts", "production mock payments only permit an administrator or listed test user"],
] as const;

test("the billing security matrix maps every required scenario to an executable test", () => {
  assert.equal(securityMatrix.length, 20);

  for (const [requirement, path, testName] of securityMatrix) {
    assert.ok(
      declaredTestNames(path).has(testName),
      `${requirement} is not backed by ${path}: ${testName}`,
    );
  }
});

test("billing operator documentation covers safe setup, provider prerequisites, and rollback", () => {
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

  for (const migration of [
    "202607210001_billing_schema.sql",
    "202607210002_billing_rls.sql",
    "202607210003_billing_functions.sql",
    "202607230004_billing_after_sales.sql",
    "202607290005_billing_admin_functions.sql",
    "202607290006_billing_admin_hardening.sql",
    "202607290007_billing_admin_rpc_hardening.sql",
    "202607290008_revoke_legacy_billing_credit_rpc.sql",
  ]) {
    assert.match(setup, new RegExp(migration));
  }

  assert.match(security, /日志脱敏/);
  assert.match(security, /备案/);
  assert.match(rollback, /BILLING_FEATURE_ENABLED=false/);
  assert.match(rollback, /保留.*账务/);
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
