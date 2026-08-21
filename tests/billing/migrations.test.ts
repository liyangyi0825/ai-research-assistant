import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const projectFile = (path: string) => {
  const url = new URL(`../../${path}`, import.meta.url);
  assert.ok(existsSync(url), `expected Task 2 file to exist: ${path}`);
  return readFileSync(url, "utf8");
};

const compactSql = (path: string) =>
  projectFile(path)
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

test("013 webhook retries are bounded, server-timed, immutable, and service-role only", () => {
  const sql = compactSql("supabase/migrations/202608180013_billing_webhook_retry.sql");
  assert.match(sql, /status in \('received', 'processing', 'processed', 'retryable', 'failed'\)/);
  assert.match(sql, /retry_count between 0 and 8/);
  assert.match(sql, /retry_after = clock_timestamp\(\) \+ make_interval/);
  assert.match(sql, /least\(60, power\(2, retry_count\)::integer\)/);
  assert.match(sql, /where provider = p_provider and provider_event_id = p_provider_event_id for update/);
  assert.match(sql, /p_error_code not in \('billing_storage_unavailable', 'billing_serialization_retry', 'billing_database_timeout', 'billing_connection_unavailable'\)/);
  assert.match(sql, /grant execute on function public\.billing_mark_webhook_retryable\(text, text, text\) to service_role/);
  assert.match(sql, /revoke all on function public\.billing_prepare_webhook_settlement\(text, text\) from public, anon, authenticated/);
  assert.match(sql, /create or replace function public\.billing_validate_webhook_event_update\(\)/);
  assert.match(sql, /old\.status = 'received' and new\.status in \('processing', 'retryable', 'failed'\)/);
  assert.match(sql, /old\.status = 'retryable' and new\.status in \('received', 'failed'\)/);
  assert.match(sql, /new\.retry_count[\s\S]*old\.retry_count/);
  assert.match(sql, /new\.retry_after is distinct from old\.retry_after/);
  assert.match(sql, /old\.status = 'received'[\s\S]*new\.status = 'retryable'[\s\S]*new\.retry_after is not null[\s\S]*new\.retry_count = old\.retry_count \+ 1/);
  assert.match(sql, /old\.status = 'retryable'[\s\S]*new\.status in \('received', 'failed'\)[\s\S]*new\.retry_after is null/);
  assert.match(sql, /new\.provider_event_id[\s\S]*old\.provider_event_id/);
});

test("014 persists owned Native intent expectations and atomically binds only verified transaction IDs", () => {
  const sql = compactSql(
    "supabase/migrations/202608210014_wechat_native_payment_intents.sql",
  );

  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;$/);
  assert.match(sql, /add column merchant_order_number text/);
  assert.match(
    sql,
    /update public\.billing_payment_intents as intent set merchant_order_number = billing_order\.order_number from public\.billing_orders as billing_order where billing_order\.id = intent\.order_id and intent\.merchant_order_number is null/,
  );
  assert.match(
    sql,
    /update public\.billing_payment_intents set provider_transaction_id = null where provider = 'wechat' and provider_transaction_id = merchant_order_number/,
  );
  assert.match(sql, /unique \(provider, merchant_order_number\)/);
  assert.match(sql, /payment_status = 'pending'[\s\S]*provider_transaction_id is null[\s\S]*payment_token is not null/);
  assert.match(sql, /payment_status = 'paid'[\s\S]*provider_transaction_id is not null[\s\S]*paid_at is not null/);

  assert.match(
    sql,
    /create function public\.billing_claim_payment_intent\( p_user_id uuid, p_order_id uuid, p_provider text, p_merchant_order_number text, p_request_idempotency_key text, p_claim_token uuid \)/,
  );
  assert.match(
    sql,
    /merchant_order_number = case when last_error_code = 'payment_requires_new_payment' then p_merchant_order_number else v_intent\.merchant_order_number end/,
  );
  assert.match(
    sql,
    /request_idempotency_key = case when last_error_code = 'payment_requires_new_payment' then p_request_idempotency_key else v_intent\.request_idempotency_key end/,
  );
  assert.match(sql, /'merchant_order_number', v_intent\.merchant_order_number/);
  assert.match(sql, /'request_idempotency_key', v_intent\.request_idempotency_key/);

  assert.match(
    sql,
    /create function public\.billing_complete_payment_intent\( p_intent_id uuid, p_claim_token uuid, p_merchant_order_number text, p_provider_transaction_id text, p_payment_token text/,
  );
  assert.match(sql, /v_intent\.merchant_order_number is distinct from p_merchant_order_number/);
  assert.match(sql, /p_payment_status = 'pending'[\s\S]*p_payment_token is not null[\s\S]*p_paid_at is null/);
  assert.match(sql, /v_intent\.provider = 'wechat'[\s\S]*p_payment_status = 'pending'[\s\S]*p_provider_transaction_id is not null/);
  assert.match(sql, /p_payment_status = 'paid'[\s\S]*p_provider_transaction_id is not null[\s\S]*p_paid_at is not null/);

  const intentLock = sql.indexOf(
    "from public.billing_payment_intents where provider = upper(p_provider) and merchant_order_number = p_order_number for update",
  );
  const orderLock = sql.indexOf(
    "from public.billing_orders where id = v_intent.order_id for update",
  );
  assert.ok(intentLock >= 0, "settlement must lock the merchant-reference intent");
  assert.ok(orderLock > intentLock, "settlement must resolve its owned order through the locked intent");
  assert.match(
    sql,
    /v_intent\.provider_transaction_id is not null and v_intent\.provider_transaction_id is distinct from p_provider_transaction_id/,
  );
  assert.match(
    sql,
    /update public\.billing_payment_intents set provider_transaction_id = p_provider_transaction_id,[\s\S]*payment_status = 'paid'/,
  );
  assert.doesNotMatch(
    sql,
    /from public\.billing_orders where order_number = p_order_number for update/,
  );

  for (const signature of [
    "public.billing_claim_payment_intent(uuid, uuid, text, text, text, uuid)",
    "public.billing_complete_payment_intent(uuid, uuid, text, text, text, text, timestamptz, timestamptz)",
    "public.billing_settle_paid_order(text, text, text, text, text, bigint, text, timestamptz, jsonb)",
  ]) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flexible = escaped
      .replaceAll(" ", "\\s*")
      .replace("\\(", "\\(\\s*")
      .replace("\\)", "\\s*\\)");
    assert.match(sql, new RegExp(`revoke all on function ${flexible} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function ${flexible} to service_role`));
  }
  assert.equal((sql.match(/security definer set search_path = pg_catalog, public/g) ?? []).length >= 4, true);
});

