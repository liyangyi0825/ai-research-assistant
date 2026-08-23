import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as rsaSign,
  verify as rsaVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { register } from "../../instrumentation";
import {
  validateBillingRuntimeAtStartup,
} from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import { loadWechatPayConfig } from "../../lib/billing/payments/wechat-config";
import {
  signWechatRequest,
  verifyWechatSignature,
} from "../../lib/billing/payments/wechat-crypto";
import { VALID_WECHAT_PLATFORM_CERTIFICATE } from "./helpers/wechat-certificates";

const { privateKey: wechatPrivateKey, publicKey: wechatPublicKey } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });

const configuredWechat: Record<string, string | undefined> = {
  WECHAT_PAY_MCH_ID: "1900000109",
  WECHAT_PAY_APP_ID: "wx1234567890abcdef",
  WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
  WECHAT_PAY_PRIVATE_KEY: wechatPrivateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
  WECHAT_PAY_CERT_SERIAL_NO: "A1B2C3D4E5F6",
  WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_00000000000000000000000000000001",
  WECHAT_PAY_PUBLIC_KEY: wechatPublicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  WECHAT_PAY_NOTIFY_URL: "https://billing.test/wechat/callback",
};

const expiredPlatformCertificate = `-----BEGIN CERTIFICATE-----
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

const configuredAlipay = {
  ALIPAY_APP_ID: "test-app",
  ALIPAY_PRIVATE_KEY: "test-private-key",
  ALIPAY_PUBLIC_KEY: "test-public-key",
  ALIPAY_NOTIFY_URL: "https://billing.test/alipay/callback",
  ALIPAY_RETURN_URL: "https://billing.test/alipay/return",
};

test("startup accepts the disabled Mock safety defaults", () => {
  assert.doesNotThrow(() =>
    validateBillingRuntimeAtStartup({
      NODE_ENV: "production",
      BILLING_FEATURE_ENABLED: "false",
      PAYMENT_MODE: "mock",
    }),
  );
});

test("startup rejects production Mock billing without an explicit test allowlist", () => {
  assert.throws(
    () =>
      validateBillingRuntimeAtStartup({
        NODE_ENV: "production",
        BILLING_FEATURE_ENABLED: "true",
        PAYMENT_MODE: "mock",
      }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "UNSAFE_PAYMENT_CONFIGURATION",
  );
});

test("startup permits allowlisted production Mock while request guards still isolate users", () => {
  assert.doesNotThrow(() =>
    validateBillingRuntimeAtStartup({
      NODE_ENV: "production",
      BILLING_FEATURE_ENABLED: "true",
      PAYMENT_MODE: "mock",
      BILLING_TEST_USER_IDS: "admin-test-user",
    }),
  );
});

test("startup rejects wildcard-like production Mock allowlist entries", () => {
  for (const unsafeId of ["*", "all", "public"]) {
    assert.throws(
      () =>
        validateBillingRuntimeAtStartup({
          NODE_ENV: "production",
          BILLING_FEATURE_ENABLED: "true",
          PAYMENT_MODE: "mock",
          BILLING_TEST_USER_IDS: unsafeId,
        }),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "UNSAFE_PAYMENT_CONFIGURATION",
    );
  }
});

test("startup rejects incomplete WeChat and Alipay configuration without leaking secrets", () => {
  const secret = "never-print-this-secret";

  for (const paymentMode of ["wechat", "alipay"] as const) {
    assert.throws(
      () =>
        validateBillingRuntimeAtStartup({
          NODE_ENV: "production",
          BILLING_FEATURE_ENABLED: "true",
          PAYMENT_MODE: paymentMode,
          WECHAT_PAY_API_V3_KEY: secret,
          ALIPAY_PRIVATE_KEY: secret,
        }),
      (error: unknown) => {
        assert.ok(error instanceof BillingError);
        assert.equal(error.code, "PROVIDER_NOT_CONFIGURED");
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  }
});

test("startup accepts a complete exactly-one WeChat verifier mode", () => {
  assert.doesNotThrow(() =>
    validateBillingRuntimeAtStartup({
      NODE_ENV: "production",
      BILLING_FEATURE_ENABLED: "true",
      PAYMENT_MODE: "wechat",
      ...configuredWechat,
    }),
  );
});

test("startup-validated WeChat keys perform an actual RSA-2048 request sign and response verify", () => {
  const environment = {
    NODE_ENV: "production",
    BILLING_FEATURE_ENABLED: "true",
    PAYMENT_MODE: "wechat",
    ...configuredWechat,
  };
  assert.doesNotThrow(() => validateBillingRuntimeAtStartup(environment));
  const config = loadWechatPayConfig(environment);
  const signed = signWechatRequest({
    method: "POST",
    pathWithQuery: "/v3/pay/transactions/native",
    body: "{}",
    timestamp: 1_777_777_777,
    nonce: "startup-test-nonce",
    mchId: config.mchId,
    certificateSerialNumber: config.merchantCertificateSerialNumber,
    privateKeyPem: config.merchantPrivateKeyPem,
  });
  const requestSignature = /signature="([A-Za-z0-9+/]+={0,2})"/.exec(
    signed.authorization,
  )?.[1];
  assert.ok(requestSignature);
  assert.equal(
    rsaVerify(
      "RSA-SHA256",
      Buffer.from(signed.message, "utf8"),
      wechatPublicKey,
      Buffer.from(requestSignature, "base64"),
    ),
    true,
  );

  const responseBody = "{}";
  const timestamp = "1777777777";
  const nonce = "startup-response-nonce";
  const responseSignature = rsaSign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${nonce}\n${responseBody}\n`, "utf8"),
    wechatPrivateKey,
  ).toString("base64");
  assert.doesNotThrow(() =>
    verifyWechatSignature({
      timestamp,
      nonce,
      body: responseBody,
      signatureBase64: responseSignature,
      verifierId: config.verifier.mode === "PUBLIC_KEY" ? config.verifier.keyId : "",
      verifier: config.verifier,
    }),
  );
});

