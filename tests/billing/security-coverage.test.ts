import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import ts from "typescript";

import { assertBillingAccess } from "../../lib/billing/auth";
import {
  assertPaymentRuntimeSafe,
  BILLING_AGREEMENT_VERSION,
  getBillingConfig,
} from "../../lib/billing/config";
import { CreditService } from "../../lib/billing/credits";
import { BillingError } from "../../lib/billing/errors";
import { getPaymentProvider } from "../../lib/billing/payments/registry";
import { loadWechatPayConfig } from "../../lib/billing/payments/wechat-config";
import { WechatHttpClient } from "../../lib/billing/payments/wechat-transport";
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
import { createBillingSecurityLogger } from "../../lib/billing/security-logger";
import {
  createBillingUsageRpcAdapter,
  type UsageRpcResult,
} from "../../lib/billing/usage-quota";

const root = new URL("../../", import.meta.url);
const rootDirectory = fileURLToPath(root);

function readProjectFile(path: string) {
  const file = new URL(path, root);
  assert.ok(existsSync(file), `missing required project file: ${path}`);
  return readFileSync(file, "utf8");
}

function parseExampleEnvironment(contents: string): Record<string, string> {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function collectEnumerableStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Object.keys(value).flatMap((key) => [
    key,
    ...collectEnumerableStrings((value as Record<string, unknown>)[key], seen),
  ]);
}

function collectReflectiveStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value instanceof ArrayBuffer) return [Buffer.from(value).toString("utf8")];
  if (ArrayBuffer.isView(value)) return [Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8")];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return Reflect.ownKeys(value).flatMap((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return [String(key), ...(descriptor && "value" in descriptor
      ? collectReflectiveStrings(descriptor.value, seen)
      : [])];
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path))
        ? [path]
        : [];
  });
}

