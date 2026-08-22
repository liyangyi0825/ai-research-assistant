import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  sign as rsaSign,
} from "node:crypto";
import test from "node:test";

import { getBillingConfig, type BillingConfig, type PaymentMode } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import { AlipayProvider } from "../../lib/billing/payments/alipay";
import { MockPaymentProvider } from "../../lib/billing/payments/mock";
import type { PaymentProvider } from "../../lib/billing/payments/provider";
import { getPaymentProvider } from "../../lib/billing/payments/registry";
import type {
  CreatePaymentInput,
  PaymentReferenceInput,
  PaymentWebhookEvent,
} from "../../lib/billing/payments/types";
import { WechatPayProvider } from "../../lib/billing/payments/wechat";

const now = new Date("2026-07-22T03:00:00.000Z");
const mockSecret = "unit-test-only-secret";

function mockProvider(): MockPaymentProvider {
  return new MockPaymentProvider({ secret: mockSecret, now: () => now });
}

function createInput(
  overrides: Partial<CreatePaymentInput> = {},
): CreatePaymentInput {
  return {
    orderNumber: "BILL-ORDER-1",
    description: "Pro Semester",
    amountMinor: 1_990,
    currency: "CNY",
    expiresAt: "2026-07-22T03:30:00.000Z",
    idempotencyKey: "create-order-1",
    ...overrides,
  };
}