test("startup accepts a complete platform-certificate WeChat verifier mode", () => {
  assert.doesNotThrow(() =>
    validateBillingRuntimeAtStartup({
      NODE_ENV: "production",
      BILLING_FEATURE_ENABLED: "true",
      PAYMENT_MODE: "wechat",
      ...configuredWechat,
      WECHAT_PAY_PUBLIC_KEY_ID: undefined,
      WECHAT_PAY_PUBLIC_KEY: undefined,
      WECHAT_PAY_PLATFORM_CERT: VALID_WECHAT_PLATFORM_CERTIFICATE,
    }),
  );
});

test("startup rejects missing, blank, whitespace, malformed, and conflicting WeChat entries", () => {
  const cases: Array<{
    name: string;
    overrides: Record<string, string | undefined>;
    code: "PROVIDER_NOT_CONFIGURED" | "PAYMENT_CONFIGURATION_CONFLICT";
  }> = [
    {
      name: "missing",
      overrides: { WECHAT_PAY_NOTIFY_URL: undefined },
      code: "PROVIDER_NOT_CONFIGURED",
    },
    {
      name: "blank",
      overrides: { WECHAT_PAY_APP_ID: "" },
      code: "PROVIDER_NOT_CONFIGURED",
    },
    {
      name: "whitespace",
      overrides: { WECHAT_PAY_CERT_SERIAL_NO: "   " },
      code: "PROVIDER_NOT_CONFIGURED",
    },
    {
      name: "malformed",
      overrides: { WECHAT_PAY_PRIVATE_KEY: "not-a-private-key-sentinel" },
      code: "PROVIDER_NOT_CONFIGURED",
    },
    {
      name: "conflicting",
      overrides: { WECHAT_PAY_PLATFORM_CERT: VALID_WECHAT_PLATFORM_CERTIFICATE },
      code: "PAYMENT_CONFIGURATION_CONFLICT",
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () =>
        validateBillingRuntimeAtStartup({
          NODE_ENV: "production",
          BILLING_FEATURE_ENABLED: "true",
          PAYMENT_MODE: "wechat",
          ...configuredWechat,
          ...entry.overrides,
        }),
      (error: unknown) => {
        assert.ok(error instanceof BillingError, entry.name);
        assert.equal(error.code, entry.code, entry.name);
        assert.doesNotMatch(error.message, /not-a-private-key-sentinel/);
        return true;
      },
    );
  }
});

test("startup rejects an expired WeChat platform certificate", () => {
  assert.throws(
    () => validateBillingRuntimeAtStartup({
      NODE_ENV: "production",
      BILLING_FEATURE_ENABLED: "true",
      PAYMENT_MODE: "wechat",
      ...configuredWechat,
      WECHAT_PAY_PUBLIC_KEY_ID: undefined,
      WECHAT_PAY_PUBLIC_KEY: undefined,
      WECHAT_PAY_PLATFORM_CERT: expiredPlatformCertificate,
    }),
    (error: unknown) =>
      error instanceof BillingError && error.code === "PROVIDER_NOT_CONFIGURED",
  );
});

test("startup keeps fully configured Alipay blocked as unimplemented", () => {
  const secret = configuredAlipay.ALIPAY_PRIVATE_KEY;

  assert.throws(
    () =>
      validateBillingRuntimeAtStartup({
        NODE_ENV: "production",
        BILLING_FEATURE_ENABLED: "true",
        PAYMENT_MODE: "alipay",
        ...configuredAlipay,
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

test("Next instrumentation invokes the explicit billing startup validator", () => {
  const source = readFileSync(
    new URL("../../instrumentation.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /export async function register\(\)/);
  assert.match(source, /validateBillingRuntimeAtStartup\(\)/);
});

test("instrumentation runs the Node-only billing validator without poisoning Edge startup", async () => {
  const keys = [
    "NEXT_RUNTIME",
    "NODE_ENV",
    "BILLING_FEATURE_ENABLED",
    "PAYMENT_MODE",
    "WECHAT_PAY_MCH_ID",
    "WECHAT_PAY_APP_ID",
    "WECHAT_PAY_API_V3_KEY",
    "WECHAT_PAY_PRIVATE_KEY",
    "WECHAT_PAY_CERT_SERIAL_NO",
    "WECHAT_PAY_PUBLIC_KEY_ID",
    "WECHAT_PAY_PUBLIC_KEY",
    "WECHAT_PAY_PLATFORM_CERT",
    "WECHAT_PAY_NOTIFY_URL",
  ] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    for (const key of keys) delete process.env[key];
    Reflect.set(process.env, "NODE_ENV", "production");
    Reflect.set(process.env, "BILLING_FEATURE_ENABLED", "true");
    Reflect.set(process.env, "PAYMENT_MODE", "wechat");

    Reflect.set(process.env, "NEXT_RUNTIME", "edge");
    await assert.doesNotReject(() => register());

    Reflect.set(process.env, "NEXT_RUNTIME", "nodejs");
    await assert.rejects(
      () => register(),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "PROVIDER_NOT_CONFIGURED",
    );
  } finally {
    for (const key of keys) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else Reflect.set(process.env, key, value);
    }
  }
});
