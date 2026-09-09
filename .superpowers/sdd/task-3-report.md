# Task 3 Report

## Status

Completed locally in the isolated `codex/billing-mvp` worktree. No deployment,
remote database access, middleware changes, AI API changes, or payment secrets
were used.

## Delivered

- Server-side billing user and administrator guards with 401/403 errors.
- Active `billing_admins` authorization with an authenticated `ADMIN_EMAIL`
  bootstrap fallback.
- Feature-flag and production Mock-payment guards.
- A persistent, injectable order-creation rate-limit repository with a
  60-second, five-request sliding window and fail-closed storage errors.

## TDD Evidence

The new test command first failed because `lib/billing/auth` and
`lib/billing/rate-limit` did not exist. After the minimal implementation, the
targeted suite passed. The final full suite passed 46 tests; TypeScript and
targeted ESLint also passed.

## Concerns

The existing schema has no transactional rate-limit RPC. The default repository
persists and evaluates the sliding window correctly for ordinary requests, but
two simultaneous requests can race between the count and insert operations.
Before handling significant concurrent production traffic, add a database-side
atomic consume function and make this repository call it.

## Review Remediation

- A disabled `billing_admins` record now takes precedence over `ADMIN_EMAIL`;
  bootstrap authorization only applies when the server-side lookup has no row.
- `billing_consume_order_rate_limit` now holds a per-user transaction advisory
  lock while it cleans expired requests, counts the window, and consumes one
  request. The default repository calls this RPC through the service-role
  client.
- The RPC contract is documented in the migration, generated database types,
  database guide, and tests. It is `SECURITY DEFINER`, pins `search_path`,
  revokes client execution, and grants only `service_role`.

## Current Concern

The prior count/insert race is resolved in the migration. By task scope, the
new function was statically tested only; it still needs its documented local or
isolated-test-database runtime verification before any production use.
