import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAuthorizedTargets,
  assertDatabaseUrlMatchesRef,
  BILLING_SOURCE_PROJECT_REF,
} from "../../scripts/billing-db-drill/identity";
import {
  buildBackupPlan,
  buildPreflightPlan,
  buildRestorePlan,
  buildUpgradePlan,
  parseDrillArgs,
  runDrill,
} from "../../scripts/billing-db-drill/cli";
import { redactText, runRedacted, sha256File } from "../../scripts/billing-db-drill/process";

const restoreRef = "abcdefghijklmnopqrst";
const productionRef = "uvwxyzabcdefghijklmn";
const drillSqlDirectory = join(process.cwd(), "scripts", "billing-db-drill", "sql");
const migrationsDirectory = join(process.cwd(), "supabase", "migrations");

async function readDrillSql(name: string): Promise<string> {
  return readFile(join(drillSqlDirectory, name), "utf8");
}

async function readBillingMigrations(): Promise<string> {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => /^2026\d+_.*\.sql$/.test(name))
    .sort();
  assert.equal(migrationNames.length, 10);
  return (await Promise.all(
    migrationNames.map((name) => readFile(join(migrationsDirectory, name), "utf8")),
  )).join("\n");
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

function skipSqlTrivia(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    if (/\s/.test(sql[index])) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      index = sql.indexOf("\n", index + 2);
      if (index === -1) return sql.length;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      assert.equal(depth, 0, "unterminated SQL block comment");
      continue;
    }
    break;
  }
  return index;
}

function assertDollarQuotedDoBlocks(sql: string, expectedCount: number): void {
  let index = 0;
  let doBlockCount = 0;
  while (index < sql.length) {
    index = skipSqlTrivia(sql, index);
    if (index >= sql.length) break;

    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index];
      index += 1;
      while (index < sql.length) {
        if (sql[index] !== quote) {
          index += 1;
          continue;
        }
        if (sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      continue;
    }

    const word = sql.slice(index).match(/^[a-z_][a-z0-9_$]*/i)?.[0];
    if (!word) {
      index += 1;
      continue;
    }
    index += word.length;
    if (word.toLowerCase() !== "do") continue;

    const delimiterIndex = skipSqlTrivia(sql, index);
    const delimiter = sql.slice(delimiterIndex).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];
    assert.ok(delimiter, `DO at offset ${index - word.length} lacks a dollar-quote delimiter`);
    const bodyStart = delimiterIndex + delimiter.length;
    const bodyEnd = sql.indexOf(delimiter, bodyStart);
    assert.notEqual(bodyEnd, -1, `DO at offset ${index - word.length} has no closing ${delimiter}`);
    const semicolonIndex = skipSqlTrivia(sql, bodyEnd + delimiter.length);
    assert.equal(sql[semicolonIndex], ";", `DO ${delimiter} block is not terminated by a semicolon`);
    doBlockCount += 1;
    index = semicolonIndex + 1;
  }
  assert.equal(doBlockCount, expectedCount, "unexpected dollar-quoted DO block count");
}

function createTableBodies(sql: string): Array<{ table: string; body: string }> {
  const tables: Array<{ table: string; body: string }> = [];
  const declarations = sql.matchAll(/create\s+table\s+public\.([a-z0-9_]+)\s*\(/gi);
  for (const declaration of declarations) {
    const openIndex = (declaration.index ?? 0) + declaration[0].lastIndexOf("(");
    let depth = 1;
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
      if (character !== ")") continue;
      depth -= 1;
      if (depth === 0) {
        tables.push({ table: declaration[1].toLowerCase(), body: sql.slice(openIndex + 1, index) });
        break;
      }
    }
  }
  return tables;
}

