import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBillingAccess,
  requireBillingAdmin,
  requireBillingUser,
  type BillingAuthDependencies,
  type BillingUser,
} from "../../lib/billing/auth";
import { getBillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";

const regularUser: BillingUser = {
  id: "regular-user",
  email: "student@example.com",
  isAdmin: false,
};

function dependencies(overrides: Partial<BillingAuthDependencies> = {}): BillingAuthDependencies {
  return {
    getUser: async () => regularUser,
    findAdmin: async () => null,
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

test("requireBillingUser rejects a missing server session", async () => {
  await assert.rejects(
    () => requireBillingUser(dependencies({ getUser: async () => null })),
    (error: unknown) => expectBillingError(error, "UNAUTHENTICATED", 401),
  );
});

test("requireBillingAdmin rejects a regular user", async () => {
  await assert.rejects(
    () => requireBillingAdmin(dependencies()),
    (error: unknown) => expectBillingError(error, "BILLING_ADMIN_REQUIRED", 403),
  );
});

test("requireBillingAdmin rejects an inactive database administrator", async () => {
  await assert.rejects(
    () =>
      requireBillingAdmin(
        dependencies({
          findAdmin: async () => ({
            role: "BILLING_ADMIN",
            isActive: false,
          }),
        }),
      ),
    (error: unknown) => expectBillingError(error, "BILLING_ADMIN_REQUIRED", 403),
  );
});

test("requireBillingAdmin accepts an active administrator returned by the server repository", async () => {
  const admin = await requireBillingAdmin(
    dependencies({
      findAdmin: async () => ({ role: "BILLING_ADMIN", isActive: true }),
    }),
  );

  assert.equal(admin.id, regularUser.id);
  assert.equal(admin.role, "BILLING_ADMIN");
  assert.equal(admin.isAdmin, true);
});

test("requireBillingAdmin supports the ADMIN_EMAIL bootstrap only after server authentication", async () => {
  const admin = await requireBillingAdmin(
    dependencies({
      findAdmin: async () => null,
      adminEmail: "student@example.com",
    }),
  );

  assert.equal(admin.isAdmin, true);
  assert.equal(admin.role, "BILLING_ADMIN");
});

test("assertBillingAccess rejects billing writes while the server feature flag is disabled", () => {
  const config = getBillingConfig({ BILLING_FEATURE_ENABLED: "false" });

  assert.throws(
    () => assertBillingAccess(regularUser, config),
    (error: unknown) => expectBillingError(error, "BILLING_FEATURE_DISABLED", 403),
  );
});

test("assertBillingAccess rejects production mock payments for a regular user", () => {
  const config = getBillingConfig({
    NODE_ENV: "production",
    BILLING_FEATURE_ENABLED: "true",
    PAYMENT_MODE: "mock",
    BILLING_TEST_USER_IDS: "test-user",
  });

  assert.throws(
    () => assertBillingAccess(regularUser, config),
    (error: unknown) => expectBillingError(error, "MOCK_PAYMENT_NOT_ALLOWED", 403),
  );
});

test("assertBillingAccess permits production mock payments for a listed test user and an administrator", () => {
  const config = getBillingConfig({
    NODE_ENV: "production",
    BILLING_FEATURE_ENABLED: "true",
    PAYMENT_MODE: "mock",
    BILLING_TEST_USER_IDS: "test-user",
  });

  assert.doesNotThrow(() =>
    assertBillingAccess({ id: "test-user", email: "tester@example.com", isAdmin: false }, config),
  );
  assert.doesNotThrow(() =>
    assertBillingAccess({ ...regularUser, isAdmin: true }, config),
  );
});
