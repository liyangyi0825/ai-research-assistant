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
  return encryptResourceBytes(Buffer.from(plaintext, "utf8"), associatedData);
}

function encryptResourceBytes(
  plaintext: Uint8Array,
  associatedData: string,
): string {
  const cipher = createCipheriv(
    "aes-256-gcm",
    API_V3_KEY,
    Buffer.from(CALLBACK_NONCE, "utf8"),
  );
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  return Buffer.concat([
    cipher.update(plaintext),
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

function signedCallback(rawBody: string): {
  rawBody: string;
  headers: Record<string, string>;
} {
  return {
    rawBody,
    headers: {
      "WeChatPay-Timestamp": TIMESTAMP,
      "wechatpay-NONCE": "callback-signing-nonce",
      "WECHATPAY-SIGNATURE": signature(rawBody),
      "Wechatpay-Serial": VERIFIER_ID,
    },
  };
}

function handwrittenResource(ciphertext: string, extra = ""): string {
  return (
    `{"original_type":"transaction",` +
    `"algorithm":"AEAD_AES_256_GCM",` +
    `"ciphertext":"${ciphertext}",` +
    `"associated_data":"transaction",` +
    `"nonce":"callback1234"${extra}}`
  );
}

function handwrittenOuter(resource: string, eventEntries: string): string {
  return (
    `{"id":"EVT-1",` +
    `"create_time":"2026-08-19T18:00:01+08:00",` +
    `"resource_type":"encrypt-resource",` +
    `${eventEntries},` +
    `"summary":"支付成功",` +
    `"resource":${resource}}`
  );
}

function handwrittenTransaction(totalLiteral: string, extra = ""): string {
  return (
    `{"appid":"wx-app-1",` +
    `"mchid":"1900000109",` +
    `"out_trade_no":"BILL-ORDER-1",` +
    `"transaction_id":"4200000000001",` +
    `"trade_state":"SUCCESS",` +
    `"success_time":"2026-08-19T18:00:00+08:00",` +
    `"amount":{"total":${totalLiteral},"currency":"CNY"}${extra}}`
  );
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

function signedResponse(body: unknown, status = 200): Response {
  return signedRawResponse(JSON.stringify(body), status);
}

function signedRawResponse(rawBody: string, status = 200): Response {
  return new Response(rawBody, {
    status,
    headers: {
      "Wechatpay-Timestamp": TIMESTAMP,
      "Wechatpay-Nonce": "callback-signing-nonce",
      "Wechatpay-Signature": signature(rawBody),
      "Wechatpay-Serial": VERIFIER_ID,
      "Content-Type": "application/json",
    },
  });
}

function nativeProvider(
  responses: Response[],
  recorded: Array<{ url: string; method: string; body: unknown }>,
  options: {
    timeoutMs?: number;
    hangRequestAt?: number;
    connectionFailureAt?: number;
  } = {},
): WechatPayProvider {
  const httpClient = new WechatHttpClient({
    config: config(),
    now: () => new Date(NOW),
    nonce: () => "native-request-nonce",
    timeoutMs: options.timeoutMs,
    fetchImpl: async (url, init) => {
      recorded.push({
        url,
        method: init.method ?? "GET",
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (options.hangRequestAt === recorded.length) {
        return new Promise<Response>(() => undefined);
      }
      if (options.connectionFailureAt === recorded.length) {
        throw new TypeError("test-connection-failure");
      }
      const response = responses.shift();
      if (!response) throw new Error("unexpected test request");
      return response;
    },
  });
  return new WechatPayProvider({
    config: config(),
    httpClient,
    now: () => new Date("2026-08-19T01:00:00.000Z"),
  });
}

function nativeTransaction(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    appid: "wx-app-1",
    mchid: "1900000109",
    out_trade_no: "BILL-ORDER-1",
    transaction_id: "4200000000001",
    trade_type: "NATIVE",
    trade_state: "NOTPAY",
    amount: { total: 7_900, currency: "CNY" },
    time_expire: "2026-08-19T10:30:00+08:00",
    ...overrides,
  };
}

const NATIVE_CREATE_INPUT = {
  orderNumber: "BILL-ORDER-1",
  description: "Pro Semester",
  amountMinor: 7_900,
  currency: "CNY" as const,
  expiresAt: "2026-08-19T10:30:00+08:00",
  idempotencyKey: "create-order-1",
};

const NATIVE_REFERENCE = {
  orderNumber: "BILL-ORDER-1",
  providerTransactionId: "4200000000001",
  amountMinor: 7_900,
  currency: "CNY" as const,
  expiresAt: "2026-08-19T10:30:00+08:00",
  paymentToken: "weixin://wxpay/bizpayurl?pr=persisted",
};

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

test("parseWebhook never reuses a prior successful verification", async () => {
  const wechat = provider();
  const callback = fixture();
  assert.equal(await wechat.verifyWebhook(callback), true);

  await assert.rejects(
    wechat.parseWebhook({
      ...callback,
      rawBody: `${callback.rawBody} `,
    }),
    (error: unknown) => expectFixedError(error, INVALID_SIGNATURE),
  );
});

test("duplicate keys at every callback object layer are permanently rejected", async () => {
  const encrypted = encryptResource(
    JSON.stringify(BASE_TRANSACTION),
    CALLBACK_AAD,
  );
  const standardResource = handwrittenResource(encrypted);
  const outerDuplicate = signedCallback(
    handwrittenOuter(
      standardResource,
      `"event_type":"TRANSACTION.SUCCESS","event_type":"TRANSACTION.SUCCESS"`,
    ),
  );
  const escapedOuterDuplicate = signedCallback(
    handwrittenOuter(
      standardResource,
      `"event_type":"TRANSACTION.SUCCESS","\\u0065vent_type":"TRANSACTION.SUCCESS"`,
    ),
  );
  const resourceDuplicate = signedCallback(
    handwrittenOuter(
      handwrittenResource(encrypted, `,"nonce":"duplicate-resource-secret"`),
      `"event_type":"TRANSACTION.SUCCESS"`,
    ),
  );
  const decryptedDuplicates = [
    `{"appid":"wx-app-1","mchid":"1900000109","out_trade_no":"BILL-ORDER-1","transaction_id":"4200000000001","transaction_id":"duplicate-transaction-secret","trade_state":"SUCCESS","success_time":"2026-08-19T18:00:00+08:00","amount":{"total":7900,"currency":"CNY"}}`,
    `{"appid":"wx-app-1","mchid":"1900000109","out_trade_no":"BILL-ORDER-1","transaction_id":"4200000000001","trade_state":"SUCCESS","success_time":"2026-08-19T18:00:00+08:00","amount":{"total":7900,"total":7900,"currency":"CNY"}}`,
    `{"appid":"wx-app-1","mchid":"1900000109","out_trade_no":"BILL-ORDER-1","transaction_id":"4200000000001","trade_state":"SUCCESS","success_time":"2026-08-19T18:00:00+08:00","payer":{"openid":"first","openid":"duplicate-payer-secret"},"amount":{"total":7900,"currency":"CNY"}}`,
  ];
  const callbacks = [
    outerDuplicate,
    escapedOuterDuplicate,
    resourceDuplicate,
    ...decryptedDuplicates.map((plaintext) => fixture({ plaintext })),
  ];

  for (const callback of callbacks) {
    await assert.rejects(
      provider().parseWebhook(callback),
      (error: unknown) =>
        expectFixedError(error, INVALID_WEBHOOK, [
          callback.rawBody,
          "duplicate-resource-secret",
          "duplicate-transaction-secret",
          "duplicate-payer-secret",
        ]),
    );
  }
});

test("amount JSON numbers are accepted only as lossless plain safe integers", async () => {
  for (const [literal, expected] of [
    ["9007199254740991", 9_007_199_254_740_991],
    ["1e3", 1_000],
    ["1.0", 1],
    ["10e-1", 1],
    ["90071992547409910e-1", 9_007_199_254_740_991],
  ] as const) {
    const callback = fixture({
      plaintext: handwrittenTransaction(literal),
    });
    assert.equal((await provider().parseWebhook(callback)).amountMinor, expected);
  }

  for (const literal of [
    "0",
    "-1",
    "9007199254740992",
    "0.1",
    "1.5",
    "1e-1",
    "9007199254740991.1",
    "1e1000000",
    "0e1000000",
  ]) {
    const callback = fixture({ plaintext: handwrittenTransaction(literal) });
    await assert.rejects(
      provider().parseWebhook(callback),
      (error: unknown) =>
        expectFixedError(
          error,
          INVALID_WEBHOOK,
          literal === "9007199254740991.1"
            ? [callback.rawBody, literal]
            : [callback.rawBody],
        ),
    );
  }
});

test("payment identifiers reject every Unicode category C and non-scalar value", async () => {
  const callbacks = [
    fixture({ outerOverrides: { id: "EVT\u0085X" } }),
    fixture({ outerOverrides: { id: "EVT\uE000X" } }),
    fixture({ outerOverrides: { id: "EVT\u0378X" } }),
    fixture({
      transaction: { ...BASE_TRANSACTION, transaction_id: "TX\u202EX" },
    }),
    fixture({
      transaction: { ...BASE_TRANSACTION, transaction_id: "TX\u200BX" },
    }),
    fixture({
      plaintext: `{"appid":"wx-app-1","mchid":"1900000109","out_trade_no":"BILL-\\ud800-X","transaction_id":"4200000000001","trade_state":"SUCCESS","success_time":"2026-08-19T18:00:00+08:00","amount":{"total":7900,"currency":"CNY"}}`,
    }),
  ];

  for (const callback of callbacks) {
    await assert.rejects(
      provider().parseWebhook(callback),
      (error: unknown) =>
        expectFixedError(error, INVALID_WEBHOOK, [callback.rawBody]),
    );
  }
});

test("strict callback JSON rejects excessive nesting", async () => {
  const deepValue = `${"[".repeat(33)}0${"]".repeat(33)}`;
  const callback = fixture({
    plaintext: handwrittenTransaction("7900", `,"deep":${deepValue}`),
  });

  await assert.rejects(
    provider().parseWebhook(callback),
    (error: unknown) => expectFixedError(error, INVALID_WEBHOOK, [deepValue]),
  );
});

test("strict callback JSON preserves standard nested JSON value types", async () => {
  const callback = fixture({
    plaintext: handwrittenTransaction(
      "7900",
      `,"extensions":[true,false,null,{"label":"ok","values":[1,2,3,0e999,1.0,10e-1]}]`,
    ),
  });

  assert.equal((await provider().parseWebhook(callback)).amountMinor, 7_900);
});

test("strict callback JSON bounds aggregate nodes and individual strings", async () => {
  const nodeHeavy = fixture({
    plaintext: handwrittenTransaction(
      "7900",
      `,"extensions":[${"null,".repeat(10_000)}null]`,
    ),
  });
  const stringHeavy = fixture({
    plaintext: handwrittenTransaction(
      "7900",
      `,"description":"${"x".repeat(256 * 1024 + 1)}"`,
    ),
  });

  await assert.rejects(
    provider().parseWebhook(nodeHeavy),
    (error: unknown) => expectFixedError(error, INVALID_WEBHOOK),
  );
  await assert.rejects(
    provider({ maxWebhookBytes: 512 * 1024 }).parseWebhook(stringHeavy),
    (error: unknown) => expectFixedError(error, INVALID_WEBHOOK),
  );
});

test("authenticated resources containing invalid UTF-8 plaintext are rejected", async () => {
  const invalidPlaintext = Buffer.concat([
    Buffer.from(
      `{"appid":"wx-app-1","mchid":"1900000109","out_trade_no":"BILL-`,
      "utf8",
    ),
    Buffer.from([0xff]),
    Buffer.from(
      `-ORDER-1","transaction_id":"4200000000001","trade_state":"SUCCESS","success_time":"2026-08-19T18:00:00+08:00","amount":{"total":7900,"currency":"CNY"}}`,
      "utf8",
    ),
  ]);
  const callback = fixture({
    resourceOverrides: {
      ciphertext: encryptResourceBytes(
        invalidPlaintext,
        CALLBACK_AAD,
      ),
    },
  });

  await assert.rejects(
    provider().parseWebhook(callback),
    (error: unknown) => expectFixedError(error, INVALID_WEBHOOK, [callback.rawBody]),
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

test("creates a Native payment with the exact server-owned request DTO", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [signedResponse({ code_url: "weixin://wxpay/bizpayurl?pr=test-only" })],
    recorded,
  );

  const result = await wechat.createPayment(NATIVE_CREATE_INPUT);

  assert.deepEqual(recorded, [
    {
      url: "https://api.mch.weixin.qq.com/v3/pay/transactions/native",
      method: "POST",
      body: {
        appid: "wx-app-1",
        mchid: "1900000109",
        description: "Pro Semester",
        out_trade_no: "BILL-ORDER-1",
        time_expire: "2026-08-19T10:30:00+08:00",
        notify_url: "https://billing.example.test/api/billing/webhooks/wechat",
        amount: { total: 7900, currency: "CNY" },
      },
    },
  ]);
  assert.equal(result.paymentToken, "weixin://wxpay/bizpayurl?pr=test-only");
  assert.equal(result.providerTransactionId, null);
  assert.equal(result.orderNumber, "BILL-ORDER-1");
  assert.equal(result.status, "PENDING");
  assert.equal(result.amountMinor, 7_900);
  assert.equal(result.currency, "CNY");
  assert.equal(result.expiresAt, "2026-08-19T10:30:00+08:00");
  assert.equal(result.paidAt, null);
});

test("bounds Native descriptions by code points and rejects create contract drift", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [signedResponse({ code_url: "weixin://wxpay/bizpayurl?pr=short" })],
    recorded,
  );
  await wechat.createPayment({
    ...NATIVE_CREATE_INPUT,
    description: "🙂".repeat(128),
  });
  assert.deepEqual((recorded[0]!.body as { description: string }).description, "🙂".repeat(127));

  const invalid = nativeProvider([signedResponse({ code_url: 42 })], []);
  await assert.rejects(
    () => invalid.createPayment(NATIVE_CREATE_INPUT),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
      error.status === 502,
  );
});

test("marks an uncertain unpaid Native create as requiring a new payment without inventing a token", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [
      signedResponse({}, 500),
      signedResponse(nativeTransaction()),
    ],
    recorded,
  );

  const result = await wechat.createPayment(NATIVE_CREATE_INPUT);

  assert.equal(result.status, "REQUIRES_NEW_PAYMENT");
  assert.equal(result.paymentToken, null);
  assert.equal(result.providerTransactionId, "4200000000001");
  assert.deepEqual(recorded.map(({ url, method }) => ({ url, method })), [
    {
      url: "https://api.mch.weixin.qq.com/v3/pay/transactions/native",
      method: "POST",
    },
    {
      url: "https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/BILL-ORDER-1?mchid=1900000109",
      method: "GET",
    },
  ]);
});

test("persists a verified paid recovery with the real transaction and no payment token", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [
      signedResponse({}, 500),
      signedResponse(nativeTransaction({
        trade_state: "SUCCESS",
        success_time: "2026-08-19T10:00:00+08:00",
      })),
    ],
    recorded,
  );
  const queried = await wechat.createPayment(NATIVE_CREATE_INPUT);

  assert.equal(queried.status, "PAID");
  assert.equal(queried.providerTransactionId, "4200000000001");
  assert.equal(queried.paymentToken, null);
  assert.equal(queried.paidAt, "2026-08-19T02:00:00.000Z");
  assert.equal(
    recorded[1]!.url,
    "https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/BILL-ORDER-1?mchid=1900000109",
  );
});

