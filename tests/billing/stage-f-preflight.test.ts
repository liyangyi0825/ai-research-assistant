import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectStageFEnvironment,
  type StageFEnvironment,
} from "../../scripts/billing-stage-f-preflight";

const stagingRef = "abcdefghijklmnopqrst";
const firstUser = "11111111-1111-4111-8111-111111111111";
const secondUser = "22222222-2222-4222-8222-222222222222";

function safeEnvironment(
  overrides: StageFEnvironment = {},
): StageFEnvironment {
  return {
    NODE_ENV: "production",
    BILLING_FEATURE_ENABLED: "false",
    PAYMENT_MODE: "mock",
    BILLING_REAL_PAYMENT_PUBLIC_ENABLED: "false",
    BILLING_TEST_USER_IDS: `${firstUser},${secondUser}`,
    BILLING_STAGE_F_PROJECT_REF: stagingRef,
    BILLING_PRODUCTION_PROJECT_REFS: "uvwxyzabcdefghijklmn",
    NEXT_PUBLIC_SUPABASE_URL: `https://${stagingRef}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "stage-f-anon-secret",
    SUPABASE_SERVICE_ROLE_KEY: "stage-f-service-secret",
    LEGAL_OPERATOR_NAME: "已确认运营主体",
    LEGAL_OPERATOR_CREDIT_CODE: "91130000STAGEFTEST1",
    LEGAL_CONTACT_EMAIL: "support@example.test",
    ...overrides,
  };
}

test("Stage F preflight accepts only the closed Mock staging profile", () => {
  const report = inspectStageFEnvironment(safeEnvironment());

  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.profile, "STAGE_F_CLOSED_MOCK");
  assert.equal(report.testUserCount, 2);
  assert.equal(report.projectRef, stagingRef);
});

test("Stage F preflight fails closed for purchasing or real payment modes", () => {
  const cases: Array<[Partial<StageFEnvironment>, string]> = [
    [{ BILLING_FEATURE_ENABLED: "true" }, "BILLING_FEATURE_MUST_BE_DISABLED"],
    [{ PAYMENT_MODE: "wechat" }, "PAYMENT_MODE_MUST_BE_MOCK"],
    [
      { BILLING_REAL_PAYMENT_PUBLIC_ENABLED: "true" },
      "REAL_PAYMENT_PUBLIC_MUST_BE_DISABLED",
    ],
    [{ NODE_ENV: "development" }, "NODE_ENV_MUST_BE_PRODUCTION"],
  ];

  for (const [overrides, code] of cases) {
    const report = inspectStageFEnvironment(safeEnvironment(overrides));
    assert.equal(report.ok, false);
    assert.ok(report.errors.includes(code), code);
  }
});

test("Stage F preflight requires explicit unique Supabase user UUIDs", () => {
  for (const value of [
    "",
    "*",
    "all",
    "public",
    "test@example.test",
    `${firstUser},${firstUser}`,
  ]) {
    const report = inspectStageFEnvironment(
      safeEnvironment({ BILLING_TEST_USER_IDS: value }),
    );
    assert.equal(report.ok, false, value);
    assert.ok(
      report.errors.some((code) => code.startsWith("TEST_USER_IDS_")),
      value,
    );
  }
});

test("Stage F preflight binds the public Supabase URL to a non-production project ref", () => {
  const productionRef = "uvwxyzabcdefghijklmn";
  const cases: Array<[Partial<StageFEnvironment>, string]> = [
    [
      { BILLING_STAGE_F_PROJECT_REF: "not-a-project" },
      "STAGE_F_PROJECT_REF_INVALID",
    ],
    [
      { BILLING_STAGE_F_PROJECT_REF: productionRef },
      "STAGE_F_PROJECT_IS_PRODUCTION",
    ],
    [
      { NEXT_PUBLIC_SUPABASE_URL: "https://differentref123456789.supabase.co" },
      "SUPABASE_URL_PROJECT_MISMATCH",
    ],
  ];

  for (const [overrides, code] of cases) {
    const report = inspectStageFEnvironment(safeEnvironment(overrides));
    assert.equal(report.ok, false);
    assert.ok(report.errors.includes(code), code);
  }
});

test("Stage F preflight requires a non-empty valid production project ref list", () => {
  for (const productionRefs of ["", "not-a-project-ref"]) {
    const report = inspectStageFEnvironment(
      safeEnvironment({ BILLING_PRODUCTION_PROJECT_REFS: productionRefs }),
    );
    assert.equal(report.ok, false, productionRefs);
    assert.ok(
      report.errors.includes(
        productionRefs === ""
          ? "PRODUCTION_PROJECT_REFS_REQUIRED"
          : "PRODUCTION_PROJECT_REFS_INVALID",
      ),
    );
  }
});

test("Stage F preflight requires legal and Supabase server configuration", () => {
  const cases: Array<[keyof StageFEnvironment, string]> = [
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY_MISSING"],
    ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY_MISSING"],
    ["LEGAL_OPERATOR_NAME", "LEGAL_OPERATOR_NAME_MISSING"],
    ["LEGAL_OPERATOR_CREDIT_CODE", "LEGAL_OPERATOR_CREDIT_CODE_MISSING"],
    ["LEGAL_CONTACT_EMAIL", "LEGAL_CONTACT_EMAIL_INVALID"],
  ];

  for (const [key, code] of cases) {
    const report = inspectStageFEnvironment(safeEnvironment({ [key]: "" }));
    assert.equal(report.ok, false);
    assert.ok(report.errors.includes(code), code);
  }
});

test("Stage F preflight rejects every real payment credential without leaking values", () => {
  const secret = "stage-f-secret-must-never-appear";
  for (const key of [
    "WECHAT_PAY_MCH_ID",
    "WECHAT_PAY_APP_ID",
    "WECHAT_PAY_API_V3_KEY",
    "WECHAT_PAY_PRIVATE_KEY",
    "WECHAT_PAY_CERT_SERIAL_NO",
    "WECHAT_PAY_PLATFORM_CERT",
    "WECHAT_PAY_PUBLIC_KEY_ID",
    "WECHAT_PAY_PUBLIC_KEY",
    "WECHAT_PAY_NOTIFY_URL",
    "ALIPAY_APP_ID",
    "ALIPAY_PRIVATE_KEY",
    "ALIPAY_PUBLIC_KEY",
    "ALIPAY_NOTIFY_URL",
    "ALIPAY_RETURN_URL",
  ] as const) {
    const report = inspectStageFEnvironment(safeEnvironment({ [key]: secret }));
    assert.equal(report.ok, false, key);
    assert.ok(report.errors.includes("REAL_PAYMENT_CONFIGURATION_MUST_BE_EMPTY"));
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  }
});
