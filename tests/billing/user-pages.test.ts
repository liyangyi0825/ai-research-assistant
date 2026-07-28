import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { BillingUser } from "../../lib/billing/auth";
import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import type { BillingOrder } from "../../lib/billing/repositories";
import type {
  BillingSummary,
  BillingUserPageRepository,
} from "../../lib/billing/user-pages";

async function userPagesModule() {
  try {
    return await import("../../lib/billing/user-pages");
  } catch {
    assert.fail("lib/billing/user-pages.ts must exist");
  }
}

async function source(relativePath: string): Promise<string> {
  try {
    return await readFile(path.join(process.cwd(), relativePath), "utf8");
  } catch {
    assert.fail(`${relativePath} must exist`);
  }
}

function billingConfig(
  overrides: Partial<BillingConfig> = {},
): BillingConfig {
  return {
    featureEnabled: false,
    paymentMode: "mock",
    testUserIds: [],
    legal: {
      operatorName: "",
      operatorCreditCode: "",
      contactEmail: "",
    },
    wechatConfigured: false,
    alipayConfigured: false,
    isProduction: false,
    ...overrides,
  };
}

function user(overrides: Partial<BillingUser> = {}): BillingUser {
  return {
    id: "user-1",
    email: "student@example.edu.cn",
    isAdmin: false,
    ...overrides,
  };
}

function order(overrides: Partial<BillingOrder> = {}): BillingOrder {
  return {
    id: "order-1",
    orderNumber: "BILL-ORDER-1",
    userId: "user-1",
    productId: "product-1",
    provider: "MOCK",
    status: "PAID",
    amountMinor: 3990,
    currency: "CNY",
    snapshotProductName: "科研月度方案",
    snapshotProductType: "SUBSCRIPTION",
    snapshotPlanId: "plan-1",
    snapshotDurationDays: 30,
    snapshotCreditGrant: 1200,
    snapshotEntitlementVersion: "research-v1",
    snapshotEntitlements: [],
    snapshotDetails: {},
    acceptedAgreementVersion: "billing-v1",
    expiresAt: "2026-07-28T09:30:00.000Z",
    paidAt: "2026-07-28T09:02:00.000Z",
    closedAt: null,
    refundStatus: "NONE",
    createdAt: "2026-07-28T09:00:00.000Z",
    updatedAt: "2026-07-28T09:02:00.000Z",
    ...overrides,
  };
}

function summary(): BillingSummary {
  return {
    subscription: {
      planId: "plan-1",
      planName: "科研月度方案",
      startsAt: "2026-07-01T00:00:00.000Z",
      endsAt: "2026-08-01T00:00:00.000Z",
    },
    credits: {
      available: 800,
      reserved: 20,
    },
    quotas: [
      {
        featureKey: "deep_research",
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-08-01T00:00:00.000Z",
        limit: 100,
        reserved: 2,
        used: 18,
      },
    ],
    orders: [
      {
        id: "order-1",
        orderNumber: "BILL-ORDER-1",
        status: "PAID",
        productName: "科研月度方案",
        amountMinor: 3990,
        currency: "CNY",
        refundStatus: "NONE",
        createdAt: "2026-07-28T09:00:00.000Z",
        paidAt: "2026-07-28T09:02:00.000Z",
      },
    ],
    usage: [],
    refunds: [],
    invoices: [],
  };
}

function repository(
  overrides: Partial<BillingUserPageRepository> = {},
): BillingUserPageRepository {
  return {
    async getSummary() {
      return summary();
    },
    async findUserOrder() {
      return order();
    },
    async upsertRefundRequest(input) {
      return {
        id: "refund-request-1",
        orderId: input.orderId,
        status: "PENDING",
        requestedAmountMinor: input.requestedAmountMinor,
        currency: input.currency,
        reasonCode: input.reasonCode,
        details: input.details,
        createdAt: "2026-07-28T10:00:00.000Z",
      };
    },
    async upsertInvoiceRequest(input) {
      return {
        id: "invoice-request-1",
        orderId: input.orderId,
        status: "PENDING",
        titleType: input.titleType,
        invoiceTitle: input.invoiceTitle,
        taxIdentifier: input.taxIdentifier,
        amountMinor: input.amountMinor,
        currency: input.currency,
        deliveryEmail: input.deliveryEmail,
        createdAt: "2026-07-28T10:00:00.000Z",
      };
    },
    ...overrides,
  };
}

