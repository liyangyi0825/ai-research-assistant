import { pathToFileURL } from "node:url";

export type StageFEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface StageFPreflightReport {
  readonly ok: boolean;
  readonly profile: "STAGE_F_CLOSED_MOCK";
  readonly projectRef: string;
  readonly testUserCount: number;
  readonly errors: readonly string[];
}

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNSAFE_TEST_USER_IDS = new Set(["*", "all", "public"]);

const REAL_PAYMENT_VARIABLES = [
  "WECHAT_PAY_MCH_ID",
  "WECHAT_PAY_APP_ID",
  "WECHAT_PAY_API_V3_KEY",
  "WECHAT_PAY_PRIVATE_KEY",
  "WECHAT_PAY_MCH_PRIVATE_KEY",
  "WECHAT_PAY_CERT_SERIAL_NO",
  "WECHAT_PAY_MCH_SERIAL_NO",
  "WECHAT_PAY_PLATFORM_CERT",
  "WECHAT_PAY_PUBLIC_KEY_ID",
  "WECHAT_PAY_PUBLIC_KEY",
  "WECHAT_PAY_NOTIFY_URL",
  "ALIPAY_APP_ID",
  "ALIPAY_PRIVATE_KEY",
  "ALIPAY_APP_PRIVATE_KEY",
  "ALIPAY_PUBLIC_KEY",
  "ALIPAY_NOTIFY_URL",
  "ALIPAY_RETURN_URL",
] as const;

function value(env: StageFEnvironment, key: string): string {
  return env[key]?.trim() ?? "";
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function inspectStageFEnvironment(
  env: StageFEnvironment = process.env,
): StageFPreflightReport {
  const errors = new Set<string>();
  const projectRef = value(env, "BILLING_STAGE_F_PROJECT_REF");
  const testUserIds = parseList(value(env, "BILLING_TEST_USER_IDS"));
  const productionRefs = parseList(
    value(env, "BILLING_PRODUCTION_PROJECT_REFS"),
  );

  if (value(env, "NODE_ENV") !== "production") {
    errors.add("NODE_ENV_MUST_BE_PRODUCTION");
  }
  if (value(env, "BILLING_FEATURE_ENABLED") !== "false") {
    errors.add("BILLING_FEATURE_MUST_BE_DISABLED");
  }
  if (value(env, "PAYMENT_MODE") !== "mock") {
    errors.add("PAYMENT_MODE_MUST_BE_MOCK");
  }
  if (value(env, "BILLING_REAL_PAYMENT_PUBLIC_ENABLED") !== "false") {
    errors.add("REAL_PAYMENT_PUBLIC_MUST_BE_DISABLED");
  }

  if (testUserIds.length === 0) {
    errors.add("TEST_USER_IDS_REQUIRED");
  }
  if (
    testUserIds.some(
      (id) => UNSAFE_TEST_USER_IDS.has(id.toLowerCase()) || !USER_ID_PATTERN.test(id),
    )
  ) {
    errors.add("TEST_USER_IDS_INVALID");
  }
  if (new Set(testUserIds.map((id) => id.toLowerCase())).size !== testUserIds.length) {
    errors.add("TEST_USER_IDS_DUPLICATED");
  }

  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    errors.add("STAGE_F_PROJECT_REF_INVALID");
  }
  if (productionRefs.length === 0) {
    errors.add("PRODUCTION_PROJECT_REFS_REQUIRED");
  }
  if (
    productionRefs.some((ref) => !PROJECT_REF_PATTERN.test(ref))
  ) {
    errors.add("PRODUCTION_PROJECT_REFS_INVALID");
  }
  if (productionRefs.includes(projectRef)) {
    errors.add("STAGE_F_PROJECT_IS_PRODUCTION");
  }

  const supabaseUrl = value(env, "NEXT_PUBLIC_SUPABASE_URL");
  try {
    const parsed = new URL(supabaseUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== `${projectRef}.supabase.co` ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      errors.add("SUPABASE_URL_PROJECT_MISMATCH");
    }
  } catch {
    errors.add("SUPABASE_URL_PROJECT_MISMATCH");
  }

  if (!value(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY")) {
    errors.add("SUPABASE_ANON_KEY_MISSING");
  }
  if (!value(env, "SUPABASE_SERVICE_ROLE_KEY")) {
    errors.add("SUPABASE_SERVICE_ROLE_KEY_MISSING");
  }
  if (!value(env, "LEGAL_OPERATOR_NAME")) {
    errors.add("LEGAL_OPERATOR_NAME_MISSING");
  }
  if (!value(env, "LEGAL_OPERATOR_CREDIT_CODE")) {
    errors.add("LEGAL_OPERATOR_CREDIT_CODE_MISSING");
  }
  if (!EMAIL_PATTERN.test(value(env, "LEGAL_CONTACT_EMAIL"))) {
    errors.add("LEGAL_CONTACT_EMAIL_INVALID");
  }
  if (REAL_PAYMENT_VARIABLES.some((key) => value(env, key))) {
    errors.add("REAL_PAYMENT_CONFIGURATION_MUST_BE_EMPTY");
  }

  return {
    ok: errors.size === 0,
    profile: "STAGE_F_CLOSED_MOCK",
    projectRef: PROJECT_REF_PATTERN.test(projectRef) ? projectRef : "INVALID",
    testUserCount: testUserIds.length,
    errors: [...errors].sort(),
  };
}

function runCli(): void {
  const report = inspectStageFEnvironment();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
