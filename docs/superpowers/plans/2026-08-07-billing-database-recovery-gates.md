# Billing Database Recovery Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the billing database can upgrade from migrations `001`–`009` to `010` and can be logically backed up from the authorized test project and restored into a separately approved disposable hosted Supabase project.

**Architecture:** A fail-closed Node/TypeScript drill runner validates project identity before invoking Supabase/PostgreSQL tools. Deterministic SQL fixtures and read-only verification queries produce sanitized JSON manifests for the ordered-upgrade and logical-restore paths; raw dumps and credentials remain in an ignored temporary directory. Remote mutation is a separately gated execution task that cannot start until the user supplies and approves the second Project Ref.

**Tech Stack:** Node.js 20+, TypeScript, `tsx`, Node test runner, Supabase CLI 2.111+, PostgreSQL client tools (`psql`), hosted Supabase PostgreSQL, PowerShell-compatible command invocation.

## Global Constraints

- Source Project Ref is exactly `fqnpzsecalhrsqhpdaxs`; source access is export/read-only and source reset or mutation is forbidden.
- Restore Project Ref must be supplied and explicitly approved by the user before any remote connection; it must differ from the source and every known production Project Ref.
- Destructive preparation is allowed only on the approved empty/disposable restore project.
- Never print or persist database URLs, passwords, access tokens, service-role keys, webhook bodies, signatures, or payment credentials.
- Dumps and raw manifests live under `.artifacts/billing-db-drill/YYYYMMDDTHHMMSSZ-random8/`, are excluded from Git, and are never staged or committed.
- Use only synthetic billing data. Stop if unexpected real users, real payment records, active products, or secret-like values are detected.
- Do not push, merge to `main`, deploy, enable billing, activate products, configure real providers, modify filing information, or connect to production.
- Do not describe application logical recovery as physical backup, PITR, Storage-object recovery, production RTO/RPO, or production disaster-recovery validation.
- Every subprocess failure, SQL error, identity mismatch, checksum mismatch, or security check failure stops the drill; never continue with ignored errors or broad privilege grants.

## File map

- `scripts/billing-db-drill/identity.ts`: pure Project Ref and database URL identity validation.
- `scripts/billing-db-drill/process.ts`: redacted subprocess execution and artifact hashing.
- `scripts/billing-db-drill/cli.ts`: explicit drill commands and confirmation gates.
- `scripts/billing-db-drill/sql/fixtures-009.sql`: deterministic synthetic fixtures valid after migration `009`.
- `scripts/billing-db-drill/sql/manifest.sql`: safe JSON manifest query.
- `scripts/billing-db-drill/sql/verify.sql`: schema, RLS, grant, RPC, catalog, and integrity assertions.
- `tests/billing/database-drill.test.ts`: behavior tests for identity guards, redaction, command construction, and SQL contracts.
- `.gitignore`: excludes `.artifacts/billing-db-drill/`.
- `docs/billing-database-recovery-report.md`: sanitized evidence report created only after the hosted drill runs.

---

### Task 1: Fail-closed project identity and secret redaction

**Files:**
- Create: `scripts/billing-db-drill/identity.ts`
- Create: `scripts/billing-db-drill/process.ts`
- Create: `tests/billing/database-drill.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `assertAuthorizedTargets(input: TargetIdentityInput): AuthorizedTargets`.
- Produces: `assertDatabaseUrlMatchesRef(rawUrl: string, expectedRef: string): URL`.
- Produces: `runRedacted(command: string, args: string[], options: RunOptions): Promise<RunResult>`.
- Produces: `sha256File(path: string): Promise<string>`.

- [ ] **Step 1: Write failing guard and redaction tests**

Test these exact behaviors in `tests/billing/database-drill.test.ts`:

```ts
assert.throws(
  () => assertAuthorizedTargets({
    sourceRef: "fqnpzsecalhrsqhpdaxs",
    restoreRef: "fqnpzsecalhrsqhpdaxs",
    approvedRestoreRef: "fqnpzsecalhrsqhpdaxs",
    productionRefs: [],
  }),
  /SOURCE_AND_RESTORE_MUST_DIFFER/,
);

