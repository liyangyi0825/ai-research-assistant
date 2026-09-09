import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import {
  FeatureUsageCostService,
  type FeatureUsageCostRepository,
} from "../../lib/billing/feature-usage-costs";

function repository(value: unknown): FeatureUsageCostRepository {
  return {
    async findEnabledFeatureCost() {
      return value;
    },
  };
}

test("an entitled feature consumes its configured quota units", async () => {
  const service = new FeatureUsageCostService(
    repository({
      featureKey: "chat",
      quotaUnits: 2,
      creditAmount: 15,
      allowCreditFallback: true,
    }),
    { async getEntitlement() { return { id: "entitlement-1" }; } },
  );

  assert.deepEqual(await service.resolve("user-1", "chat"), {
    quotaUnits: 2,
    creditAmount: 0,
    accessMode: "ENTITLEMENT",
  });
});

test("a configured credit fallback gives credit packs a real consumption path", async () => {
  const service = new FeatureUsageCostService(
    repository({
      featureKey: "chat",
      quotaUnits: 1,
      creditAmount: 25,
      allowCreditFallback: true,
    }),
    { async getEntitlement() { return null; } },
  );

  assert.deepEqual(await service.resolve("user-1", "chat"), {
    quotaUnits: 0,
    creditAmount: 25,
    accessMode: "CREDIT_FALLBACK",
  });
});

test("credits never bypass entitlement unless the server policy explicitly allows it", async () => {
  const service = new FeatureUsageCostService(
    repository({
      featureKey: "chat",
      quotaUnits: 1,
      creditAmount: 25,
      allowCreditFallback: false,
    }),
    { async getEntitlement() { return null; } },
  );

  await assert.rejects(
    service.resolve("user-1", "chat"),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "ENTITLEMENT_REQUIRED" &&
      error.status === 403,
  );
});

test("unknown and malformed cost policies fail closed", async () => {
  for (const value of [
    null,
    { featureKey: "other", quotaUnits: 1, creditAmount: 1, allowCreditFallback: true },
    { featureKey: "chat", quotaUnits: 1.5, creditAmount: 1, allowCreditFallback: true },
    { featureKey: "chat", quotaUnits: 0, creditAmount: 0, allowCreditFallback: true },
  ]) {
    const service = new FeatureUsageCostService(repository(value), {
      async getEntitlement() { return null; },
    });
    await assert.rejects(
      service.resolve("user-1", "chat"),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "BILLING_USAGE_POLICY_INVALID",
    );
  }
});

test("forward migration keeps feature costs private and bigint-safe", async () => {
  const sql = await readFile(
    path.join(process.cwd(), "supabase/migrations/202607290009_billing_feature_usage_costs.sql"),
    "utf8",
  );
  assert.match(sql, /quota_units BIGINT NOT NULL CHECK \(quota_units >= 0\)/i);
  assert.match(sql, /credit_amount BIGINT NOT NULL CHECK \(credit_amount >= 0\)/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.billing_feature_usage_costs FROM anon, authenticated/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.billing_feature_usage_costs TO service_role/i);
  assert.match(sql, /CHECK \(NOT allow_credit_fallback OR credit_amount > 0\)/i);
});

test("the atomic usage RPC supports credit-only reservations and prevents negative balances", async () => {
  const sql = await readFile(
    path.join(process.cwd(), "supabase/migrations/202607210003_billing_functions.sql"),
    "utf8",
  );
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.billing_reserve_usage");
  const end = sql.indexOf("CREATE OR REPLACE FUNCTION", start + 1);
  const reserve = sql.slice(start, end);
  assert.match(reserve, /IF p_quota_units > 0 THEN/i);
  assert.match(reserve, /IF p_credit_amount > 0 THEN/i);
  assert.match(reserve, /available_balance >= p_credit_amount/i);
  assert.match(reserve, /FOR UPDATE/i);
});
