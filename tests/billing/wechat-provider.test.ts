import assert from "node:assert/strict";
import {
  createCipheriv,
  generateKeyPairSync,
  sign as rsaSign,
} from "node:crypto";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import type { WechatPayConfig } from "../../lib/billing/payments/wechat-config";
import { WechatHttpClient } from "../../lib/billing/payments/wechat-transport";
import { WechatPayProvider } from "../../lib/billing/payments/wechat";

const NOW = new Date("2026-08-19T10:02:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1_000));
const VERIFIER_ID = "PUB_KEY_ID_0111111111111111111111";
const API_V3_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const CALLBACK_NONCE = "callback1234";
const CALLBACK_AAD = "transaction";
const { privateKey: platformPrivateKey, publicKey: platformPublicKey } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: merchantPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const platformPublicKeyPem = platformPublicKey.export({
  type: "spki",
  format: "pem",
}).toString();

const BASE_TRANSACTION: Readonly<Record<string, unknown>> = {
  appid: "wx-app-1",
  mchid: "1900000109",
  out_trade_no: "BILL-ORDER-1",
  transaction_id: "4200000000001",
  trade_type: "NATIVE",
  trade_state: "SUCCESS",
  trade_state_desc: "支付成功",
  bank_type: "OTHERS",
  success_time: "2026-08-19T18:00:00+08:00",
  payer: { openid: "openid-test-only" },
  amount: {
    total: 7_900,
    payer_total: 7_900,
    currency: "CNY",
    payer_currency: "CNY",
  },
};

type FixtureOptions = {
  transaction?: Readonly<Record<string, unknown>>;
  plaintext?: string;
  timestamp?: string;
  encryptionAssociatedData?: string;
  resourceOverrides?: Readonly<Record<string, unknown>>;
  outerOverrides?: Readonly<Record<string, unknown>>;
};

function config(): WechatPayConfig {
  return {
    mchId: "1900000109",
    appId: "wx-app-1",
    apiV3Key: Buffer.from(API_V3_KEY),
    merchantPrivateKeyPem: merchantPrivateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString(),
    merchantCertificateSerialNumber: "MERCHANT_CERT_1",
    notifyUrl: "https://billing.example.test/api/billing/webhooks/wechat",
    verifier: {
      mode: "PUBLIC_KEY",
      keyId: VERIFIER_ID,
      publicKeyPem: platformPublicKeyPem,
    },
  };
}

function encryptResource(
  plaintext: string,
  associatedData: string,
): string {
  const cipher = createCipheriv(
    "aes-256-gcm",
    API_V3_KEY,
    Buffer.from(CALLBACK_NONCE, "utf8"),
  );
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  return Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}

function signature(rawBody: string, timestamp = TIMESTAMP): string {
  return rsaSign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\ncallback-signing-nonce\n${rawBody}\n`, "utf8"),
    platformPrivateKey,
  ).toString("base64");
}

function fixture(options: FixtureOptions = {}): {
  rawBody: string;
  headers: Record<string, string>;
} {
  const transaction = options.transaction ?? BASE_TRANSACTION;
  const plaintext = options.plaintext ?? JSON.stringify(transaction);
  const encryptionAssociatedData =
    options.encryptionAssociatedData ?? CALLBACK_AAD;
  const resource = {
    original_type: "transaction",
    algorithm: "AEAD_AES_256_GCM",
    ciphertext: encryptResource(plaintext, encryptionAssociatedData),
    associated_data: CALLBACK_AAD,
    nonce: CALLBACK_NONCE,
    ...options.resourceOverrides,
  };
  const outer = {
    id: "EVT-1",
    create_time: "2026-08-19T18:00:01+08:00",
    resource_type: "encrypt-resource",
    event_type: "TRANSACTION.SUCCESS",
    summary: "支付成功",
    resource,
    ...options.outerOverrides,
  };
  const rawBody = JSON.stringify(outer);
  const timestamp = options.timestamp ?? TIMESTAMP;
  return {
    rawBody,
    headers: {
      "WeChatPay-Timestamp": timestamp,
      "wechatpay-NONCE": "callback-signing-nonce",
      "WECHATPAY-SIGNATURE": signature(rawBody, timestamp),
      "Wechatpay-Serial": VERIFIER_ID,
    },
  };
}

function provider(options: {
  maxWebhookBytes?: number;
  webhookToleranceSeconds?: number;
  onFetch?: () => void;
} = {}): WechatPayProvider {
  const httpClient = new WechatHttpClient({
    config: config(),
    fetchImpl: async () => {
      options.onFetch?.();
      throw new Error("test HTTP client must never be called by callbacks");
    },
  });
  return new WechatPayProvider({
    config: config(),
    httpClient,
    now: () => new Date(NOW),
    maxWebhookBytes: options.maxWebhookBytes,
    webhookToleranceSeconds: options.webhookToleranceSeconds,
  });
}

function expectFixedError(
  error: unknown,
  expected: { code: string; status: number; message: string },
  forbidden: readonly string[] = [],
): boolean {
  assert.ok(error instanceof BillingError);
  assert.equal(error.code, expected.code);
  assert.equal(error.status, expected.status);
  assert.equal(error.message, expected.message);
  const serialized = JSON.stringify({
    name: error.name,
    code: error.code,
    status: error.status,
    message: error.message,
  });
  for (const secret of forbidden) {
    assert.equal(serialized.includes(secret), false);
  }
  return true;
}

const INVALID_SIGNATURE = {
  code: "INVALID_WEBHOOK_SIGNATURE",
  status: 401,
  message: "The WeChat Pay webhook signature is invalid.",
} as const;
const INVALID_WEBHOOK = {
  code: "INVALID_WEBHOOK",
  status: 400,
  message: "The WeChat Pay webhook payload is invalid.",
} as const;
const TOO_LARGE = {
  code: "WEBHOOK_BODY_TOO_LARGE",
  status: 413,
  message: "The payment webhook body is too large.",
} as const;

test("verifies exact callback bytes and maps a paid transaction DTO", async () => {
  let fetchCalls = 0;
  const callback = fixture();
  const wechat = provider({ onFetch: () => (fetchCalls += 1) });

  assert.equal(await wechat.verifyWebhook(callback), true);
  assert.deepEqual(await wechat.parseWebhook(callback), {
    eventId: "EVT-1",
    eventType: "PAYMENT.PAID",
    providerTransactionId: "4200000000001",
    orderNumber: "BILL-ORDER-1",
    amountMinor: 7_900,
    currency: "CNY",
    occurredAt: "2026-08-19T10:00:00.000Z",
  });
  assert.equal(fetchCalls, 0);
});

test("parseWebhook independently repeats verification without prior verify state", async () => {
  const callback = fixture();
  assert.deepEqual(await provider().parseWebhook(callback), {
    eventId: "EVT-1",
    eventType: "PAYMENT.PAID",
    providerTransactionId: "4200000000001",
    orderNumber: "BILL-ORDER-1",
    amountMinor: 7_900,
    currency: "CNY",
    occurredAt: "2026-08-19T10:00:00.000Z",
  });

  await assert.rejects(
    provider().parseWebhook({
      ...callback,
      rawBody: `${callback.rawBody} `,
    }),
    (error: unknown) => expectFixedError(error, INVALID_SIGNATURE),
  );
});

test("missing, ambiguous, empty, and comma-joined headers fail permanently", async () => {
  const callback = fixture();
  const cases: ReadonlyArray<Record<string, string | undefined>> = [
    {},
    { ...callback.headers, "Wechatpay-Signature": undefined },
    { ...callback.headers, "Wechatpay-Signature": "" },
    {
      ...callback.headers,
      "Wechatpay-Signature": `${callback.headers["WECHATPAY-SIGNATURE"]},duplicate-secret`,
    },
    {
      ...callback.headers,
      "wechatpay-timestamp": callback.headers["WeChatPay-Timestamp"],
    },
  ];

  for (const headers of cases) {
    await assert.rejects(
      provider().verifyWebhook({ rawBody: callback.rawBody, headers }),
      (error: unknown) =>
        expectFixedError(error, INVALID_SIGNATURE, ["duplicate-secret"]),
    );
  }
});

test("stale timestamps, unknown verifiers, malformed Base64, and bad signatures use one fixed error", async () => {
  const stale = fixture({ timestamp: String(Number(TIMESTAMP) - 301) });
  const callback = fixture();
  const secretSignature = "signature-secret-not-for-error";
  const cases = [
    stale,
    {
      ...callback,
      headers: { ...callback.headers, "Wechatpay-Serial": "UNKNOWN-SECRET-ID" },
    },
    {
      ...callback,
      headers: { ...callback.headers, "WECHATPAY-SIGNATURE": "%%%not-base64%%%" },
    },
    {
      ...callback,
      headers: {
        ...callback.headers,
        "WECHATPAY-SIGNATURE": Buffer.from(secretSignature).toString("base64"),
      },
    },
  ];

  for (const entry of cases) {
    await assert.rejects(
      provider().verifyWebhook(entry),
      (error: unknown) =>
        expectFixedError(error, INVALID_SIGNATURE, [
          "UNKNOWN-SECRET-ID",
          "%%%not-base64%%%",
          secretSignature,
        ]),
    );
  }
});

test("timestamp tolerance accepts both exact 300-second boundaries", async () => {
  for (const timestamp of [
    String(Number(TIMESTAMP) - 300),
    String(Number(TIMESTAMP) + 300),
  ]) {
    assert.equal(await provider().verifyWebhook(fixture({ timestamp })), true);
  }
});

test("callback byte limits use UTF-8 bytes for verify and parse", async () => {
  const callback = fixture();
  const maxWebhookBytes = Buffer.byteLength(callback.rawBody, "utf8") - 1;
  const wechat = provider({ maxWebhookBytes });

  await assert.rejects(
    wechat.verifyWebhook(callback),
    (error: unknown) => expectFixedError(error, TOO_LARGE),
  );
  await assert.rejects(
    wechat.parseWebhook(callback),
    (error: unknown) => expectFixedError(error, TOO_LARGE),
  );

  const multibyte = fixture({ outerOverrides: { summary: "支".repeat(400) } });
  const characterLimit = multibyte.rawBody.length + 1;
  assert.ok(Buffer.byteLength(multibyte.rawBody, "utf8") > characterLimit);
  await assert.rejects(
    provider({ maxWebhookBytes: characterLimit }).verifyWebhook(multibyte),
    (error: unknown) => expectFixedError(error, TOO_LARGE),
  );
});

test("signed resources with wrong AAD or authentication tags fail without leakage", async () => {
  const wrongAad = fixture({ encryptionAssociatedData: "different-secret-aad" });
  const valid = fixture();
  const parsedOuter = JSON.parse(valid.rawBody) as {
    resource: { ciphertext: string };
  };
  const tamperedBytes = Buffer.from(parsedOuter.resource.ciphertext, "base64");
  tamperedBytes[tamperedBytes.length - 1] ^= 1;
  const wrongTag = fixture({
    resourceOverrides: { ciphertext: tamperedBytes.toString("base64") },
  });

  for (const callback of [wrongAad, wrongTag]) {
    await assert.rejects(
      provider().parseWebhook(callback),
      (error: unknown) =>
        expectFixedError(error, INVALID_WEBHOOK, [
          callback.rawBody,
          "different-secret-aad",
          parsedOuter.resource.ciphertext,
        ]),
    );
  }
});

test("outer event and encrypted resource schemas are strict", async () => {
  const cases = [
    fixture({ outerOverrides: { id: "" } }),
    fixture({ outerOverrides: { event_type: "TRANSACTION.CLOSED" } }),
    fixture({ outerOverrides: { event_type: 7 } }),
    fixture({ outerOverrides: { create_time: 7 } }),
    fixture({ outerOverrides: { summary: {} } }),
    fixture({ outerOverrides: { resource_type: undefined } }),
    fixture({ outerOverrides: { resource_type: "plaintext-resource" } }),
    fixture({ outerOverrides: { resource: null } }),
    fixture({ resourceOverrides: { original_type: undefined } }),
    fixture({ resourceOverrides: { original_type: "refund" } }),
    fixture({ resourceOverrides: { algorithm: "AES-UNKNOWN" } }),
    fixture({ resourceOverrides: { nonce: 7 } }),
    fixture({ resourceOverrides: { associated_data: null } }),
    fixture({ resourceOverrides: { ciphertext: [] } }),
    fixture({ plaintext: "null" }),
    fixture({ plaintext: "[]" }),
    fixture({ plaintext: "not-json-secret" }),
  ];

  for (const callback of cases) {
    await assert.rejects(
      provider().parseWebhook(callback),
      (error: unknown) =>
        expectFixedError(error, INVALID_WEBHOOK, [
          callback.rawBody,
          "not-json-secret",
          "AES-UNKNOWN",
        ]),
    );
  }
});

test("only successful transactions for the configured merchant and app are mapped", async () => {
  const cases = [
    { trade_state: undefined },
    { trade_state: "NOTPAY", code_url: "code-url-secret-not-for-error" },
    { mchid: "other-secret-merchant" },
    { appid: "other-secret-app" },
    { trade_type: 7 },
    { payer: [] },
    { transaction_id: "" },
    { transaction_id: "x".repeat(65) },
    { out_trade_no: " " },
    { out_trade_no: "x".repeat(65) },
  ];

  for (const override of cases) {
    const transaction = { ...BASE_TRANSACTION, ...override };
    await assert.rejects(
      provider().parseWebhook(fixture({ transaction })),
      (error: unknown) =>
        expectFixedError(error, INVALID_WEBHOOK, [
          JSON.stringify(transaction),
          "other-secret-merchant",
          "other-secret-app",
          "code-url-secret-not-for-error",
        ]),
    );
  }
});

test("amount, currency, and success time reject unsafe or malformed values", async () => {
  const amountCases: unknown[] = [
    { total: 0, currency: "CNY" },
    { total: -1, currency: "CNY" },
    { total: 1.5, currency: "CNY" },
    { total: Number.MAX_SAFE_INTEGER + 1, currency: "CNY" },
    { total: 7_900, currency: "USD" },
    { total: "7900", currency: "CNY" },
    { total: 7_900, currency: "CNY", payer_total: "7900" },
    { total: 7_900, currency: "CNY", payer_currency: 7 },
    null,
    [],
  ];
  const transactions: Array<Record<string, unknown>> = amountCases.map((amount) => ({
    ...BASE_TRANSACTION,
    amount,
  }));
  transactions.push(
    { ...BASE_TRANSACTION, success_time: "not-a-date-secret" },
    { ...BASE_TRANSACTION, success_time: "2026-02-30T10:00:00Z" },
    { ...BASE_TRANSACTION, success_time: 7 },
  );

  for (const transaction of transactions) {
    await assert.rejects(
      provider().parseWebhook(fixture({ transaction })),
      (error: unknown) =>
        expectFixedError(error, INVALID_WEBHOOK, [
          JSON.stringify(transaction),
          "not-a-date-secret",
          "USD",
        ]),
    );
  }
});

test("legacy boolean construction cannot enable callback verification", async () => {
  const callback = fixture();
  for (const [configured, code, status] of [
    [false, "PROVIDER_NOT_CONFIGURED", 503],
    [true, "NOT_IMPLEMENTED", 501],
  ] as const) {
    const legacy = new WechatPayProvider(configured);
    await assert.rejects(
      legacy.verifyWebhook(callback),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === code &&
        error.status === status,
    );
    await assert.rejects(
      legacy.parseWebhook(callback),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === code &&
        error.status === status,
    );
  }
});

test("callback dependencies do not implement create, query, close, or refund", async () => {
  const wechat = provider();
  const operations = [
    () =>
      wechat.createPayment({
        orderNumber: "BILL-ORDER-1",
        description: "Pro Semester",
        amountMinor: 7_900,
        currency: "CNY" as const,
        expiresAt: "2026-08-19T11:00:00.000Z",
        idempotencyKey: "create-order-1",
      }),
    () =>
      wechat.queryPayment({
        orderNumber: "BILL-ORDER-1",
        providerTransactionId: "4200000000001",
      }),
    () =>
      wechat.closePayment({
        orderNumber: "BILL-ORDER-1",
        providerTransactionId: "4200000000001",
      }),
    () =>
      wechat.refundPayment({
        providerTransactionId: "4200000000001",
        amountMinor: 7_900,
        currency: "CNY" as const,
        idempotencyKey: "refund-order-1",
      }),
  ];

  for (const operation of operations) {
    await assert.rejects(
      operation,
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "NOT_IMPLEMENTED" &&
        error.status === 501,
    );
  }
});
