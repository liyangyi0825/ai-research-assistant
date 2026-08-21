import assert from "node:assert/strict";
import test from "node:test";

import { GET as productsGET } from "../../app/api/billing/products/route";
import { GET as orderGET } from "../../app/api/billing/orders/[id]/route";
import { POST as ordersPOST } from "../../app/api/billing/orders/route";
import type { BillingUser } from "../../lib/billing/auth";
import { assertBillingAccess } from "../../lib/billing/auth";
import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import {
  createGetUserOrderHandler,
  createOrderPostHandler,
  type CreateOrderInput,
} from "../../lib/billing/orders";
import {
  createListPublicProductsHandler,
  type PublicBillingProduct,
} from "../../lib/billing/products";
import type { BillingOrder } from "../../lib/billing/repositories";

const user: BillingUser = {
  id: "server-user",
  email: "student@example.com",
  isAdmin: false,
};

const config: BillingConfig = {
  featureEnabled: true,
  paymentMode: "mock",
  testUserIds: [],
  legal: {
    operatorName: "",
    operatorCreditCode: "",
    contactEmail: "",
  },
  wechat: null,
  wechatConfigured: false,
  alipayConfigured: false,
  isProduction: false,
};

const publicProduct: PublicBillingProduct = {
  id: "product-pro-monthly",
  sku: "PRO_MONTHLY",
  name: "Pro 月度会员",
  description: "适合持续科研工作",
  productType: "SUBSCRIPTION",
  priceMinor: 1_990,
  currency: "CNY",
  durationDays: 30,
  creditGrant: 0,
  displayMetadata: { badge: "推荐" },
};

const order: BillingOrder = {
  id: "order-id-1",
  orderNumber: "BILL-00000000000000000000000000000001",
  userId: user.id,
  productId: publicProduct.id,
  provider: "MOCK",
  status: "PENDING",
  amountMinor: publicProduct.priceMinor,
  currency: "CNY",
  snapshotProductName: publicProduct.name,
  snapshotProductType: publicProduct.productType,
  snapshotPlanId: "plan-pro",
  snapshotDurationDays: 30,
  snapshotCreditGrant: 0,
  snapshotEntitlementVersion: "pro-v1",
  snapshotEntitlements: [],
  snapshotDetails: { sku: publicProduct.sku },
  acceptedAgreementVersion: "billing-member-v1",
  expiresAt: "2026-07-22T02:30:00.000Z",
  paidAt: null,
  closedAt: null,
  refundStatus: "NONE",
  createdAt: "2026-07-22T02:00:00.000Z",
  updatedAt: "2026-07-22T02:00:00.000Z",
};

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/billing/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

test("billing route modules expose the expected HTTP methods", () => {
  assert.equal(typeof productsGET, "function");
  assert.equal(typeof ordersPOST, "function");
  assert.equal(typeof orderGET, "function");
});

test("GET products returns only the public product DTO", async () => {
  const handler = createListPublicProductsHandler({
    getConfig: () => config,
    listProducts: async () => [publicProduct],
  });

  const response = await handler();

  assert.equal(response.status, 200);
  assert.deepEqual(await responseBody(response), { products: [publicProduct] });
  assert.equal("entitlementVersion" in publicProduct, false);
});

test("GET products returns an empty catalog while billing is disabled without reading storage", async () => {
  let storageReads = 0;
  const handler = createListPublicProductsHandler({
    getConfig: () => ({ ...config, featureEnabled: false }),
    listProducts: async () => {
      storageReads += 1;
      return [publicProduct];
    },
  });

  const response = await handler();

  assert.equal(response.status, 200);
  assert.deepEqual(await responseBody(response), { products: [] });
  assert.equal(storageReads, 0);
});