test("rejects wrong server-owned amount and expiry when recovering an uncertain Native create", async () => {
  for (const transaction of [
    nativeTransaction({ amount: { total: 7_901, currency: "CNY" } }),
    nativeTransaction({ time_expire: "2026-08-19T10:31:00+08:00" }),
  ]) {
    const wechat = nativeProvider(
      [signedResponse({}, 500), signedResponse(transaction)],
      [],
    );
    await assert.rejects(
      () => wechat.createPayment(NATIVE_CREATE_INPUT),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
        error.status === 502,
    );
  }
});

test("maps every Native query trade state from durable expectations in a fresh provider", async () => {
  const cases = [
    ["SUCCESS", "PAID", "2026-08-19T02:00:00.000Z"],
    ["NOTPAY", "PENDING", null],
    ["USERPAYING", "PENDING", null],
    ["CLOSED", "CLOSED", null],
    ["PAYERROR", "FAILED", null],
    ["REFUND", "REFUNDED", null],
  ] as const;

  for (const [tradeState, status, paidAt] of cases) {
    const recorded: Array<{ url: string; method: string; body: unknown }> = [];
    const wechat = nativeProvider([
      signedResponse(
        nativeTransaction({
          trade_state: tradeState,
          ...(tradeState === "SUCCESS"
            ? { success_time: "2026-08-19T10:00:00+08:00" }
            : {}),
        }),
      ),
    ], recorded);
    const result = await wechat.queryPayment({
      ...NATIVE_REFERENCE,
    });

    assert.equal(
      recorded[0]!.url,
      "https://api.mch.weixin.qq.com/v3/pay/transactions/id/4200000000001?mchid=1900000109",
    );
    assert.equal(recorded[0]!.method, "GET");
    assert.equal(recorded[0]!.body, undefined);
    assert.equal(result.status, status);
    assert.equal(result.paidAt, paidAt);
    assert.equal(
      result.paymentToken,
      status === "PENDING" ? NATIVE_REFERENCE.paymentToken : null,
    );
  }
});