test("Task 9 pages, focused components, and route handlers exist", async () => {
  const expectedFiles = [
    "app/pricing/page.tsx",
    "app/checkout/[productId]/page.tsx",
    "app/billing/page.tsx",
    "app/billing/orders/[id]/page.tsx",
    "app/billing/payment-result/page.tsx",
    "app/api/billing/availability/route.ts",
    "app/api/billing/summary/route.ts",
    "app/api/billing/refunds/route.ts",
    "app/api/billing/invoices/route.ts",
    "components/billing/PricingProducts.tsx",
    "components/billing/CheckoutPanel.tsx",
    "components/billing/BillingCenter.tsx",
    "components/billing/OrderDetail.tsx",
    "components/billing/PaymentResult.tsx",
    "components/billing/ResearchResourceScale.tsx",
  ];

  for (const file of expectedFiles) {
    assert.ok((await source(file)).length > 0, file);
  }
});

test("pricing and checkout use backend products without embedded prices or quotas", async () => {
  const pricing = await source("components/billing/PricingProducts.tsx");
  const checkout = await source("components/billing/CheckoutPanel.tsx");
  const combined = `${pricing}\n${checkout}`;

  assert.match(pricing, /\/api\/billing\/products/);
  assert.match(checkout, /\/api\/billing\/products/);
  assert.match(checkout, /acceptedAgreement/);
  assert.match(checkout, /disabled=\{[^}]*!acceptedAgreement/);
  assert.match(checkout, /\/api\/billing\/orders/);
  assert.doesNotMatch(
    combined,
    /(?:priceMinor|creditGrant|periodicLimit|quotaLimit)\s*:\s*\d/,
  );
  assert.doesNotMatch(combined, /[¥￥]\s*\d/);

  const orderRequest = checkout.slice(checkout.indexOf("/api/billing/orders"));
  assert.doesNotMatch(orderRequest, /\b(?:amount|currency|userId)\s*:/);
});

test("disabled billing has no purchase action and production mock confirmation is gated", async () => {
  const pricingPage = await source("app/pricing/page.tsx");
  const checkoutPage = await source("app/checkout/[productId]/page.tsx");
  const paymentPage = await source("app/billing/payment-result/page.tsx");
  const paymentComponent = await source(
    "components/billing/PaymentResult.tsx",
  );
  const unavailableComponent = await source(
    "components/billing/BillingFeatureUnavailable.tsx",
  );
  const sidebar = await source("components/Sidebar.tsx");

  for (const contents of [pricingPage, checkoutPage, paymentPage]) {
    assert.match(contents, /BillingFeatureUnavailable/);
    assert.match(contents, /getBillingConfig/);
  }
  assert.match(unavailableComponent, /收费功能暂未开放/);
  assert.match(paymentComponent, /mockConfirmationAllowed/);
  assert.match(sidebar, /\/api\/billing\/availability/);
  assert.match(sidebar, /useState\(false\)/);
  assert.doesNotMatch(sidebar, /process\.env\.BILLING_FEATURE_ENABLED/);
});

test("AppShell bypasses independent billing routes instead of mounting SPA tabs", async () => {
  const appShell = await source("components/AppShell.tsx");

  assert.match(appShell, /BILLING_PATHS/);
  assert.match(appShell, /"\/billing"/);
  assert.match(appShell, /"\/pricing"/);
  assert.match(appShell, /"\/checkout"/);
  assert.match(appShell, /isBillingPage/);
  assert.match(appShell, /isBypassPage\s*\|\|\s*isBillingPage/);
});

