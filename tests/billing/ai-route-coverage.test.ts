import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function source(route: string) {
  return readFile(path.join(process.cwd(), route), "utf8");
}

test("uncovered AI routes use the centralized billing adapter", async () => {
  const routes = [
    "app/api/ppt/generate-outline/route.ts",
    "app/api/ppt/regenerate-slide/route.ts",
    "app/api/papers/recommend/route.ts",
    "app/api/concept-explorer/papers/route.ts",
  ];
  for (const route of routes) {
    const contents = await source(route);
    assert.match(contents, /import \{ withAiUsage/);
    assert.match(contents, /return await withAiUsage\(/);
  }
});

test("paper recommendation is a finite continuation of the charged search", async () => {
  const search = await source("app/api/papers/search/route.ts");
  const recommend = await source("app/api/papers/recommend/route.ts");
  assert.match(search, /featureEnabled[\s\S]*continuationStages:\s*\[\{\s*stageKey:\s*"recommend"\s*\}\]/);
  assert.match(recommend, /continuation:\s*\{[\s\S]*stageKey:\s*"recommend"/);
  assert.match(recommend, /catch \(error\) \{[\s\S]*usage\.markFailed\(error\)/);
  assert.match(recommend, /if \(!getBillingConfig\(\)\.featureEnabled\)/);
});

test("the translation route uses the centralized billing adapter", async () => {
  const status = await source("app/api/translate-page/route.ts");
  const client = await source("components/PdfTranslationView.tsx");
  assert.match(status, /import \{ withAiUsage/);
  assert.match(status, /return await withAiUsage\(/);
  assert.doesNotMatch(status, /checkUsageLimit|insertUsageRecord/);
  assert.doesNotMatch(status, /if \(!isFirst\)/);
  assert.match(status, /translationContinuationPolicy/);
  assert.match(status, /continuationStages: continuationPolicy\.continuationStages/);
  assert.match(
    client,
    /if \(!safeRootRetryRef\.current\)[\s\S]*translationTaskKeyRef\.current = crypto\.randomUUID\(\)/,
  );
  assert.match(client, /e instanceof TranslationProviderError[\s\S]*safeRootRetryRef\.current = true/);
});

test("concept paper fallback releases enabled usage while preserving its legacy 200 DTO", async () => {
  const contents = await source("app/api/concept-explorer/papers/route.ts");
  assert.match(contents, /type ConceptPaperFallback/);
  assert.match(contents, /fallback\?: ConceptPaperFallback/);
  assert.match(
    contents,
    /catch \(error\) \{[\s\S]*?usage\?\.markFailed\(error\);[\s\S]*?fallback\.error = error;[\s\S]*?fallback\.response = response/,
  );
  assert.match(contents, /if \(!getBillingConfig\(\)\.featureEnabled\) \{[\s\S]*?execute\(req\)/);
  assert.match(contents, /async \(usage\) => execute\(req, usage, fallback\)/);
  assert.match(
    contents,
    /catch \(error\) \{[\s\S]*?fallback\.error === error[\s\S]*?return fallback\.response[\s\S]*?throw error/,
  );
});