test("validates a fresh Native close before POST and recovers paid and timed-out closes by query", async () => {
  const pendingCalls: Array<{ url: string; method: string; body: unknown }> = [];
  const pending = nativeProvider(
    [
      signedResponse(nativeTransaction()),
      signedResponse({}),
      signedResponse(nativeTransaction({ trade_state: "CLOSED" })),
    ],
    pendingCalls,
  );
  const closed = await pending.closePayment({
    ...NATIVE_REFERENCE,
  });
  assert.equal(closed.status, "CLOSED");
  assert.deepEqual(pendingCalls.map(({ url, method, body }) => ({ url, method, body })), [
    {
      url: "https://api.mch.weixin.qq.com/v3/pay/transactions/id/4200000000001?mchid=1900000109",
      method: "GET",
      body: undefined,
    },
    {
      url: "https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/BILL-ORDER-1/close",
      method: "POST",
      body: { mchid: "1900000109" },
    },
    {
      url: "https://api.mch.weixin.qq.com/v3/pay/transactions/id/4200000000001?mchid=1900000109",
      method: "GET",
      body: undefined,
    },
  ]);

  const paid = nativeProvider(
    [
      signedResponse(
        nativeTransaction({
          trade_state: "SUCCESS",
          success_time: "2026-08-19T10:00:00+08:00",
        }),
      ),
    ],
    [],
  );
  assert.equal(
    (
      await paid.closePayment({
        ...NATIVE_REFERENCE,
      })
    ).status,
    "PAID",
  );

  const timeoutCalls: Array<{ url: string; method: string; body: unknown }> = [];
  const timedOut = nativeProvider(
    [
      signedResponse(nativeTransaction()),
      signedResponse(nativeTransaction({ trade_state: "CLOSED" })),
    ],
    timeoutCalls,
    { timeoutMs: 0, hangRequestAt: 2 },
  );
  assert.equal(
    (
      await timedOut.closePayment({
        ...NATIVE_REFERENCE,
      })
    ).status,
    "CLOSED",
  );
  assert.equal(timeoutCalls.length, 3);
});

