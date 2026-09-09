import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  LEGAL_OPERATOR_PLACEHOLDER,
  getLegalOperatorConfig,
} from "../../lib/legal/config";
import {
  LEGAL_DOCUMENTS,
  REQUIRED_ACADEMIC_SAFETY_STATEMENTS,
} from "../../lib/legal/documents";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("legal operator config only uses trimmed environment values", () => {
  const config = getLegalOperatorConfig({
    LEGAL_OPERATOR_NAME: "  合法运营主体  ",
    LEGAL_OPERATOR_CREDIT_CODE: "  91300000000000000X ",
    LEGAL_CONTACT_EMAIL: "  legal@example.test ",
  });

  assert.deepEqual(config, {
    operatorName: "合法运营主体",
    operatorCreditCode: "91300000000000000X",
    contactEmail: "legal@example.test",
    isPlaceholder: false,
  });
});

test("missing legal operator values use neutral placeholders", () => {
  const config = getLegalOperatorConfig({});

  assert.equal(config.operatorName, LEGAL_OPERATOR_PLACEHOLDER);
  assert.equal(config.operatorCreditCode, LEGAL_OPERATOR_PLACEHOLDER);
  assert.equal(config.contactEmail, LEGAL_OPERATOR_PLACEHOLDER);
  assert.equal(config.isPlaceholder, true);
});

test("all eight legal drafts are registered and visibly non-final", () => {
  assert.deepEqual(
    LEGAL_DOCUMENTS.map(({ slug }) => slug),
    [
      "terms",
      "privacy",
      "membership",
      "refunds",
      "ai-use",
      "academic-integrity",
      "invoices",
      "support",
    ],
  );

  for (const document of LEGAL_DOCUMENTS) {
    assert.match(document.statusNotice, /草案|未正式生效/);
    assert.match(document.reviewNotice, /专业律师审核/);
    assert.ok(document.sections.length >= 3);
  }
});

test("legal drafts contain the required research and academic safety statements", () => {
  const corpus = LEGAL_DOCUMENTS.flatMap((document) => [
    document.summary,
    ...document.sections.flatMap((section) => [
      section.heading,
      ...section.paragraphs,
    ]),
  ]).join("\n");

  for (const statement of REQUIRED_ACADEMIC_SAFETY_STATEMENTS) {
    assert.match(corpus, statement);
  }
});

test("membership and payment policies stay explicitly inactive", () => {
  const membership = LEGAL_DOCUMENTS.find(
    ({ slug }) => slug === "membership",
  );
  const refunds = LEGAL_DOCUMENTS.find(({ slug }) => slug === "refunds");

  assert.ok(membership);
  assert.ok(refunds);
  assert.match(membership.statusNotice, /未正式生效/);
  assert.match(refunds.statusNotice, /未正式生效/);
  assert.doesNotMatch(
    `${membership.summary}\n${refunds.summary}`,
    /立即购买|立即支付|开通会员/,
  );
});

test("every registered legal route delegates to the shared document page", async () => {
  for (const { slug } of LEGAL_DOCUMENTS) {
    const source = await readFile(
      path.join(repositoryRoot, "app", "legal", slug, "page.tsx"),
      "utf8",
    );
    assert.match(source, /LegalDocumentPage/);
    assert.doesNotMatch(source, /SiteFilingFooter|ICP备案|公安备案/);
    assert.doesNotMatch(source, /立即购买|立即支付/);
  }
});
