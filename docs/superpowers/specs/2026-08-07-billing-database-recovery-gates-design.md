# Billing Database Recovery Gates Design

## Objective

Close the remaining Stage B billing database gates by proving that migrations can upgrade an existing `001`–`009` database to `010`, and that a logical backup from the authorized billing test project can be restored and verified in a second disposable hosted Supabase project.

This stage is a test-environment exercise only. It does not authorize production access, production migration, deployment, package activation, public billing, or real payment providers.

## Authorized environments

- Source project: `fqnpzsecalhrsqhpdaxs` (`ai-research-assistant-billing-test`).
- Restore project: a newly created, empty, disposable hosted Supabase project whose Project Ref must be supplied and approved separately before any connection.
- Production project identifiers and credentials are out of scope and must never be used.
- The source project is read-only for backup export and verification during the recovery drill. No reset, destructive migration, or fixture replacement is allowed on it.
- Destructive preparation is allowed only on the approved restore project after its identity and empty/disposable status have been confirmed.

Every command that can connect to a remote database must first display or independently verify its target Project Ref. A missing, unexpected, source, or known production Project Ref is a hard stop.

## Recovery scope

The drill proves application-level logical recovery for the billing database objects and synthetic test data required by this repository. It does not claim:

- Supabase physical-backup or point-in-time-recovery readiness;
- recovery of Storage object contents;
- recovery of secrets, database passwords, or third-party payment credentials;
- production recovery time or recovery point objectives;
- recovery of real user or payment data.

Backup artifacts must contain test data only, live outside Git, and never be committed. Reports may record file names, byte sizes, cryptographic checksums, migration versions, row counts, and safe aggregate results, but not connection strings, access tokens, passwords, service-role keys, raw webhook bodies, signatures, or payment credentials.

## Drill architecture

The restore project is used for two independently evaluated paths.

### Path 1: ordered upgrade

1. Verify the restore project is the separately approved disposable target.
2. Establish an empty application baseline without resetting the source project.
3. Apply migrations `202607210001` through `202607290009` in filename order.
4. Insert deterministic synthetic fixtures covering users referenced by billing rows, orders, payments, subscriptions, entitlements, quotas, credits, refunds, invoices, webhook events, and administrative audit references where their schemas permit it.
5. Capture a pre-upgrade manifest containing migration history, schema fingerprints, safe row counts, fixture identifiers, and expected account balances/statuses.
6. Apply only `202608050010_billing_catalog_seed.sql`.
7. Verify that pre-existing fixtures are unchanged and that the inactive catalog is correct.
8. Verify the final structure is equivalent to a clean `001`–`010` application, subject to expected fixture data.

Catalog acceptance requires exactly the approved Free, Pro Monthly, Pro Semester, and Credit Pack 100 configuration. Free must not have a zero-price purchasable product. All plans and products must remain `is_active=false`. Re-applying the catalog seed through an explicitly safe transaction or equivalent idempotency check must not duplicate catalog rows or change unrelated data.

### Path 2: logical backup and restore

1. Verify the source Project Ref is exactly `fqnpzsecalhrsqhpdaxs` and use it only for non-mutating export and inspection.
2. Verify the restore Project Ref is the separately approved disposable project and is not the source or production.
3. Produce a logical backup using supported Supabase/PostgreSQL tooling. Separate schema/roles/data artifacts when required by the official restore workflow.
4. Store artifacts in an excluded temporary directory and calculate SHA-256 checksums.
5. Restore into the disposable project using the dependency order required by Supabase/PostgreSQL.
6. Re-run schema, security, behavior, and data-integrity checks.
7. Compare the restored manifest with the source manifest using safe aggregates and deterministic fixture identifiers.

If a full hosted-project logical restore conflicts with Supabase-managed schemas or roles, stop and classify the result. Do not bypass ownership or privilege failures with broad grants. A narrower application-schema recovery may be evaluated only if the report explicitly states the reduced scope and the user approves it.

## Acceptance checks

### Migration history and schema

- Local migration files and remote migration history agree for `001`–`010` after the upgrade.
- All expected billing tables, enum/check constraints, foreign keys, uniqueness constraints, indexes, triggers, and functions exist.
- Function signatures, security-definer/search-path protections, grants, and revoked legacy RPC access match repository migrations.
- A second migration list/dry-run reports no pending billing migration.

### RLS and authorization

- RLS is enabled on every billing table required by the migrations.
- Anonymous access cannot read or mutate protected billing records or execute privileged billing RPCs.
- An authenticated ordinary user is limited to the intended self-service reads/actions.
- Administrator actions require server-side authorization and the expected database role/RPC contract.
- Service-role behavior is tested only with test-project credentials and its values never appear in output or reports.

### Transactional behavior

- Usage reservation, finalization, and failure release are atomic and idempotent.
- Insufficient quota or credit fails without a negative balance.
- Concurrent reservations cannot overspend quota or credit.
- Duplicate settlement/webhook events cannot duplicate subscription or credit grants.
- Amount, currency, order, provider, and state mismatches are rejected.
- Refund and administrative adjustment operations preserve audit and idempotency contracts.

### Data integrity

- Pre-upgrade fixtures retain identifiers, monetary integer values, currencies, statuses, timestamps, balances, and relationships after `010`.
- Source and restored manifests have matching safe row counts and fixture-level checksums for in-scope billing data.
- No active catalog row, real credential, or production-derived record exists.

## Failure handling and stop conditions

Stop before mutation when any of the following is true:

- the restore Project Ref has not been explicitly approved;
- the target is the source project, a production project, non-empty in an unexplained way, or not confirmed disposable;
- a command would reset or destructively modify the source project;
- the dump contains unexpected schemas, real users, real payment records, or secrets;
- local and remote migration histories diverge before the expected exercise;
- the required connection method cannot identify the target reliably;
- restoring requires disabling security controls, applying broad grants, or ignoring SQL errors;
- a checksum, row count, schema fingerprint, RLS check, permission check, or transactional behavior check fails.

On failure, preserve the source project and local branch unchanged, collect sanitized diagnostics, and report the exact failed gate. Do not continue to later gates or declare Stage B complete.

## Evidence and documentation

Create a sanitized Stage B report under `docs/` containing:

- source and restore Project Refs only;
- execution date and CLI/PostgreSQL versions;
- migration history before and after upgrade;
- backup artifact names, sizes, and SHA-256 checksums;
- schema/security/RPC/data test commands and summarized results;
- failures and remediation, if any;
- confirmation that the source was not reset or mutated;
- confirmation that production was never connected;
- the explicit limitation that Storage contents, physical backups, PITR, production RTO/RPO, and real payment data were not tested.

Temporary dumps, credentials, raw SQL output containing sensitive rows, and connection strings must not be committed. The restore project remains available for inspection until the user separately authorizes deletion.

## Implementation boundaries

- Work remains on `codex/billing-mvp` in `D:\网站项目\.worktrees\billing-mvp`.
- Do not push, merge to `main`, deploy, enable billing, enable products, or configure real payment providers.
- Do not modify filing information or deployment infrastructure.
- Do not modify production data or run a production migration.
- Any helper must fail closed, require explicit Project Ref inputs, avoid secret logging, and support dry-run or read-only inspection before mutation.

## Completion criteria

Stage B is complete only when both upgrade and logical-recovery paths pass all in-scope checks, the sanitized evidence report is reviewed, and no unresolved security or integrity failure remains. A partial application-schema recovery, an unavailable restore target, or a failed backup restore must be reported as partial/blocked rather than passed.