assert.throws(
  () => assertDatabaseUrlMatchesRef(
    "postgresql://postgres:secret@db.wrongprojectref0000.supabase.co:5432/postgres",
    "abcdefghijklmnopqrst",
  ),
  /DATABASE_URL_PROJECT_MISMATCH/,
);

assert.equal(
  redactText("postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co/postgres"),
  "[REDACTED_DATABASE_URL]",
);
```

Also cover missing approval, restore matching a production ref, invalid 20-character refs, direct-host URL matching, session-pooler username matching (`postgres.<ref>`), child-process non-zero exit, and absence of credentials from thrown errors.

- [ ] **Step 2: Run the focused test and confirm red state**

Run:

```powershell
npx.cmd tsx --test tests/billing/database-drill.test.ts
```

Expected: FAIL because the identity/process modules do not exist.

- [ ] **Step 3: Implement the pure guards**

Use these public types and constants:

```ts
export const BILLING_SOURCE_PROJECT_REF = "fqnpzsecalhrsqhpdaxs";
export const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export interface TargetIdentityInput {
  sourceRef: string;
  restoreRef: string;
  approvedRestoreRef: string;
  productionRefs: readonly string[];
}

export interface AuthorizedTargets {
  sourceRef: typeof BILLING_SOURCE_PROJECT_REF;
  restoreRef: string;
}
```

`assertAuthorizedTargets` must require exact source identity, exact restore approval, distinct refs, valid formats, and no restore/source membership in `productionRefs`. `assertDatabaseUrlMatchesRef` must accept only an HTTPS-safe PostgreSQL URL whose direct host is `db.<ref>.supabase.co` or whose pooler username is exactly `postgres.<ref>`; it must return a parsed URL but never include the raw URL in errors.

- [ ] **Step 4: Implement redacted process execution and artifact hashing**

`runRedacted` must use `spawn` with an argument array and `shell:false`, accept secrets through the child environment, collect bounded stdout/stderr, redact PostgreSQL URLs and values named by `secretValues`, and reject on non-zero exit. It must never interpolate commands. `sha256File` must stream the file and return lowercase hexadecimal SHA-256.

Add exactly this ignore rule:

```gitignore
/.artifacts/billing-db-drill/
```

- [ ] **Step 5: Verify and commit Task 1**

Run:

```powershell
npx.cmd tsx --test tests/billing/database-drill.test.ts
npx.cmd eslint scripts/billing-db-drill tests/billing/database-drill.test.ts
npm.cmd run typecheck
git diff --check
```

Expected: all commands exit 0.

Commit only Task 1 files:

```powershell
git add -- .gitignore scripts/billing-db-drill/identity.ts scripts/billing-db-drill/process.ts tests/billing/database-drill.test.ts
git commit -m "feat: guard billing database recovery targets"
```

---

### Task 2: Deterministic upgrade fixtures and safe verification manifest

**Files:**
- Create: `scripts/billing-db-drill/sql/fixtures-009.sql`
- Create: `scripts/billing-db-drill/sql/manifest.sql`
- Create: `scripts/billing-db-drill/sql/verify.sql`
- Modify: `tests/billing/database-drill.test.ts`

**Interfaces:**
- Consumes: repository migrations `001`–`010`.
- Produces: deterministic fixture namespace `00000000-0000-4000-8000-00000000b0xx` and JSON output with keys `migration_versions`, `table_counts`, `fixture_checksums`, `catalog`, `security_checks`, and `behavior_checks`.

- [ ] **Step 1: Extend tests with exact SQL safety contracts**

Load the three SQL files as text and assert:

```ts
assert.match(fixtures009, /begin;/i);
assert.match(fixtures009, /\\if\s+:drill_commit[\s\S]*commit;[\s\S]*\\else[\s\S]*rollback;/i);
assert.doesNotMatch(fixtures009, /service_role|api[_ -]?key|private[_ -]?key/i);
assert.match(manifest, /jsonb_build_object/i);
assert.doesNotMatch(manifest, /email|raw_payload|signature|token|password/i);
assert.match(verify, /relrowsecurity/i);
assert.match(verify, /prosecdef/i);
assert.match(verify, /is_active\s*=\s*true/i);
```

The fixture test must also prove every literal UUID begins with the reserved synthetic prefix and every monetary amount is an integer.

- [ ] **Step 2: Run the focused test and confirm red state**

Run:

```powershell
npx.cmd tsx --test tests/billing/database-drill.test.ts
```

Expected: FAIL because the SQL assets do not exist.

- [ ] **Step 3: Author `fixtures-009.sql` as a transaction-controlled fixture**

The file must use `\set ON_ERROR_STOP on`, default the psql variable `drill_commit` to `false` when absent, begin a transaction, insert deterministic rows compatible with `001`–`009`, and use psql `\if :drill_commit` to choose `commit;` or `rollback;`. The runner may set `-v drill_commit=true` only after the approved restore target passes preflight; it must never rewrite the SQL file. Cover one pending order, one paid subscription order/payment/subscription/quota, one credit-pack order/payment/credit ledger entry, one refund request, one invoice request, one processed webhook event, and one admin audit record. Use `MOCK`, `CNY`, integer minor units, inactive products, and clearly synthetic identifiers.

- [ ] **Step 4: Author the manifest and verification SQL**

`manifest.sql` must emit a single JSON object with safe counts, migration versions, deterministic fixture status/balance tuples, inactive catalog tuples, and SHA-256-compatible stable text inputs. It must not select emails, raw webhook payloads, signatures, tokens, keys, or unrestricted row contents.

`verify.sql` must fail with `raise exception` unless all expected billing tables/indexes/constraints exist, RLS is enabled, privileged functions have `security definer` and safe `search_path`, legacy RPC grants are revoked, catalog rows are exactly Free/Pro Monthly/Pro Semester/Credit Pack 100, Free has no product, and every plan/product is inactive. Include safe transactional checks inside rollbacks for quota/credit reserve-finalize-release, insufficient balance, duplicate settlement, mismatched amount/currency, refund idempotency, and unauthorized role access.

- [ ] **Step 5: Verify and commit Task 2**

Run:

```powershell
npx.cmd tsx --test tests/billing/database-drill.test.ts tests/billing/migrations.test.ts tests/billing/security-coverage.test.ts
npx.cmd eslint tests/billing/database-drill.test.ts
git diff --check
```

Expected: all commands exit 0.

Commit only Task 2 files:

```powershell
git add -- scripts/billing-db-drill/sql/fixtures-009.sql scripts/billing-db-drill/sql/manifest.sql scripts/billing-db-drill/sql/verify.sql tests/billing/database-drill.test.ts
git commit -m "test: add billing database recovery fixtures"
```

---

### Task 3: Dry-run drill CLI and command construction

**Files:**
- Create: `scripts/billing-db-drill/cli.ts`
- Modify: `scripts/billing-db-drill/process.ts`
- Modify: `tests/billing/database-drill.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `assertAuthorizedTargets`, `assertDatabaseUrlMatchesRef`, `runRedacted`, SQL assets.
- Produces CLI commands `preflight`, `upgrade`, `backup`, `restore`, `verify`, and `all`.
- Produces npm command `billing:db-drill` equal to `tsx scripts/billing-db-drill/cli.ts`.