const sqlFunction = (name: string, path = functionsPath) => {
  const sql = compactSql(path);
  const block = sql.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`,
    ),
  );
  assert.ok(block, `expected SQL function block: ${name}`);
  return block[0];
};

const sqlFunctionBody = (name: string, path = functionsPath) => {
  const fn = sqlFunction(name, path);
  const body = fn.match(/\bas\s+\$\$([\s\S]*?)\$\$;/);
  assert.ok(body, `expected SQL function body: ${name}`);
  return body[1];
};

const approvedFastLaunchFeatures = [
  "bibtex_export",
  "chat",
  "concept_explore",
  "data_clean",
  "extract_refs",
  "keyword_gen",
  "latex_export",
  "literature_review",
  "polish",
  "ppt_generate",
  "profile_summarize",
  "summarize",
  "translate",
] as const;

const assertApprovedFastLaunchFeatures = (body: string) => {
  const declaration = body.match(
    /\bv_approved_features\s+text\[\]\s*:=\s*array\s*\[([\s\S]*?)\]\s*;/,
  );
  assert.ok(declaration, "expected v_approved_features ARRAY literal");
  const stringLiteral = /'((?:''|[^'])*)'/g;
  const features = [...declaration[1].matchAll(stringLiteral)].map((match) =>
    match[1].replace(/''/g, "'"),
  );
  const nonLiteralContent = declaration[1]
    .replace(stringLiteral, "")
    .replace(/[\s,]/g, "");
  assert.equal(
    nonLiteralContent,
    "",
    "approved fast-launch features must be a string-literal-only ARRAY",
  );
  assert.deepEqual(
    features.sort(),
    [...approvedFastLaunchFeatures].sort(),
    "approved fast-launch feature ARRAY must contain exactly the 13 approved keys",
  );
};

const catalogTables = [
  "billing_plan_entitlements",
  "billing_plans",
  "billing_products",
] as const;

type IdentityTable = "billing_plans" | "billing_products";

const targetRowLockPattern = (table: IdentityTable) => {
  const idParameter = table === "billing_plans" ? "p_plan_id" : "p_product_id";
  return new RegExp(
    `\\bselect\\b[^;]*\\bfrom\\s+public\\.${table}\\b[^;]*\\bwhere\\b[^;]*(?:[a-z_][a-z0-9_]*\\.)?id\\s*=\\s*${idParameter}\\b[^;]*\\bfor\\s+update\\b[^;]*;`,
  );
};

const removeTargetRowLock = (body: string, table: IdentityTable) =>
  body.replace(targetRowLockPattern(table), (statement) =>
    statement.replace(/\s+for\s+update\b/, ""),
  );

const moveTargetRowLockAfterGuard = (
  body: string,
  table: IdentityTable,
  guard: "plan_identity_mutation" | "product_identity_mutation",
) => {
  const targetLock = body.match(targetRowLockPattern(table));
  assert.ok(targetLock, `expected target ${table} row-lock mutation fixture`);
  const targetLockIndex = targetLock.index ?? -1;
  assert.ok(targetLockIndex >= 0, `expected target ${table} row-lock position`);
  const withoutTargetLock =
    body.slice(0, targetLockIndex) +
    body.slice(targetLockIndex + targetLock[0].length);
  const guardIndex = withoutTargetLock.indexOf(`'${guard}'`);
  assert.ok(guardIndex >= 0, `expected ${guard} mutation fixture`);
  const guardEnd = withoutTargetLock.indexOf(";", guardIndex);
  assert.ok(guardEnd >= 0, `expected ${guard} statement terminator`);
  return (
    withoutTargetLock.slice(0, guardEnd + 1) +
    targetLock[0] +
    withoutTargetLock.slice(guardEnd + 1)
  );
};

const assertCatalogLockPrecedesAccess = (body: string) => {
  const locks = [
    ...body.matchAll(
      /\block\s+table\s+([\s\S]*?)\s+in\s+share\s+row\s+exclusive\s+mode\s*;/g,
    ),
  ];
  assert.equal(locks.length, 1, "expected one fast-launch catalog table lock");
  const lockedTables = locks[0][1]
    .split(",")
    .map((table) => table.trim().replace(/^public\./, ""))
    .sort();
  assert.deepEqual(
    lockedTables,
    [...catalogTables].sort(),
    "catalog lock must cover exactly the three catalog tables",
  );

  const lockEnd = locks[0].index + locks[0][0].length;
  const catalogAccess = new RegExp(
    `\\b(?:from|join|insert\\s+into|update|delete\\s+from)\\s+public\\.(${catalogTables.join("|")})\\b`,
    "g",
  );
  for (const access of body.matchAll(catalogAccess)) {
    assert.ok(
      access.index >= lockEnd,
      `${access[0]} must follow the catalog table lock`,
    );
  }
};

const assertIdentityRowLockPrecedesGuard = (
  body: string,
  table: IdentityTable,
  guard: "plan_identity_mutation" | "product_identity_mutation",
) => {
  const identity = table === "billing_plans" ? "code" : "sku";
  const targetLock = body.match(targetRowLockPattern(table));
  assert.ok(targetLock, `expected target ${table} row lock`);
  const identityGuard = body.match(
    new RegExp(
      `\\bif\\s+v_before\\s+is\\s+not\\s+null\\s+and\\s+v_before\\s*->>\\s*'${identity}'\\s+is\\s+distinct\\s+from\\s+btrim\\(p_${identity}\\)\\s+then\\s+raise\\s+exception\\s+'${guard}'`,
    ),
  );
  assert.ok(identityGuard, `expected ${identity} identity guard`);
  const targetLockIndex = targetLock.index ?? -1;
  const identityGuardIndex = identityGuard.index ?? -1;
  assert.ok(targetLockIndex >= 0, `expected target ${table} row-lock position`);
  assert.ok(identityGuardIndex >= 0, `expected ${identity} identity-guard position`);
  assert.ok(
    targetLockIndex + targetLock[0].length <= identityGuardIndex,
    `target ${table} row lock must precede the ${identity} identity guard`,
  );
};

const sqlTable = (name: string) => {
  const sql = compactSql(schemaPath);
  const block = sql.match(
    new RegExp(`create table public\\.${name} \\([\\s\\S]*?\\);`),
  );
  assert.ok(block, `expected SQL table block: ${name}`);
  return block[0];
};

const sqlPolicy = (name: string) => {
  const sql = compactSql(rlsPath);
  const block = sql.match(
    new RegExp(
      `create policy ${name} on public\\.[a-z0-9_]+[\\s\\S]*?;`,
    ),
  );
  assert.ok(block, `expected SQL policy block: ${name}`);
  return block[0];
};

const schemaPath = "supabase/migrations/202607210001_billing_schema.sql";
const rlsPath = "supabase/migrations/202607210002_billing_rls.sql";
const functionsPath =
  "supabase/migrations/202607210003_billing_functions.sql";
const afterSalesPath =
  "supabase/migrations/202607230004_billing_after_sales.sql";
const catalogSeedPath =
  "supabase/migrations/202608050010_billing_catalog_seed.sql";

const tables = [
  "billing_plans",
  "billing_products",
  "billing_plan_entitlements",
  "billing_orders",
  "billing_payment_intents",
  "billing_payments",
  "billing_subscriptions",
  "billing_user_entitlements",
  "billing_usage_quotas",
  "billing_usage_records",
  "billing_usage_continuations",
  "billing_credit_accounts",
  "billing_credit_ledger",
  "billing_webhook_events",
  "billing_refund_requests",
  "billing_refunds",
  "billing_invoice_requests",
  "billing_admins",
  "billing_admin_audit_logs",
  "billing_rate_limits",
] as const;

const rpcNames = [
  "billing_claim_payment_intent",
  "billing_complete_payment_intent",
  "billing_fail_payment_intent",
  "billing_claim_mock_payment_confirmation",
  "billing_settle_paid_order",
  "billing_reserve_usage",
  "billing_finalize_usage",
  "billing_release_usage",
  "billing_provision_usage_continuations",
  "billing_claim_usage_continuation",
  "billing_complete_usage_continuation",
  "billing_release_usage_continuation",
  "billing_adjust_credit",
  "billing_consume_order_rate_limit",
] as const;

test("schema migration creates every billing table with UUID and timestamp conventions", () => {
  const sql = compactSql(schemaPath);

  for (const table of tables) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`));
  }

  assert.match(sql, /id uuid primary key default extensions\.gen_random_uuid\(\)/);
  assert.match(sql, /user_id uuid not null references auth\.users\(id\)/);
  assert.match(sql, /created_at timestamptz not null default now\(\)/);
  assert.match(sql, /updated_at timestamptz not null default now\(\)/);
});

