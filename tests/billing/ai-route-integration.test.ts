import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const TARGET_ROUTES = [
  "app/api/chat/route.ts",
  "app/api/context-chat/route.ts",
  "app/api/cite/route.ts",
  "app/api/concept-explorer/ai/route.ts",
  "app/api/extract/route.ts",
  "app/api/generate-latex/route.ts",
  "app/api/keywords/route.ts",
  "app/api/literature-review/route.ts",
  "app/api/data-clean/route.ts",
  "app/api/papers/search/route.ts",
  "app/api/profile/summarize/route.ts",
  "app/api/summarize/route.ts",
  "app/api/polish/route.ts",
  "app/api/translate/route.ts",
  "app/api/ppt/generate-content/route.ts",
  "app/api/ppt/generate-section/route.ts",
] as const;

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

test("every Task 8 AI route delegates paid work to the unified usage adapter", async () => {
  for (const route of TARGET_ROUTES) {
    const contents = await source(route);

    assert.match(
      contents,
      /from ["']@\/lib\/billing\/ai-usage["'];/,
      `${route} must import the centralized AI usage adapter`,
    );
    assert.match(
      contents,
      /withAiUsage\s*\(/,
      `${route} must execute its research task through withAiUsage`,
    );
    assert.doesNotMatch(
      contents,
      /\b(?:checkUsageLimit|insertUsageRecord)\b/,
      `${route} must not call the legacy paid path directly`,
    );
  }
});

test("Task 8 routes do not duplicate membership or billing-table policy", async () => {
  for (const route of TARGET_ROUTES) {
    const contents = await source(route);

    assert.doesNotMatch(contents, /\bisVip\b/i, `${route} duplicates VIP policy`);
    assert.doesNotMatch(
      contents,
      /billing_(?:usage_quotas|usage_records|credit_accounts|credit_ledger)/,
      `${route} accesses billing balances directly`,
    );
    assert.doesNotMatch(
      contents,
      /@gmail\.com|BILLING_TEST_USER_IDS/,
      `${route} embeds a membership allowlist`,
    );
  }
});

test("translate-page remains outside this conflict-sensitive integration batch", () => {
  assert.equal(
    TARGET_ROUTES.includes(
      "app/api/translate-page/route.ts" as (typeof TARGET_ROUTES)[number],
    ),
    false,
  );
});
