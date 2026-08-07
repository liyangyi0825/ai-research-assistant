import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAuthorizedTargets,
  assertDatabaseUrlMatchesRef,
  BILLING_SOURCE_PROJECT_REF,
} from "../../scripts/billing-db-drill/identity";
import { redactText, runRedacted, sha256File } from "../../scripts/billing-db-drill/process";

const restoreRef = "abcdefghijklmnopqrst";
const productionRef = "uvwxyzabcdefghijklmn";

function databaseUrl(parts: { username?: string; host: string; protocol?: string } ): string {
  const protocol = parts.protocol ?? "postgresql";
  const username = parts.username ?? "postgres";
  return `${protocol}://${username}:test-password@${parts.host}:5432/postgres`;
}

function authorizedInput(overrides: Partial<Parameters<typeof assertAuthorizedTargets>[0]> = {}) {
  return {
    sourceRef: BILLING_SOURCE_PROJECT_REF,
    restoreRef,
    approvedRestoreRef: restoreRef,
    productionRefs: [] as readonly string[],
    ...overrides,
  };
}

test("rejects a restore target that is the billing source", () => {
  assert.throws(
    () => assertAuthorizedTargets(authorizedInput({ restoreRef: BILLING_SOURCE_PROJECT_REF, approvedRestoreRef: BILLING_SOURCE_PROJECT_REF })),
    /SOURCE_AND_RESTORE_MUST_DIFFER/,
  );
});

test("rejects a restore target without exact approval", () => {
  assert.throws(
    () => assertAuthorizedTargets(authorizedInput({ approvedRestoreRef: "" })),
    /RESTORE_PROJECT_NOT_APPROVED/,
  );
});

test("rejects malformed project references", () => {
  assert.throws(
    () => assertAuthorizedTargets(authorizedInput({ restoreRef: "invalid-ref" })),
    /INVALID_PROJECT_REF/,
  );
});

test("rejects a restore target listed as production", () => {
  assert.throws(
    () => assertAuthorizedTargets(authorizedInput({ productionRefs: [productionRef, restoreRef] })),
    /RESTORE_PROJECT_IS_PRODUCTION/,
  );
});

test("rejects an unsafe configuration that lists the source as production", () => {
  assert.throws(
    () => assertAuthorizedTargets(authorizedInput({ productionRefs: [BILLING_SOURCE_PROJECT_REF] })),
    /SOURCE_PROJECT_IS_PRODUCTION/,
  );
});

test("accepts a PostgreSQL direct host that belongs to the expected project", () => {
  const url = assertDatabaseUrlMatchesRef(databaseUrl({ host: `db.${restoreRef}.supabase.co` }), restoreRef);
  assert.equal(url.hostname, `db.${restoreRef}.supabase.co`);
});

test("rejects a PostgreSQL direct host for another project without exposing credentials", () => {
  const rawUrl = databaseUrl({ host: "db.zabcdefghijklmnopqrs.supabase.co" });
  assert.throws(
    () => assertDatabaseUrlMatchesRef(rawUrl, restoreRef),
    (error: unknown) => error instanceof Error && error.message === "DATABASE_URL_PROJECT_MISMATCH" && !error.message.includes("test-password"),
  );
});

test("accepts a session-pooler username that belongs to the expected project", () => {
  const url = assertDatabaseUrlMatchesRef(
    databaseUrl({ username: `postgres.${restoreRef}`, host: "aws-0-ap-southeast-1.pooler.supabase.com" }),
    restoreRef,
  );
  assert.equal(url.username, `postgres.${restoreRef}`);
});

test("rejects a session-pooler username for another project", () => {
  assert.throws(
    () => assertDatabaseUrlMatchesRef(
      databaseUrl({ username: "postgres.zabcdefghijklmnopqrs", host: "aws-0-ap-southeast-1.pooler.supabase.com" }),
      restoreRef,
    ),
    /DATABASE_URL_PROJECT_MISMATCH/,
  );
});

test("rejects a non-PostgreSQL database URL without exposing it", () => {
  const rawUrl = databaseUrl({ protocol: "https", host: `db.${restoreRef}.supabase.co` });
  assert.throws(
    () => assertDatabaseUrlMatchesRef(rawUrl, restoreRef),
    (error: unknown) => error instanceof Error && error.message === "DATABASE_URL_PROTOCOL_INVALID" && !error.message.includes("test-password"),
  );
});

test("redacts PostgreSQL URLs and explicitly supplied secrets", () => {
  const input = `connecting ${databaseUrl({ host: `db.${restoreRef}.supabase.co` })} with explicit-secret`;
  assert.equal(redactText(input, ["explicit-secret"]), "connecting [REDACTED_DATABASE_URL] with [REDACTED_SECRET]");
});

test("rejects non-zero child exits with bounded, sanitized diagnostics", async () => {
  const secret = "explicit-child-secret";
  const url = databaseUrl({ host: `db.${restoreRef}.supabase.co` });
  await assert.rejects(
    runRedacted(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(`${secret} ${url} ${"x".repeat(512)}`)}); process.exit(7)`], {
      secretValues: [secret],
      maxOutputBytes: 96,
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes("PROCESS_EXIT_NONZERO")
      && error.message.includes("[REDACTED_DATABASE_URL]")
      && error.message.includes("[REDACTED_SECRET]")
      && !error.message.includes("test-password")
      && !error.message.includes(secret)
      && error.message.length <= 256,
  );
});

test("hashes a deterministic temporary file as lowercase SHA-256", async () => {
  const directory = await mkdtemp(join(tmpdir(), "billing-db-drill-"));
  const path = join(directory, "fixture.txt");
  const bytes = "deterministic fixture\n";
  try {
    await writeFile(path, bytes, "utf8");
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(await sha256File(path), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