test("availability fails closed and only enables production mock for a test user or admin", async () => {
  const { createBillingAvailabilityGetHandler } = await userPagesModule();
  const events: string[] = [];
  const disabled = createBillingAvailabilityGetHandler({
    getConfig: () => billingConfig(),
    requireUser: async () => {
      events.push("unexpected-auth");
      return user();
    },
    requireAdmin: async () => {
      events.push("unexpected-admin");
      return { ...user(), isAdmin: true, role: "BILLING_ADMIN" };
    },
  });

  const disabledResponse = await disabled();
  assert.equal(disabledResponse.status, 200);
  assert.deepEqual(await disabledResponse.json(), {
    available: false,
    paymentMode: null,
    mockConfirmationAllowed: false,
  });
  assert.deepEqual(events, []);

  const productionUser = createBillingAvailabilityGetHandler({
    getConfig: () =>
      billingConfig({
        featureEnabled: true,
        isProduction: true,
        testUserIds: ["allowed-user"],
      }),
    requireUser: async () => user(),
    requireAdmin: async () => {
      throw new BillingError("BILLING_ADMIN_REQUIRED", "denied", 403);
    },
  });
  assert.deepEqual(await (await productionUser()).json(), {
    available: false,
    paymentMode: null,
    mockConfirmationAllowed: false,
  });

  const productionTestUser = createBillingAvailabilityGetHandler({
    getConfig: () =>
      billingConfig({
        featureEnabled: true,
        isProduction: true,
        testUserIds: ["user-1"],
      }),
    requireUser: async () => user(),
    requireAdmin: async () => {
      throw new Error("whitelisted users must not need admin lookup");
    },
  });
  assert.deepEqual(await (await productionTestUser()).json(), {
    available: true,
    paymentMode: "mock",
    mockConfirmationAllowed: true,
  });
});

test("billing summary authenticates server-side and hides storage errors", async () => {
  const { createBillingSummaryGetHandler } = await userPagesModule();
  const events: string[] = [];
  const handler = createBillingSummaryGetHandler({
    requireUser: async () => {
      events.push("auth");
      return user();
    },
    getSummary: async (userId: string) => {
      events.push(`summary:${userId}`);
      return summary();
    },
  });

  const response = await handler();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { summary: summary() });
  assert.deepEqual(events, ["auth", "summary:user-1"]);

  const failure = createBillingSummaryGetHandler({
    requireUser: async () => user(),
    getSummary: async () => {
      throw new Error("postgres password=secret");
    },
  });
  const failedResponse = await failure();
  const body = await failedResponse.json();
  assert.equal(failedResponse.status, 500);
  assert.deepEqual(body, {
    error: {
      code: "INTERNAL_BILLING_ERROR",
      message: "账单信息暂时无法加载，请稍后重试。",
    },
  });
  assert.equal(JSON.stringify(body).includes("password=secret"), false);
});

