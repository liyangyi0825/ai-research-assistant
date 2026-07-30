import { BillingError } from "./errors";

export type PaymentMode = "mock" | "wechat" | "alipay";

export const BILLING_AGREEMENT_VERSION = "billing-member-v1";

export type BillingConfig = {
  featureEnabled: boolean;
  paymentMode: PaymentMode;
  testUserIds: string[];
  legal: {
    operatorName: string;
    operatorCreditCode: string;
    contactEmail: string;
  };
  wechatConfigured: boolean;
  alipayConfigured: boolean;
  isProduction: boolean;
};

export type PaymentRuntimeContext = {
  userId?: string;
  isAdmin?: boolean;
};

type BillingEnvironment = Readonly<Record<string, string | undefined>>;

const WECHAT_REQUIRED_VARIABLES = [
  "WECHAT_PAY_MCH_ID",
  "WECHAT_PAY_APP_ID",
  "WECHAT_PAY_API_V3_KEY",
  "WECHAT_PAY_PRIVATE_KEY",
  "WECHAT_PAY_CERT_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_CERT",
  "WECHAT_PAY_NOTIFY_URL",
] as const;

const ALIPAY_REQUIRED_VARIABLES = [
  "ALIPAY_APP_ID",
  "ALIPAY_PRIVATE_KEY",
  "ALIPAY_PUBLIC_KEY",
  "ALIPAY_NOTIFY_URL",
  "ALIPAY_RETURN_URL",
] as const;

const PAYMENT_VARIABLE_ALIASES = [
  ["WECHAT_PAY_PRIVATE_KEY", "WECHAT_PAY_MCH_PRIVATE_KEY"],
  ["WECHAT_PAY_CERT_SERIAL_NO", "WECHAT_PAY_MCH_SERIAL_NO"],
  ["ALIPAY_PRIVATE_KEY", "ALIPAY_APP_PRIVATE_KEY"],
] as const;

function normalizedPaymentEnvironment(
  env: BillingEnvironment,
): BillingEnvironment {
  const normalized: Record<string, string | undefined> = { ...env };

  for (const [canonical, alias] of PAYMENT_VARIABLE_ALIASES) {
    const canonicalValue = env[canonical]?.trim();
    const aliasValue = env[alias]?.trim();
    if (canonicalValue && aliasValue && canonicalValue !== aliasValue) {
      throw new BillingError(
        "PAYMENT_CONFIGURATION_CONFLICT",
        `Conflicting payment configuration variables: ${canonical}, ${alias}.`,
        500,
      );
    }
    normalized[canonical] = canonicalValue || aliasValue;
  }

  return normalized;
}

function hasValue(env: BillingEnvironment, variable: string): boolean {
  return Boolean(env[variable]?.trim());
}

function missingVariables(
  env: BillingEnvironment,
  variables: readonly string[],
): string[] {
  return variables.filter((variable) => !hasValue(env, variable));
}

function parsePaymentMode(value: string | undefined): PaymentMode {
  const mode = value ?? "mock";

  if (mode === "mock" || mode === "wechat" || mode === "alipay") {
    return mode;
  }

  throw new BillingError(
    "INVALID_PAYMENT_MODE",
    "PAYMENT_MODE must be one of mock, wechat, or alipay.",
    500,
  );
}

function parseTestUserIds(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
}

function assertProviderConfigured(
  mode: PaymentMode,
  env: BillingEnvironment,
): void {
  const requiredVariables =
    mode === "wechat"
      ? WECHAT_REQUIRED_VARIABLES
      : mode === "alipay"
        ? ALIPAY_REQUIRED_VARIABLES
        : [];
  const missing = missingVariables(env, requiredVariables);

  if (missing.length > 0) {
    throw new BillingError(
      "PROVIDER_NOT_CONFIGURED",
      `Missing required payment configuration: ${missing.join(", ")}.`,
      503,
    );
  }
}

export function getBillingConfig(
  env: BillingEnvironment = process.env,
): BillingConfig {
  const paymentEnv = normalizedPaymentEnvironment(env);
  const paymentMode = parsePaymentMode(paymentEnv.PAYMENT_MODE);
  const testUserIds = parseTestUserIds(paymentEnv.BILLING_TEST_USER_IDS);
  const wechatConfigured =
    missingVariables(paymentEnv, WECHAT_REQUIRED_VARIABLES).length === 0;
  const alipayConfigured =
    missingVariables(paymentEnv, ALIPAY_REQUIRED_VARIABLES).length === 0;
  const config: BillingConfig = {
    featureEnabled: paymentEnv.BILLING_FEATURE_ENABLED === "true",
    paymentMode,
    testUserIds,
    legal: {
      operatorName: paymentEnv.LEGAL_OPERATOR_NAME?.trim() ?? "",
      operatorCreditCode: paymentEnv.LEGAL_OPERATOR_CREDIT_CODE?.trim() ?? "",
      contactEmail: paymentEnv.LEGAL_CONTACT_EMAIL?.trim() ?? "",
    },
    wechatConfigured,
    alipayConfigured,
    isProduction: paymentEnv.NODE_ENV === "production",
  };

  if (
    config.featureEnabled &&
    config.isProduction &&
    config.paymentMode === "mock" &&
    config.testUserIds.length === 0
  ) {
    throw new BillingError(
      "UNSAFE_PAYMENT_CONFIGURATION",
      "Production mock payments require BILLING_TEST_USER_IDS before billing can be enabled.",
      500,
    );
  }

  if (config.featureEnabled) {
    assertProviderConfigured(config.paymentMode, paymentEnv);
  }

  return config;
}

export function validateBillingRuntimeAtStartup(
  env: BillingEnvironment = process.env,
): void {
  const config = getBillingConfig(env);
  const unsafeTestUserIds = new Set(["*", "all", "public"]);

  if (
    config.featureEnabled &&
    config.isProduction &&
    config.paymentMode === "mock" &&
    config.testUserIds.some((id) => unsafeTestUserIds.has(id.toLowerCase()))
  ) {
    throw new BillingError(
      "UNSAFE_PAYMENT_CONFIGURATION",
      "Production mock payments require explicit individual test user IDs.",
      500,
    );
  }
}

export function assertPaymentRuntimeSafe(
  config: BillingConfig,
  context: PaymentRuntimeContext,
): void {
  if (
    !config.featureEnabled ||
    !config.isProduction ||
    config.paymentMode !== "mock" ||
    context.isAdmin ||
    (context.userId !== undefined && config.testUserIds.includes(context.userId))
  ) {
    return;
  }

  throw new BillingError(
    "MOCK_PAYMENT_NOT_ALLOWED",
    "Mock payments are restricted to production administrators and listed test users.",
    403,
  );
}
