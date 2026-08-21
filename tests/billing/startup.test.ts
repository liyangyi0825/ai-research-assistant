import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateBillingRuntimeAtStartup,
} from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";

const { privateKey: wechatPrivateKey, publicKey: wechatPublicKey } =
  generateKeyPairSync("rsa", { modulusLength: 2048 });

const configuredWechat = {
  WECHAT_PAY_MCH_ID: "test-mch",
  WECHAT_PAY_APP_ID: "test-app",
  WECHAT_PAY_API_V3_KEY: "12345678901234567890123456789012",
  WECHAT_PAY_PRIVATE_KEY: wechatPrivateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
  WECHAT_PAY_CERT_SERIAL_NO: "test-serial",
  WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_TEST",
  WECHAT_PAY_PUBLIC_KEY: wechatPublicKey
    .export({ type: "spki", format: "pem" })
    .toString(),
  WECHAT_PAY_NOTIFY_URL: "https://billing.test/wechat/callback",
};

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
