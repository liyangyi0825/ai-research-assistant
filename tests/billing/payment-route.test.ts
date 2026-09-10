import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { BillingActor } from "../../lib/billing/auth";
import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import {
  createOrderPaymentGetHandler,
  createOrderPaymentPostHandler,
} from "../../lib/billing/payments/service";
import type { PaymentResult } from "../../lib/billing/payments/types";

const actor: BillingActor = {
  id: "user-1",
  email: "researcher@example.edu.cn",
  isAdmin: false,
};

const config: BillingConfig = {
  featureEnabled: true,
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
};

const payment: PaymentResult = {
  orderNumber: "BILL-ORDER-1",
  providerTransactionId: "mock-provider-secret",
  status: "PENDING",
  amountMinor: 3990,
  currency: "CNY",
  paymentToken: "mock-payment-token-secret",
  expiresAt: "2026-07-30T01:30:00.000Z",
  paidAt: null,
};

test("payment route authenticates the owner and returns only a safe intent DTO", async () => {
  const calls: unknown[] = [];
  const handler = createOrderPaymentPostHandler({
    requireActor: async () => actor,
    getConfig: () => config,
    assertAccess: (resolvedActor, resolvedConfig) => {
      calls.push(["access", resolvedActor.id, resolvedConfig.paymentMode]);
    },
    createPayment: async (userId, orderId, dependencies) => {
      calls.push(["payment", userId, orderId, dependencies?.isAdmin]);
      return payment;
    },
  });

  const response = await handler(
    new Request("http://localhost/api/billing/orders/order-1/payment", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "order-1" }) },
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    payment: {
      status: "PENDING",
      expiresAt: payment.expiresAt,
    },
  });
  assert.deepEqual(calls, [
    ["access", "user-1", "mock"],
    ["payment", "user-1", "order-1", false],
  ]);
});

test("owner-authenticated WeChat creation returns a local SVG QR for the verified code_url", async () => {
  const wechatPayment: PaymentResult = {
    ...payment,
    orderNumber: "WX0123456789abcdef0123456789abcd",
    providerTransactionId: null,
    paymentToken: "weixin://wxpay/bizpayurl?pr=owner-only-token",
  };
  const handler = createOrderPaymentPostHandler({
    requireActor: async () => actor,
    getConfig: () => ({
      ...config,
      paymentMode: "wechat",
      wechatConfigured: true,
    }),
    assertAccess: () => undefined,
    createPayment: async () => wechatPayment,
  });

  const response = await handler(
    new Request("http://localhost/api/billing/orders/order-1/payment", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "order-1" }) },
  );
  const body = (await response.json()) as {
    payment: { qrCodeDataUrl: string } & Record<string, unknown>;
  };

  assert.equal(response.status, 201);
  assert.equal("codeUrl" in body.payment, false);
  assert.equal(JSON.stringify(body).includes(wechatPayment.paymentToken!), false);
  assert.match(body.payment.qrCodeDataUrl, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(body.payment.qrCodeDataUrl.split(",")[1]!, "base64").toString("utf8");
  assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<path/);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
});

test("owner-authenticated payment status GET queries and settles before returning PAID", async () => {
  const calls: unknown[] = [];
  const handler = createOrderPaymentGetHandler({
    requireActor: async () => actor,
    getConfig: () => ({
      ...config,
      paymentMode: "wechat",
      wechatConfigured: true,
    }),
    assertAccess: () => undefined,
    queryPayment: async (userId, orderId, dependencies) => {
      calls.push([userId, orderId, dependencies?.isAdmin]);
      return {
        ...payment,
        orderNumber: "WX0123456789abcdef0123456789abcd",
        status: "PAID",
        paymentToken: null,
        paidAt: "2026-07-30T01:00:00.000Z",
      };
    },
  });

  const response = await handler(new Request("http://localhost"), {
    params: Promise.resolve({ id: "order-1" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    payment: { status: "PAID", expiresAt: payment.expiresAt },
  });
  assert.deepEqual(calls, [["user-1", "order-1", false]]);
});

test("payment route rejects disabled, unauthorized, paid, expired, and foreign orders without leaking details", async () => {
  for (const error of [
    new BillingError("BILLING_FEATURE_DISABLED", "Billing writes are disabled.", 403),
    new BillingError("ORDER_NOT_FOUND", "The billing order was not found.", 404),
    new BillingError("ORDER_ALREADY_PAID", "The billing order is already paid.", 409),
    new BillingError("ORDER_EXPIRED", "The billing order has expired.", 409),
  ]) {
    const handler = createOrderPaymentPostHandler({
      requireActor: async () => actor,
      getConfig: () => config,
      assertAccess: () => undefined,
      createPayment: async () => {
        throw error;
      },
    });
    const response = await handler(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ id: "order-1" }),
    });
    assert.equal(response.status, error.status);
    assert.deepEqual(await response.json(), {
      error: { code: error.code, message: error.message },
    });
  }
});

test("checkout renders the owner-only WeChat QR and polls the verified payment status endpoint", async () => {
  const { requestBillingOrder } = await import(
    "../../components/billing/CheckoutPanel"
  );
  const orderCalls: Array<{ input: string; init?: RequestInit }> = [];
  const orderResult = await requestBillingOrder(
    {
      productId: "product-1",
      provider: "wechat",
      acceptedAgreementVersion: "billing-member-v1",
    },
    async (input, init) => {
      orderCalls.push({ input, init });
      return Response.json({ order: { id: "order-1" } });
    },
  );
  assert.deepEqual(orderResult, { kind: "created", orderId: "order-1" });
  assert.equal(orderCalls.length, 1);
  assert.equal(orderCalls[0]?.input, "/api/billing/orders");
  assert.equal(orderCalls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(orderCalls[0]?.init?.body)), {
    productId: "product-1",
    provider: "wechat",
    acceptedAgreementVersion: "billing-member-v1",
  });
  assert.doesNotMatch(
    String(orderCalls[0]?.init?.body),
    /"(?:amount|currency|userId)"\s*:/,
  );

  const checkout = await readFile(
    new URL("../../components/billing/CheckoutPanel.tsx", import.meta.url),
    "utf8",
  );
  const route = await readFile(
    new URL(
      "../../app/api/billing/orders/[id]/payment/route.ts",
      import.meta.url,
    ),
    "utf8",
  ).catch(() => "");
  const paymentResult = await readFile(
    new URL("../../components/billing/PaymentResult.tsx", import.meta.url),
    "utf8",
  );

  const submit = checkout.indexOf("async function submit");
  const createIntent = checkout.indexOf("/payment", submit);
  assert.ok(submit >= 0);
  assert.ok(createIntent > submit);
  assert.match(checkout.slice(createIntent), /method:\s*"POST"/);
  assert.doesNotMatch(
    checkout.slice(createIntent),
    /\b(?:amount|currency|provider|userId)\s*:/,
  );
  assert.match(route, /createOrderPaymentPostHandler/);
  assert.match(route, /createOrderPaymentGetHandler/);
  assert.match(checkout, /qrCodeDataUrl/);
  assert.match(checkout, /<Image/);
  assert.match(checkout, /setTimeout/);
  assert.match(paymentResult, /\/api\/billing\/payments\/mock\/confirm/);
  assert.match(paymentResult, /await refresh\(\)/);
});
