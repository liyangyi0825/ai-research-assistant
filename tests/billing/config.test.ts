import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPaymentRuntimeSafe,
  getBillingConfig,
} from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";

test("billing is disabled and uses mock payments by default", () => {
  const config = getBillingConfig({});

  assert.equal(config.featureEnabled, false);
  assert.equal(config.paymentMode, "mock");
  assert.deepEqual(config.testUserIds, []);
  assert.equal(config.wechatConfigured, false);
  assert.equal(config.alipayConfigured, false);
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
        BILLING_FEATURE_ENABLED: "true",
        PAYMENT_MODE: "wechat",
        WECHAT_PAY_API_V3_KEY: secret,
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