- [ ] **Step 1: Add failing CLI behavior tests**

Export `parseDrillArgs(argv)`, `buildUpgradePlan(input)`, `buildBackupPlan(input)`, and `buildRestorePlan(input)` for pure tests. Assert that:

- all commands require `--source-ref`, `--restore-ref`, and `--approved-restore-ref`;
- mutating commands require `--confirm-restore REF` exactly matching the restore ref;
- `--dry-run` returns redacted executable/argument plans without executing them;
- upgrade first creates an isolated temporary Supabase workspace containing migrations `001`–`009`, links that workspace using only the approved restore Project Ref and a password supplied through `SUPABASE_DB_PASSWORD`, runs `supabase db push --linked`, loads committed fixtures, captures a manifest, then pushes `010` from the full migration set;
- backup creates role, schema, and data dumps with `supabase db dump` and SHA-256 files;
- restore orders roles, schema, then data and uses `psql -v ON_ERROR_STOP=1`;
- no command argument contains a database URL or password.

- [ ] **Step 2: Run the focused test and confirm red state**

Run:

```powershell
npx.cmd tsx --test tests/billing/database-drill.test.ts
```

Expected: FAIL because the CLI module does not exist.

- [ ] **Step 3: Implement explicit parsing and dry-run output**

Environment variables are exactly:

