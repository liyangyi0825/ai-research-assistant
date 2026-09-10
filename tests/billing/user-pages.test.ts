import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { act, createElement } from "react";

import {
  assertBillingAccess,
  type BillingUser,
} from "../../lib/billing/auth";
import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import type { PublicBillingProduct } from "../../lib/billing/products";
import type {
  BillingSummary,
  BillingUserPageRepository,
} from "../../lib/billing/user-pages";
import { createReactDomHarness } from "./helpers/react-dom-harness";

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
    realPaymentPublicEnabled: false,
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

function publicProducts(): PublicBillingProduct[] {
  return [
    {
      id: "monthly-product",
      sku: "PRO_MONTHLY",
      name: "Pro Monthly",
      description: "30 天科研订阅",
      productType: "SUBSCRIPTION",
      priceMinor: 1990,
      currency: "CNY",
      durationDays: 30,
      creditGrant: 0,
      displayMetadata: {},
    },
    {
      id: "semester-product",
      sku: "PRO_SEMESTER",
      name: "Pro Semester",
      description: "150 天科研订阅",
      productType: "SUBSCRIPTION",
      priceMinor: 7900,
      currency: "CNY",
      durationDays: 150,
      creditGrant: 0,
      displayMetadata: {},
    },
    {
      id: "credits-product",
      sku: "CREDIT_PACK_100",
      name: "100 credits",
      description: "独立 credits 包",
      productType: "CREDIT_PACK",
      priceMinor: 990,
      currency: "CNY",
      durationDays: null,
      creditGrant: 100,
      displayMetadata: {},
    },
  ];
}