function migrationConstraintShape(sql: string): string[] {
  const constraints: string[] = [];
  for (const { table, body } of createTableBodies(sql)) {
    const add = (type: "c" | "f" | "p" | "u") => constraints.push(`${table}.${type}`);

    for (const item of splitSqlArguments(body)) {
      const compact = item.replace(/--.*$/gm, " ").replace(/\s+/g, " ").trim();
      if (/^unique\s*\(/i.test(compact)) {
        add("u");
        continue;
      }
      if (/^check\s*\(/i.test(compact)) {
        add("c");
        continue;
      }

      const column = compact.match(/^([a-z_][a-z0-9_]*)\s/i)?.[1];
      assert.ok(column, `unable to parse table item: ${compact}`);
      if (/\bprimary\s+key\b/i.test(compact)) add("p");
      if (/\bunique\b/i.test(compact)) add("u");
      if (/\breferences\s+(?:public\.|auth\.)?[a-z_]+\s*\(/i.test(compact)) add("f");
      if (/\bcheck\s*\(/i.test(compact)) add("c");
    }
  }

  for (const match of sql.matchAll(
    /alter\s+table\s+public\.([a-z0-9_]+)\s+add\s+constraint\s+([a-z0-9_]+)\s+(primary\s+key|foreign\s+key|unique|check)\b/gi,
  )) {
    if (match[2].toLowerCase() === "billing_plans_billing_period_check") continue;
    const type = ({ "primary key": "p", "foreign key": "f", unique: "u", check: "c" } as const)[
      match[3].toLowerCase() as "primary key" | "foreign key" | "unique" | "check"
    ];
    constraints.push(`${match[1].toLowerCase()}.${type}`);
  }
  return constraints.sort();
}

function migrationIndexManifest(sql: string) {
  return [...sql.matchAll(
    /create\s+(unique\s+)?index\s+([a-z0-9_]+)\s+on\s+public\.([a-z0-9_]+)\s*(?:using\s+([a-z0-9_]+)\s*)?\(([^()]*)\)\s*(?:where\s+([\s\S]*?))?;/gi,
  )].map((match) => {
    const definitions = splitSqlArguments(match[5]);
    return {
      schema: "public",
      table: match[3].toLowerCase(),
      name: match[2].toLowerCase(),
      columns: definitions.map((definition) => definition.trim().split(/\s+/)[0].toLowerCase()),
      indoptions: definitions.map((definition) => /\bdesc\b/i.test(definition) ? 3 : 0),
      method: (match[4] ?? "btree").toLowerCase(),
      unique: Boolean(match[1]),
      predicate: match[6]?.replace(/\s+/g, " ").trim() ?? null,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function verifyConstraintManifest(sql: string): Array<{
  schema: string;
  table: string;
  name: string | null;
  type: "c" | "f" | "p" | "u";
  identity: string;
  definition: string;
}> {
  const block = sqlBetween(sql, "with expected_constraints", ")\n  select array_agg");
  return [...block.matchAll(
    /\('([^']+)',\s*'([^']+)',\s*(null::text|'([^']+)'),\s*'([cfpu])',\s*'((?:''|[^'])*)'\)/gi,
  )].map((match) => ({
    schema: match[1].toLowerCase(),
    table: match[2].toLowerCase(),
    name: match[4]?.toLowerCase() ?? null,
    type: match[5].toLowerCase() as "c" | "f" | "p" | "u",
    identity: `${match[1]}.${match[2]}.${match[4] ?? "<unnamed>"}.${match[5]}`.toLowerCase(),
    definition: match[6].replace(/''/g, "'"),
  })).sort((left, right) => left.identity.localeCompare(right.identity));
}

function migrationExplicitConstraintNames(sql: string): string[] {
  return [...sql.matchAll(
    /alter\s+table\s+public\.([a-z0-9_]+)\s+add\s+constraint\s+([a-z0-9_]+)\s+(?:primary\s+key|foreign\s+key|unique|check)\b/gi,
  )].map((match) => `${match[1]}.${match[2]}`.toLowerCase()).sort();
}

const indexAttributeCountGates = [
  ["key attribute count", "index_meta.indnkeyatts is distinct from cardinality(expected.column_names)"],
  ["total attribute count", "index_meta.indnatts is distinct from cardinality(expected.column_names)"],
] as const;

const indexVerificationGates = [
  ["schema binding", "index_class.relnamespace = expected.schema_name::regnamespace"],
  ["table binding", "index_meta.indrelid is distinct from to_regclass(format('%I.%I', expected.schema_name, expected.table_name))"],
  ["valid state", "index_meta.indisvalid is not true"],
  ["ready state", "index_meta.indisready is not true"],
  ["live state", "index_meta.indislive is not true"],
  ["access method", "access_method.amname is distinct from expected.access_method"],
  ["uniqueness", "index_meta.indisunique is distinct from expected.expected_unique"],
  ["ordered columns", ") is distinct from expected.column_names"],
  ["predicate", "is distinct from expected.expected_predicate"],
  ["sort options", ") is distinct from expected.expected_indoptions"],
  ...indexAttributeCountGates,
] as const;

function assertIndexVerificationGates(sql: string): void {
  for (const [name, comparison] of indexVerificationGates) {
    const comparisonIndex = sql.indexOf(comparison);
    assert.notEqual(comparisonIndex, -1, `missing index ${name} comparison`);
    const comparisonTail = sql.slice(comparisonIndex, comparisonIndex + comparison.length + 32);
    assert.doesNotMatch(comparisonTail, /\band\s+false\b/i, `index ${name} comparison is disabled`);
  }
}

function verifyIndexManifest(sql: string) {
  const block = sqlBetween(sql, "with expected_indexes", ")\n  select array_agg");
  return [...block.matchAll(
    /\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*array\[([^\]]+)\],\s*array\[([^\]]+)\],\s*'([^']+)',\s*(true|false),\s*(null::text|'[^']*')\)/gi,
  )].map((match) => ({
    schema: match[1].toLowerCase(),
    table: match[2].toLowerCase(),
    name: match[3].toLowerCase(),
    columns: [...match[4].matchAll(/'([^']+)'/g)].map((column) => column[1].toLowerCase()),
    indoptions: match[5].split(",").map((option) => Number(option.trim())),
    method: match[6].toLowerCase(),
    unique: match[7].toLowerCase() === "true",
    predicate: match[8].toLowerCase() === "null::text" ? null : match[8].slice(1, -1),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

const expectedConstraintCounts = new Map<string, number>([
  ["billing_plans", 3], ["billing_products", 9], ["billing_plan_entitlements", 5],
  ["billing_orders", 17], ["billing_payment_intents", 13], ["billing_payments", 9],
  ["billing_subscriptions", 8], ["billing_user_entitlements", 7], ["billing_usage_quotas", 10],
  ["billing_credit_accounts", 7], ["billing_usage_records", 10], ["billing_usage_continuations", 7],
  ["billing_credit_ledger", 8], ["billing_webhook_events", 10], ["billing_refund_requests", 8],
  ["billing_refunds", 12], ["billing_invoice_requests", 7], ["billing_admins", 4],
  ["billing_admin_audit_logs", 3], ["billing_rate_limits", 4], ["billing_feature_usage_costs", 5],
]);

function assertConstraintInventoryMatchesMigrations(migrations: string, verify: string): void {
  const manifest = verifyConstraintManifest(verify);
  const migrationShape = migrationConstraintShape(migrations);
  const explicitNames = migrationExplicitConstraintNames(migrations);
  for (const [table, expectedCount] of expectedConstraintCounts) {
    assert.equal(
      migrationShape.filter((constraint) => constraint.startsWith(`${table}.`)).length,
      expectedCount,
      `migration constraint parser mismatch for ${table}`,
    );
    for (const type of ["c", "f", "p", "u"]) {
      assert.equal(
        manifest.filter(({ identity }) =>
          identity.startsWith(`public.${table}.`) && identity.endsWith(`.${type}`)).length,
        migrationShape.filter((constraint) => constraint === `${table}.${type}`).length,
        `constraint type count mismatch for ${table}.${type}`,
      );
    }
  }
  assert.equal(migrationShape.length, 166);
  assert.deepEqual(
    manifest.filter(({ name }) => name !== null).map(({ table, name }) => `${table}.${name}`).sort(),
    explicitNames,
    "only migration-explicit constraint names may be enforced",
  );
  assert.equal(manifest.length, 166);
  assert.equal(
    new Set(manifest.map(({ table, type, definition }) => `${table}.${type}.${definition}`)).size,
    166,
    "constraint semantic signatures must form an exact multiset",
  );
}

function replaceUnique(source: string, target: string, replacement: string): string {
  const first = source.indexOf(target);
  assert.notEqual(first, -1, `missing mutation leaf: ${target}`);
  assert.equal(source.indexOf(target, first + target.length), -1, `ambiguous mutation leaf: ${target}`);
  return `${source.slice(0, first)}${replacement}${source.slice(first + target.length)}`;
}

function deleteBooleanLeaf(checkDefinition: string, leaf: string): string {
  assert.equal(checkDefinition.split(leaf).length, 2, `expected one deletion leaf: ${leaf}`);
  for (const [target, replacement] of [
    [`${leaf} AND `, ""],
    [` AND ${leaf}`, ""],
    [`${leaf} OR `, ""],
    [` OR ${leaf}`, ""],
  ] as const) {
    if (checkDefinition.includes(target)) return replaceUnique(checkDefinition, target, replacement);
  }
  return replaceUnique(checkDefinition, leaf, "(true)");
}

function expandBooleanLeaf(checkDefinition: string, leaf: string): string {
  return replaceUnique(checkDefinition, leaf, `(${leaf} OR true)`);
}

const wideConstraintSemantics = [
  {
    table: "billing_products",
    marker: "duration_days IS NOT NULL",
    migration: /product_type\s*=\s*'SUBSCRIPTION'[\s\S]*plan_id\s+is\s+not\s+null[\s\S]*duration_days\s+is\s+not\s+null[\s\S]*or[\s\S]*product_type\s*=\s*'CREDIT_PACK'/i,
    valid: "CHECK ((((product_type = 'SUBSCRIPTION'::text) AND (plan_id IS NOT NULL) AND (duration_days IS NOT NULL)) OR ((product_type = 'CREDIT_PACK'::text) AND (plan_id IS NULL) AND (credit_grant > 0))))",
    mutationLeaf: "(plan_id IS NOT NULL)",
  },
  {
    table: "billing_orders",
    marker: "jsonb_typeof",
    migration: /jsonb_typeof\s*\(snapshot_entitlements\)\s*=\s*'array'/i,
    valid: "CHECK ((jsonb_typeof(snapshot_entitlements) = 'array'::text))",
    mutationLeaf: "(jsonb_typeof(snapshot_entitlements) = 'array'::text)",
  },
  {
    table: "billing_orders",
    marker: "expires_at > created_at",
    migration: /check\s*\(expires_at\s*>\s*created_at\)/i,
    valid: "CHECK ((expires_at > created_at))",
    mutationLeaf: "(expires_at > created_at)",
  },
  {
    table: "billing_orders",
    marker: "paid_at IS NOT NULL",
    migration: /status\s+not\s+in\s*\('PAID',\s*'REFUNDING',\s*'REFUNDED'\)[\s\S]*or\s+paid_at\s+is\s+not\s+null/i,
    valid: "CHECK (((status <> ALL (ARRAY['PAID'::text, 'REFUNDING'::text, 'REFUNDED'::text])) OR (paid_at IS NOT NULL)))",
    mutationLeaf: "(paid_at IS NOT NULL)",
  },
  {
    table: "billing_orders",
    marker: "snapshot_credit_grant > 0",
    migration: /snapshot_product_type\s*=\s*'SUBSCRIPTION'[\s\S]*snapshot_duration_days\s+is\s+not\s+null[\s\S]*or[\s\S]*snapshot_product_type\s*=\s*'CREDIT_PACK'/i,
    valid: "CHECK ((((snapshot_product_type = 'SUBSCRIPTION'::text) AND (snapshot_plan_id IS NOT NULL) AND (snapshot_duration_days IS NOT NULL)) OR ((snapshot_product_type = 'CREDIT_PACK'::text) AND (snapshot_plan_id IS NULL) AND (snapshot_credit_grant > 0))))",
    mutationLeaf: "(snapshot_plan_id IS NOT NULL)",
  },
  {
    table: "billing_payment_intents",
    marker: "claim_expires_at IS NOT NULL",
    migration: /status\s*=\s*'CREATING'[\s\S]*claim_token\s+is\s+not\s+null[\s\S]*status\s*=\s*'CREATED'[\s\S]*payment_token\s+is\s+not\s+null[\s\S]*status\s*=\s*'FAILED'[\s\S]*last_error_code/i,
    valid: "CHECK ((((status = 'CREATING'::text) AND (claim_token IS NOT NULL) AND (claim_expires_at IS NOT NULL) AND (provider_transaction_id IS NULL) AND (payment_token IS NULL) AND (payment_status IS NULL) AND (last_error_code IS NULL)) OR ((status = 'CREATED'::text) AND (claim_token IS NULL) AND (claim_expires_at IS NULL) AND (provider_transaction_id IS NOT NULL) AND (payment_token IS NOT NULL) AND (payment_status IS NOT NULL) AND (last_error_code IS NULL)) OR ((status = 'FAILED'::text) AND (claim_token IS NULL) AND (claim_expires_at IS NULL) AND (provider_transaction_id IS NULL) AND (payment_token IS NULL) AND (payment_status IS NULL) AND (NULLIF(btrim(last_error_code), ''::text) IS NOT NULL))))",
    mutationLeaf: "(claim_expires_at IS NOT NULL)",
  },
  {
    table: "billing_subscriptions",
    marker: "auto_renew",
    migration: /auto_renew\s+boolean[\s\S]*check\s*\(auto_renew\s*=\s*false\)/i,
    valid: "CHECK ((auto_renew = false))",
    mutationLeaf: "(auto_renew = false)",
  },
  {
    table: "billing_subscriptions",
    marker: "ends_at > starts_at",
    migration: /check\s*\(ends_at\s*>\s*starts_at\)/i,
    valid: "CHECK ((ends_at > starts_at))",
    mutationLeaf: "(ends_at > starts_at)",
  },
  {
    table: "billing_user_entitlements",
    marker: "valid_until IS NULL",
    migration: /valid_until\s+is\s+null\s+or\s+valid_until\s*>\s*valid_from/i,
    valid: "CHECK (((valid_until IS NULL) OR (valid_until > valid_from)))",
    mutationLeaf: "(valid_until > valid_from)",
  },
  {
    table: "billing_usage_quotas",
    marker: "period_end > period_start",
    migration: /check\s*\(period_end\s*>\s*period_start\)/i,
    valid: "CHECK ((period_end > period_start))",
    mutationLeaf: "(period_end > period_start)",
  },
  {
    table: "billing_usage_quotas",
    marker: "reserved_units \\+ used_units",
    migration: /reserved_units\s*\+\s*used_units\s*<=\s*quota_limit/i,
    valid: "CHECK (((reserved_units + used_units) <= quota_limit))",
    mutationLeaf: "((reserved_units + used_units) <= quota_limit)",
  },
  {
    table: "billing_usage_records",
    marker: "quota_units > 0",
    migration: /quota_units\s*>\s*0\s+or\s+credit_amount\s*>\s*0/i,
    valid: "CHECK (((quota_units > 0) OR (credit_amount > 0)))",
    mutationLeaf: "(quota_units > 0)",
  },
  {
    table: "billing_usage_continuations",
    marker: "0-9a-f",
    migration: /request_hash\s+is\s+null\s+or\s+request_hash\s*~\s*'\^\[0-9a-f\]\{64\}\$'/i,
    valid: "CHECK (((request_hash IS NULL) OR (request_hash ~ '^[0-9a-f]{64}$'::text)))",
    mutationLeaf: "(request_hash ~ '^[0-9a-f]{64}$'::text)",
  },
  {
    table: "billing_usage_continuations",
    marker: "completed_at IS NOT NULL",
    migration: /status\s*=\s*'AVAILABLE'[\s\S]*claim_token\s+is\s+null[\s\S]*status\s*=\s*'CLAIMED'[\s\S]*request_hash\s+is\s+not\s+null[\s\S]*status\s*=\s*'COMPLETED'[\s\S]*completed_at\s+is\s+not\s+null/i,
    valid: "CHECK ((((status = 'AVAILABLE'::text) AND (claim_token IS NULL) AND (lease_expires_at IS NULL)) OR ((status = 'CLAIMED'::text) AND (claim_token IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (request_hash IS NOT NULL)) OR ((status = 'COMPLETED'::text) AND (claim_token IS NULL) AND (lease_expires_at IS NULL) AND (request_hash IS NOT NULL) AND (completed_at IS NOT NULL))))",
    mutationLeaf: "(lease_expires_at IS NOT NULL)",
  },
  {
    table: "billing_webhook_events",
    marker: "error_code",
    migration: /status\s*<>\s*'FAILED'[\s\S]*or\s+nullif\s*\(btrim\s*\(error_code\)/i,
    valid: "CHECK (((status <> 'FAILED'::text) OR (NULLIF(btrim(error_code), ''::text) IS NOT NULL)))",
    mutationLeaf: "(NULLIF(btrim(error_code), ''::text) IS NOT NULL)",
  },
  {
    table: "billing_webhook_events",
    marker: "signature_valid IS TRUE",
    migration: /status\s+in\s*\('RECEIVED',\s*'PROCESSING',\s*'PROCESSED'\)[\s\S]*signature_valid\s+is\s+true[\s\S]*status\s*=\s*'FAILED'[\s\S]*order_number\s+is\s+null/i,
    valid: "CHECK ((((status = ANY (ARRAY['RECEIVED'::text, 'PROCESSING'::text, 'PROCESSED'::text])) AND (signature_valid IS TRUE) AND (order_number IS NOT NULL) AND (provider_transaction_id IS NOT NULL) AND (request_idempotency_key IS NOT NULL) AND (amount_minor IS NOT NULL) AND (currency IS NOT NULL) AND (paid_at IS NOT NULL)) OR ((status = 'FAILED'::text) AND (((signature_valid IS TRUE) AND (order_number IS NOT NULL) AND (provider_transaction_id IS NOT NULL) AND (request_idempotency_key IS NOT NULL) AND (amount_minor IS NOT NULL) AND (currency IS NOT NULL) AND (paid_at IS NOT NULL)) OR ((order_number IS NULL) AND (provider_transaction_id IS NULL) AND (request_idempotency_key IS NULL) AND (amount_minor IS NULL) AND (currency IS NULL) AND (paid_at IS NULL))))))",
    mutationLeaf: "(request_idempotency_key IS NULL)",
  },
  {
    table: "billing_feature_usage_costs",
    marker: "quota_units > 0",
    migration: /quota_units\s*>\s*0\s+or\s+credit_amount\s*>\s*0/i,
    valid: "CHECK (((quota_units > 0) OR (credit_amount > 0)))",
    mutationLeaf: "(quota_units > 0)",
  },
  {
    table: "billing_feature_usage_costs",
    marker: "allow_credit_fallback",
    migration: /not\s+allow_credit_fallback\s+or\s+credit_amount\s*>\s*0/i,
    valid: "CHECK (((NOT allow_credit_fallback) OR (credit_amount > 0)))",
    mutationLeaf: "(NOT allow_credit_fallback)",
  },
] as const;

function assertConstraintSemantics(migrations: string, verify: string): void {
  const manifest = verifyConstraintManifest(verify);
  const migrationTables = new Map(createTableBodies(migrations).map(({ table, body }) => [table, body]));
  const matchedWideDefinitions = new Set<string>();

  for (const expected of wideConstraintSemantics) {
    const migrationBody = migrationTables.get(expected.table);
    assert.ok(migrationBody, `migration table missing: ${expected.table}`);
    assert.match(migrationBody, expected.migration, `migration semantic missing: ${expected.table}.${expected.marker}`);
    const matches = manifest.filter(({ table, type, definition }) =>
      table === expected.table && type === "c" && definition.includes(expected.marker));
    assert.equal(matches.length, 1, `expected one wide CHECK: ${expected.table}.${expected.marker}`);
    const definition = matches[0].definition;
    matchedWideDefinitions.add(`${matches[0].table}.${definition}`);
    const pattern = new RegExp(definition, "i");
    assert.match(expected.valid, pattern, `valid deparsed CHECK rejected: ${expected.table}.${expected.marker}`);
    assert.doesNotMatch(
      deleteBooleanLeaf(expected.valid, expected.mutationLeaf),
      pattern,
      `deleted CHECK leaf accepted: ${expected.table}.${expected.marker}`,
    );
    assert.doesNotMatch(
      expandBooleanLeaf(expected.valid, expected.mutationLeaf),
      pattern,
      `expanded CHECK leaf accepted: ${expected.table}.${expected.marker}`,
    );
  }
  assert.equal(wideConstraintSemantics.length, 18);
  assert.equal(matchedWideDefinitions.size, 18, "wide CHECK mutation table must cover 18 distinct definitions");

  for (const expected of [
    {
      table: "billing_plans", type: "p", marker: "PRIMARY KEY \\(id\\)",
      migration: /id\s+uuid\s+primary\s+key/i,
      valid: "PRIMARY KEY (id)", invalid: "PRIMARY KEY (code)",
    },
    {
      table: "billing_products", type: "f", marker: "FOREIGN KEY \\(plan_id\\)",
      migration: /plan_id\s+uuid\s+references\s+public\.billing_plans\s*\(id\)\s+on\s+delete\s+restrict/i,
      valid: "FOREIGN KEY (plan_id) REFERENCES billing_plans(id) ON DELETE RESTRICT",
      invalid: "FOREIGN KEY (plan_id) REFERENCES billing_plans(id) ON DELETE CASCADE",
    },
    {
      table: "billing_plan_entitlements", type: "u", marker: "UNIQUE \\(plan_id, feature_key, entitlement_version\\)",
      migration: /unique\s*\(plan_id,\s*feature_key,\s*entitlement_version\)/i,
      valid: "UNIQUE (plan_id, feature_key, entitlement_version)",
      invalid: "UNIQUE (feature_key, plan_id, entitlement_version)",
    },
    {
      table: "billing_orders", type: "c", marker: "amount_minor >= 0",
      migration: /amount_minor\s+bigint\s+not\s+null\s+check\s*\(amount_minor\s*>=\s*0\)/i,
      valid: "CHECK ((amount_minor >= 0))", invalid: "CHECK ((amount_minor >= '-1'::integer))",
    },
  ] as const) {
    const migrationBody = migrationTables.get(expected.table);
    assert.ok(migrationBody);
    assert.match(migrationBody, expected.migration);
    const matches = manifest.filter(({ table, type, definition }) =>
      table === expected.table && type === expected.type && definition.includes(expected.marker));
    assert.equal(matches.length, 1, `expected one representative ${expected.type}: ${expected.table}`);
    const pattern = new RegExp(matches[0].definition, "i");
    assert.match(expected.valid, pattern);
    assert.doesNotMatch(expected.invalid, pattern);
  }
}

function wideConstraintPattern(verify: string, table: string, marker: string): RegExp {
  const matches = verifyConstraintManifest(verify).filter((entry) =>
    entry.table === table && entry.type === "c" && entry.definition.includes(marker));
  assert.equal(matches.length, 1, `expected one wide CHECK: ${table}.${marker}`);
  return new RegExp(matches[0].definition, "i");
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

test("verification SQL contains nine balanced dollar-quoted DO statements", async () => {
  const verify = await readDrillSql("verify.sql");
  assertDollarQuotedDoBlocks(verify, 9);

  const brokenDelimiter = verify.replace(/do\s+\$(?:[a-z_][a-z0-9_]*)?\$/i, "do $");
  assert.notEqual(brokenDelimiter, verify, "failed to construct delimiter mutation");
  assert.throws(
    () => assertDollarQuotedDoBlocks(brokenDelimiter, 9),
    /lacks a dollar-quote delimiter/,
  );
});

test("verification index manifest preserves every migration index definition", async () => {
  const [migrations, verify] = await Promise.all([
    readBillingMigrations(),
    readDrillSql("verify.sql"),
  ]);
  assert.equal(migrationIndexManifest(migrations).length, 8);

  assert.match(
    verify,
    /expected_indexes\s*\(\s*schema_name\s*,\s*table_name\s*,\s*index_name\s*,\s*column_names\s*,\s*expected_indoptions\s*,\s*access_method\s*,\s*expected_unique\s*,\s*expected_predicate\s*\)/i,
  );
  assert.deepEqual(verifyIndexManifest(verify), migrationIndexManifest(migrations));
  assertIndexVerificationGates(verify);
  for (const [name, comparison] of indexVerificationGates) {
    assert.throws(
      () => assertIndexVerificationGates(verify.replace(comparison, `${comparison} and false`)),
      new RegExp(`index ${name} comparison is disabled`, "i"),
    );
    assert.throws(
      () => assertIndexVerificationGates(verify.replace(comparison, "true")),
      new RegExp(`missing index ${name} comparison`, "i"),
    );
  }
  assert.match(verify, /pg_am[\s\S]*indisunique[\s\S]*pg_get_expr\s*\(\s*index_meta\.indpred/i);
});

for (const [name, comparison] of indexAttributeCountGates) {
  test(`verification index ${name} participates in comparison mutations`, async () => {
    const verify = await readDrillSql("verify.sql");
    assert.ok(verify.includes(comparison), `missing index ${name} mutation target`);
    assert.throws(
      () => assertIndexVerificationGates(verify.replace(comparison, `${comparison} and false`)),
      new RegExp(`index ${name} comparison is disabled`, "i"),
    );
    assert.throws(
      () => assertIndexVerificationGates(verify.replace(comparison, "true")),
      new RegExp(`missing index ${name} comparison`, "i"),
    );
  });
}

test("verification constraint manifest covers every migration constraint", async () => {
  const [migrations, verify] = await Promise.all([
    readBillingMigrations(),
    readDrillSql("verify.sql"),
  ]);
  const manifest = verifyConstraintManifest(verify);
  assertConstraintInventoryMatchesMigrations(migrations, verify);

  assert.match(
    verify,
    /expected_constraints\s*\(\s*schema_name\s*,\s*table_name\s*,\s*constraint_name\s*,\s*constraint_type\s*,\s*expected_definition\s*\)/i,
  );
  assert.ok(manifest.every(({ definition }) => definition.length >= 12));
  for (const { identity, definition } of manifest.filter(({ identity }) => identity.endsWith(".c"))) {
    assert.match(
      definition,
      /(?:>=|<=|<>|=|>|<|\bNULL\b|\bNOT\b|jsonb_typeof|\bANY\b)/,
      `CHECK pattern lacks an operator or Boolean semantic: ${identity}`,
    );
  }
  for (const { identity, definition } of manifest.filter(({ type, definition }) =>
    type === "c" && definition.includes("currency ="))) {
    assert.match(definition, /currency = '(?:CNY|CREDITS)'::text/, `currency pattern is not semantic: ${identity}`);
    assert.match(definition, /\$$/, `currency pattern is not end-anchored: ${identity}`);
  }
  for (const { identity, definition } of manifest.filter(({ definition }) =>
    definition.includes("= ANY \\(ARRAY\\["))) {
    assert.ok(definition.includes("= ANY \\(ARRAY\\["), `enum pattern is not semantic: ${identity}`);
    assert.match(definition, /\$$/, `enum pattern is not end-anchored: ${identity}`);
  }
  assert.match(verify, /set\s+local\s+search_path\s*=\s*pg_catalog\s*,\s*public/i);
  assert.match(verify, /constraint_meta\.conname[\s\S]*constraint_meta\.contype[\s\S]*constraint_meta\.convalidated[\s\S]*pg_get_constraintdef\s*\(\s*constraint_meta\.oid/i);
  assert.match(verify, /constraint_matches[\s\S]*matched_expected_count[\s\S]*matched_actual_count/i);
});

test("constraint inventory rejects missing and duplicate canonical entries", async () => {
  const [migrations, verify] = await Promise.all([
    readBillingMigrations(),
    readDrillSql("verify.sql"),
  ]);
  const entry = "      ('public', 'billing_plans', null::text, 'p', '^PRIMARY KEY \\(id\\)$'),";
  assert.ok(verify.includes(entry), "missing mutation target");

  for (const [name, mutated] of [
    ["missing", verify.replace(entry, "")],
    ["duplicate", verify.replace(entry, `${entry}\n${entry}`)],
  ] as const) {
    assert.throws(
      () => assertConstraintInventoryMatchesMigrations(migrations, mutated),
      `${name} constraint entry escaped inventory checks`,
    );
  }
});

test("constraint semantic mutation table covers every broad CHECK and every constraint type", async () => {
  const [migrations, verify] = await Promise.all([
    readBillingMigrations(),
    readDrillSql("verify.sql"),
  ]);
  assertConstraintSemantics(migrations, verify);

  const expiresAt = verifyConstraintManifest(verify).find(({ table, definition }) =>
    table === "billing_orders" && definition.includes("expires_at > created_at"));
  assert.ok(expiresAt, "missing semantic regex mutation target");
  const original = `'${expiresAt.definition.replaceAll("'", "''")}'`;
  assert.throws(
    () => assertConstraintSemantics(migrations, replaceUnique(verify, original, "'^CHECK .*$'")),
    "weakened constraint regex escaped semantic checks",
  );
});

test("product CHECK rejects OR true inside the subscription branch", async () => {
  const verify = await readDrillSql("verify.sql");
  const expected = wideConstraintSemantics.find(({ table }) => table === "billing_products");
  assert.ok(expected);
  assert.doesNotMatch(
    expandBooleanLeaf(expected.valid, expected.mutationLeaf),
    wideConstraintPattern(verify, expected.table, expected.marker),
  );
});

test("payment-intent CHECK rejects deletion of claim expiry", async () => {
  const verify = await readDrillSql("verify.sql");
  const expected = wideConstraintSemantics.find(({ table }) => table === "billing_payment_intents");
  assert.ok(expected);
  assert.doesNotMatch(
    deleteBooleanLeaf(expected.valid, expected.mutationLeaf),
    wideConstraintPattern(verify, expected.table, expected.marker),
  );
});

test("constraint patterns reject semantic weakening and expansion", async () => {
  const manifest = verifyConstraintManifest(await readDrillSql("verify.sql"));
  const pattern = (table: string, marker: string) => {
    const matches = manifest.filter((entry) =>
      entry.table === table && entry.type === "c" && entry.definition.includes(marker));
    assert.equal(matches.length, 1, `expected one ${table}.${marker} CHECK`);
    return new RegExp(matches[0].definition, "i");
  };

  const currency = pattern("billing_orders", "currency");
  assert.match("CHECK ((currency = 'CNY'::text))", currency);
  assert.doesNotMatch("CHECK ((currency <> 'CNY'::text))", currency);
  assert.doesNotMatch("CHECK (((currency = 'CNY'::text) OR (currency = 'USD'::text)))", currency);

  const status = pattern("billing_orders", "PENDING");
  assert.match(
    "CHECK ((status = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'FAILED'::text, 'CANCELLED'::text, 'CLOSED'::text, 'REFUNDING'::text, 'REFUNDED'::text])))",
    status,
  );
  assert.doesNotMatch(
    "CHECK ((status = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'FAILED'::text, 'CANCELLED'::text, 'CLOSED'::text, 'REFUNDING'::text, 'REFUNDED'::text, 'FREE'::text])))",
    status,
  );

  for (const [table, marker, valid, weakened] of [
    ["billing_orders", "amount_minor", "CHECK ((amount_minor >= 0))", "CHECK (((amount_minor >= 0) OR true))"],
    ["billing_refunds", "refunded_amount_minor", "CHECK ((refunded_amount_minor > 0))", "CHECK ((refunded_amount_minor >= 0))"],
    ["billing_credit_accounts", "available_balance", "CHECK ((available_balance >= 0))", "CHECK ((available_balance >= '-1'::integer))"],
  ] as const) {
    const constraint = pattern(table, marker);
    assert.match(valid, constraint);
    assert.doesNotMatch(weakened, constraint);
  }
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

const fakeRunDirectory = ".artifacts/billing-db-drill/20260812T010203Z-a1b2c3d4";
const sourceDatabaseUrl = `postgresql://postgres.${BILLING_SOURCE_PROJECT_REF}:source-secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;
const restoreDatabaseUrl = `postgresql://postgres.${restoreRef}:restore-secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`;

function planInput() {
  return {
    sourceRef: BILLING_SOURCE_PROJECT_REF,
    restoreRef,
    runDirectory: fakeRunDirectory,
    sourceDatabaseUrl,
    restoreDatabaseUrl,
  };
}

test("drill parser accepts exactly the six commands and required target refs", () => {
  for (const command of ["preflight", "backup", "verify"] as const) {
    assert.deepEqual(
      parseDrillArgs([
        command,
        "--source-ref", BILLING_SOURCE_PROJECT_REF,
        "--restore-ref", restoreRef,
        "--approved-restore-ref", restoreRef,
        "--dry-run",
      ]),
      {
        command,
        sourceRef: BILLING_SOURCE_PROJECT_REF,
        restoreRef,
        approvedRestoreRef: restoreRef,
        dryRun: true,
      },
    );
  }
  for (const command of ["upgrade", "restore", "all"] as const) {
    assert.equal(
      parseDrillArgs([
        command,
        "--source-ref", BILLING_SOURCE_PROJECT_REF,
        "--restore-ref", restoreRef,
        "--approved-restore-ref", restoreRef,
        "--confirm-restore", restoreRef,
      ]).command,
      command,
    );
  }
});

test("drill parser fails closed on missing, duplicate, unknown, or malformed arguments", () => {
  const base = [
    "preflight",
    "--source-ref", BILLING_SOURCE_PROJECT_REF,
    "--restore-ref", restoreRef,
    "--approved-restore-ref", restoreRef,
  ];
  for (const argv of [
    [],
    ["destroy", ...base.slice(1)],
    base.slice(0, -2),
    [...base, "--source-ref", BILLING_SOURCE_PROJECT_REF],
    [...base, "--surprise"],
    ["preflight", "--source-ref", "not-a-ref", "--restore-ref", restoreRef, "--approved-restore-ref", restoreRef],
  ]) {
    assert.throws(() => parseDrillArgs(argv));
  }
});

test("mutating drill commands require an exact second restore confirmation", () => {
  for (const command of ["upgrade", "restore", "all"] as const) {
    const base = [
      command,
      "--source-ref", BILLING_SOURCE_PROJECT_REF,
      "--restore-ref", restoreRef,
      "--approved-restore-ref", restoreRef,
    ];
    assert.throws(() => parseDrillArgs(base), /RESTORE_CONFIRMATION_REQUIRED/);
    assert.throws(
      () => parseDrillArgs([...base, "--confirm-restore", productionRef]),
      /RESTORE_CONFIRMATION_MISMATCH/,
    );
  }
});

test("preflight plan fails closed when restore billing relations or migration history exist", () => {
  const plan = buildPreflightPlan(planInput());
  const emptyCheck = plan.find(({ operation }) => operation === "verify-restore-empty");
  assert.ok(emptyCheck);
  const sql = emptyCheck.args.at(-1) ?? "";
  assert.match(sql, /raise\s+exception/i);
  assert.match(sql, /billing\\_%/i);
  for (const version of ["202607210001", "202607210002", "202607210003", "202607230004", "202607290005", "202607290006", "202607290007", "202607290008", "202607290009", "202608050010"]) {
    assert.match(sql, new RegExp(version));
  }
  assert.equal(emptyCheck.readOnly, true);
  assert.equal(emptyCheck.targetRef, restoreRef);
});

test("upgrade plan isolates migrations 001-009 before fixtures and pushes 010 last", () => {
  const plan = buildUpgradePlan(planInput());
  assert.deepEqual(plan.map(({ operation }) => operation), [
    "prepare-upgrade-009-workspace",
    "link-upgrade-workspace",
    "verify-upgrade-workspace-ref-before-009",
    "push-migrations-001-009",
    "load-fixtures-009",
    "capture-pre-upgrade-manifest",
    "copy-migration-010",
    "verify-upgrade-workspace-ref-before-010",
    "push-migration-010",
    "verify-upgraded-restore",
  ]);
  assert.deepEqual(plan[0].args, ["copy-migrations", "001-009", "upgrade-workspace"]);
  assert.equal(plan[0].cwd, fakeRunDirectory);
  assert.deepEqual(plan[1].args, ["link", "--project-ref", restoreRef]);
  assert.deepEqual(plan[3].args, ["db", "push", "--linked"]);
  assert.deepEqual(plan[4].args.slice(0, 4), ["-X", "-v", "ON_ERROR_STOP=1", "-v"]);
  assert.ok(plan[4].args.includes("drill_commit=true"));
  assert.deepEqual(plan[8].args, ["db", "push", "--linked"]);
  assert.ok(plan.every(({ targetRef }) => targetRef !== BILLING_SOURCE_PROJECT_REF));
});

test("backup and restore plans preserve logical artifact order and stop-safe SQL flags", () => {
  const backup = buildBackupPlan(planInput());
  assert.deepEqual(backup.map(({ operation }) => operation), [
    "prepare-backup-workspace",
    "link-backup-workspace",
    "verify-backup-workspace-ref-before-roles",
    "dump-roles",
    "verify-backup-workspace-ref-before-schema",
    "dump-schema",
    "verify-backup-workspace-ref-before-data",
    "dump-data",
    "hash-roles",
    "hash-schema",
    "hash-data",
  ]);
  assert.equal(backup[0].cwd, fakeRunDirectory);
  assert.deepEqual(
    backup.filter(({ operation }) => operation.startsWith("dump-")).map(({ executable }) => executable),
    ["supabase", "supabase", "supabase"],
  );
  assert.deepEqual(
    backup.filter(({ operation }) => operation.startsWith("dump-")).map(({ artifactBasenames }) => artifactBasenames),
    ["roles.sql", "schema.sql", "data.sql"],
  );
  assert.ok(backup.filter(({ targetRef }) => targetRef === BILLING_SOURCE_PROJECT_REF).every(({ readOnly }) => readOnly));

  const restore = buildRestorePlan(planInput());
  assert.deepEqual(restore.map(({ operation }) => operation), ["restore-roles", "restore-schema", "restore-data"]);
  assert.deepEqual(restore.map(({ artifactBasenames }) => artifactBasenames), ["roles.sql", "schema.sql", "data.sql"]);
  for (const command of restore) {
    assert.deepEqual(command.args.slice(0, 3), ["-X", "-v", "ON_ERROR_STOP=1"]);
    assert.equal(command.targetRef, restoreRef);
    const artifactPath = command.args.at(-1)?.replaceAll("\\", "/") ?? "";
    assert.ok(artifactPath.startsWith(`${fakeRunDirectory}/`));
    assert.doesNotMatch(artifactPath, /(?:^|\/)\.\.(?:\/|$)/);
  }
});

test("plans keep URLs and passwords out of arguments and expose secrets only in child env", () => {
  const plans = [buildUpgradePlan(planInput()), buildBackupPlan(planInput()), buildRestorePlan(planInput())];
  for (const command of plans.flat()) {
    const args = command.args.join(" ");
    assert.doesNotMatch(args, /postgres(?:ql)?:\/\//i);
    assert.doesNotMatch(args, /source-secret|restore-secret/);
    for (const key of Object.keys(command.env)) {
      assert.ok([
        "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE", "SUPABASE_DB_PASSWORD",
      ].includes(key));
    }
  }
  assert.equal(buildUpgradePlan(planInput()).find(({ operation }) => operation === "load-fixtures-009")?.env.PGPASSWORD, "restore-secret");
  assert.equal(buildBackupPlan(planInput()).find(({ operation }) => operation === "link-backup-workspace")?.env.SUPABASE_DB_PASSWORD, "source-secret");
});

test("dry-run emits a sanitized run path and records zero executor calls", async () => {
  const spawnCalls: unknown[] = [];
  const output: string[] = [];
  const exitCode = await runDrill(
    [
      "preflight",
      "--source-ref", BILLING_SOURCE_PROJECT_REF,
      "--restore-ref", restoreRef,
      "--approved-restore-ref", restoreRef,
      "--dry-run",
    ],
    {
      env: {
        BILLING_SOURCE_DB_URL: sourceDatabaseUrl,
        BILLING_RESTORE_DB_URL: restoreDatabaseUrl,
        BILLING_PRODUCTION_PROJECT_REFS: productionRef,
      },
      now: () => new Date("2026-08-12T01:02:03.000Z"),
      randomHex: () => "a1b2c3d4",
      execute: async (...args) => {
        spawnCalls.push(args);
        return { stdout: "", stderr: "" };
      },
      writeOutput: (line) => output.push(line),
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(spawnCalls.length, 0);
  const text = output.join("\n");
  assert.match(text, /\.artifacts\/billing-db-drill\/20260812T010203Z-a1b2c3d4/);
  assert.match(text, new RegExp(BILLING_SOURCE_PROJECT_REF));
  assert.match(text, new RegExp(restoreRef));
  assert.doesNotMatch(text, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(text, /source-secret|restore-secret/);
});