test("all monetary values are constrained BIGINT integer minor units", () => {
  const sql = compactSql(schemaPath);

  assert.match(sql, /price_minor bigint not null check \(price_minor >= 0\)/);
  assert.match(
    sql,
    /amount_minor bigint not null check \(amount_minor >= 0\)/,
  );
  assert.match(
    sql,
    /requested_amount_minor bigint not null check \(requested_amount_minor > 0\)/,
  );
  assert.match(
    sql,
    /refunded_amount_minor bigint not null check \(refunded_amount_minor > 0\)/,
  );
  assert.doesNotMatch(sql, /\b(?:money|decimal|numeric)\b/);
});

test("order and refund status constraints include every lifecycle state", () => {
  const sql = compactSql(schemaPath);

  for (const status of [
    "PENDING",
    "PAID",
    "FAILED",
    "CANCELLED",
    "CLOSED",
    "REFUNDING",
    "REFUNDED",
  ]) {
    assert.match(sql, new RegExp(`'${status.toLowerCase()}'`));
  }

  for (const status of ["APPROVED", "REJECTED", "SUCCEEDED"]) {
    assert.match(sql, new RegExp(`'${status.toLowerCase()}'`));
  }
});

test("orders, provider transactions, webhook events, and ledger operations are unique", () => {
  const sql = compactSql(schemaPath);

  assert.match(sql, /order_number text not null unique/);
  assert.match(sql, /unique \(provider, provider_transaction_id\)/);
  assert.match(sql, /request_idempotency_key text not null unique/);
  assert.match(sql, /unique \(provider, provider_event_id\)/);
  assert.match(sql, /idempotency_key text not null unique/);
  assert.match(sql, /task_idempotency_key text not null unique/);
});