function pricingFetch(options: {
  summaryResponse: Response;
  available: boolean;
  calls: string[];
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    options.calls.push(url);
    if (url === "/api/billing/products") {
      return Response.json({ products: publicProducts() });
    }
    if (url === "/api/billing/availability") {
      return Response.json({
        available: options.available,
        paymentMode: options.available ? "mock" : null,
        mockConfirmationAllowed: options.available,
        agreementVersion: options.available ? "billing-member-v1" : null,
      });
    }
    if (url === "/api/billing/summary") return options.summaryResponse;
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function repository(
  overrides: Partial<BillingUserPageRepository> = {},
): BillingUserPageRepository {
  return {
    async getSummary() {
      return summary();
    },
    async requestRefund(input) {
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
    async requestInvoice(input) {
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
  assert.match(
    orderRequest,
    /acceptedAgreementVersion:\s*availability\.agreementVersion/,
  );
  assert.doesNotMatch(checkout, /["']billing-member-v1["']/);
});

test("active subscription pricing fetches products, availability, and summary together", async () => {
  const pricing = await source("components/billing/PricingProducts.tsx");

  assert.match(pricing, /Promise\.all\(\[/);
  assert.match(pricing, /\/api\/billing\/products/);
  assert.match(pricing, /\/api\/billing\/availability/);
  assert.match(pricing, /\/api\/billing\/summary/);
  assert.match(pricing, /BillingSummary/);
  assert.match(pricing, /setSummary/);
});

test("pricing keeps gated cards when the billing summary is unauthenticated", async () => {
  const pricing = (await import(
    "../../components/billing/PricingProducts"
  )) as {
    readPricingResponses?: (
      responses: [Response, Response, Response],
    ) => Promise<{
      products: PublicBillingProduct[];
      availability: { available: boolean };
      summary: BillingSummary | null;
    }>;
  };
  assert.equal(typeof pricing.readPricingResponses, "function");

  const result = await pricing.readPricingResponses!([
    Response.json({
      products: [
        {
          id: "monthly-product",
          sku: "PRO_MONTHLY",
          name: "Pro Monthly",
          description: null,
          productType: "SUBSCRIPTION",
          priceMinor: 1990,
          currency: "CNY",
          durationDays: 30,
          creditGrant: 0,
          displayMetadata: {},
        },
      ],
    }),
    Response.json({
      available: false,
      paymentMode: null,
      mockConfirmationAllowed: false,
      agreementVersion: null,
    }),
    Response.json(
      { error: { code: "UNAUTHENTICATED", message: "Sign in required." } },
      { status: 401 },
    ),
  ]);

  assert.equal(result.products.length, 1);
  assert.equal(result.availability.available, false);
  assert.equal(result.summary, null);
});

test("active subscription blocks only subscription products and keeps credits linked", async () => {
  const pricing = (await import(
    "../../components/billing/PricingProducts"
  )) as {
    getPricingProductAction?: (
      product: PublicBillingProduct,
      available: boolean,
      currentSummary: BillingSummary | null,
    ) =>
      | { kind: "link"; href: string }
      | {
          kind: "subscription-blocked";
          planName: string;
          endsAt: string;
        }
      | { kind: "unavailable" };
  };
  assert.equal(typeof pricing.getPricingProductAction, "function");

  const products: PublicBillingProduct[] = [
    {
      id: "monthly-product",
      sku: "PRO_MONTHLY",
      name: "Pro Monthly",
      description: null,
      productType: "SUBSCRIPTION",
      priceMinor: 1990,
      currency: "CNY",
      durationDays: 30,
      creditGrant: 0,
      displayMetadata: {},
    },
    {
      id: "semester-product",
      sku: "PRO_SEMESTER",
      name: "Pro Semester",
      description: null,
      productType: "SUBSCRIPTION",
      priceMinor: 7900,
      currency: "CNY",
      durationDays: 150,
      creditGrant: 0,
      displayMetadata: {},
    },
    {
      id: "credits-product",
      sku: "CREDIT_PACK_100",
      name: "100 credits",
      description: null,
      productType: "CREDIT_PACK",
      priceMinor: 990,
      currency: "CNY",
      durationDays: null,
      creditGrant: 100,
      displayMetadata: {},
    },
  ];
  const actions = products.map((product) =>
    pricing.getPricingProductAction!(product, true, summary()),
  );

  assert.deepEqual(actions, [
    {
      kind: "subscription-blocked",
      planName: "科研月度方案",
      endsAt: "2026年8月1日",
    },
    {
      kind: "subscription-blocked",
      planName: "科研月度方案",
      endsAt: "2026年8月1日",
    },
    {
      kind: "link",
      href: "/checkout/credits-product",
    },
  ]);
});

test("subscription cards state one-time payment, not auto-renew, and one semester period", async () => {
  const pricing = (await import(
    "../../components/billing/PricingProducts"
  )) as {
    getProductPurchaseTerms?: (product: PublicBillingProduct) => {
      label: string;
      value: string;
      payment: string;
      periodNote: string;
    };
  };
  assert.equal(typeof pricing.getProductPurchaseTerms, "function");

  const monthly: PublicBillingProduct = {
    id: "monthly-product",
    sku: "PRO_MONTHLY",
    name: "Pro Monthly",
    description: null,
    productType: "SUBSCRIPTION",
    priceMinor: 1990,
    currency: "CNY",
    durationDays: 30,
    creditGrant: 0,
    displayMetadata: {},
  };
  const semester: PublicBillingProduct = {
    ...monthly,
    id: "semester-product",
    sku: "PRO_SEMESTER",
    name: "Pro Semester",
    priceMinor: 7900,
    durationDays: 150,
  };

  assert.deepEqual(pricing.getProductPurchaseTerms!(monthly), {
    label: "本次使用期",
    value: "30 天",
    payment: "一次性支付，不自动续费",
    periodNote: "开通后连续使用一个完整的 30 天周期。",
  });
  assert.deepEqual(pricing.getProductPurchaseTerms!(semester), {
    label: "本次使用期",
    value: "150 天",
    payment: "一次性支付，不自动续费",
    periodNote: "额度覆盖一个完整的 150 天周期，不按月重置。",
  });

  const sourceText = await source("components/billing/PricingProducts.tsx");
  assert.match(sourceText, /xl:grid-cols-3/);
  assert.doesNotMatch(sourceText, /lg:grid-cols-3/);
  assert.match(sourceText, /aria-disabled/);
  assert.match(sourceText, /motion-reduce:animate-none/);
});

test("subscription purchase conflict is stable and does not retry order creation", async () => {
  const checkout = (await import(
    "../../components/billing/CheckoutPanel"
  )) as {
    requestBillingOrder?: (
      input: {
        productId: string;
        provider: "mock";
        acceptedAgreementVersion: string;
      },
      fetcher: (
        input: string,
        init?: RequestInit,
      ) => Promise<Response>,
    ) => Promise<unknown>;
  };
  assert.equal(typeof checkout.requestBillingOrder, "function");

  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const result = await checkout.requestBillingOrder!(
    {
      productId: "semester-product",
      provider: "mock",
      acceptedAgreementVersion: "agreement-v1",
    },
    async (input, init) => {
      calls.push({ input, init });
      return Response.json(
        {
          error: {
            code: "ACTIVE_SUBSCRIPTION_EXISTS",
            message: "database detail that must not be shown",
          },
        },
        { status: 409 },
      );
    },
  );

  assert.deepEqual(result, {
    kind: "error",
    message:
      "当前已有有效订阅，请在现有方案到期后再购买新的订阅。credits 包仍可单独购买。",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/billing/orders");
  assert.equal(calls[0]?.init?.method, "POST");
});

test("PricingProducts renders subscriptions disabled, credits linked, and purchase terms", async () => {
  const harness = createReactDomHarness();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = pricingFetch({
    summaryResponse: Response.json({ summary: summary() }),
    available: true,
    calls,
  });

  try {
    const { PricingProducts } = await import(
      "../../components/billing/PricingProducts"
    );
    await harness.render(createElement(PricingProducts));

    const articles = Array.from(
      harness.container.querySelectorAll("article"),
    );
    assert.equal(articles.length, 3);
    const monthly = articles.find((article) =>
      article.textContent?.includes("Pro Monthly"),
    );
    const semester = articles.find((article) =>
      article.textContent?.includes("Pro Semester"),
    );
    const credits = articles.find((article) =>
      article.textContent?.includes("100 credits"),
    );
    assert.ok(monthly);
    assert.ok(semester);
    assert.ok(credits);

    for (const subscription of [monthly, semester]) {
      assert.equal(subscription.querySelector("a"), null);
      assert.ok(subscription.querySelector('[aria-disabled="true"]'));
      assert.match(subscription.textContent ?? "", /科研月度方案/);
      assert.match(subscription.textContent ?? "", /2026年8月1日/);
      assert.match(subscription.textContent ?? "", /一次性支付，不自动续费/);
    }
    assert.match(monthly.textContent ?? "", /完整的 30 天周期/);
    assert.match(
      semester.textContent ?? "",
      /额度覆盖一个完整的 150 天周期，不按月重置/,
    );
    assert.equal(
      credits.querySelector("a")?.getAttribute("href"),
      "/checkout/credits-product",
    );
    assert.deepEqual(calls, [
      "/api/billing/products",
      "/api/billing/availability",
      "/api/billing/summary",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await harness.cleanup();
  }
});

test("PricingProducts renders gated cards when summary returns 401", async () => {
  const harness = createReactDomHarness();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = pricingFetch({
    summaryResponse: Response.json(
      { error: { code: "UNAUTHENTICATED", message: "Sign in required." } },
      { status: 401 },
    ),
    available: false,
    calls,
  });

  try {
    const { PricingProducts } = await import(
      "../../components/billing/PricingProducts"
    );
    await harness.render(createElement(PricingProducts));

    assert.equal(harness.container.querySelectorAll("article").length, 3);
    assert.equal(harness.container.querySelectorAll("article a").length, 0);
    assert.equal(
      harness.container.textContent?.includes("套餐信息暂时无法加载"),
      false,
    );
    assert.equal(
      harness.container.textContent?.match(/当前账号暂未开放购买/g)?.length,
      3,
    );
    assert.deepEqual(calls, [
      "/api/billing/products",
      "/api/billing/availability",
      "/api/billing/summary",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await harness.cleanup();
  }
});

test("PricingProducts renders its error state when summary fails outside 401", async () => {
  const harness = createReactDomHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = pricingFetch({
    summaryResponse: Response.json(
      { error: { code: "INTERNAL_BILLING_ERROR" } },
      { status: 503 },
    ),
    available: true,
    calls: [],
  });

  try {
    const { PricingProducts } = await import(
      "../../components/billing/PricingProducts"
    );
    await harness.render(createElement(PricingProducts));

    assert.equal(harness.container.querySelectorAll("article").length, 0);
    assert.match(
      harness.container.textContent ?? "",
      /套餐信息暂时无法加载。请稍后刷新页面/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await harness.cleanup();
  }
});

test("CheckoutPanel renders the active-subscription conflict after one order POST", async () => {
  const harness = createReactDomHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("CheckoutPanel must use the injected fetch port");
  }) as typeof fetch;
  const calls: Array<{ url: string; method: string }> = [];
  const navigations: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url === "/api/billing/products") {
      return Response.json({ products: publicProducts() });
    }
    if (url === "/api/billing/availability") {
      return Response.json({
        available: true,
        paymentMode: "mock",
        mockConfirmationAllowed: true,
        agreementVersion: "billing-member-v1",
      });
    }
    if (url === "/api/billing/orders" && method === "POST") {
      return Response.json(
        {
          error: {
            code: "ACTIVE_SUBSCRIPTION_EXISTS",
            message: "unsafe repository detail",
          },
        },
        { status: 409 },
      );
    }
    throw new Error(`unexpected checkout request: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const { CheckoutPanel, CheckoutPanelDependenciesProvider } = await import(
      "../../components/billing/CheckoutPanel"
    );
    assert.ok(CheckoutPanelDependenciesProvider);
    await harness.render(
      createElement(
        CheckoutPanelDependenciesProvider,
        {
          value: {
            fetcher,
            router: { push: (path: string) => navigations.push(path) },
          },
        },
        createElement(CheckoutPanel, { productId: "semester-product" }),
      ),
    );

    const checkbox = harness.container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const form = harness.container.querySelector("form");
    assert.ok(checkbox);
    assert.ok(form);
    await act(async () => {
      checkbox.click();
    });
    await act(async () => {
      form.dispatchEvent(
        new harness.window.Event("submit", {
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      );
      await Promise.resolve();
    });
    await harness.flush();

    assert.match(
      harness.container.textContent ?? "",
      /当前已有有效订阅，请在现有方案到期后再购买新的订阅。credits 包仍可单独购买。/,
    );
    assert.deepEqual(
      calls.filter(
        (call) => call.url === "/api/billing/orders" && call.method === "POST",
      ),
      [{ url: "/api/billing/orders", method: "POST" }],
    );
    assert.deepEqual(navigations, []);
  } finally {
    globalThis.fetch = originalFetch;
    await harness.cleanup();
  }
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
    requireActor: async () => {
      events.push("unexpected-auth");
      return user();
    },
  });

  const disabledResponse = await disabled();
  assert.equal(disabledResponse.status, 200);
  assert.deepEqual(await disabledResponse.json(), {
    available: false,
    paymentMode: null,
    mockConfirmationAllowed: false,
    agreementVersion: null,
  });
  assert.deepEqual(events, []);

  const productionUser = createBillingAvailabilityGetHandler({
    getConfig: () =>
      billingConfig({
        featureEnabled: true,
        isProduction: true,
        testUserIds: ["allowed-user"],
      }),
    requireActor: async () => user(),
  });
  assert.deepEqual(await (await productionUser()).json(), {
    available: false,
    paymentMode: null,
    mockConfirmationAllowed: false,
    agreementVersion: null,
  });

  const productionTestUser = createBillingAvailabilityGetHandler({
    getConfig: () =>
      billingConfig({
        featureEnabled: true,
        isProduction: true,
        testUserIds: ["user-1"],
      }),
    requireActor: async () => user(),
  });
  assert.deepEqual(await (await productionTestUser()).json(), {
    available: true,
    paymentMode: "mock",
    mockConfirmationAllowed: true,
    agreementVersion: "billing-member-v1",
  });

  const productionAdmin = createBillingAvailabilityGetHandler({
    getConfig: () =>
      billingConfig({
        featureEnabled: true,
        isProduction: true,
        testUserIds: ["allowed-user"],
      }),
    requireActor: async () => ({
      ...user(),
      isAdmin: true,
      role: "BILLING_ADMIN",
    }),
  });
  assert.deepEqual(await (await productionAdmin()).json(), {
    available: true,
    paymentMode: "mock",
    mockConfirmationAllowed: true,
    agreementVersion: "billing-member-v1",
  });
});

test("WeChat availability enforces the server allowlist until public real payments are explicitly enabled", async () => {
  const { createBillingAvailabilityGetHandler } = await userPagesModule();
  const restrictedConfig = billingConfig({
    featureEnabled: true,
    paymentMode: "wechat",
    wechatConfigured: true,
    testUserIds: ["test-user"],
    realPaymentPublicEnabled: false,
  } as Partial<BillingConfig>);
  const ordinary = createBillingAvailabilityGetHandler({
    getConfig: () => restrictedConfig,
    requireActor: async () => user(),
  });
  assert.deepEqual(await (await ordinary()).json(), {
    available: false,
    paymentMode: null,
    mockConfirmationAllowed: false,
    agreementVersion: null,
  });

  for (const actor of [
    user({ id: "test-user" }),
    user({ isAdmin: true }),
  ]) {
    const allowed = createBillingAvailabilityGetHandler({
      getConfig: () => restrictedConfig,
      requireActor: async () => actor,
    });
    assert.equal((await (await allowed()).json()).available, true);
  }

  const publicHandler = createBillingAvailabilityGetHandler({
    getConfig: () => ({ ...restrictedConfig, realPaymentPublicEnabled: true }),
    requireActor: async () => user(),
  });
  assert.equal((await (await publicHandler()).json()).available, true);
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
    requireActor: async () => user(),
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

test("refund service delegates ownership, state, and money derivation to the atomic repository operation", async () => {
  const { submitRefundRequest } = await userPagesModule();
  let requestInput: unknown;
  const result = await submitRefundRequest(
    {
      userId: "user-1",
      orderId: "order-1",
      reasonCode: "SERVICE_ISSUE",
      details: "服务结果未满足研究任务需要。",
    },
    {
      repository: repository({
        requestRefund: async (input) => {
          requestInput = input;
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
      }),
    },
  );

  assert.equal(result.status, "PENDING");
  assert.deepEqual(requestInput, {
    userId: "user-1",
    orderId: "order-1",
    reasonCode: "SERVICE_ISSUE",
    details: "服务结果未满足研究任务需要。",
  });
});

test("invoice handler validates enum, title, tax identifier, and email", async () => {
  const { createInvoicePostHandler } = await userPagesModule();
  const submitted: unknown[] = [];
  const handler = createInvoicePostHandler({
    requireActor: async () => user(),
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

test("refund and invoice routes use the resolved actor for a production Mock administrator", async () => {
  const {
    createRefundPostHandler,
    createInvoicePostHandler,
  } = await userPagesModule();
  const admin = {
    ...user(),
    isAdmin: true as const,
    role: "BILLING_ADMIN" as const,
  };
  const productionMock = billingConfig({
    featureEnabled: true,
    isProduction: true,
    testUserIds: ["different-test-user"],
  });
  const refund = createRefundPostHandler({
    requireActor: async () => admin,
    getConfig: () => productionMock,
    assertAccess: assertBillingAccess,
    submitRefund: async (input) => ({
      id: "refund-request-admin",
      orderId: input.orderId,
      status: "PENDING",
      requestedAmountMinor: 3990,
      currency: "CNY",
      reasonCode: input.reasonCode,
      details: input.details,
      createdAt: "2026-07-29T01:00:00.000Z",
    }),
  });
  const invoice = createInvoicePostHandler({
    requireActor: async () => admin,
    getConfig: () => productionMock,
    assertAccess: assertBillingAccess,
    submitInvoice: async (input) => ({
      id: "invoice-request-admin",
      orderId: input.orderId,
      status: "PENDING",
      titleType: input.titleType,
      invoiceTitle: input.invoiceTitle,
      taxIdentifier: input.taxIdentifier,
      amountMinor: 3990,
      currency: "CNY",
      deliveryEmail: input.deliveryEmail,
      createdAt: "2026-07-29T01:00:00.000Z",
    }),
  });

  const refundResponse = await refund(
    new Request("http://localhost/api/billing/refunds", {
      method: "POST",
      body: JSON.stringify({
        orderId: "order-1",
        reasonCode: "NO_LONGER_NEEDED",
        details: "",
      }),
    }),
  );
  const invoiceResponse = await invoice(
    new Request("http://localhost/api/billing/invoices", {
      method: "POST",
      body: JSON.stringify({
        orderId: "order-1",
        titleType: "PERSONAL",
        invoiceTitle: "张同学",
        taxIdentifier: null,
        deliveryEmail: "student@example.edu.cn",
      }),
    }),
  );

  assert.equal(refundResponse.status, 202);
  assert.equal(invoiceResponse.status, 202);
});

test("invoice service delegates ownership, state, and money derivation to the atomic repository operation", async () => {
  const { submitInvoiceRequest } = await userPagesModule();
  let requestInput: unknown;
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
        requestInvoice: async (input) => {
          requestInput = input;
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
      }),
    },
  );

  assert.equal(result.status, "PENDING");
  assert.deepEqual(requestInput, {
    userId: "user-1",
    orderId: "order-1",
    titleType: "PERSONAL",
    invoiceTitle: "张同学",
    taxIdentifier: null,
    deliveryEmail: "student@example.edu.cn",
  });
});

test("refund and invoice repositories delegate one atomic request to service-role RPCs", async () => {
  const { createBillingUserPageRepository } = await userPagesModule();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    from() {
      throw new Error("after-sales writes must not read or upsert tables");
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "billing_request_refund") {
        return {
          data: {
            id: "refund-request-1",
            order_id: "order-1",
            status: "PENDING",
            requested_amount_minor: 3990,
            currency: "CNY",
            reason: JSON.stringify({
              reasonCode: "SERVICE_ISSUE",
              details: "服务结果未满足研究任务需要。",
            }),
            created_at: "2026-07-29T01:00:00.000Z",
          },
          error: null,
        };
      }
      return {
        data: {
          id: "invoice-request-1",
          order_id: "order-1",
          status: "PENDING",
          invoice_title: "张同学",
          tax_identifier: null,
          amount_minor: 3990,
          currency: "CNY",
          delivery_email: "student@example.edu.cn",
          created_at: "2026-07-29T01:00:00.000Z",
        },
        error: null,
      };
    },
  };
  const atomicRepository = createBillingUserPageRepository(client);

  const refund = await atomicRepository.requestRefund({
    userId: "user-1",
    orderId: "order-1",
    reasonCode: "SERVICE_ISSUE",
    details: "服务结果未满足研究任务需要。",
  });
  const invoice = await atomicRepository.requestInvoice({
    userId: "user-1",
    orderId: "order-1",
    titleType: "PERSONAL",
    invoiceTitle: "张同学",
    taxIdentifier: null,
    deliveryEmail: "student@example.edu.cn",
  });

  assert.equal(refund.requestedAmountMinor, 3990);
  assert.equal(invoice.amountMinor, 3990);
  assert.deepEqual(calls, [
    {
      name: "billing_request_refund",
      args: {
        p_user_id: "user-1",
        p_order_id: "order-1",
        p_reason: JSON.stringify({
          reasonCode: "SERVICE_ISSUE",
          details: "服务结果未满足研究任务需要。",
        }),
      },
    },
    {
      name: "billing_request_invoice",
      args: {
        p_user_id: "user-1",
        p_order_id: "order-1",
        p_invoice_title: "张同学",
        p_tax_identifier: null,
        p_delivery_email: "student@example.edu.cn",
      },
    },
  ]);
});

test("refund and invoice writes fail closed on repository errors", async () => {
  const {
    submitRefundRequest,
    submitInvoiceRequest,
  } = await userPagesModule();
  const failing = repository({
    requestRefund: async () => {
      throw new Error("database host=secret");
    },
    requestInvoice: async () => {
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
