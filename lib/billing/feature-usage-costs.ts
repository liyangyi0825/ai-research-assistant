import { getSupabaseAdminClient } from "../supabase";
import { EntitlementService } from "./entitlements";
import { BillingError } from "./errors";

export type FeatureUsageCost = {
  featureKey: string;
  quotaUnits: number;
  creditAmount: number;
  allowCreditFallback: boolean;
};

export type ResolvedFeatureUsageCost = {
  quotaUnits: number;
  creditAmount: number;
  accessMode: "ENTITLEMENT" | "CREDIT_FALLBACK";
};

export type FeatureUsageCostRepository = {
  findEnabledFeatureCost(featureKey: string): Promise<unknown>;
};

type EntitlementLookup = {
  getEntitlement(userId: string, featureKey: string): Promise<unknown | null>;
};

function policyError(): BillingError {
  return new BillingError(
    "BILLING_USAGE_POLICY_INVALID",
    "This research feature does not have a valid server-side usage policy.",
    503,
  );
}

function positiveOrZero(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw policyError();
  }
  return value;
}

function parsePolicy(value: unknown, featureKey: string): FeatureUsageCost {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw policyError();
  }
  const row = value as Record<string, unknown>;
  const policy = {
    featureKey: row.featureKey,
    quotaUnits: positiveOrZero(row.quotaUnits),
    creditAmount: positiveOrZero(row.creditAmount),
    allowCreditFallback: row.allowCreditFallback,
  };
  if (
    policy.featureKey !== featureKey ||
    typeof policy.allowCreditFallback !== "boolean" ||
    (policy.quotaUnits === 0 && policy.creditAmount === 0) ||
    (policy.allowCreditFallback && policy.creditAmount === 0)
  ) {
    throw policyError();
  }
  return policy as FeatureUsageCost;
}

function defaultRepository(): FeatureUsageCostRepository {
  return {
    async findEnabledFeatureCost(featureKey) {
      const client = getSupabaseAdminClient();
      if (!client) throw policyError();
      const { data, error } = await client
        .from("billing_feature_usage_costs")
        .select("feature_key, quota_units, credit_amount, allow_credit_fallback")
        .eq("feature_key", featureKey)
        .eq("enabled", true)
        .maybeSingle();
      if (error || !data) throw policyError();
      return {
        featureKey: data.feature_key,
        quotaUnits: data.quota_units,
        creditAmount: data.credit_amount,
        allowCreditFallback: data.allow_credit_fallback,
      };
    },
  };
}

export class FeatureUsageCostService {
  constructor(
    private readonly repository: FeatureUsageCostRepository = defaultRepository(),
    private readonly entitlements: EntitlementLookup = new EntitlementService(),
  ) {}

  async resolve(
    userId: string,
    featureKey: string,
  ): Promise<ResolvedFeatureUsageCost> {
    const policy = parsePolicy(
      await this.repository.findEnabledFeatureCost(featureKey),
      featureKey,
    );
    const entitlement = await this.entitlements.getEntitlement(userId, featureKey);
    if (entitlement) {
      if (policy.quotaUnits === 0) throw policyError();
      return {
        quotaUnits: policy.quotaUnits,
        creditAmount: 0,
        accessMode: "ENTITLEMENT",
      };
    }
    if (!policy.allowCreditFallback) {
      throw new BillingError(
        "ENTITLEMENT_REQUIRED",
        "This research feature is not included in the current entitlement.",
        403,
      );
    }
    return {
      quotaUnits: 0,
      creditAmount: policy.creditAmount,
      accessMode: "CREDIT_FALLBACK",
    };
  }
}