function billingConfig(
  paymentMode: PaymentMode,
  overrides: Partial<BillingConfig> = {},
): BillingConfig {
  return {
    featureEnabled: true,
    paymentMode,
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

function expectBillingError(
  error: unknown,
  code: string,
  status: number,
): boolean {
  return (
    error instanceof BillingError && error.code === code && error.status === status
  );
}

test("Mock creates an opaque pending payment and can query it", async () => {
  const provider = new MockPaymentProvider({
    secret: mockSecret,
    now: () => now,
  });

  const created = await provider.createPayment(createInput());
  const reference: PaymentReferenceInput = {
    orderNumber: "BILL-ORDER-1",
    providerTransactionId: null,
  };
  const queried = await provider.queryPayment(reference);

  assert.equal(created.status, "PENDING");
  assert.equal(created.orderNumber, "BILL-ORDER-1");
  assert.equal(created.amountMinor, 1_990);
  assert.equal(created.currency, "CNY");
  assert.equal(created.expiresAt, "2026-07-22T03:30:00.000Z");
  assert.match(created.paymentToken, /^mock_test_[A-Za-z0-9_-]+$/);
  assert.equal(JSON.stringify(created).includes(mockSecret), false);
  assert.equal(JSON.stringify(provider).includes(mockSecret), false);
  assert.deepEqual(Object.keys(created).sort(), [
    "amountMinor",
    "currency",
    "expiresAt",
    "orderNumber",
    "paidAt",
    "paymentToken",
    "providerTransactionId",
    "status",
  ]);
  assert.deepEqual(queried, created);
  await assert.rejects(
    () =>
      provider.queryPayment({
        orderNumber: "BILL-OTHER-ORDER",
        providerTransactionId: created.providerTransactionId,
      }),
    (error: unknown) => expectBillingError(error, "PAYMENT_NOT_FOUND", 404),
  );
});

test("Mock create is idempotent only for an identical request", async () => {
  const provider = mockProvider();

  const first = await provider.createPayment(createInput());
  const repeated = await provider.createPayment(createInput());

  assert.deepEqual(repeated, first);
  await assert.rejects(
    () =>
      provider.createPayment(
        createInput({ amountMinor: 1, idempotencyKey: "create-order-1" }),
      ),
    (error: unknown) => expectBillingError(error, "IDEMPOTENCY_CONFLICT", 409),
  );
  await assert.rejects(
    () =>
      provider.createPayment(
        createInput({ idempotencyKey: "different-create-request" }),
      ),
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_ALREADY_EXISTS", 409),
  );
});

test("Mock returns an identical create retry after the payment expires", async () => {
  let clock = now;
  const provider = new MockPaymentProvider({
    secret: mockSecret,
    now: () => clock,
  });
  const first = await provider.createPayment(createInput());

  clock = new Date("2026-07-22T03:31:00.000Z");

  assert.deepEqual(await provider.createPayment(createInput()), first);
});

test("Mock accepts only safe integer CNY amounts and valid backend order data", async () => {
  const provider = mockProvider();

  for (const amountMinor of [1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => provider.createPayment(createInput({ amountMinor })),
      (error: unknown) =>
        expectBillingError(error, "INVALID_PAYMENT_AMOUNT", 400),
    );
  }
  await assert.rejects(
    () =>
      provider.createPayment(
        createInput({ currency: "USD" as CreatePaymentInput["currency"] }),
      ),
    (error: unknown) =>
      expectBillingError(error, "INVALID_PAYMENT_CURRENCY", 400),
  );
  await assert.rejects(
    () => provider.createPayment(createInput({ orderNumber: "  " })),
    (error: unknown) =>
      expectBillingError(error, "INVALID_PAYMENT_ORDER", 400),
  );
});

test("Mock server confirmation pays a pending unexpired payment only", async () => {
  const provider = new MockPaymentProvider({
    secret: mockSecret,
    now: () => now,
  });
  const created = await provider.createPayment(createInput());

  const paid = await provider.confirmPayment({
    orderNumber: created.orderNumber,
    providerTransactionId: created.providerTransactionId,
  });
  const repeated = await provider.confirmPayment({
    orderNumber: created.orderNumber,
    providerTransactionId: created.providerTransactionId,
  });

  assert.equal(paid.status, "PAID");
  assert.equal(paid.paidAt, now.toISOString());
  assert.deepEqual(repeated, paid);

  let expiredClock = new Date("2026-07-22T04:00:00.000Z");
  const expiredProvider = new MockPaymentProvider({
    secret: mockSecret,
    now: () => expiredClock,
  });
  const expired = await expiredProvider.createPayment(
    createInput({ expiresAt: "2026-07-22T04:00:01.000Z" }),
  );
  expiredClock = new Date("2026-07-22T04:00:02.000Z");
  await assert.rejects(
    () =>
      expiredProvider.confirmPayment({
        orderNumber: expired.orderNumber,
        providerTransactionId: expired.providerTransactionId,
      }),
    (error: unknown) => expectBillingError(error, "PAYMENT_EXPIRED", 409),
  );
});

test("Mock confirmation uses one timestamp across the expiration boundary", async () => {
  const times = [
    new Date("2026-07-22T03:00:00.000Z"),
    new Date("2026-07-22T03:29:59.999Z"),
    new Date("2026-07-22T03:30:00.001Z"),
  ];
  let clockCall = 0;
  const provider = new MockPaymentProvider({
    secret: mockSecret,
    now: () => times[Math.min(clockCall++, times.length - 1)],
  });
  const pending = await provider.createPayment(createInput());

  const paid = await provider.confirmPayment({
    orderNumber: pending.orderNumber,
    providerTransactionId: pending.providerTransactionId,
  });

  assert.equal(paid.status, "PAID");
  assert.equal(paid.paidAt, "2026-07-22T03:29:59.999Z");
  assert.ok(Date.parse(paid.paidAt) < Date.parse(paid.expiresAt));
});

test("Mock closes pending payments and rejects inconsistent transitions", async () => {
  const provider = mockProvider();
  const pending = await provider.createPayment(createInput());

  const closed = await provider.closePayment({
    orderNumber: pending.orderNumber,
    providerTransactionId: pending.providerTransactionId,
  });
  assert.equal(closed.status, "CLOSED");
  assert.deepEqual(
    await provider.closePayment({
      orderNumber: pending.orderNumber,
      providerTransactionId: pending.providerTransactionId,
    }),
    closed,
  );
  await assert.rejects(
    () =>
      provider.confirmPayment({
        orderNumber: pending.orderNumber,
        providerTransactionId: pending.providerTransactionId,
      }),
    (error: unknown) =>
      expectBillingError(error, "INVALID_PAYMENT_STATE", 409),
  );
});

test("Mock closes by owned order number and rejects mismatched transaction references", async () => {
  const provider = mockProvider();
  const byOrder = await provider.createPayment(createInput());

  const closed = await provider.closePayment({
    orderNumber: byOrder.orderNumber,
    providerTransactionId: null,
  });
  assert.equal(closed.status, "CLOSED");

  const second = await provider.createPayment(
    createInput({
      orderNumber: "BILL-ORDER-2",
      idempotencyKey: "create-order-2",
    }),
  );
  await assert.rejects(
    () =>
      provider.closePayment({
        orderNumber: "BILL-WRONG-ORDER",
        providerTransactionId: second.providerTransactionId,
      }),
    (error: unknown) => expectBillingError(error, "PAYMENT_NOT_FOUND", 404),
  );
});

test("Mock refunds a paid payment once and rejects conflicting refunds", async () => {
  const provider = mockProvider();
  const pending = await provider.createPayment(createInput());
  await provider.confirmPayment({
    orderNumber: pending.orderNumber,
    providerTransactionId: pending.providerTransactionId,
  });

  const refunded = await provider.refundPayment({
    providerTransactionId: pending.providerTransactionId,
    amountMinor: 1_990,
    currency: "CNY",
    idempotencyKey: "refund-order-1",
  });

  assert.equal(refunded.status, "SUCCEEDED");
  assert.equal(refunded.refundedAmountMinor, 1_990);
  assert.equal(
    (
      await provider.queryPayment({
        orderNumber: pending.orderNumber,
        providerTransactionId: pending.providerTransactionId,
      })
    ).status,
    "REFUNDED",
  );
  assert.deepEqual(
    await provider.refundPayment({
      providerTransactionId: pending.providerTransactionId,
      amountMinor: 1_990,
      currency: "CNY",
      idempotencyKey: "refund-order-1",
    }),
    refunded,
  );
  await assert.rejects(
    () =>
      provider.refundPayment({
        providerTransactionId: pending.providerTransactionId,
        amountMinor: 1,
        currency: "CNY",
        idempotencyKey: "refund-order-1",
      }),
    (error: unknown) => expectBillingError(error, "IDEMPOTENCY_CONFLICT", 409),
  );
});

test("Mock verifies HMAC webhooks without accepting tampering", async () => {
  const provider = mockProvider();
  const event: PaymentWebhookEvent = {
    eventId: "mock-event-1",
    eventType: "PAYMENT.PAID",
    providerTransactionId: "mock-payment-1",
    orderNumber: "BILL-ORDER-1",
    amountMinor: 1_990,
    currency: "CNY",
    occurredAt: now.toISOString(),
  };
  const rawBody = JSON.stringify(event);
  const signature = `sha256=${createHmac("sha256", mockSecret)
    .update(rawBody)
    .digest("hex")}`;

  assert.equal(
    await provider.verifyWebhook({
      rawBody,
      headers: { "x-mock-signature": signature },
    }),
    true,
  );
  assert.equal(
    await provider.verifyWebhook({
      rawBody: `${rawBody} `,
      headers: { "x-mock-signature": signature },
    }),
    false,
  );
  assert.equal(
    await provider.verifyWebhook({ rawBody, headers: {} }),
    false,
  );
  assert.deepEqual(await provider.parseWebhook({ rawBody, headers: {} }), event);
});

test("Mock webhook parsing rejects malformed or unsafe event data", async () => {
  const provider = mockProvider();

  for (const rawBody of [
    "not-json",
    JSON.stringify({
      eventId: "event-1",
      eventType: "PAYMENT.PAID",
      providerTransactionId: "payment-1",
      orderNumber: "order-1",
      amountMinor: 1.5,
      currency: "CNY",
      occurredAt: now.toISOString(),
    }),
    JSON.stringify({
      eventId: "event-1",
      eventType: "PAYMENT.PAID",
      providerTransactionId: "payment-1",
      orderNumber: "order-1",
      amountMinor: 1_990,
      currency: "USD",
      occurredAt: now.toISOString(),
    }),
  ]) {
    await assert.rejects(
      () => provider.parseWebhook({ rawBody, headers: {} }),
      (error: unknown) => expectBillingError(error, "INVALID_WEBHOOK", 400),
    );
  }
});

test("formal provider skeletons fail closed for every method", async () => {
  for (const [Provider, configured] of [
    [WechatPayProvider, false],
    [AlipayProvider, false],
    [WechatPayProvider, true],
    [AlipayProvider, true],
  ] as const) {
    const provider: PaymentProvider = new Provider(configured);
    const expectedCode = configured ? "NOT_IMPLEMENTED" : "PROVIDER_NOT_CONFIGURED";
    const expectedStatus = configured ? 501 : 503;
    const operations = [
      () => provider.createPayment(createInput()),
      () =>
        provider.queryPayment({ orderNumber: "order-id", providerTransactionId: "payment-id" }),
      () =>
        provider.closePayment({ orderNumber: "order-id", providerTransactionId: "payment-id" }),
      () =>
        provider.refundPayment({
          providerTransactionId: "payment-id",
          amountMinor: 1_990,
          currency: "CNY",
          idempotencyKey: "refund-1",
        }),
      () => provider.verifyWebhook({ rawBody: "{}", headers: {} }),
      () => provider.parseWebhook({ rawBody: "{}", headers: {} }),
    ];

    for (const operation of operations) {
      await assert.rejects(
        operation,
        (error: unknown) =>
          expectBillingError(error, expectedCode, expectedStatus),
      );
    }
  }
});

test("registry selects only the server-configured payment mode", () => {
  assert.ok(
    getPaymentProvider("mock", billingConfig("mock")) instanceof
      MockPaymentProvider,
  );
  assert.ok(
    getPaymentProvider("alipay", billingConfig("alipay")) instanceof
      AlipayProvider,
  );
  assert.throws(
    () => getPaymentProvider("mock", billingConfig("wechat")),
    (error: unknown) =>
      expectBillingError(error, "PAYMENT_PROVIDER_MISMATCH", 400),
  );
  assert.throws(
    () => getPaymentProvider("wechat", billingConfig("wechat")),
    (error: unknown) =>
      expectBillingError(error, "PROVIDER_NOT_CONFIGURED", 503),
  );
});

test("registry wires validated WeChat config through the real HTTP client with an injected transport", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const registryNow = new Date("2026-08-22T01:02:03.000Z");
  const responseTimestamp = String(Math.floor(registryNow.getTime() / 1_000));
  const responseNonce = "registry-response-nonce";
  const responseBody = JSON.stringify({
    code_url: "weixin://wxpay/bizpayurl?pr=registry-wired",
  });
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const config = getBillingConfig({
    BILLING_FEATURE_ENABLED: "true",
    PAYMENT_MODE: "wechat",
    WECHAT_PAY_MCH_ID: "1900000999",
    WECHAT_PAY_APP_ID: "app-from-config",
    WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
    WECHAT_PAY_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    WECHAT_PAY_CERT_SERIAL_NO: "ABCDEF1234",
    WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_FROM_CONFIG",
    WECHAT_PAY_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    WECHAT_PAY_NOTIFY_URL: "https://billing.test/wechat/callback",
  });
  const copiedPublicConfig = { ...config };
  assert.equal(copiedPublicConfig.wechatConfigured, true);
  assert.throws(
    () => getPaymentProvider("wechat", copiedPublicConfig),
    (error: unknown) =>
      expectBillingError(error, "PROVIDER_NOT_CONFIGURED", 503),
  );
  const provider = getPaymentProvider("wechat", config, {
    wechatFetch: async (input, init) => {
      calls.push({ input, init });
      return new Response(responseBody, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Wechatpay-Timestamp": responseTimestamp,
          "Wechatpay-Nonce": responseNonce,
          "Wechatpay-Signature": rsaSign(
            "RSA-SHA256",
            Buffer.from(
              `${responseTimestamp}\n${responseNonce}\n${responseBody}\n`,
              "utf8",
            ),
            privateKey,
          ).toString("base64"),
          "Wechatpay-Serial": "PUB_KEY_ID_FROM_CONFIG",
        },
      });
    },
    now: () => new Date(registryNow),
    nonce: () => "registry-request-nonce",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("registry test forbids the ambient network transport");
  };
  let payment: Awaited<ReturnType<PaymentProvider["createPayment"]>>;
  try {
    payment = await provider.createPayment(
      createInput({
        orderNumber: "BILL-REGISTRY-WIRING",
        expiresAt: "2099-08-22T01:32:03.000Z",
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(payment.paymentToken, "weixin://wxpay/bizpayurl?pr=registry-wired");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "https://api.mch.weixin.qq.com/v3/pay/transactions/native");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    appid: "app-from-config",
    mchid: "1900000999",
    description: "Pro Semester",
    out_trade_no: "BILL-REGISTRY-WIRING",
    time_expire: "2099-08-22T01:32:03.000Z",
    notify_url: "https://billing.test/wechat/callback",
    amount: { total: 1_990, currency: "CNY" },
  });
  const authorization = new Headers(calls[0]?.init.headers).get("Authorization");
  assert.match(authorization ?? "", /mchid="1900000999"/);
  assert.match(authorization ?? "", /serial_no="ABCDEF1234"/);
});

test("registry keeps Mock state and server confirmation across acquisitions", async () => {
  const config = billingConfig("mock");
  const firstProvider = getPaymentProvider("mock", config);
  const created = await firstProvider.createPayment(
    createInput({
      orderNumber: "BILL-REGISTRY-ORDER",
      expiresAt: "2099-01-01T00:00:00.000Z",
      idempotencyKey: "create-registry-order",
    }),
  );

  const secondProvider = getPaymentProvider("mock", config);
  assert.ok(secondProvider instanceof MockPaymentProvider);
  const paid = await secondProvider.confirmPayment({
    orderNumber: created.orderNumber,
    providerTransactionId: created.providerTransactionId,
  });

  assert.equal(paid.status, "PAID");
  assert.equal(
    (
      await firstProvider.queryPayment({
        orderNumber: created.orderNumber,
        providerTransactionId: created.providerTransactionId,
      })
    ).status,
    "PAID",
  );
});
