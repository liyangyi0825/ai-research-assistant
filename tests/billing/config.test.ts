import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  assertPaymentRuntimeSafe,
  getBillingConfig,
} from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import { loadWechatPayConfig } from "../../lib/billing/payments/wechat-config";
import {
  VALID_WECHAT_PLATFORM_CERTIFICATE,
} from "./helpers/wechat-certificates";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const testPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const testPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
const expiredTestCertificate = `-----BEGIN CERTIFICATE-----
MIICuzCCAaOgAwIBAgIJAK0647KjCDoVMA0GCSqGSIb3DQEBCwUAMB0xGzAZBgNVBAMT
EndlY2hhdC1jb25maWctdGVzdDAeFw0yNjA4MTgwOTI3NDdaFw0yNjA4MjAwOTI3NDdaMB0xGzAZ
BgNVBAMTEndlY2hhdC1jb25maWctdGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
APRdII17aYppQ6bROzum6JEOKO/7mjKP2exBCVgGit3tH3lkcI0ouK2AQo6vSWikCO1Xf6GKIFr+
GR/eRWD4srKjVFM6XtD+mrBlIB7U6F/EVrSXvNVpxsz0un9uY/AwBoO379nr+TQB6BzJ55dE2fpF
Fqw537cziNERJmDCzZUJ+M342QnmYaecTL0OzGjSjQ+3DgAznxkG9zhSRWe+N5N1PTfN7QNJ5+1I
/htURexHYB+9bTNBxIkbJo6cnp9R4/wtZnBLLA8zdFvAWVajbfV7BIvW2NzNZVUflrbbS+y5WD04
whLp49OwA/SEjULs3fbbvTXunRAM/e53x74oWhkCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEA59/O
iwqolnJWJFgz6JDfHs6z/yaapsn/O4o6MksZAGmWeepqrM+xG5MevPnSmfZd3vn2Wj3A/i7ebi/z
YdRB2mZ4KrB7G8nVz1OvPr28dlA1xiSl6P+CYwY61HczV8hGhoAemck2rdZ8UQ9HBu8KQmaxNBP
Loj7hNFA0MJ91C1DzW0TTOYsD8yK8cy1gCfr0SZ5SZPpW6nuf0ozRGI/Vnu0kiGDOrKaBX3YMfH
QCCFD4H1xOt5YScR1Xo4Cdxx4G8sq5/rwFwiBhcbZkEMVimckyDE4iNfhbCi/GSgjimvU6mwP/m
iuCvYg13CEv2skezRklelHcOgmEdumUJErdCQ==
-----END CERTIFICATE-----`;

function validWechatEnvironment(): Record<string, string> {
  return {
    WECHAT_PAY_MCH_ID: "1900000109",
    WECHAT_PAY_APP_ID: "wx1234567890abcdef",
    WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
    WECHAT_PAY_PRIVATE_KEY: testPrivateKey,
    WECHAT_PAY_CERT_SERIAL_NO: "A1B2C3D4E5F6",
    WECHAT_PAY_NOTIFY_URL: "https://example.test/payments/wechat/notify",
    WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_00000000000000000000000000000001",
    WECHAT_PAY_PUBLIC_KEY: testPublicKey,
  };
}

function billingErrorCode(error: unknown): string | null {
  return error instanceof BillingError ? error.code : null;
}

test("billing is disabled and uses mock payments by default", () => {
  const config = getBillingConfig({});

  assert.equal(config.featureEnabled, false);
  assert.equal(config.paymentMode, "mock");
  assert.deepEqual(config.testUserIds, []);
  assert.equal(config.wechatConfigured, false);
  assert.equal(config.alipayConfigured, false);
});

test("WeChat configuration accepts one public-key verifier and a 32-byte API v3 key", () => {
  const config = loadWechatPayConfig(validWechatEnvironment());

  assert.equal(config.apiV3Key.length, 32);
  assert.equal(config.verifier.mode, "PUBLIC_KEY");
  assert.equal(config.verifier.keyId, "PUB_KEY_ID_00000000000000000000000000000001");
});

test("WeChat configuration accepts a 34-digit payment public key ID", () => {
  const publicKeyId = `PUB_KEY_ID_${"1".repeat(34)}`;
  const config = loadWechatPayConfig({
    ...validWechatEnvironment(),
    WECHAT_PAY_PUBLIC_KEY_ID: publicKeyId,
  });

  assert.equal(config.verifier.mode, "PUBLIC_KEY");
  assert.equal(config.verifier.keyId, publicKeyId);
});