test("fails closed when a Native query has no backend-owned amount and expiry", async () => {
  const wechat = nativeProvider([signedResponse(nativeTransaction())], []);
  await assert.rejects(
    () =>
      wechat.queryPayment({
        orderNumber: "BILL-ORDER-1",
        providerTransactionId: "4200000000001",
      }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
      error.status === 502,
  );
});

test("rejects Native transaction identity, amount, and currency mismatches", async () => {
  const mismatches = [
    { out_trade_no: "BILL-OTHER" },
    { transaction_id: "4200000000002" },
    { appid: "wx-other" },
    { mchid: "1900000000" },
    { amount: { total: 7_901, currency: "CNY" } },
    { amount: { total: 7_900, currency: "USD" } },
  ];

  for (const mismatch of mismatches) {
    const wechat = nativeProvider([signedResponse(nativeTransaction(mismatch))], []);
    await assert.rejects(
      () =>
        wechat.queryPayment({
          ...NATIVE_REFERENCE,
        }),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
        error.status === 502,
    );
  }
});

test("rejects duplicate-key signed Native responses with the strict JSON parser", async () => {
  const duplicateCreate = nativeProvider(
    [signedRawResponse('{"code_url":"weixin://one","code_url":"weixin://two"}')],
    [],
  );
  await assert.rejects(
    () => duplicateCreate.createPayment(NATIVE_CREATE_INPUT),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
      error.status === 502,
  );

  const duplicateQuery = nativeProvider(
    [signedRawResponse('{"appid":"wx-app-1","appid":"wx-other"}')],
    [],
  );
  await assert.rejects(
    () => duplicateQuery.queryPayment({ ...NATIVE_REFERENCE }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
      error.status === 502,
  );
});

test("rejects non-RFC3339 expiries and overlong path identifiers before HTTP", async () => {
  for (const input of [
    { ...NATIVE_CREATE_INPUT, expiresAt: "2026-08-19 10:30:00+08:00" },
    { ...NATIVE_CREATE_INPUT, orderNumber: "O".repeat(65) },
  ]) {
    const recorded: Array<{ url: string; method: string; body: unknown }> = [];
    await assert.rejects(
      () => nativeProvider([], recorded).createPayment(input),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "PAYMENT_PROVIDER_REQUEST_INVALID" &&
        error.status === 400,
    );
    assert.equal(recorded.length, 0);
  }

  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  await assert.rejects(
    () => nativeProvider([], recorded).closePayment({
      ...NATIVE_REFERENCE,
      providerTransactionId: "T".repeat(65),
    }),
    (error: unknown) =>
      error instanceof BillingError &&
        error.code === "PAYMENT_PROVIDER_REQUEST_INVALID" &&
      error.status === 400,
  );
  assert.equal(recorded.length, 0);
});

test("Native entry identifiers match transport-safe path segments", async () => {
  const unsafe = ["%", ".", "..", "order%2fescape", "line\nbreak"];
  for (const identifier of unsafe) {
    const createCalls: Array<{ url: string; method: string; body: unknown }> = [];
    const create = nativeProvider([], createCalls);
    await assert.rejects(
      () =>
        create.createPayment({
          ...NATIVE_CREATE_INPUT,
          orderNumber: identifier,
        }),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "PAYMENT_PROVIDER_REQUEST_INVALID" &&
        error.status === 400,
    );
    assert.equal(createCalls.length, 0);

    const queryCalls: Array<{ url: string; method: string; body: unknown }> = [];
    const query = nativeProvider([], queryCalls);
    await assert.rejects(
      () =>
        query.queryPayment({
          ...NATIVE_REFERENCE,
          providerTransactionId: identifier,
        }),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "PAYMENT_PROVIDER_REQUEST_INVALID" &&
        error.status === 400,
    );
    assert.equal(queryCalls.length, 0);
  }
});

test("a Native close mismatch fails before any POST", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider([
    signedResponse(nativeTransaction({ amount: { total: 7_901, currency: "CNY" } })),
  ], recorded);

  await assert.rejects(
    () => wechat.closePayment({ ...NATIVE_REFERENCE }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
      error.status === 502,
  );
  assert.deepEqual(recorded.map(({ method }) => method), ["GET"]);
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

const REFUND_INPUT = {
  providerTransactionId: "4200000000001",
  amountMinor: 7_900,
  currency: "CNY" as const,
  idempotencyKey: "billing-refund:request-1",
};

function refundResponse(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    refund_id: "5030000000000000001",
    out_refund_no: "a1a255e9c5297ead756ecb2f4117ffe0",
    transaction_id: "4200000000001",
    status: "SUCCESS",
    amount: { refund: 7_900, total: 7_900, currency: "CNY" },
    ...overrides,
  };
}

test("creates an idempotent full refund with the exact backend-owned DTO", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [signedResponse(refundResponse()), signedResponse(refundResponse())],
    recorded,
  );

  const first = await wechat.refundPayment(REFUND_INPUT);
  const retry = await wechat.refundPayment(REFUND_INPUT);

  assert.deepEqual(first, {
    providerRefundId: "5030000000000000001",
    providerTransactionId: "4200000000001",
    status: "SUCCEEDED",
    refundedAmountMinor: 7_900,
    currency: "CNY",
  });
  assert.deepEqual(retry, first);
  assert.deepEqual(recorded, [
    {
      url: "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds",
      method: "POST",
      body: {
        transaction_id: "4200000000001",
        out_refund_no: "a1a255e9c5297ead756ecb2f4117ffe0",
        reason: "USER_APPROVED_FULL_REFUND",
        amount: { refund: 7_900, total: 7_900, currency: "CNY" },
      },
    },
    {
      url: "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds",
      method: "POST",
      body: {
        transaction_id: "4200000000001",
        out_refund_no: "a1a255e9c5297ead756ecb2f4117ffe0",
        reason: "USER_APPROVED_FULL_REFUND",
        amount: { refund: 7_900, total: 7_900, currency: "CNY" },
      },
    },
  ]);
});

test("queries the deterministic refund after an uncertain response and preserves nonterminal uncertainty", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [signedResponse({}, 500), signedResponse(refundResponse({ status: "PROCESSING" }))],
    recorded,
  );

  await assert.rejects(
    () => wechat.refundPayment(REFUND_INPUT),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_UNAVAILABLE" &&
      error.status === 503,
  );
  assert.deepEqual(recorded.map(({ url, method, body }) => ({ url, method, body })), [
    {
      url: "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds",
      method: "POST",
      body: {
        transaction_id: "4200000000001",
        out_refund_no: "a1a255e9c5297ead756ecb2f4117ffe0",
        reason: "USER_APPROVED_FULL_REFUND",
        amount: { refund: 7_900, total: 7_900, currency: "CNY" },
      },
    },
    {
      url: "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds/a1a255e9c5297ead756ecb2f4117ffe0",
      method: "GET",
      body: undefined,
    },
  ]);
});

