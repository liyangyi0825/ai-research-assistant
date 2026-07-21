import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("filing footer contains the official filing records and safe links", async () => {
  const source = await read("components/SiteFilingFooter.tsx");

  assert.match(source, /津ICP备2026007356号/);
  assert.match(source, /https:\/\/beian\.miit\.gov\.cn\//);
  assert.match(source, /冀公网安备13028302000277号/);
  assert.match(source, /https:\/\/beian\.mps\.gov\.cn\//);
  assert.equal((source.match(/target="_blank"/g) ?? []).length, 2);
  assert.equal(
    (source.match(/rel="noopener noreferrer"/g) ?? []).length,
    2,
  );
  assert.match(source, /src="\/beian-police\.png"/);
  assert.match(source, /width=\{14\}/);
  assert.match(source, /height=\{14\}/);
  assert.doesNotMatch(source, /beian-police\.svg/);
});

test("root layout renders one body and one global filing footer", async () => {
  const source = await read("app/layout.tsx");

  assert.equal((source.match(/<body\b/g) ?? []).length, 1);
  assert.equal((source.match(/<SiteFilingFooter\s*\/>/g) ?? []).length, 1);
});

test("sidebar does not duplicate filing records", async () => {
  const source = await read("components/Sidebar.tsx");

  assert.doesNotMatch(
    source,
    /津ICP备2026007356号|冀公网安备13028302000277号/,
  );
});