function resolveLocalImport(from: string, specifier: string): string | null {
  const unresolved = specifier.startsWith("@/")
    ? join(rootDirectory, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (unresolved === null) return null;

  for (const candidate of [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${unresolved}.mts`,
    `${unresolved}.cts`,
    `${unresolved}.js`,
    `${unresolved}.jsx`,
    `${unresolved}.mjs`,
    `${unresolved}.cjs`,
    join(unresolved, "index.ts"),
    join(unresolved, "index.tsx"),
    join(unresolved, "index.js"),
    join(unresolved, "index.jsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function staticModuleSpecifier(node: ts.Expression | undefined): string | null {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function runtimeModuleSpecifiers(source: string, path: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const namedBindings = clause?.namedBindings;
      const typeOnlyNamedImport =
        namedBindings !== undefined &&
        ts.isNamedImports(namedBindings) &&
        namedBindings.elements.length > 0 &&
        namedBindings.elements.every((element) => element.isTypeOnly);
      if (
        clause === undefined ||
        (!clause.isTypeOnly &&
          (clause.name !== undefined ||
            namedBindings === undefined ||
            ts.isNamespaceImport(namedBindings) ||
            !typeOnlyNamedImport))
      ) {
        const specifier = staticModuleSpecifier(node.moduleSpecifier);
        if (specifier !== null) specifiers.push(specifier);
      }
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const typeOnlyNamedExport =
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((element) => element.isTypeOnly);
      if (!node.isTypeOnly && !typeOnlyNamedExport) {
        const specifier = staticModuleSpecifier(node.moduleSpecifier);
        if (specifier !== null) specifiers.push(specifier);
      }
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = staticModuleSpecifier(node.moduleReference.expression);
      if (specifier !== null) specifiers.push(specifier);
      return;
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const specifier = staticModuleSpecifier(node.arguments[0]);
        if (specifier !== null) specifiers.push(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isClientEntry(path: string): boolean {
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    ) {
      if (statement.expression.text === "use client") return true;
      continue;
    }
    return false;
  }
  return false;
}

function clientImportGraph(start: string, seen = new Set<string>()): string[] {
  if (seen.has(start)) return [];
  seen.add(start);
  const source = readFileSync(start, "utf8");
  const imports = runtimeModuleSpecifiers(source, start)
    .map((specifier) => resolveLocalImport(start, specifier))
    .filter((path): path is string => path !== null);

  return [start, ...imports.flatMap((path) => clientImportGraph(path, seen))];
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
    description: "Mock Membership",
    amountMinor: 1_990,
    currency: "CNY",
    expiresAt: "2026-07-30T00:30:00.000Z",
    idempotencyKey: "mock-create-1",
  });
  const paid = await provider.confirmPayment({
    orderNumber: pending.orderNumber,
    providerTransactionId: pending.providerTransactionId,
  });

  assert.equal(paid.status, "PAID");
  assert.equal(paid.amountMinor, 1_990);
  const replay = await provider.confirmPayment({
    orderNumber: pending.orderNumber,
    providerTransactionId: pending.providerTransactionId,
  });
  assert.deepEqual(replay, paid);
  await assert.rejects(
    provider.createPayment({
      orderNumber: "BILL-MOCK-1",
      description: "Mock Membership",
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
  for (const server of [
    "app/api/admin/billing/reconciliation/server.ts",
    "app/api/admin/billing/refunds/server.ts",
  ]) {
    const source = readProjectFile(server);
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

test("WeChat secrets are absent from reflective config, provider, transport, errors, logs, and API-like results", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sentinel = "S".repeat(32);
  const environment = {
    BILLING_FEATURE_ENABLED: "true",
    PAYMENT_MODE: "wechat",
    WECHAT_PAY_MCH_ID: "1900000109",
    WECHAT_PAY_APP_ID: "wx1234567890abcdef",
    WECHAT_PAY_API_V3_KEY: sentinel,
    WECHAT_PAY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    WECHAT_PAY_CERT_SERIAL_NO: "ABCDEF0123456789",
    WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_00000000000000000000000000000001",
    WECHAT_PAY_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    WECHAT_PAY_NOTIFY_URL: "https://billing.test/wechat/callback",
  };
  const config = getBillingConfig(environment);
  const httpClient = new WechatHttpClient({
    config: loadWechatPayConfig(environment),
    fetchImpl: async () => {
      throw new Error("offline security test");
    },
  });
  const provider = getPaymentProvider("wechat", config);
  const logged: string[] = [];
  const logger = createBillingSecurityLogger((line) => logged.push(line));
  let startupError: unknown;
  try {
    getBillingConfig({ ...environment, WECHAT_PAY_MCH_ID: undefined });
  } catch (error) {
    startupError = error;
  }
  assert.ok(startupError instanceof BillingError);
  logger.warn({
    eventCode: "PAYMENT_CREATE_FAILED",
    provider: "WECHAT",
    errorCode: startupError.code,
    status: startupError.message,
  });

  const apiLikeResults = [
    { ok: true, data: { config, provider, httpClient } },
    { ok: false, error: startupError },
    JSON.parse(JSON.stringify({ config, startupError })),
  ];
  const targets = [config, provider, httpClient, startupError, logged, apiLikeResults];
  const visible = targets.flatMap((target) => [
    ...collectEnumerableStrings(target),
    ...collectReflectiveStrings(target),
    ...collectReflectiveStrings(Object.getOwnPropertyDescriptors(target)),
    ...Reflect.ownKeys(target).map(String),
    JSON.stringify(target),
    inspect(target, { showHidden: true, depth: null }),
  ]);

  for (const secret of [
    sentinel,
    "merchant-secret-sentinel",
    "app-secret-sentinel",
    "merchant-cert-sentinel",
    "public-key-id-sentinel",
    environment.WECHAT_PAY_NOTIFY_URL,
    environment.WECHAT_PAY_PRIVATE_KEY,
    environment.WECHAT_PAY_PUBLIC_KEY,
  ]) {
    assert.equal(visible.some((value) => value.includes(secret)), false);
  }
});

test("the safe environment example leaves billing disabled and declares empty exactly-one verifier inputs", () => {
  const environment = parseExampleEnvironment(readProjectFile(".env.example"));

  assert.equal(environment.BILLING_FEATURE_ENABLED, "false");
  assert.equal(environment.PAYMENT_MODE, "mock");
  assert.equal(environment.WECHAT_PAY_PUBLIC_KEY_ID, "");
  assert.equal(environment.WECHAT_PAY_PUBLIC_KEY, "");
});

test("the offline font build wrapper restores both present and absent caller environments", () => {
  const script = resolve(
    rootDirectory,
    "tests/fixtures/run-next-build-offline.ps1",
  );
  assert.ok(existsSync(script), "missing isolated offline build wrapper");
  const variable = "NEXT_FONT_GOOGLE_MOCKED_RESPONSES";
  const original = process.env[variable];
  const presentSentinel = "SENTINEL_PARENT_FONT_ENV";
  const presentOutput = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-VerifyEnvironmentIsolation",
    ],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      env: { ...process.env, [variable]: presentSentinel },
    },
  ).trim();
  assert.equal(presentOutput, `restored:${presentSentinel}`);

  const absentEnvironment = { ...process.env };
  delete absentEnvironment[variable];
  const absentOutput = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-VerifyEnvironmentIsolation",
    ],
    { cwd: rootDirectory, encoding: "utf8", env: absentEnvironment },
  ).trim();
  assert.equal(absentOutput, "restored:<absent>");
  assert.equal(process.env[variable], original);

  const operatorDocs = readProjectFile("docs/billing-fast-launch.md");
  assert.match(
    operatorDocs,
    /powershell\.exe -NoProfile -ExecutionPolicy Bypass -File tests\/fixtures\/run-next-build-offline\.ps1/,
  );
  assert.doesNotMatch(
    operatorDocs,
    /\$env:NEXT_FONT_GOOGLE_MOCKED_RESPONSES\s*=/,
  );
});

test("client graph classification permits type-only imports but follows static, dynamic, and require edges", () => {
  assert.deepEqual(
    runtimeModuleSpecifiers(
      `
        import type { BillingConfig } from "@/lib/billing/config-types";
        import { type PaymentMode } from "@/lib/billing/config-types";
        export type { BillingConfig as PublicConfig } from "@/lib/billing/config-types";
      `,
      "type-only.ts",
    ),
    [],
  );
  assert.deepEqual(
    runtimeModuleSpecifiers(
      `
        import { getBillingConfig } from "@/lib/billing/config";
        void import("@/lib/billing/payments/registry");
        require("@/lib/billing/payments/wechat-config");
      `,
      "runtime.ts",
    ),
    [
      "@/lib/billing/config",
      "@/lib/billing/payments/registry",
      "@/lib/billing/payments/wechat-config",
    ],
  );
});

test("no client component runtime import graph can reach WeChat server modules", () => {
  const serverModules = [
    "lib/billing/config.ts",
    "lib/billing/payments/registry.ts",
    "lib/billing/payments/wechat-config.ts",
    "lib/billing/payments/wechat-transport.ts",
    "lib/billing/payments/wechat.ts",
  ].map((path) => resolve(rootDirectory, path));
  const clientEntries = sourceFiles(join(rootDirectory, "app"))
    .concat(sourceFiles(join(rootDirectory, "components")))
    .filter(isClientEntry);

  for (const entry of clientEntries) {
    const graph = clientImportGraph(entry);
    for (const serverModule of serverModules) {
      assert.equal(
        graph.includes(serverModule),
        false,
        `client import graph reached ${serverModule} from ${entry}`,
      );
    }
  }
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

test("approved filing values are present while deployment files remain unchanged", () => {
  const filing = readProjectFile("components/SiteFilingFooter.tsx");
  assert.match(filing, /冀ICP备2026029358号/);
  assert.match(filing, /冀公网安备13028302000277号/);

  const protectedPaths = [
    "components/SiteFilingFooter.tsx",
    "public/beian-police.png",
    "app/layout.tsx",
    ".github/workflows/deploy.yml",
    "deploy.sh",
  ];
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "24e1da9", "--", ...protectedPaths],
    { cwd: root, encoding: "utf8" },
  )
    .split(/\r?\n/)
    .filter(Boolean);

  assert.deepEqual(changed, []);
});