test("payment intents durably claim, complete, fail, and reuse one provider creation", () => {
  const intent = sqlTable("billing_payment_intents");
  const claim = sqlFunction("billing_claim_payment_intent");
  const complete = sqlFunction("billing_complete_payment_intent");
  const fail = sqlFunction("billing_fail_payment_intent");
  const confirm = sqlFunction("billing_claim_mock_payment_confirmation");
  const settle = sqlFunction("billing_settle_paid_order");
  const rls = compactSql(rlsPath);
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(intent, /order_id uuid not null unique/);
  assert.match(intent, /request_idempotency_key text not null unique/);
  assert.match(intent, /status text not null default 'creating'/);
  assert.match(intent, /status in \('creating', 'created', 'failed'\)/);
  assert.match(intent, /claim_token uuid/);
  assert.match(intent, /claim_expires_at timestamptz/);
  assert.match(intent, /provider_transaction_id text/);
  assert.match(intent, /payment_token text/);
  assert.match(intent, /payment_status text/);
  assert.match(intent, /amount_minor bigint not null/);
  assert.match(intent, /expires_at timestamptz not null/);

  assert.match(claim, /from public\.billing_orders[\s\S]*?for update/);
  assert.match(claim, /insert into public\.billing_payment_intents/);
  assert.match(claim, /on conflict do nothing/);
  assert.match(claim, /from public\.billing_payment_intents[\s\S]*?for update/);
  assert.match(claim, /status = 'created'/);
  assert.match(claim, /v_now timestamptz/);
  assert.equal(
    (claim.match(/v_now := clock_timestamp\(\)/g) ?? []).length,
    2,
  );
  assert.match(claim, /status = 'creating'[\s\S]*?claim_expires_at > v_now/);
  assert.doesNotMatch(claim, /\bp_now\b/);
  assert.match(claim, /status in \('failed', 'creating'\)/);
  assert.match(claim, /'status', 'claimed'/);
  assert.match(claim, /'status', 'reuse'/);
  assert.match(claim, /'status', 'in_progress'/);

  assert.match(complete, /from public\.billing_payment_intents[\s\S]*?for update/);
  assert.match(complete, /claim_token is distinct from p_claim_token/);
  assert.match(complete, /update public\.billing_payment_intents[\s\S]*?status = 'created'/);
  assert.match(complete, /provider_transaction_id = p_provider_transaction_id/);
  assert.match(complete, /payment_token = p_payment_token/);
  assert.match(complete, /payment_status = p_payment_status/);
  assert.match(
    complete,
    /expires_at is distinct from p_expires_at[\s\S]*?raise exception 'payment intent expiration mismatch'/,
  );
  const completeUpdate = complete.match(
    /update public\.billing_payment_intents[\s\S]*?where id = v_intent\.id/,
  );
  assert.ok(completeUpdate);
  assert.doesNotMatch(completeUpdate[0], /expires_at = p_expires_at/);
  assert.match(fail, /status = 'creating'[\s\S]*?claim_token is not distinct from p_claim_token/);
  assert.match(fail, /set status = 'failed'/);

  assert.match(confirm, /from public\.billing_payment_intents[\s\S]*?for update/);
  assert.match(confirm, /provider is distinct from 'mock'/);
  assert.match(confirm, /provider_transaction_id is distinct from p_provider_transaction_id/);
  assert.match(confirm, /set payment_status = 'paid'[\s\S]*?paid_at = p_paid_at/);

  assert.match(settle, /from public\.billing_payment_intents[\s\S]*?for update/);
  assert.match(settle, /request_idempotency_key is distinct from p_request_idempotency_key/);
  assert.match(settle, /update public\.billing_payment_intents[\s\S]*?payment_status = 'paid'/);

  assert.match(rls, /alter table public\.billing_payment_intents enable row level security/);
  assert.match(rls, /revoke all on table public\.billing_payment_intents from anon, authenticated/);
  const clientSelectGrants = rls.match(/grant select on table[^;]+to (?:anon, authenticated|authenticated);/g) ?? [];
  assert.ok(clientSelectGrants.length > 0);
  for (const grant of clientSelectGrants) {
    assert.doesNotMatch(grant, /public\.billing_payment_intents/);
  }
  assert.match(types, /BillingPaymentIntentRow = \{/);
  assert.match(types, /billing_payment_intents: \{/);
  assert.match(types, /billing_claim_payment_intent: \{/);
  assert.match(types, /billing_complete_payment_intent: \{/);
  assert.match(types, /billing_fail_payment_intent: \{/);
  assert.match(types, /billing_claim_mock_payment_confirmation: \{/);
  const claimType = types.match(
    /billing_claim_payment_intent: \{[\s\S]*?Returns: Json;/,
  );
  assert.ok(claimType);
  assert.doesNotMatch(claimType[0], /p_now/);
});

test("credit and quota balances cannot become negative and order snapshots are immutable", () => {
  const sql = compactSql(schemaPath);

  assert.match(
    sql,
    /available_balance bigint not null default 0 check \(available_balance >= 0\)/,
  );
  assert.match(
    sql,
    /reserved_balance bigint not null default 0 check \(reserved_balance >= 0\)/,
  );
  assert.match(
    sql,
    /reserved_units bigint not null default 0 check \(reserved_units >= 0\)/,
  );
  assert.match(sql, /used_units bigint not null default 0 check \(used_units >= 0\)/);
  assert.match(sql, /create trigger billing_orders_protect_snapshot/);
  assert.match(sql, /raise exception 'billing order snapshots are immutable'/);
});

test("credit ledger entries cannot be updated or deleted", () => {
  const sql = compactSql(schemaPath);

  assert.match(sql, /create trigger billing_credit_ledger_immutable/);
  assert.match(sql, /before update or delete on public\.billing_credit_ledger/);
  assert.match(sql, /raise exception 'billing credit ledger is immutable'/);
});

test("RLS is enabled for every billing table", () => {
  const sql = compactSql(rlsPath);

  for (const table of tables) {
    assert.match(
      sql,
      new RegExp(`alter table public\\.${table} enable row level security`),
    );
  }
});

test("catalog reads are enabled-only and authenticated users can only read their own data", () => {
  const sql = compactSql(rlsPath);

  assert.match(
    sqlPolicy("billing_plans_select_active"),
    /using \(is_active = true\)/,
  );
  assert.match(
    sqlPolicy("billing_products_select_active"),
    /using \(is_active = true\)/,
  );

  for (const table of [
    "billing_orders",
    "billing_payments",
    "billing_subscriptions",
    "billing_user_entitlements",
    "billing_usage_quotas",
    "billing_usage_records",
    "billing_credit_accounts",
    "billing_credit_ledger",
    "billing_refund_requests",
    "billing_refunds",
    "billing_invoice_requests",
  ]) {
    assert.match(sqlPolicy(`${table}_select_own`), /auth\.uid\(\) = user_id/);
  }

  for (const table of tables) {
    assert.match(
      sql,
      new RegExp(
        `revoke all on table public\\.${table} from anon, authenticated`,
      ),
    );
  }
  assert.doesNotMatch(
    sql,
    /grant (?:insert|update|delete|all)[^;]* to (?:anon, )?authenticated;/,
  );
});

test("every billing RPC is SECURITY DEFINER with a fixed search path", () => {
  for (const rpc of rpcNames) {
    const block = sqlFunction(rpc);
    assert.match(block, /security definer set search_path = pg_catalog, public/);
  }
});

test("billing RPC execution is revoked from clients and granted only to service_role", () => {
  const sql = compactSql(functionsPath);

  for (const rpc of rpcNames) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${rpc}\\(`),
    );
    assert.match(
      sql,
      new RegExp(
        `grant execute on function public\\.${rpc}\\([\\s\\S]*? to service_role`,
      ),
    );
  }

  assert.doesNotMatch(sql, /grant execute[\s\S]*? to (?:public|anon|authenticated)/);
});

test("paid-order settlement locks and validates the complete payment contract", () => {
  const sql = sqlFunction("billing_settle_paid_order");

  assert.match(sql, /from public\.billing_orders[\s\S]*?for update/);
  assert.match(sql, /v_order\.order_number is distinct from p_order_number/);
  assert.match(sql, /v_order\.amount_minor is distinct from p_amount_minor/);
  assert.match(sql, /v_order\.currency is distinct from upper\(p_currency\)/);
  assert.match(sql, /v_order\.status is distinct from 'pending'/);
  assert.match(sql, /v_order\.expires_at <= p_paid_at/);
  assert.match(sql, /insert into public\.billing_payments/);
  assert.match(sql, /insert into public\.billing_subscriptions/);
  assert.match(sql, /insert into public\.billing_user_entitlements/);
  assert.match(sql, /update public\.billing_credit_accounts/);
  assert.match(sql, /update public\.billing_orders set status = 'paid'/);
});

test("an idempotent webhook replay still rejects a mismatched payment payload", () => {
  const sql = sqlFunction("billing_settle_paid_order");

  assert.match(
    sql,
    /v_existing_event\.order_number is distinct from p_order_number/,
  );
  assert.match(
    sql,
    /from public\.billing_payments[\s\S]*?provider_transaction_id is not distinct from p_provider_transaction_id/,
  );
  assert.match(sql, /raise exception 'webhook replay payload mismatch'/);
});

test("failed webhook replay rejects null amount and currency before any idempotent return", () => {
  const settle = sqlFunction("billing_settle_paid_order");
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(
    settle,
    /p_amount_minor is null[\s\S]*?p_currency is null[\s\S]*?p_paid_at is null/,
  );

  const nullGuard = settle.indexOf("p_amount_minor is null");
  const failedReplay = settle.indexOf("v_existing_event.status = 'failed'");
  assert.notEqual(nullGuard, -1);
  assert.notEqual(failedReplay, -1);
  assert.ok(nullGuard < failedReplay);

  for (const comparison of [
    "v_existing_event.provider_transaction_id is distinct from p_provider_transaction_id",
    "v_existing_event.request_idempotency_key is distinct from p_request_idempotency_key",
    "v_existing_event.amount_minor is distinct from p_amount_minor",
    "v_existing_event.currency is distinct from upper(p_currency)",
    "v_existing_event.paid_at is distinct from p_paid_at",
  ]) {
    assert.match(settle, new RegExp(comparison.replace(/[().]/g, "\\$&")));
  }

  assert.doesNotMatch(settle, /p_payload_summary/);
  assert.doesNotMatch(types, /p_payload_summary/);
});

test("settlement consumes a pre-persisted webhook event and preserves failure auditability", () => {
  const event = sqlTable("billing_webhook_events");
  const settle = sqlFunction("billing_settle_paid_order");
  const transition = sqlFunction(
    "billing_validate_webhook_event_update",
    schemaPath,
  );
  const guide = projectFile("docs/billing-database.md").toLowerCase();

  assert.match(event, /status text not null default 'received'/);
  assert.match(event, /error_code text/);
  assert.doesNotMatch(settle, /insert into public\.billing_webhook_events/);
  assert.match(settle, /raise exception 'webhook event must be persisted before settlement'/);
  assert.match(settle, /v_existing_event\.signature_valid is not true/);
  assert.match(settle, /v_existing_event\.status = 'received'/);
  assert.match(
    settle,
    /update public\.billing_webhook_events set status = 'processing'/,
  );
  assert.match(
    event,
    /status <> 'failed' or nullif\(btrim\(error_code\), ''\) is not null/,
  );
  assert.match(
    transition,
    /old\.status = 'received' and new\.status in \('processing', 'failed'\)/,
  );
  assert.match(
    transition,
    /old\.status = 'processing' and new\.status in \('processed', 'failed'\)/,
  );
  assert.match(transition, /new\.provider_event_id[\s\S]*?old\.provider_event_id/);
  assert.match(
    compactSql(schemaPath),
    /before update on public\.billing_webhook_events[\s\S]*?billing_validate_webhook_event_update/,
  );
  assert.match(guide, /where status = [`']received[`']/);
  assert.match(guide, /rejected:<sha256\(raw_body\)>/);
  assert.match(guide, /payload_hash/);
});

test("rejected webhooks keep only a payload hash while payable events stay complete", () => {
  const event = sqlTable("billing_webhook_events");
  const types = projectFile("lib/billing/database.types.ts");

  for (const nullableBusinessField of [
    "order_number text",
    "provider_transaction_id text",
    "request_idempotency_key text",
    "amount_minor bigint",
    "currency text",
    "paid_at timestamptz",
  ]) {
    assert.match(event, new RegExp(nullableBusinessField));
    assert.doesNotMatch(event, new RegExp(`${nullableBusinessField} not null`));
  }

  assert.match(
    event,
    /status in \('received', 'processing', 'processed'\)[\s\S]*?signature_valid is true[\s\S]*?order_number is not null[\s\S]*?provider_transaction_id is not null[\s\S]*?request_idempotency_key is not null[\s\S]*?amount_minor is not null[\s\S]*?currency is not null[\s\S]*?paid_at is not null/,
  );
  assert.match(
    event,
    /status = 'failed'[\s\S]*?order_number is null[\s\S]*?provider_transaction_id is null[\s\S]*?request_idempotency_key is null[\s\S]*?amount_minor is null[\s\S]*?currency is null[\s\S]*?paid_at is null/,
  );
  assert.match(types, /order_number: string \| null/);
  assert.match(types, /provider_transaction_id: string \| null/);
  assert.match(types, /request_idempotency_key: string \| null/);
  assert.match(types, /amount_minor: number \| null/);
  assert.match(types, /currency: "CNY" \| null/);
  assert.match(types, /paid_at: Timestamp \| null/);
});

test("settlement grants the immutable entitlement snapshot stored on the order", () => {
  const order = sqlTable("billing_orders");
  const settle = sqlFunction("billing_settle_paid_order");

  assert.match(order, /snapshot_entitlements jsonb not null check/);
  assert.match(order, /jsonb_typeof\(snapshot_entitlements\) = 'array'/);
  assert.match(
    compactSql(schemaPath),
    /new\.snapshot_entitlements[\s\S]*?old\.snapshot_entitlements/,
  );
  assert.match(settle, /jsonb_array_elements\(v_order\.snapshot_entitlements\)/);
  assert.doesNotMatch(settle, /from public\.billing_plan_entitlements/);
});

test("subscription settlement atomically provisions quota periods from immutable snapshots", () => {
  const quota = sqlTable("billing_usage_quotas");
  const settle = sqlFunction("billing_settle_paid_order");
  const reserve = sqlFunction("billing_reserve_usage");
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(
    quota,
    /subscription_id uuid references public\.billing_subscriptions\(id\) on delete restrict/,
  );
  assert.match(quota, /unique \(subscription_id, feature_key\)/);
  assert.match(
    settle,
    /insert into public\.billing_subscriptions[\s\S]*?returning \* into v_subscription/,
  );

  const quotaInsert = settle.match(
    /insert into public\.billing_usage_quotas \([\s\S]*?on conflict \(subscription_id, feature_key\) do nothing/,
  );
  assert.ok(quotaInsert);
  assert.match(quotaInsert[0], /v_subscription\.id/);
  assert.match(quotaInsert[0], /entitlement\.value ->> 'feature_key'/);
  assert.match(quotaInsert[0], /v_subscription\.starts_at/);
  assert.match(quotaInsert[0], /v_subscription\.ends_at/);
  assert.match(
    quotaInsert[0],
    /\(entitlement\.value ->> 'periodic_limit'\)::bigint/,
  );
  assert.match(
    quotaInsert[0],
    /from jsonb_array_elements\(v_order\.snapshot_entitlements\)/,
  );
  assert.doesNotMatch(quotaInsert[0], /billing_plan_entitlements/);
  assert.doesNotMatch(quotaInsert[0], /update public\.billing_usage_quotas/);

  const subscriptionBranch = settle.indexOf(
    "if v_order.snapshot_product_type = 'subscription'",
  );
  const quotaProvisioning = settle.indexOf(
    "insert into public.billing_usage_quotas",
  );
  const creditPackBranch = settle.indexOf(
    "else v_credit_grant := v_order.snapshot_credit_grant",
  );
  assert.ok(subscriptionBranch < quotaProvisioning);
  assert.ok(quotaProvisioning < creditPackBranch);

  assert.match(
    reserve,
    /from public\.billing_usage_quotas[\s\S]*?period_start <= now\(\)[\s\S]*?period_end > now\(\)/,
  );
  assert.match(types, /subscription_id: UUID \| null;/);
  assert.match(
    types,
    /snapshot_entitlements: BillingOrderEntitlementSnapshot\[\];/,
  );
  assert.match(
    types,
    /periodic_limit: number \| null;/,
  );
});

test("settlement rejects malformed periodic quota snapshots before provisioning", () => {
  const settle = sqlFunction("billing_settle_paid_order");
  const validation = settle.match(
    /if v_order\.snapshot_product_type = 'subscription'[\s\S]*?raise exception 'invalid subscription entitlement snapshot'[\s\S]*?end if/,
  );

  assert.ok(validation);
  assert.match(validation[0], /jsonb_array_elements\(v_order\.snapshot_entitlements\)/);
  assert.match(validation[0], /not \(entitlement\.value \? 'periodic_limit'\)/);
  assert.match(
    validation[0],
    /jsonb_typeof\(entitlement\.value -> 'periodic_limit'\) <> 'number'/,
  );
  assert.match(validation[0], /using errcode = 'data_exception'/);
});

test("settlement credit ledger idempotency includes the provider namespace", () => {
  const settle = sqlFunction("billing_settle_paid_order");

  assert.match(
    settle,
    /'settlement:' \|\| upper\(p_provider\) \|\| ':' \|\| p_provider_event_id \|\| ':credit'/,
  );
});

test("credit adjustment replay validates administrator and reason and returns its audit", () => {
  const ledger = sqlTable("billing_credit_ledger");
  const adjust = sqlFunction("billing_adjust_credit");

  assert.match(ledger, /audit_log_id uuid/);
  assert.match(
    adjust,
    /p_user_id is null[\s\S]*?p_amount is null[\s\S]*?p_admin_user_id is null[\s\S]*?p_currency is null/,
  );
  assert.match(adjust, /v_existing\.user_id is distinct from p_user_id/);
  assert.match(
    adjust,
    /v_existing\.delta_available is distinct from p_amount/,
  );
  assert.match(
    adjust,
    /v_existing\.reference_id is distinct from p_admin_user_id::text/,
  );
  assert.match(
    adjust,
    /v_existing\.metadata ->> 'reason' is distinct from btrim\(p_reason\)/,
  );
  assert.match(adjust, /v_existing\.reference_type is distinct from 'admin'/);
  assert.match(adjust, /'audit_id', v_existing\.audit_log_id/);

  const activeAdminCheck = adjust.indexOf(
    "from public.billing_admins where user_id = p_admin_user_id and is_active = true",
  );
  const replayLookup = adjust.indexOf(
    "from public.billing_credit_ledger where idempotency_key = p_idempotency_key",
  );
  assert.notEqual(activeAdminCheck, -1);
  assert.notEqual(replayLookup, -1);
  assert.ok(activeAdminCheck < replayLookup);
});

test("webhook replay validates request idempotency and paid timestamp", () => {
  const event = sqlTable("billing_webhook_events");
  const settle = sqlFunction("billing_settle_paid_order");

  assert.match(event, /request_idempotency_key text/);
  assert.match(event, /paid_at timestamptz/);
  assert.match(event, /request_idempotency_key is not null/);
  assert.match(event, /paid_at is not null/);
  assert.match(
    settle,
    /v_existing_event\.request_idempotency_key is distinct from p_request_idempotency_key/,
  );
  assert.match(
    settle,
    /v_existing_event\.paid_at is distinct from p_paid_at/,
  );
  assert.match(
    settle,
    /request_idempotency_key is not distinct from p_request_idempotency_key/,
  );
  assert.match(settle, /paid_at is not distinct from p_paid_at/);
});

test("usage RPCs reserve, finalize, and release atomically by one task key", () => {
  const sql = [
    sqlFunction("billing_reserve_usage"),
    sqlFunction("billing_finalize_usage"),
    sqlFunction("billing_release_usage"),
  ].join(" ");

  assert.match(sql, /task_idempotency_key = p_task_idempotency_key[\s\S]*?for update/);
  assert.match(
    sql,
    /available_balance = available_balance - p_credit_amount[\s\S]*?reserved_balance = reserved_balance \+ p_credit_amount/,
  );
  assert.match(sql, /available_balance >= p_credit_amount/);
  assert.match(
    sql,
    /reserved_units \+ used_units \+ p_quota_units <= quota_limit/,
  );
  assert.match(sql, /v_record\.status <> 'reserved'/);
  assert.match(sql, /set status = 'finalized'/);
  assert.match(sql, /set status = 'released'/);
  assert.match(sql, /insert into public\.billing_credit_ledger/);
});

test("usage continuations are finite, operation-bound, and payload-bound", () => {
  const continuation = sqlTable("billing_usage_continuations");
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(
    continuation,
    /root_usage_record_id uuid references public\.billing_usage_records\(id\) on delete restrict/,
  );
  assert.match(continuation, /root_task_idempotency_key text not null/);
  assert.match(continuation, /operation_key text not null/);
  assert.match(continuation, /stage_key text not null/);
  assert.match(continuation, /request_hash text/);
  assert.match(
    continuation,
    /status in \('available', 'claimed', 'completed'\)/,
  );
  assert.match(continuation, /claim_token uuid/);
  assert.match(continuation, /lease_expires_at timestamptz/);
  assert.match(
    continuation,
    /unique \(\s*user_id,\s*root_task_idempotency_key,\s*feature_key,\s*operation_key,\s*stage_key\s*\)/,
  );
  assert.match(
    types,
    /billing_usage_continuations: \{[\s\S]*?Row: BillingUsageContinuationRow;/,
  );
});

test("continuation RPCs atomically provision, claim, complete, and release finite stages", () => {
  const provision = sqlFunction("billing_provision_usage_continuations");
  const claim = sqlFunction("billing_claim_usage_continuation");
  const complete = sqlFunction("billing_complete_usage_continuation");
  const release = sqlFunction("billing_release_usage_continuation");
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(provision, /jsonb_array_length\(p_stages\) > 32/);
  assert.match(provision, /public\.billing_finalize_usage\(/);
  assert.match(provision, /insert into public\.billing_usage_continuations/);
  assert.match(provision, /stage ->> 'stage_key'/);
  assert.match(provision, /stage ->> 'request_hash'/);

  assert.match(claim, /from public\.billing_usage_continuations[\s\S]*?for update/);
  assert.match(claim, /operation_key = btrim\(p_operation_key\)/);
  assert.match(claim, /stage_key = btrim\(p_stage_key\)/);
  assert.match(claim, /request_hash is distinct from lower\(p_request_hash\)/);
  assert.match(claim, /raise exception 'continuation request payload mismatch'/);
  assert.match(claim, /v_continuation\.status = 'completed'/);
  assert.match(claim, /v_continuation\.lease_expires_at > now\(\)/);
  assert.match(claim, /set status = 'claimed'/);
  assert.match(claim, /claim_token = extensions\.gen_random_uuid\(\)/);

  assert.match(complete, /from public\.billing_usage_continuations[\s\S]*?for update/);
  assert.match(complete, /claim_token is distinct from p_claim_token/);
  assert.match(complete, /set status = 'completed'/);

  assert.match(release, /from public\.billing_usage_continuations[\s\S]*?for update/);
  assert.match(release, /claim_token is distinct from p_claim_token/);
  assert.match(release, /set status = 'available'/);
  assert.match(release, /request_hash = v_continuation\.request_hash/);

  assert.match(
    types,
    /billing_provision_usage_continuations: \{[\s\S]*?p_stages: Json;[\s\S]*?p_finalize_usage\?: boolean;/,
  );
  assert.match(
    types,
    /billing_claim_usage_continuation: \{[\s\S]*?p_operation_key: string;[\s\S]*?p_stage_key: string;[\s\S]*?p_request_hash: string;/,
  );
});

test("credit adjustment rejects negative outcomes and is idempotent", () => {
  const sql = sqlFunction("billing_adjust_credit");

  assert.match(sql, /available_balance \+ p_amount >= 0/);
  assert.match(sql, /idempotency_key = p_idempotency_key/);
  assert.match(sql, /nullif\(btrim\(p_reason\), ''\) is null/);
  assert.match(sql, /insert into public\.billing_admin_audit_logs/);
});

test("order rate-limit consumption is an atomic service-role-only RPC", () => {
  const rateLimit = sqlFunction("billing_consume_order_rate_limit");
  const types = projectFile("lib/billing/database.types.ts");
  const guide = projectFile("docs/billing-database.md").toLowerCase();

  assert.match(rateLimit, /pg_advisory_xact_lock/);
  assert.match(rateLimit, /delete from public\.billing_rate_limits/);
  assert.match(rateLimit, /select coalesce\(sum\(request_count\), 0\)/);
  assert.match(rateLimit, /insert into public\.billing_rate_limits/);
  assert.match(rateLimit, /on conflict \(user_id, action, window_started_at\) do update/);
  assert.match(rateLimit, /'allowed', false/);
  assert.match(rateLimit, /'allowed', true/);
  assert.match(types, /billing_consume_order_rate_limit: \{[\s\S]*?p_user_id: UUID;[\s\S]*?p_now: Timestamp;[\s\S]*?p_window_seconds\?: number;[\s\S]*?p_limit\?: number;/);
  assert.match(guide, /billing_consume_order_rate_limit/);
});

test("database types expose every table and RPC without any placeholders", () => {
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(types, /export type Json\s*=/);
  assert.match(types, /export type Database\s*=/);
  for (const table of tables) {
    assert.match(types, new RegExp(`\\b${table}: \\{`));
  }
  for (const rpc of rpcNames) {
    assert.match(types, new RegExp(`\\b${rpc}: \\{`));
  }
  assert.doesNotMatch(types, /\b(?:any|todo|unknown)\b/i);
});

test("database types expose public relationships and no ledger update operation", () => {
  const types = projectFile("lib/billing/database.types.ts");
  const product = types.match(
    /billing_products: \{[\s\S]*?\n      \};/,
  );
  const ledger = types.match(
    /billing_credit_ledger: \{[\s\S]*?\n      \};/,
  );

  assert.ok(product);
  assert.ok(ledger);
  assert.match(
    product[0],
    /foreignKeyName: "billing_products_plan_id_fkey"/,
  );
  assert.match(ledger[0], /Update: never;/);
  assert.match(
    ledger[0],
    /foreignKeyName: "billing_credit_ledger_audit_log_id_fkey"/,
  );
});

test("database types include the hardened order, webhook, and audit columns", () => {
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(
    types,
    /snapshot_entitlements: BillingOrderEntitlementSnapshot\[\];/,
  );
  assert.match(
    types,
    /billing_orders: \{[\s\S]*?Insert: Insert<[\s\S]*?\| "snapshot_entitlements"/,
  );
  assert.match(types, /audit_log_id: UUID \| null;/);
  assert.match(types, /provider_transaction_id: string;/);
  assert.match(types, /request_idempotency_key: string;/);
  assert.match(types, /amount_minor: number;/);
  assert.match(types, /paid_at: Timestamp;/);
  assert.match(
    types,
    /billing_webhook_events: \{[\s\S]*?Insert: Insert<[\s\S]*?"provider" \| "provider_event_id"/,
  );
  assert.match(
    types,
    /BillingWebhookEventRow = \{[\s\S]*?provider_transaction_id: string \| null;[\s\S]*?request_idempotency_key: string \| null;[\s\S]*?amount_minor: number \| null;[\s\S]*?paid_at: Timestamp \| null;/,
  );
});

test("database guide only documents local or isolated test database execution", () => {
  const guide = projectFile("docs/billing-database.md");

  assert.match(guide, /supabase db reset/);
  assert.match(guide, /supabase migration up --local/);
  assert.match(guide, /独立测试数据库/);
  assert.match(guide, /禁止.*线上数据库/);
  assert.doesNotMatch(guide, /(?:project-ref|db[_ -]?password|postgres(?:ql)?:\/\/)/i);
});

test("catalog seed safely adds the semester period and provisions only inactive configured products", () => {
  const seed = compactSql(catalogSeedPath);

  assert.match(
    seed,
    /alter table public\.billing_plans drop constraint if exists billing_plans_billing_period_check/,
  );
  assert.match(
    seed,
    /add constraint billing_plans_billing_period_check check \(billing_period in \('free', 'monthly', 'yearly', 'semester'\)\)/,
  );

  for (const [code, name, billingPeriod] of [
    ["FREE", "Free", "FREE"],
    ["PRO", "Pro", "MONTHLY"],
    ["PRO_SEMESTER", "Pro Semester", "SEMESTER"],
  ]) {
    assert.match(
      seed,
      new RegExp(
        `\\('${code.toLowerCase()}', '${name.toLowerCase()}', '${billingPeriod.toLowerCase()}', false\\)`,
      ),
    );
  }

  for (const [planCode, featureKey, version, periodicLimit] of [
    ["FREE", "summarize", "free-v1", 5],
    ["FREE", "chat", "free-v1", 30],
    ["FREE", "translate", "free-v1", 3],
    ["FREE", "ppt_generate", "free-v1", 3],
    ["FREE", "concept_explore", "free-v1", 10],
    ["FREE", "keyword_gen", "free-v1", 20],
    ["FREE", "bibtex_export", "free-v1", 30],
    ["FREE", "extract_refs", "free-v1", 10],
    ["FREE", "profile_summarize", "free-v1", 5],
    ["FREE", "literature_review", "free-v1", 3],
    ["FREE", "latex_export", "free-v1", 5],
    ["FREE", "data_clean", "free-v1", 10],
    ["FREE", "polish", "free-v1", 10],
    ["PRO", "summarize", "pro-v1", 100],
    ["PRO", "chat", "pro-v1", 1000],
    ["PRO", "translate", "pro-v1", 30],
    ["PRO", "ppt_generate", "pro-v1", 30],
    ["PRO", "concept_explore", "pro-v1", 100],
    ["PRO", "keyword_gen", "pro-v1", 200],
    ["PRO", "bibtex_export", "pro-v1", 1000],
    ["PRO", "extract_refs", "pro-v1", 100],
    ["PRO", "profile_summarize", "pro-v1", 100],
    ["PRO", "literature_review", "pro-v1", 30],
    ["PRO", "latex_export", "pro-v1", 100],
    ["PRO", "data_clean", "pro-v1", 100],
    ["PRO", "polish", "pro-v1", 100],
    ["PRO_SEMESTER", "summarize", "pro-semester-v1", 500],
    ["PRO_SEMESTER", "chat", "pro-semester-v1", 5000],
    ["PRO_SEMESTER", "translate", "pro-semester-v1", 150],
    ["PRO_SEMESTER", "ppt_generate", "pro-semester-v1", 150],
    ["PRO_SEMESTER", "concept_explore", "pro-semester-v1", 500],
    ["PRO_SEMESTER", "keyword_gen", "pro-semester-v1", 1000],
    ["PRO_SEMESTER", "bibtex_export", "pro-semester-v1", 5000],
    ["PRO_SEMESTER", "extract_refs", "pro-semester-v1", 500],
    ["PRO_SEMESTER", "profile_summarize", "pro-semester-v1", 500],
    ["PRO_SEMESTER", "literature_review", "pro-semester-v1", 150],
    ["PRO_SEMESTER", "latex_export", "pro-semester-v1", 500],
    ["PRO_SEMESTER", "data_clean", "pro-semester-v1", 500],
    ["PRO_SEMESTER", "polish", "pro-semester-v1", 500],
  ] as Array<[string, string, string, number]>) {
    assert.match(
      seed,
      new RegExp(
        `\\('${planCode.toLowerCase()}', '${featureKey}', '${version}', ${periodicLimit}\\)`,
      ),
    );
  }

  assert.match(
    seed,
    /\('pro_monthly', 'pro monthly', 'subscription', 'pro', 1990, 'cny', 30, 0, 'pro-v1', false\)/,
  );
  assert.match(
    seed,
    /\('pro_semester', 'pro semester', 'subscription', 'pro_semester', 7900, 'cny', 150, 0, 'pro-semester-v1', false\)/,
  );
  assert.match(
    seed,
    /\('credit_pack_100', 'credit pack 100', 'credit_pack', null, 990, 'cny', null, 100, 'credit-v1', false\)/,
  );
  const products = seed.match(
    /with desired_products[\s\S]*?\) insert into public\.billing_products/,
  );
  assert.ok(products);
  assert.doesNotMatch(products[0], /'free'/);
  assert.doesNotMatch(products[0], /'pro_yearly'/);
  assert.equal(
    (products[0].match(/\('(?:pro_monthly|pro_semester|credit_pack_100)',/g) ?? [])
      .length,
    3,
  );
  assert.equal(
    (products[0].match(/, false\)/g) ?? []).length,
    3,
  );
  assert.match(seed, /on conflict \(code\) do update/);
  assert.match(seed, /on conflict \(plan_id, feature_key, entitlement_version\) do update/);
  assert.match(seed, /on conflict \(sku\) do update/);
  assert.match(seed, /is_active = excluded\.is_active/);
});

test("database types model the forward-added semester billing period", () => {
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(
    types,
    /billing_period: "FREE" \| "MONTHLY" \| "YEARLY" \| "SEMESTER";/,
  );
  assert.match(
    types,
    /p_billing_period: "FREE" \| "MONTHLY" \| "YEARLY" \| "SEMESTER";/,
  );
});

test("011 enforces the fast-launch catalog inside compatible transactional admin RPCs", () => {
  const guardPath = "supabase/migrations/202608120011_billing_fast_launch_catalog_guard.sql";
  const upgrade = compactSql(
    guardPath,
  );
  const helper = sqlFunction("billing_assert_semester_plan", guardPath);
  const plan = sqlFunction("billing_admin_upsert_plan", guardPath);
  const product = sqlFunction("billing_admin_upsert_product", guardPath);
  const helperBody = sqlFunctionBody("billing_assert_semester_plan", guardPath);
  const planBody = sqlFunctionBody("billing_admin_upsert_plan", guardPath);
  const productBody = sqlFunctionBody("billing_admin_upsert_product", guardPath);

  assert.match(upgrade, /create or replace function public\.billing_admin_upsert_plan\([\s\S]*p_is_active boolean/);
  assert.match(upgrade, /create or replace function public\.billing_admin_upsert_product\([\s\S]*p_is_active boolean/);
  assert.match(upgrade, /pg_advisory_xact_lock/);
  assert.match(upgrade, /from public\.billing_plans[\s\S]*for update/);
  assert.match(upgrade, /from public\.billing_plan_entitlements[\s\S]*for update/);
  assert.match(upgrade, /pro_semester/);
  assert.match(upgrade, /pro semester/);
  assert.match(upgrade, /semester/);
  assert.match(upgrade, /pro-semester-v1/);
  assert.match(upgrade, /free-v1/);
  assert.match(upgrade, /count\(\*\)[\s\S]*13/);
  assert.match(upgrade, /periodic_limit[\s\S]*\* 5/);
  assert.match(upgrade, /periodic_limit is null/);
  assert.match(upgrade, /lock table public\.billing_plans[\s\S]*public\.billing_products[\s\S]*public\.billing_plan_entitlements[\s\S]*share row exclusive mode/);
  assert.match(upgrade, /v_before[\s\S]*code[\s\S]*identity_mutation/);
  assert.match(upgrade, /v_before[\s\S]*sku[\s\S]*identity_mutation/);
  assert.match(upgrade, /v_plan\.is_active/);
  assert.match(upgrade, /billing_products[\s\S]*is_active[\s\S]*plan_in_use/);
  assert.match(upgrade, /full join public\.billing_plan_entitlements/);
  assert.match(upgrade, /left join public\.billing_plan_entitlements/);
  assert.match(upgrade, /revoke all on function public\.billing_admin_upsert_plan[\s\S]*anon, authenticated/);
  assert.match(upgrade, /grant execute on function public\.billing_admin_upsert_product[\s\S]*to service_role/);

  assertApprovedFastLaunchFeatures(helperBody);
  const extraFeature = helperBody.replace(
    /(v_approved_features\s+text\[\]\s*:=\s*array\[[\s\S]*?)(\]\s*;)/,
    "$1,'unapproved_fourteenth_feature'$2",
  );
  assert.notEqual(
    extraFeature,
    helperBody,
    "expected approved-feature mutation to apply",
  );
  assert.throws(
    () => assertApprovedFastLaunchFeatures(extraFeature),
    /approved fast-launch feature/i,
  );
  assert.match(helper, /feature_key[\s\S]*(?:any|all)[\s\S]*v_approved_features/);

  for (const [name, body] of [
    ["billing_assert_semester_plan", helperBody],
    ["billing_admin_upsert_plan", planBody],
    ["billing_admin_upsert_product", productBody],
  ] as const) {
    assertCatalogLockPrecedesAccess(body);
    for (const table of catalogTables) {
      for (const operation of [
        `select 1 from public.${table}`,
        `insert into public.${table} default values`,
        `update public.${table} set updated_at=updated_at`,
        `delete from public.${table}`,
      ]) {
        const mutation = body.replace(
          /lock table public\.billing_plans[\s\S]*?share row exclusive mode\s*;/,
          `${operation}; $&`,
        );
        assert.notEqual(
          mutation,
          body,
          `expected ${name} lock-order mutation to apply`,
        );
        assert.throws(
          () => assertCatalogLockPrecedesAccess(mutation),
          /must follow the catalog table lock/,
        );
      }
      for (const joinKind of ["", "left ", "full ", "inner ", "cross "]) {
        const joinClause =
          joinKind === "cross "
            ? `cross join public.${table} as catalog_row`
            : `${joinKind}join public.${table} as catalog_row on true`;
        const mutation = body.replace(
          /lock table public\.billing_plans[\s\S]*?share row exclusive mode\s*;/,
          `select 1 from pg_catalog.pg_class as seed_row ${joinClause}; $&`,
        );
        assert.notEqual(
          mutation,
          body,
          `expected ${name} ${joinKind || "plain "}join lock-order mutation to apply`,
        );
        assert.throws(
          () => assertCatalogLockPrecedesAccess(mutation),
          /must follow the catalog table lock/,
        );
      }
    }
  }
  assertIdentityRowLockPrecedesGuard(
    planBody,
    "billing_plans",
    "plan_identity_mutation",
  );
  const planWithoutTargetLock = removeTargetRowLock(planBody, "billing_plans");
  assert.notEqual(
    planWithoutTargetLock,
    planBody,
    "expected plan row-lock mutation to apply",
  );
  assert.throws(
    () =>
      assertIdentityRowLockPrecedesGuard(
        planWithoutTargetLock,
        "billing_plans",
        "plan_identity_mutation",
      ),
    /target billing_plans row lock/i,
  );
  assert.match(
    planWithoutTargetLock,
    /from public\.billing_admin_audit_logs[^;]*for update/,
    "audit row lock must remain in the plan mutation fixture",
  );
  const planWithLateTargetLock = moveTargetRowLockAfterGuard(
    planBody,
    "billing_plans",
    "plan_identity_mutation",
  );
  assert.throws(
    () =>
      assertIdentityRowLockPrecedesGuard(
        planWithLateTargetLock,
        "billing_plans",
        "plan_identity_mutation",
      ),
    /must precede the code identity guard/i,
  );
  assert.match(plan, /billing_products[\s\S]*is_active[\s\S]*plan_in_use/);
  assertIdentityRowLockPrecedesGuard(
    productBody,
    "billing_products",
    "product_identity_mutation",
  );
  const productWithoutTargetLock = removeTargetRowLock(
    productBody,
    "billing_products",
  );
  assert.notEqual(
    productWithoutTargetLock,
    productBody,
    "expected product row-lock mutation to apply",
  );
  assert.throws(
    () =>
      assertIdentityRowLockPrecedesGuard(
        productWithoutTargetLock,
        "billing_products",
        "product_identity_mutation",
      ),
    /target billing_products row lock/i,
  );
  assert.match(
    productWithoutTargetLock,
    /from public\.billing_admin_audit_logs[^;]*for update/,
    "audit row lock must remain in the product mutation fixture",
  );
  const productWithLateTargetLock = moveTargetRowLockAfterGuard(
    productBody,
    "billing_products",
    "product_identity_mutation",
  );
  assert.throws(
    () =>
      assertIdentityRowLockPrecedesGuard(
        productWithLateTargetLock,
        "billing_products",
        "product_identity_mutation",
      ),
    /must precede the sku identity guard/i,
  );
  assert.match(product, /v_plan[\s\S]*is_active[\s\S]*fast_launch_plan_inactive/);
});

test("after-sales uniqueness is a forward-only upgrade and does not rewrite the original schema migration", () => {
  const refundRequests = sqlTable("billing_refund_requests");
  const invoiceRequests = sqlTable("billing_invoice_requests");
  const upgrade = compactSql(afterSalesPath);

  assert.doesNotMatch(refundRequests, /unique \(user_id, order_id\)/);
  assert.doesNotMatch(invoiceRequests, /unique \(user_id, order_id\)/);
  assert.match(
    upgrade,
    /alter table public\.billing_refund_requests add constraint billing_refund_requests_user_order_key unique \(user_id, order_id\)/,
  );
  assert.match(
    upgrade,
    /alter table public\.billing_invoice_requests add constraint billing_invoice_requests_user_order_key unique \(user_id, order_id\)/,
  );
});

test("after-sales request RPCs lock the owned order and return an existing request before state validation", () => {
  const refund = sqlFunction("billing_request_refund", afterSalesPath);
  const invoice = sqlFunction("billing_request_invoice", afterSalesPath);

  for (const fn of [refund, invoice]) {
    assert.match(fn, /security definer/);
    assert.match(fn, /set search_path = pg_catalog, public/);
    assert.match(
      fn,
      /from public\.billing_orders where id = p_order_id for update/,
    );
    assert.match(fn, /v_order\.user_id is distinct from p_user_id/);
    assert.match(
      fn,
      /where user_id = p_user_id and order_id = p_order_id/,
    );
    assert.ok(
      fn.indexOf("if found then") <
        fn.indexOf("object_not_in_prerequisite_state"),
      "stable replay must return before mutable order-state validation",
    );
  }

  assert.match(refund, /requested_amount_minor[\s\S]*?v_order\.amount_minor/);
  assert.match(refund, /currency[\s\S]*?v_order\.currency/);
  assert.match(invoice, /amount_minor[\s\S]*?v_order\.amount_minor/);
  assert.match(invoice, /currency[\s\S]*?v_order\.currency/);
});

test("after-sales request RPCs are executable only by service_role", () => {
  const sql = compactSql(afterSalesPath);

  assert.match(
    sql,
    /revoke all on function public\.billing_request_refund\(uuid, uuid, text\) from public, anon, authenticated/,
  );
  assert.match(
    sql,
    /grant execute on function public\.billing_request_refund\(uuid, uuid, text\) to service_role/,
  );
  assert.match(
    sql,
    /revoke all on function public\.billing_request_invoice\(uuid, uuid, text, text, text\) from public, anon, authenticated/,
  );
  assert.match(
    sql,
    /grant execute on function public\.billing_request_invoice\(uuid, uuid, text, text, text\) to service_role/,
  );
});

test("database types expose atomic after-sales request RPC contracts", () => {
  const types = projectFile("lib/billing/database.types.ts");

  assert.match(
    types,
    /billing_request_refund: \{[\s\S]*?p_user_id: UUID;[\s\S]*?p_order_id: UUID;[\s\S]*?p_reason: string;[\s\S]*?Returns: Json;/,
  );
  assert.match(
    types,
    /billing_request_invoice: \{[\s\S]*?p_user_id: UUID;[\s\S]*?p_order_id: UUID;[\s\S]*?p_invoice_title: string;[\s\S]*?p_tax_identifier: string \| null;[\s\S]*?p_delivery_email: string;[\s\S]*?Returns: Json;/,
  );
});
