import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const drillSqlDirectory = join(process.cwd(), "scripts", "billing-db-drill", "sql");

async function readDrillSql(name: string): Promise<string> {
  return readFile(join(drillSqlDirectory, name), "utf8");
}

function jsonbBuildObjectArgumentsAfter(sql: string, marker: string): string[] {
  const markerIndex = sql.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${marker}`);

  const callIndex = sql.indexOf("jsonb_build_object", markerIndex);
  assert.notEqual(callIndex, -1, `missing jsonb_build_object after ${marker}`);
  const openIndex = sql.indexOf("(", callIndex);
  assert.notEqual(openIndex, -1, "missing jsonb_build_object opening parenthesis");

  const argumentsList: string[] = [];
  let argumentStart = openIndex + 1;
  let depth = 0;
  let quoted = false;
  for (let index = openIndex + 1; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      if (quoted && sql[index + 1] === "'") {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") {
      if (depth === 0) {
        argumentsList.push(sql.slice(argumentStart, index).trim());
        return argumentsList;
      }
      depth -= 1;
    }
    if (character === "," && depth === 0) {
      argumentsList.push(sql.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }

  assert.fail("unterminated jsonb_build_object call");
}

function splitSqlArguments(sql: string): string[] {
  const values: string[] = [];
  let valueStart = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'") {
      if (quoted && sql[index + 1] === "'") {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      values.push(sql.slice(valueStart, index).trim());
      valueStart = index + 1;
    }
  }
  values.push(sql.slice(valueStart).trim());
  return values;
}

function insertedRows(sql: string): Array<{ table: string; columns: string[]; values: string[] }> {
  const rows: Array<{ table: string; columns: string[]; values: string[] }> = [];
  const inserts = sql.matchAll(/insert\s+into\s+([\w.]+)\s*\(([^)]+)\)\s*values\s*([\s\S]*?);/gi);
  for (const match of inserts) {
    const table = match[1].toLowerCase();
    const columns = match[2].split(",").map((column) => column.trim());
    const valuesSql = match[3];
    let rowStart = -1;
    let depth = 0;
    let quoted = false;
    for (let index = 0; index < valuesSql.length; index += 1) {
      const character = valuesSql[index];
      if (character === "'") {
        if (quoted && valuesSql[index + 1] === "'") {
          index += 1;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (character === "(") {
        if (depth === 0) rowStart = index + 1;
        depth += 1;
      }
      if (character === ")") {
        depth -= 1;
        if (depth === 0 && rowStart !== -1) {
          rows.push({ table, columns, values: splitSqlArguments(valuesSql.slice(rowStart, index)) });
          rowStart = -1;
        }
      }
    }
  }
  return rows;
}

function sqlBetween(sql: string, start: string, end: string): string {
  const startIndex = sql.indexOf(start);
  assert.notEqual(startIndex, -1, `missing SQL start marker ${start}`);
  const endIndex = sql.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing SQL end marker ${end}`);
  return sql.slice(startIndex, endIndex);
}

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
    runRedacted(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(`${secret} ${url}`)}); process.exit(7)`], {
      secretValues: [secret],
      maxOutputBytes: 1024,
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

test("does not return a secret prefix when successful child output is truncated", async () => {
  const secret = "boundary-secret";
  const result = await runRedacted(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(secret)});`], {
    secretValues: [secret],
    maxOutputBytes: 8,
  });
  assert.equal(result.stdout, "[REDACTED_TRUNCATED_OUTPUT]");
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("boundary"), false);
});