test("POST orders performs auth, feature access, atomic rate limiting, then order creation", async () => {
  const events: string[] = [];
  let receivedInput: CreateOrderInput | null = null;
  const handler = createOrderPostHandler({
    requireActor: async () => {
      events.push("auth");
      return user;
    },
    getConfig: () => config,
    assertAccess: (receivedUser, receivedConfig) => {
      assert.equal(receivedUser, user);
      assert.equal(receivedConfig, config);
      events.push("access");
    },
    consumeRateLimit: async (userId) => {
      assert.equal(userId, user.id);
      events.push("rate-limit");
    },
    createOrder: async (input) => {
      events.push("create-order");
      receivedInput = input;
      return order;
    },
  });

  const response = await handler(
    jsonRequest({
      productId: publicProduct.id,
      provider: "mock",
      acceptedAgreementVersion: "billing-member-v1",
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(events, ["auth", "access", "rate-limit", "create-order"]);
  assert.deepEqual(receivedInput, {
    userId: "server-user",
    productId: publicProduct.id,
    provider: "mock",
    acceptedAgreementVersion: "billing-member-v1",
  });
  assert.deepEqual(await responseBody(response), { order });
});

test("POST orders uses the server-resolved actor so an active administrator can use production Mock", async () => {
  const admin = {
    ...user,
    isAdmin: true as const,
    role: "BILLING_ADMIN" as const,
  };
  const productionMockConfig: BillingConfig = {
    ...config,
    isProduction: true,
    testUserIds: ["different-test-user"],
  };
  let created = false;
  const handler = createOrderPostHandler({
    requireActor: async () => admin,
    getConfig: () => productionMockConfig,
    assertAccess: assertBillingAccess,
    consumeRateLimit: async () => undefined,
    createOrder: async () => {
      created = true;
      return { ...order, userId: admin.id };
    },
  });

  const response = await handler(
    jsonRequest({
      productId: publicProduct.id,
      provider: "mock",
      acceptedAgreementVersion: "billing-member-v1",
    }),
  );

  assert.equal(response.status, 201);
  assert.equal(created, true);
});

test("POST orders rejects client amount, currency, and userId fields before product access", async () => {
  for (const forbiddenBody of [
    {
      productId: publicProduct.id,
      provider: "mock",
      acceptedAgreementVersion: "billing-member-v1",
      amount: 1,
    },
    {
      productId: publicProduct.id,
      provider: "mock",
      acceptedAgreementVersion: "billing-member-v1",
      currency: "USD",
    },
    {
      productId: publicProduct.id,
      provider: "mock",
      acceptedAgreementVersion: "billing-member-v1",
      userId: "attacker-user",
    },
  ]) {
    const events: string[] = [];
    const handler = createOrderPostHandler({
      requireActor: async () => {
        events.push("auth");
        return user;
      },
      getConfig: () => config,
      assertAccess: () => events.push("access"),
      consumeRateLimit: async () => {
        events.push("rate-limit");
      },
      createOrder: async () => {
        events.push("create-order");
        return order;
      },
    });

    const response = await handler(jsonRequest(forbiddenBody));
    const body = await responseBody(response);

    assert.equal(response.status, 400);
    assert.deepEqual(events, ["auth", "access", "rate-limit"]);
    assert.deepEqual(body, {
      error: {
        code: "INVALID_ORDER_BODY",
        message: "Order body contains unsupported or invalid fields.",
      },
    });
  }
});

test("POST orders rejects blank agreements and invalid providers", async () => {
  const handler = createOrderPostHandler({
    requireActor: async () => user,
    getConfig: () => config,
    assertAccess: () => undefined,
    consumeRateLimit: async () => undefined,
    createOrder: async () => order,
  });

  for (const body of [
    {
      productId: publicProduct.id,
      provider: "mock",
      acceptedAgreementVersion: " ",
    },
    {
      productId: publicProduct.id,
      provider: "paypal",
      acceptedAgreementVersion: "billing-member-v1",
    },
  ]) {
    const response = await handler(jsonRequest(body));
    assert.equal(response.status, 400);
  }
});

test("POST orders rejects a stale client agreement version before order creation", async () => {
  let created = false;
  const handler = createOrderPostHandler({
    requireActor: async () => user,
    getConfig: () => config,
    assertAccess: () => undefined,
    consumeRateLimit: async () => undefined,
    createOrder: async () => {
      created = true;
      return order;
    },
  });

  const response = await handler(
    jsonRequest({
      productId: publicProduct.id,
      provider: "mock",
      acceptedAgreementVersion: "membership-v1",
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(created, false);
  assert.deepEqual(await responseBody(response), {
    error: {
      code: "AGREEMENT_VERSION_MISMATCH",
      message: "The accepted billing agreement version is not current.",
    },
  });
});

test("POST orders rejects providers that differ from the server payment mode", async () => {
  for (const [provider, paymentMode] of [
    ["wechat", "mock"],
    ["alipay", "mock"],
    ["mock", "wechat"],
  ] as const) {
    const events: string[] = [];
    const handler = createOrderPostHandler({
      requireActor: async () => {
        events.push("auth");
        return user;
      },
      getConfig: () => ({ ...config, paymentMode }),
      assertAccess: () => events.push("access"),
      consumeRateLimit: async () => {
        events.push("rate-limit");
      },
      createOrder: async () => {
        events.push("create-order");
        return order;
      },
    });

    const response = await handler(
      jsonRequest({
        productId: publicProduct.id,
        provider,
        acceptedAgreementVersion: "billing-member-v1",
      }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(events, ["auth", "access", "rate-limit"]);
    assert.deepEqual(await responseBody(response), {
      error: {
        code: "PAYMENT_PROVIDER_MISMATCH",
        message:
          "Requested payment provider does not match the server payment mode.",
      },
    });
  }
});

test("POST orders stops immediately when authentication or access checks fail", async () => {
  const events: string[] = [];
  const handler = createOrderPostHandler({
    requireActor: async () => {
      events.push("auth");
      throw new BillingError("UNAUTHENTICATED", "Sign in required.", 401);
    },
    getConfig: () => config,
    assertAccess: () => events.push("access"),
    consumeRateLimit: async () => {
      events.push("rate-limit");
    },
    createOrder: async () => {
      events.push("create-order");
      return order;
    },
  });

  const response = await handler(jsonRequest({}));

  assert.equal(response.status, 401);
  assert.deepEqual(events, ["auth"]);
  assert.deepEqual(await responseBody(response), {
    error: { code: "UNAUTHENTICATED", message: "Sign in required." },
  });
});

test("GET an order awaits Next.js 16 params and uses the authenticated owner", async () => {
  const events: string[] = [];
  const handler = createGetUserOrderHandler({
    requireUser: async () => {
      events.push("auth");
      return user;
    },
    getOrder: async (userId, orderId) => {
      events.push("get-order");
      assert.equal(userId, user.id);
      assert.equal(orderId, order.id);
      return order;
    },
  });
  const params = Promise.resolve({ id: order.id });

  const response = await handler(
    new Request(`http://localhost/api/billing/orders/${order.id}`),
    { params },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(events, ["auth", "get-order"]);
  assert.deepEqual(await responseBody(response), { order });
});

test("billing handlers fail closed without leaking unexpected errors", async () => {
  const productsHandler = createListPublicProductsHandler({
    getConfig: () => config,
    listProducts: async () => {
      throw new Error("database password=secret");
    },
  });

  const response = await productsHandler();
  const body = await responseBody(response);

  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    error: {
      code: "INTERNAL_BILLING_ERROR",
      message: "Billing request failed.",
    },
  });
  assert.equal(JSON.stringify(body).includes("password=secret"), false);
});