```text
BILLING_SOURCE_DB_URL
BILLING_RESTORE_DB_URL
BILLING_PRODUCTION_PROJECT_REFS
```

The CLI must validate URL-to-ref binding before command construction, derive `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and `PGSSLMODE=require` only in each child process environment, require the approved restore ref twice for mutations, create a unique run directory beneath `.artifacts/billing-db-drill/`, and print only refs, operation names, artifact basenames, checksums, and sanitized statuses. Supabase CLI workspaces must be temporary and linked using `--project-ref`; database passwords are supplied only through `SUPABASE_DB_PASSWORD`. Neither PostgreSQL URLs nor passwords may appear in subprocess arguments. `preflight` must check Node, Supabase CLI, and `psql` versions and use read-only SQL to prove source/restore identity and restore emptiness. Empty means no `billing_%` relations and no billing migration history; otherwise stop unless the exact expected prior state belongs to the currently running upgrade path.

- [ ] **Step 4: Implement upgrade, backup, restore, and verify orchestration**

Use temporary copied migration directories; never rename or delete repository migrations. Link each temporary workspace to exactly one already validated ref and re-read its linked ref before every Supabase CLI operation. Every SQL command uses `ON_ERROR_STOP`. The source URL may be converted to child-only `PG*` variables only for backup and read-only manifest commands. The restore URL may be converted to child-only `PG*` variables for preflight, upgrade, restore, and verification. Record a machine-readable sanitized `run-summary.json` without URLs or secrets. Do not delete artifacts automatically.

- [ ] **Step 5: Verify and commit Task 3**

Run:

```powershell
npx.cmd tsx --test tests/billing/database-drill.test.ts
npm.cmd run billing:db-drill -- preflight --source-ref fqnpzsecalhrsqhpdaxs --restore-ref abcdefghijklmnopqrst --approved-restore-ref abcdefghijklmnopqrst --dry-run
npx.cmd eslint scripts/billing-db-drill tests/billing/database-drill.test.ts
npm.cmd run typecheck
git diff --check
```

Expected: tests/lint/typecheck/diff-check exit 0; dry-run prints a redacted plan and makes no connection.

Commit only Task 3 files:

```powershell
git add -- package.json scripts/billing-db-drill/cli.ts scripts/billing-db-drill/process.ts tests/billing/database-drill.test.ts
git commit -m "feat: add billing database recovery drill"
```

---

### Task 4: Hosted ordered-upgrade drill

**Files:**
- Create after execution: `.artifacts/billing-db-drill/YYYYMMDDTHHMMSSZ-random8/upgrade-before.json` (ignored)
- Create after execution: `.artifacts/billing-db-drill/YYYYMMDDTHHMMSSZ-random8/upgrade-after.json` (ignored)
- Create after execution: `.artifacts/billing-db-drill/YYYYMMDDTHHMMSSZ-random8/run-summary.json` (ignored)
- Modify only after evidence exists: `docs/billing-database-recovery-report.md`

**Interfaces:**
- Consumes: the user-approved restore Project Ref, test-only direct/session PostgreSQL URLs supplied through environment variables, Tasks 1–3 CLI.
- Produces: sanitized ordered-upgrade evidence and a pass/fail gate result.

- [ ] **Step 1: Stop for the remote authorization gate**

Before connecting, obtain all of the following in one user confirmation:

```text
Restore project name
Restore Project Ref
Confirmed empty/disposable: yes
Confirmed contains no production data: yes
Confirmed destructive preparation is allowed: yes
Confirmed source remains read-only: yes
```

Do not accept a ref that equals `fqnpzsecalhrsqhpdaxs` or a known production ref.

- [ ] **Step 2: Run read-only preflight**

Set database URLs only in the process environment, then run with the approved literal ref:

```powershell
npm.cmd run billing:db-drill -- preflight --source-ref fqnpzsecalhrsqhpdaxs --restore-ref $env:BILLING_RESTORE_PROJECT_REF --approved-restore-ref $env:BILLING_RESTORE_PROJECT_REF
```

Expected: source identity matches, restore identity matches, restore application schema is empty, tool versions are supported, and no URL or password appears in output. `BILLING_RESTORE_PROJECT_REF` must equal the exact user-approved value from Step 1.

- [ ] **Step 3: Run the ordered upgrade**

```powershell
npm.cmd run billing:db-drill -- upgrade --source-ref fqnpzsecalhrsqhpdaxs --restore-ref $env:BILLING_RESTORE_PROJECT_REF --approved-restore-ref $env:BILLING_RESTORE_PROJECT_REF --confirm-restore $env:BILLING_RESTORE_PROJECT_REF
```

Expected: `001`–`009` apply in order, synthetic fixtures commit, pre-upgrade manifest is captured, `010` applies alone, post-upgrade verification passes, and existing fixture tuples/checksums remain unchanged except the expected inactive catalog additions.

- [ ] **Step 4: Re-run migration and security verification**

Run:

```powershell
npm.cmd run billing:db-drill -- verify --source-ref fqnpzsecalhrsqhpdaxs --restore-ref $env:BILLING_RESTORE_PROJECT_REF --approved-restore-ref $env:BILLING_RESTORE_PROJECT_REF
npx.cmd supabase migration list
npx.cmd supabase db push --dry-run
```

The Supabase CLI must be explicitly linked to the restore ref before the last two commands and immediately checked with `supabase projects list`. Expected: local/remote migration history agrees through `010`, no pending migration, and all SQL assertions pass. Do not relink to or operate on production.

- [ ] **Step 5: Record the ordered-upgrade result**

Add only sanitized refs, versions, counts, checksums, commands, and pass/fail results to `docs/billing-database-recovery-report.md`. If any gate failed, record it and stop before Task 5.

- [ ] **Step 6: Commit the sanitized Task 4 report**

```powershell
git add -- docs/billing-database-recovery-report.md
git commit -m "docs: record billing database upgrade drill"
```

---

### Task 5: Hosted logical backup and restore drill

**Files:**
- Create after execution: `.artifacts/billing-db-drill/YYYYMMDDTHHMMSSZ-random8/roles.sql` (ignored)
- Create after execution: `.artifacts/billing-db-drill/YYYYMMDDTHHMMSSZ-random8/schema.sql` (ignored)
- Create after execution: `.artifacts/billing-db-drill/YYYYMMDDTHHMMSSZ-random8/data.sql` (ignored)
- Create after execution: `.artifacts/billing-db-drill/YYYYMMDDTHHMMSSZ-random8/*.sha256` (ignored)
- Modify: `docs/billing-database-recovery-report.md`

**Interfaces:**
- Consumes: source test project `fqnpzsecalhrsqhpdaxs`, approved disposable restore project, Task 3 CLI.
- Produces: restored database manifest, backup checksums, final Stage B pass/fail result.

- [ ] **Step 1: Reconfirm source read-only and restore mutation authorization**

Run preflight again and compare the refs with the Task 4 report. Stop on any mismatch. Confirm the source migration list and manifest are unchanged from their recorded pre-drill values.

- [ ] **Step 2: Export the logical backup**

```powershell
npm.cmd run billing:db-drill -- backup --source-ref fqnpzsecalhrsqhpdaxs --restore-ref $env:BILLING_RESTORE_PROJECT_REF --approved-restore-ref $env:BILLING_RESTORE_PROJECT_REF
```

Expected: role/schema/data artifacts and SHA-256 files are created under the ignored run directory, contain no detected secret-like values or unexpected production-derived records, and nothing is staged in Git.

- [ ] **Step 3: Prepare only the restore project and restore the backup**

```powershell
npm.cmd run billing:db-drill -- restore --source-ref fqnpzsecalhrsqhpdaxs --restore-ref $env:BILLING_RESTORE_PROJECT_REF --approved-restore-ref $env:BILLING_RESTORE_PROJECT_REF --confirm-restore $env:BILLING_RESTORE_PROJECT_REF
```

Expected: restore runs roles/schema/data in order with `ON_ERROR_STOP`, refuses broad ownership/grant workarounds, and stops on the first SQL failure. If Supabase-managed schemas prevent full logical restore, report the exact failure and request approval before narrowing scope; do not silently continue.

- [ ] **Step 4: Verify restored structure, security, behavior, and data**

```powershell
npm.cmd run billing:db-drill -- verify --source-ref fqnpzsecalhrsqhpdaxs --restore-ref $env:BILLING_RESTORE_PROJECT_REF --approved-restore-ref $env:BILLING_RESTORE_PROJECT_REF
```

Expected: migration history, schema fingerprint, RLS, grants, RPC contracts, inactive catalog, safe table counts, deterministic fixture checksums, concurrency/idempotency behavior, and source/restore manifests all satisfy the design.

- [ ] **Step 5: Complete the sanitized report and commit**

Record logical artifact basenames, sizes, SHA-256 values, summarized verification results, source-read-only confirmation, production-never-connected confirmation, and excluded scope for Storage, physical backups, PITR, RTO/RPO, and real payment data.

Run:

```powershell
git status --short
git diff --check
git add -- docs/billing-database-recovery-report.md
git commit -m "docs: verify billing database logical recovery"
```

Expected: no `.artifacts` file is listed or staged.

---

### Task 6: Whole-stage verification and independent final review

**Files:**
- Modify only for a verified Stage B defect: files introduced by Tasks 1–5 with a focused regression test.

**Interfaces:**
- Consumes: all Stage B commits and sanitized evidence.
- Produces: final Stage B status: `PASS`, `PARTIAL`, or `BLOCKED`.

- [ ] **Step 1: Run the complete local quality gate**

```powershell
npm.cmd test
npm.cmd run typecheck
npx.cmd eslint scripts/billing-db-drill tests/billing lib/billing app/api/billing app/api/admin/billing app/admin/billing
npm.cmd run build
npm.cmd audit --audit-level=low
git diff --check
```

Expected: tests/typecheck/build/audit/diff-check exit 0; ESLint has 0 errors. Record warning count separately.

- [ ] **Step 2: Re-check protected scope**

```powershell
git diff --name-only main...HEAD -- components/SiteFilingFooter.tsx public/beian-police.svg app/layout.tsx .github
git diff --cached --name-only
git status --short
```

Expected: no unintended filing/deployment changes, no staged artifact, and only documented pre-existing worktree noise remains.

- [ ] **Step 3: Dispatch independent whole-stage review**

The reviewer receives the approved design, this plan, commits since `b213b6b`, sanitized report, and Global Constraints. It must verify target identity guards, absence of secret leakage, source read-only enforcement, migration ordering, SQL assertion quality, backup/restore evidence, and accuracy of the claimed recovery scope.

- [ ] **Step 4: Apply at most one reviewed fix wave**

If the final reviewer finds Critical or Important defects, dispatch one fixer for the complete finding list, require focused tests, then dispatch one scoped re-review. Do not change remote databases merely to hide or overwrite failed evidence.

- [ ] **Step 5: Report the gate honestly**

Return `PASS` only if ordered upgrade and logical restore both passed and the final review has no unresolved load-bearing finding. Return `PARTIAL` when application-schema recovery passed but full scoped logical restore did not. Return `BLOCKED` for missing target authorization, unsafe identity, failed restore, unresolved security/integrity failure, or unavailable required tooling.

The final report must state that no production connection, deployment, push, billing activation, real payment, physical-backup/PITR test, or Storage-object recovery occurred.