test("does not emit a secret prefix when non-zero diagnostics are truncated", async () => {
  const secret = "boundary-secret";
  await assert.rejects(
    runRedacted(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(secret)}); process.exit(7)`], {
      secretValues: [secret],
      maxOutputBytes: 8,
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes("PROCESS_EXIT_NONZERO")
      && error.message.includes("[REDACTED_TRUNCATED_OUTPUT]")
      && !error.message.includes("boundary"),
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

test("009 fixtures are deterministic, synthetic, and transaction-safe", async () => {
  const fixtures009 = await readDrillSql("fixtures-009.sql");

  assert.match(fixtures009, /\\set\s+ON_ERROR_STOP\s+on/i);
  assert.match(fixtures009, /\\if\s+:\{\?drill_commit\}[\s\S]*\\set\s+drill_commit\s+false[\s\S]*\\endif/i);
  assert.match(fixtures009, /begin;/i);
  assert.match(fixtures009, /\\if\s+:drill_commit[\s\S]*commit;[\s\S]*\\else[\s\S]*rollback;/i);
  assert.doesNotMatch(fixtures009, /service_role|api[_ -]?key|private[_ -]?key/i);

  for (const table of [
    "auth.users",
    "billing_orders",
    "billing_payments",
    "billing_subscriptions",
    "billing_usage_quotas",
    "billing_credit_ledger",
    "billing_refund_requests",
    "billing_invoice_requests",
    "billing_webhook_events",
    "billing_admin_audit_logs",
  ]) {
    assert.match(fixtures009, new RegExp(`insert\\s+into\\s+(?:public\\.)?${table.replace(".", "\\.")}`, "i"));
  }
  assert.match(fixtures009, /'MOCK'/);
  assert.match(fixtures009, /'CNY'/);
  assert.match(fixtures009, /is_active[\s\S]*false/i);

  const uuidLiterals = [...fixtures009.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/gi)];
  assert.ok(uuidLiterals.length >= 15, "expected a broad deterministic UUID fixture set");
  for (const [, uuid] of uuidLiterals) {
    assert.match(uuid, /^00000000-0000-4000-8000-00000000b0/i);
  }

  const monetaryValues = insertedRows(fixtures009).flatMap(({ columns, values }) =>
    columns.flatMap((column, index) => /(?:price|amount|requested_amount|refunded_amount)_minor/i.test(column)
      ? [values[index]]
      : []),
  );
  assert.ok(monetaryValues.length >= 10, "expected monetary values across products, orders, and after-sales fixtures");
  for (const value of monetaryValues) {
    assert.match(value, /^\d+$/, `monetary fixture value must be an integer literal: ${value}`);
  }

  const rows = insertedRows(fixtures009);
  const cell = (row: (typeof rows)[number], column: string) => row.values[row.columns.indexOf(column)];
  const providerRows = rows.filter((row) => row.columns.includes("provider"));
  assert.ok(providerRows.length >= 5);
  assert.ok(providerRows.every((row) => cell(row, "provider") === "'MOCK'"));

  const currencyRows = rows.filter((row) => row.columns.includes("currency"));
  assert.ok(currencyRows.length >= 10);
  assert.ok(currencyRows.every((row) =>
    cell(row, "currency") === (row.table === "public.billing_credit_accounts" ? "'CREDITS'" : "'CNY'")),
  );

  const catalogRows = rows.filter((row) =>
    row.table === "public.billing_plans" || row.table === "public.billing_products");
  assert.equal(catalogRows.length, 3);
  assert.ok(catalogRows.every((row) => cell(row, "is_active") === "false"));
});

test("manifest emits only the six safe top-level sections", async () => {
  const manifest = await readDrillSql("manifest.sql");

  assert.match(manifest, /jsonb_build_object/i);
  assert.doesNotMatch(manifest, /email|raw_payload|signature|token|password/i);
  assert.doesNotMatch(manifest, /select\s+\*/i);

  const topLevelArguments = jsonbBuildObjectArgumentsAfter(manifest, "BILLING_DRILL_MANIFEST");
  const topLevelKeys = topLevelArguments
    .filter((_argument, index) => index % 2 === 0)
    .map((argument) => argument.match(/^'([^']+)'$/)?.[1]);
  assert.equal(topLevelArguments.length, 12);
  assert.deepEqual(topLevelKeys, [
    "migration_versions",
    "table_counts",
    "fixture_checksums",
    "catalog",
    "security_checks",
    "behavior_checks",
  ]);
});

test("verification SQL enforces structural, security, catalog, and runtime behavior gates", async () => {
  const verify = await readDrillSql("verify.sql");

  assert.match(verify, /raise\s+exception/i);
  assert.match(verify, /relrowsecurity/i);
  assert.match(verify, /prosecdef/i);
  assert.match(verify, /is_active\s*=\s*true/i);
  assert.match(verify, /billing_reserve_usage\s*\(/i);
  assert.match(verify, /billing_finalize_usage\s*\(/i);
  assert.match(verify, /billing_release_usage\s*\(/i);
  assert.match(verify, /billing_settle_paid_order\s*\(/i);
  assert.match(verify, /billing_request_refund\s*\(/i);
  assert.match(verify, /billing_admin_[a-z_]+\s*\(/i);
  assert.match(verify, /set\s+local\s+role\s+authenticated/i);
  assert.match(verify, /begin;[\s\S]*rollback;/i);
  assert.doesNotMatch(verify, /--[^\r\n]*(?:reserve|finalize|release|settlement|idempotenc)/i);
  assert.match(verify, /expected_constraint_counts/i);
  for (const [table, expectedCounts] of [
    ["billing_orders", [1, 3, 1, 12]],
    ["billing_payment_intents", [1, 2, 3, 7]],
  ] as const) {
    const constraintCounts = verify.match(
      new RegExp(`\\('${table}',\\s*(\\d+),\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\)`, "i"),
    );
    assert.ok(constraintCounts);
    assert.deepEqual(constraintCounts.slice(1).map(Number), expectedCounts);
  }
  assert.match(verify, /expected_indexes\s*\(\s*table_name\s*,\s*index_name\s*,\s*column_names\s*,\s*expected_predicate\s*\)/i);
  assert.match(verify, /pg_index\s+as\s+index_meta[\s\S]*index_meta\.indrelid[\s\S]*index_meta\.indisvalid[\s\S]*index_meta\.indkey[\s\S]*with\s+ordinality[\s\S]*pg_get_expr\s*\(\s*index_meta\.indpred/i);
  assert.match(verify, /expected_constraints\s*\(\s*table_name\s*,\s*constraint_name\s*,\s*constraint_type\s*,\s*expected_definition\s*\)/i);
  assert.match(verify, /pg_get_constraintdef[\s\S]*convalidated/i);
  for (const triggerFunction of [
    "billing_set_updated_at",
    "billing_protect_order_snapshot",
    "billing_protect_credit_ledger",
    "billing_validate_webhook_event_update",
  ]) {
    assert.match(verify, new RegExp(`${triggerFunction}\\(\\)`, "i"));
  }
  assert.match(verify, /expected_writer_functions[\s\S]*aclexplode/i);
  assert.match(verify, /verify-insufficient-balance-009[\s\S]*100000[\s\S]*sqlstate\s+'53000'[\s\S]*insufficient credit balance was accepted/i);
  assert.match(verify, /billing_settle_paid_order\s*\([\s\S]*ALREADY_PROCESSED[\s\S]*duplicate settlement was not idempotent/i);
  assert.match(verify, /991[\s\S]*sqlstate\s+'22000'[\s\S]*mismatched settlement amount was accepted/i);
  assert.match(verify, /'USD'[\s\S]*sqlstate\s+'22000'[\s\S]*mismatched settlement currency was accepted/i);
  assert.match(verify, /billing_request_refund\s*\([\s\S]*b022[\s\S]*refund request replay was not idempotent/i);
  assert.match(verify, /billing_admin_review_invoice\s*\([\s\S]*ALREADY_APPLIED[\s\S]*administrator replay was not idempotent/i);

  const finalizedStateChecks = sqlBetween(verify, "'verify-finalize-009'", "'verify-release-009'");
  assert.match(finalizedStateChecks, /from\s+public\.billing_usage_quotas[\s\S]*reserved_units[\s\S]*used_units/i);
  assert.match(finalizedStateChecks, /from\s+public\.billing_credit_accounts[\s\S]*available_balance[\s\S]*reserved_balance/i);
  assert.match(finalizedStateChecks, /from\s+public\.billing_usage_records[\s\S]*status\s*=\s*'FINALIZED'/i);
  assert.match(finalizedStateChecks, /from\s+public\.billing_credit_ledger[\s\S]*entry_type[\s\S]*CONSUME/i);

  const releasedStateChecks = sqlBetween(verify, "'verify-release-009'", "'verify-insufficient-balance-009'");
  assert.match(releasedStateChecks, /from\s+public\.billing_usage_quotas[\s\S]*reserved_units[\s\S]*used_units/i);
  assert.match(releasedStateChecks, /from\s+public\.billing_credit_accounts[\s\S]*available_balance[\s\S]*reserved_balance/i);
  assert.match(releasedStateChecks, /from\s+public\.billing_usage_records[\s\S]*status\s*=\s*'RELEASED'/i);
  assert.match(releasedStateChecks, /from\s+public\.billing_credit_ledger[\s\S]*entry_type[\s\S]*RELEASE/i);

  const insufficientStateChecks = sqlBetween(verify, "'verify-insufficient-balance-009'", "'DRILL-CREDIT-009'");
  assert.match(insufficientStateChecks, /billing_usage_records[\s\S]*billing_credit_ledger[\s\S]*available_balance[\s\S]*reserved_balance/i);

  const settlementStateChecks = sqlBetween(verify, "'DRILL-CREDIT-009'", "991");
  assert.match(settlementStateChecks, /billing_payments[\s\S]*billing_credit_ledger[\s\S]*billing_subscriptions[\s\S]*billing_credit_accounts/i);
  assert.match(settlementStateChecks, /count\s*\([^)]+\)[\s\S]*is\s+distinct\s+from/i);

  const refundStateChecks = sqlBetween(verify, "result := public.billing_request_refund", "result := public.billing_admin_review_invoice");
  assert.match(refundStateChecks, /00000000-0000-4000-8000-00000000b022/i);
  assert.match(refundStateChecks, /from\s+public\.billing_refund_requests[\s\S]*count\s*\(/i);

  const adminStateChecks = verify.slice(verify.indexOf("result := public.billing_admin_review_invoice"));
  assert.match(adminStateChecks, /from\s+public\.billing_invoice_requests[\s\S]*status\s*=\s*'ISSUED'[\s\S]*issued_at\s+is\s+not\s+null/i);
  const auditCountCheck = adminStateChecks.match(
    /select\s+count\s*\(\s*\*\s*\)\s+from\s+public\.billing_admin_audit_logs([\s\S]*?)\)\s*<>\s*1/i,
  );
  assert.ok(auditCountCheck);
  assert.doesNotMatch(auditCountCheck[1], /\bid\s*=\s*\(result\s*->>\s*'audit_id'\)/i);
  assert.match(adminStateChecks, /exists\s*\([\s\S]*from\s+public\.billing_admin_audit_logs[\s\S]*id\s*=\s*\(result\s*->>\s*'audit_id'\)::uuid/i);
});