test("WeChat API v3 key validates and preserves the raw 32 UTF-8 bytes", () => {
  const exactMultibyteKey = `${"界".repeat(10)}xx`;
  const config = loadWechatPayConfig({
    ...validWechatEnvironment(),
    WECHAT_PAY_API_V3_KEY: exactMultibyteKey,
  });

  assert.equal(Buffer.byteLength(exactMultibyteKey, "utf8"), 32);
  assert.deepEqual(config.apiV3Key, Buffer.from(exactMultibyteKey, "utf8"));
});

test("WeChat API v3 key rejects raw leading or trailing whitespace", () => {
  for (const apiV3Key of [
    ` ${"x".repeat(32)}`,
    `${"x".repeat(32)} `,
  ]) {
    assert.throws(
      () =>
        loadWechatPayConfig({
          ...validWechatEnvironment(),
          WECHAT_PAY_API_V3_KEY: apiV3Key,
        }),
      (error: unknown) => {
        assert.ok(error instanceof BillingError);
        assert.equal(error.code, "PROVIDER_NOT_CONFIGURED");
        assert.match(error.message, /WECHAT_PAY_API_V3_KEY/);
        assert.doesNotMatch(error.message, new RegExp(apiV3Key));
        return true;
      },
    );
  }
});

test("WeChat API v3 key rejects 31-byte and 33-byte multibyte values", () => {
  for (const apiV3Key of [`${"界".repeat(10)}x`, "界".repeat(11)]) {
    assert.throws(
      () =>
        loadWechatPayConfig({
          ...validWechatEnvironment(),
          WECHAT_PAY_API_V3_KEY: apiV3Key,
        }),
      (error: unknown) =>
        billingErrorCode(error) === "PROVIDER_NOT_CONFIGURED",
    );
  }
});

test("WeChat configuration requires exactly one complete verifier mode", () => {
  assert.throws(
    () =>
      loadWechatPayConfig({
        ...validWechatEnvironment(),
        WECHAT_PAY_PUBLIC_KEY: undefined,
      }),
    (error: unknown) => billingErrorCode(error) === "PROVIDER_NOT_CONFIGURED",
  );
  assert.throws(
    () =>
      loadWechatPayConfig({
        ...validWechatEnvironment(),
        WECHAT_PAY_PLATFORM_CERT: VALID_WECHAT_PLATFORM_CERTIFICATE,
      }),
    (error: unknown) =>
      billingErrorCode(error) === "PAYMENT_CONFIGURATION_CONFLICT",
  );
});

test("WeChat configuration derives a normalized platform certificate serial number", () => {
  const environment = validWechatEnvironment();
  delete environment.WECHAT_PAY_PUBLIC_KEY_ID;
  delete environment.WECHAT_PAY_PUBLIC_KEY;
  environment.WECHAT_PAY_PLATFORM_CERT = VALID_WECHAT_PLATFORM_CERTIFICATE;

  const config = loadWechatPayConfig(environment);

  assert.deepEqual(config.verifier, {
    mode: "PLATFORM_CERTIFICATE",
    serialNumber: "B7B2B6CA7BD13715",
    certificatePem: VALID_WECHAT_PLATFORM_CERTIFICATE,
  });
});

