import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { BillingActor } from "../../lib/billing/auth";
import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import {
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

test("checkout follows create order -> create intent -> payment result and never sends price/provider to the intent route", async () => {
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

  const createOrder = checkout.indexOf('fetch("/api/billing/orders"');
  const createIntent = checkout.indexOf("/payment");
  const navigate = checkout.indexOf("/billing/payment-result");
  assert.ok(createOrder >= 0);
  assert.ok(createIntent > createOrder);
  assert.ok(navigate > createIntent);
  assert.match(checkout.slice(createIntent, navigate), /method:\s*"POST"/);
  assert.doesNotMatch(
    checkout.slice(createIntent, navigate),
    /\b(?:amount|currency|provider|userId)\s*:/,
  );
  assert.match(route, /createOrderPaymentPostHandler/);
  assert.match(paymentResult, /\/api\/billing\/payments\/mock\/confirm/);
  assert.match(paymentResult, /await refresh\(\)/);
});