test("recovers a verified successful refund after a transport timeout", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [signedResponse(refundResponse())],
    recorded,
    { timeoutMs: 0, hangRequestAt: 1 },
  );

  const refund = await wechat.refundPayment(REFUND_INPUT);

  assert.equal(refund.status, "SUCCEEDED");
  assert.equal(recorded.length, 2);
  assert.equal(
    recorded[1]!.url,
    "https://api.mch.weixin.qq.com/v3/refund/domestic/refunds/a1a255e9c5297ead756ecb2f4117ffe0",
  );
});

test("recovers a verified successful refund after a connection failure", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [signedResponse(refundResponse())],
    recorded,
    { connectionFailureAt: 1 },
  );

  const refund = await wechat.refundPayment(REFUND_INPUT);

  assert.equal(refund.status, "SUCCEEDED");
  assert.deepEqual(recorded.map(({ method }) => method), ["POST", "GET"]);
});

test("keeps failed and not-found refund queries retryable", async () => {
  const failed = nativeProvider([
    signedResponse({}, 500),
    signedResponse(refundResponse({ status: "CLOSED" })),
  ], []);
  await assert.rejects(
    () => failed.refundPayment(REFUND_INPUT),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_UNAVAILABLE" &&
      error.status === 503,
  );

  const missing = nativeProvider([
    signedResponse({}, 500),
    signedResponse({ code: "RESOURCE_NOT_EXISTS" }, 404),
  ], []);
  await assert.rejects(
    () => missing.refundPayment(REFUND_INPUT),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_REQUEST_REJECTED" &&
      error.status === 400,
  );
});