test("WeChat startup credentials require RSA-2048 keys, strict identifiers, and a currently valid RSA certificate", () => {
  const weakRsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const invalidEnvironments = [
    { WECHAT_PAY_MCH_ID: "merchant-1" },
    { WECHAT_PAY_APP_ID: "app-1" },
    { WECHAT_PAY_CERT_SERIAL_NO: "serial-with-hyphens" },
    { WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_TEST" },
    { WECHAT_PAY_PUBLIC_KEY_ID: "1".repeat(34) },
    { WECHAT_PAY_PUBLIC_KEY_ID: `PUB_KEY_ID_${"1".repeat(65)}` },
    {
      WECHAT_PAY_PRIVATE_KEY: weakRsa.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    {
      WECHAT_PAY_PRIVATE_KEY: ec.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    {
      WECHAT_PAY_PUBLIC_KEY: weakRsa.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
    {
      WECHAT_PAY_PUBLIC_KEY: ec.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
  ];
  for (const overrides of invalidEnvironments) {
    assert.throws(
      () => loadWechatPayConfig({ ...validWechatEnvironment(), ...overrides }),
      (error: unknown) =>
        error instanceof BillingError && error.code === "PROVIDER_NOT_CONFIGURED",
    );
  }

  const platformEnvironment = validWechatEnvironment();
  delete platformEnvironment.WECHAT_PAY_PUBLIC_KEY_ID;
  delete platformEnvironment.WECHAT_PAY_PUBLIC_KEY;
  platformEnvironment.WECHAT_PAY_PLATFORM_CERT = expiredTestCertificate;
  assert.throws(
    () => loadWechatPayConfig(platformEnvironment),
    (error: unknown) =>
      error instanceof BillingError && error.code === "PROVIDER_NOT_CONFIGURED",
  );
});

test("WeChat configuration rejects a non-HTTPS notification URL independently", () => {
  assert.throws(
    () =>
      loadWechatPayConfig({
        ...validWechatEnvironment(),
        WECHAT_PAY_NOTIFY_URL: "http://example.test/notify",
      }),
    (error: unknown) => {
      assert.ok(error instanceof BillingError);
      assert.match(error.message, /WECHAT_PAY_NOTIFY_URL/);
      assert.doesNotMatch(error.message, /http:\/\/example\.test/);
      return true;
    },
  );
});

test("WeChat configuration rejects a malformed public key independently", () => {
  const secret = "not-a-public-key-secret";
  assert.throws(
    () =>
      loadWechatPayConfig({
        ...validWechatEnvironment(),
        WECHAT_PAY_PUBLIC_KEY: secret,
      }),
    (error: unknown) => {
      assert.ok(error instanceof BillingError);
      assert.match(error.message, /WECHAT_PAY_PUBLIC_KEY/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("WeChat configuration rejects conflicting canonical and alias values", () => {
  assert.throws(
    () =>
      loadWechatPayConfig({
        ...validWechatEnvironment(),
        WECHAT_PAY_MCH_PRIVATE_KEY: testPublicKey,
      }),
    (error: unknown) =>
      billingErrorCode(error) === "PAYMENT_CONFIGURATION_CONFLICT",
  );
  assert.throws(
    () =>
      loadWechatPayConfig({
        ...validWechatEnvironment(),
        WECHAT_PAY_MCH_SERIAL_NO: "different-merchant-cert",
      }),
    (error: unknown) =>
      billingErrorCode(error) === "PAYMENT_CONFIGURATION_CONFLICT",
  );
});

test("disabled billing reports only fully valid WeChat configuration as configured", () => {
  assert.equal(
    getBillingConfig({
      ...validWechatEnvironment(),
      BILLING_FEATURE_ENABLED: "false",
    }).wechatConfigured,
    true,
  );
  assert.equal(
    getBillingConfig({
      ...validWechatEnvironment(),
      BILLING_FEATURE_ENABLED: "false",
      WECHAT_PAY_PUBLIC_KEY: undefined,
    }).wechatConfigured,
    false,
  );
});

test("enabled WeChat billing keeps validated secrets outside its public shape", () => {
  const config = getBillingConfig({
    ...validWechatEnvironment(),
    BILLING_FEATURE_ENABLED: "true",
    PAYMENT_MODE: "wechat",
  });
  assert.equal(config.featureEnabled, true);
  assert.equal(config.paymentMode, "wechat");
  assert.equal(config.wechatConfigured, true);
  assert.equal(Reflect.ownKeys(config).includes("wechat"), false);
});

test("only the explicit true string enables billing", () => {
  assert.equal(
    getBillingConfig({ BILLING_FEATURE_ENABLED: "true" }).featureEnabled,
    true,
  );
  assert.equal(
    getBillingConfig({ BILLING_FEATURE_ENABLED: "TRUE" }).featureEnabled,
    false,
  );
});

test("production can start with billing disabled and mock payments", () => {
  const config = getBillingConfig({
    NODE_ENV: "production",
    BILLING_FEATURE_ENABLED: "false",
    PAYMENT_MODE: "mock",
  });

  assert.equal(config.featureEnabled, false);
  assert.doesNotThrow(() => assertPaymentRuntimeSafe(config, {}));
});

test("production rejects publicly enabled mock payments", () => {
  assert.throws(
    () =>
      getBillingConfig({
        NODE_ENV: "production",
        BILLING_FEATURE_ENABLED: "true",
        PAYMENT_MODE: "mock",
      }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "UNSAFE_PAYMENT_CONFIGURATION",
  );
});

test("production mock payments only permit an administrator or listed test user", () => {
  const config = getBillingConfig({
    NODE_ENV: "production",
    BILLING_FEATURE_ENABLED: "true",
    PAYMENT_MODE: "mock",
    BILLING_TEST_USER_IDS: " test-user ",
  });

  assert.throws(
    () => assertPaymentRuntimeSafe(config, { userId: "regular-user" }),
    (error: unknown) =>
      error instanceof BillingError && error.code === "MOCK_PAYMENT_NOT_ALLOWED",
  );
  assert.doesNotThrow(() =>
    assertPaymentRuntimeSafe(config, { userId: "test-user" }),
  );
  assert.doesNotThrow(() =>
    assertPaymentRuntimeSafe(config, { isAdmin: true }),
  );
});

test("real WeChat payments default to administrators and explicit test users until the public launch switch is true", () => {
  const restricted = {
    ...getBillingConfig({}),
    featureEnabled: true,
    paymentMode: "wechat" as const,
    wechatConfigured: true,
    testUserIds: ["test-user"],
    realPaymentPublicEnabled: false,
  };
  assert.throws(
    () => assertPaymentRuntimeSafe(restricted, { userId: "regular-user" }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "REAL_PAYMENT_NOT_ALLOWED" &&
      error.status === 403,
  );
  assert.doesNotThrow(() =>
    assertPaymentRuntimeSafe(restricted, { userId: "test-user" }),
  );
  assert.doesNotThrow(() =>
    assertPaymentRuntimeSafe(restricted, { isAdmin: true }),
  );
  assert.doesNotThrow(() =>
    assertPaymentRuntimeSafe(
      { ...restricted, realPaymentPublicEnabled: true },
      { userId: "regular-user" },
    ),
  );
});

test("a formal payment provider is rejected when its required configuration is missing", () => {
  assert.throws(
    () =>
      getBillingConfig({
        BILLING_FEATURE_ENABLED: "true",
        PAYMENT_MODE: "wechat",
        WECHAT_PAY_API_V3_KEY: "secret-value-that-must-not-leak",
      }),
    (error: unknown) =>
      error instanceof BillingError && error.code === "PROVIDER_NOT_CONFIGURED",
  );
});

test("configuration errors name missing variables without exposing their values", () => {
  const secret = "secret-value-that-must-not-leak";

  assert.throws(
    () =>
      getBillingConfig({
        ...validWechatEnvironment(),
        WECHAT_PAY_MCH_ID: undefined,
        UNUSED_SECRET: secret,
        BILLING_FEATURE_ENABLED: "true",
        PAYMENT_MODE: "wechat",
      }),
    (error: unknown) => {
      assert.ok(error instanceof BillingError);
      assert.match(error.message, /WECHAT_PAY_MCH_ID/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("test user IDs are trimmed and de-duplicated", () => {
  const config = getBillingConfig({
    BILLING_TEST_USER_IDS: " first-user, second-user , first-user, , third-user ",
  });

  assert.deepEqual(config.testUserIds, [
    "first-user",
    "second-user",
    "third-user",
  ]);
});

test("configured Alipay remains unavailable without leaking its secret", () => {
  const secret = "private-key";

  assert.throws(
    () =>
      getBillingConfig({
        BILLING_FEATURE_ENABLED: "true",
        PAYMENT_MODE: "alipay",
        ALIPAY_APP_ID: "app",
        ALIPAY_PRIVATE_KEY: secret,
        ALIPAY_PUBLIC_KEY: "public-key",
        ALIPAY_NOTIFY_URL: "https://example.test/alipay",
        ALIPAY_RETURN_URL: "https://example.test/return",
      }),
    (error: unknown) => {
      assert.ok(error instanceof BillingError);
      assert.equal(error.code, "PROVIDER_NOT_IMPLEMENTED");
      assert.match(error.message, /provider is not implemented/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("legacy key aliases normalize into the validated enabled WeChat configuration", () => {
  const config = loadWechatPayConfig({
    ...validWechatEnvironment(),
    WECHAT_PAY_PRIVATE_KEY: undefined,
    WECHAT_PAY_CERT_SERIAL_NO: undefined,
    WECHAT_PAY_MCH_PRIVATE_KEY: testPrivateKey,
    WECHAT_PAY_MCH_SERIAL_NO: "A1B2C3D4E5F6",
  });

  assert.equal(config.merchantPrivateKeyPem, testPrivateKey.trim());
  assert.equal(config.merchantCertificateSerialNumber, "A1B2C3D4E5F6");

  const secret = "must-not-leak";
  assert.throws(
    () =>
      getBillingConfig({
        BILLING_FEATURE_ENABLED: "true",
        PAYMENT_MODE: "alipay",
        ALIPAY_APP_ID: "app",
        ALIPAY_PRIVATE_KEY: secret,
        ALIPAY_APP_PRIVATE_KEY: "different-secret",
        ALIPAY_PUBLIC_KEY: "public",
        ALIPAY_NOTIFY_URL: "https://example.test/alipay",
        ALIPAY_RETURN_URL: "https://example.test/return",
      }),
    (error: unknown) => {
      assert.ok(error instanceof BillingError);
      assert.equal(error.code, "PAYMENT_CONFIGURATION_CONFLICT");
      assert.doesNotMatch(error.message, /must-not-leak|different-secret/);
      return true;
    },
  );
});