test("refund handler rejects client authority fields and validates reason input", async () => {
  const { createRefundPostHandler } = await userPagesModule();
  const submitted: unknown[] = [];
  const handler = createRefundPostHandler({
    requireUser: async () => user(),
    getConfig: () => billingConfig({ featureEnabled: true }),
    assertAccess: () => undefined,
    submitRefund: async (input) => {
      submitted.push(input);
      return {
        id: "refund-request-1",
        orderId: input.orderId,
        status: "PENDING",
        requestedAmountMinor: 3990,
        currency: "CNY",
        reasonCode: input.reasonCode,
        details: input.details,
        createdAt: "2026-07-28T10:00:00.000Z",
      };
    },
  });

  const forbidden = await handler(
    new Request("http://localhost/api/billing/refunds", {
      method: "POST",
      body: JSON.stringify({
        orderId: "order-1",
        reasonCode: "OTHER",
        details: "不再需要该科研套餐。",
        amount: 1,
        currency: "CNY",
        userId: "attacker",
      }),
    }),
  );
  assert.equal(forbidden.status, 400);

  const invalidEnum = await handler(
    new Request("http://localhost/api/billing/refunds", {
      method: "POST",
      body: JSON.stringify({
        orderId: "order-1",
        reasonCode: "INSTANT_REFUND",
        details: "绕过人工审核的非法选项。",
      }),
    }),
  );
  assert.equal(invalidEnum.status, 400);

  const tooLong = await handler(
    new Request("http://localhost/api/billing/refunds", {
      method: "POST",
      body: JSON.stringify({
        orderId: "order-1",
        reasonCode: "OTHER",
        details: "x".repeat(501),
      }),
    }),
  );
  assert.equal(tooLong.status, 400);
  assert.deepEqual(submitted, []);

  const accepted = await handler(
    new Request("http://localhost/api/billing/refunds", {
      method: "POST",
      body: JSON.stringify({
        orderId: "order-1",
        reasonCode: "OTHER",
        details: "研究计划发生变化，不再需要该套餐。",
      }),
    }),
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(submitted, [
    {
      userId: "user-1",
      orderId: "order-1",
      reasonCode: "OTHER",
      details: "研究计划发生变化，不再需要该套餐。",
    },
  ]);
});

test("refund service verifies ownership and state and derives money from the order", async () => {
  const { submitRefundRequest } = await userPagesModule();

  await assert.rejects(
    submitRefundRequest(
      {
        userId: "user-1",
        orderId: "missing",
        reasonCode: "NO_LONGER_NEEDED",
        details: "",
      },
      { repository: repository({ findUserOrder: async () => null }) },
    ),
    (error) =>
      error instanceof BillingError &&
      error.code === "ORDER_NOT_FOUND" &&
      error.status === 404,
  );

  await assert.rejects(
    submitRefundRequest(
      {
        userId: "user-1",
        orderId: "order-1",
        reasonCode: "NO_LONGER_NEEDED",
        details: "",
      },
      {
        repository: repository({
          findUserOrder: async () => order({ status: "PENDING" }),
        }),
      },
    ),
    (error) =>
      error instanceof BillingError &&
      error.code === "REFUND_NOT_ALLOWED" &&
      error.status === 409,
  );

  let upsertInput: unknown;
  const result = await submitRefundRequest(
    {
      userId: "user-1",
      orderId: "order-1",
      reasonCode: "SERVICE_ISSUE",
      details: "服务结果未满足研究任务需要。",
    },
    {
      repository: repository({
        upsertRefundRequest: async (input) => {
          upsertInput = input;
          return {
            id: "refund-request-1",
            orderId: input.orderId,
            status: "PENDING",
            requestedAmountMinor: input.requestedAmountMinor,
            currency: input.currency,
            reasonCode: input.reasonCode,
            details: input.details,
            createdAt: "2026-07-28T10:00:00.000Z",
          };
        },
      }),
    },
  );

  assert.equal(result.status, "PENDING");
  assert.deepEqual(upsertInput, {
    userId: "user-1",
    orderId: "order-1",
    requestedAmountMinor: 3990,
    currency: "CNY",
    reasonCode: "SERVICE_ISSUE",
    details: "服务结果未满足研究任务需要。",
  });
});

test("invoice handler validates enum, title, tax identifier, and email", async () => {
  const { createInvoicePostHandler } = await userPagesModule();
  const submitted: unknown[] = [];
  const handler = createInvoicePostHandler({
    requireUser: async () => user(),
    getConfig: () => billingConfig({ featureEnabled: true }),
    assertAccess: () => undefined,
    submitInvoice: async (input) => {
      submitted.push(input);
      return {
        id: "invoice-request-1",
        orderId: input.orderId,
        status: "PENDING",
        titleType: input.titleType,
        invoiceTitle: input.invoiceTitle,
        taxIdentifier: input.taxIdentifier,
        amountMinor: 3990,
        currency: "CNY",
        deliveryEmail: input.deliveryEmail,
        createdAt: "2026-07-28T10:00:00.000Z",
      };
    },
  });

  for (const body of [
    {
      orderId: "order-1",
      titleType: "COMPANY",
      invoiceTitle: "某大学",
      taxIdentifier: "123456789012345",
      deliveryEmail: "student@example.edu.cn",
    },
    {
      orderId: "order-1",
      titleType: "ORGANIZATION",
      invoiceTitle: "某大学",
      taxIdentifier: "bad-tax-id",
      deliveryEmail: "student@example.edu.cn",
    },
    {
      orderId: "order-1",
      titleType: "PERSONAL",
      invoiceTitle: "张",
      taxIdentifier: null,
      deliveryEmail: "not-an-email",
    },
    {
      orderId: "order-1",
      titleType: "PERSONAL",
      invoiceTitle: "张同学",
      taxIdentifier: null,
      deliveryEmail: "student@example.edu.cn",
      amountMinor: 1,
    },
  ]) {
    const response = await handler(
      new Request("http://localhost/api/billing/invoices", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    assert.equal(response.status, 400);
  }
  assert.deepEqual(submitted, []);

  const accepted = await handler(
    new Request("http://localhost/api/billing/invoices", {
      method: "POST",
      body: JSON.stringify({
        orderId: "order-1",
        titleType: "ORGANIZATION",
        invoiceTitle: "某大学科研实验室",
        taxIdentifier: "12345678901234567X",
        deliveryEmail: "student@example.edu.cn",
      }),
    }),
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(submitted, [
    {
      userId: "user-1",
      orderId: "order-1",
      titleType: "ORGANIZATION",
      invoiceTitle: "某大学科研实验室",
      taxIdentifier: "12345678901234567X",
      deliveryEmail: "student@example.edu.cn",
    },
  ]);
});

test("invoice service verifies ownership and paid state and derives money from the order", async () => {
  const { submitInvoiceRequest } = await userPagesModule();

  await assert.rejects(
    submitInvoiceRequest(
      {
        userId: "user-1",
        orderId: "order-1",
        titleType: "PERSONAL",
        invoiceTitle: "张同学",
        taxIdentifier: null,
        deliveryEmail: "student@example.edu.cn",
      },
      {
        repository: repository({
          findUserOrder: async () => order({ status: "REFUNDED" }),
        }),
      },
    ),
    (error) =>
      error instanceof BillingError &&
      error.code === "INVOICE_NOT_ALLOWED" &&
      error.status === 409,
  );

  let upsertInput: unknown;
  const result = await submitInvoiceRequest(
    {
      userId: "user-1",
      orderId: "order-1",
      titleType: "PERSONAL",
      invoiceTitle: "张同学",
      taxIdentifier: null,
      deliveryEmail: "student@example.edu.cn",
    },
    {
      repository: repository({
        upsertInvoiceRequest: async (input) => {
          upsertInput = input;
          return {
            id: "invoice-request-1",
            orderId: input.orderId,
            status: "PENDING",
            titleType: input.titleType,
            invoiceTitle: input.invoiceTitle,
            taxIdentifier: input.taxIdentifier,
            amountMinor: input.amountMinor,
            currency: input.currency,
            deliveryEmail: input.deliveryEmail,
            createdAt: "2026-07-28T10:00:00.000Z",
          };
        },
      }),
    },
  );

  assert.equal(result.status, "PENDING");
  assert.deepEqual(upsertInput, {
    userId: "user-1",
    orderId: "order-1",
    titleType: "PERSONAL",
    invoiceTitle: "张同学",
    taxIdentifier: null,
    amountMinor: 3990,
    currency: "CNY",
    deliveryEmail: "student@example.edu.cn",
  });
});

test("refund and invoice repositories use unique upsert conflicts and own-order filters", async () => {
  const contents = await source("lib/billing/user-pages.ts");

  assert.match(contents, /upsert\(/);
  assert.match(contents, /onConflict:\s*["']user_id,order_id["']/);
  assert.match(contents, /ignoreDuplicates:\s*true/);
  assert.match(contents, /\.eq\(["']user_id["'],\s*userId\)/);
  assert.match(
    contents,
    /\.eq\(["']order_id["'],\s*(?:orderId|request\.orderId)\)/,
  );
  assert.doesNotMatch(contents, /requested_amount_minor:\s*(?:input|body)\./);
  assert.doesNotMatch(contents, /amount_minor:\s*(?:input|body)\.amount/);
});

test("refund and invoice writes fail closed on repository errors", async () => {
  const {
    submitRefundRequest,
    submitInvoiceRequest,
  } = await userPagesModule();
  const failing = repository({
    upsertRefundRequest: async () => {
      throw new Error("database host=secret");
    },
    upsertInvoiceRequest: async () => {
      throw new Error("database host=secret");
    },
  });

  await assert.rejects(
    submitRefundRequest(
      {
        userId: "user-1",
        orderId: "order-1",
        reasonCode: "NO_LONGER_NEEDED",
        details: "",
      },
      { repository: failing },
    ),
    (error) =>
      error instanceof BillingError &&
      error.code === "BILLING_STORAGE_UNAVAILABLE" &&
      !error.message.includes("secret"),
  );
  await assert.rejects(
    submitInvoiceRequest(
      {
        userId: "user-1",
        orderId: "order-1",
        titleType: "PERSONAL",
        invoiceTitle: "张同学",
        taxIdentifier: null,
        deliveryEmail: "student@example.edu.cn",
      },
      { repository: failing },
    ),
    (error) =>
      error instanceof BillingError &&
      error.code === "BILLING_STORAGE_UNAVAILABLE" &&
      !error.message.includes("secret"),
  );
});