test("does not classify a verified remote refund PARAM_ERROR as local preflight", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  const wechat = nativeProvider(
    [signedResponse({ code: "PARAM_ERROR" }, 400)],
    recorded,
  );

  await assert.rejects(
    () => wechat.refundPayment(REFUND_INPUT),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_REQUEST_INVALID" &&
      error.status === 400,
  );
  assert.deepEqual(recorded.map(({ method }) => method), ["POST"]);
});

test("rejects malformed, duplicate, and mismatched verified refund responses", async () => {
  for (const response of [
    refundResponse({ transaction_id: "4200000000002" }),
    refundResponse({ out_refund_no: "b".repeat(32) }),
    refundResponse({ amount: { refund: 7_899, total: 7_900, currency: "CNY" } }),
    refundResponse({ amount: { refund: 7_900, total: 7_900, currency: "USD" } }),
    { status: "SUCCESS" },
  ]) {
    await assert.rejects(
      () => nativeProvider([signedResponse(response)], []).refundPayment(REFUND_INPUT),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
        error.status === 502,
    );
  }

  await assert.rejects(
    () => nativeProvider([
      signedRawResponse('{"refund_id":"one","refund_id":"two"}'),
    ], []).refundPayment(REFUND_INPUT),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" &&
      error.status === 502,
  );
});

test("rejects invalid full-refund inputs before provider invocation", async () => {
  const recorded: Array<{ url: string; method: string; body: unknown }> = [];
  await assert.rejects(
    () => nativeProvider([], recorded).refundPayment({
      ...REFUND_INPUT,
      amountMinor: 0,
    }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_REFUND_PRECHECK_FAILED" &&
      error.status === 400,
  );
  assert.equal(recorded.length, 0);
});
