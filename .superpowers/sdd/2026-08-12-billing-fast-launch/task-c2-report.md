# Stage C2a Report - Refund Execution

Date: 2026-08-18
Scope: C2a only (approved full-refund execution). The broader Mock end-to-end harness is intentionally deferred to C2b.

## Outcome

- Added a server-only refund execution service and Supabase adapter.
- Added forward migration `202608160012_billing_refund_execution.sql`; it was not executed against any database.
- Refund claims derive order, payment, Provider, amount, currency, and idempotency from locked database rows.
- Automatic Provider refunds are limited to unused `SUBSCRIPTION` orders without credit grants. `CREDIT_PACK` returns `REFUND_REQUIRES_MANUAL_REVIEW` before claim creation or Provider construction, preserving the approved request for an audited manual process.
- Provider results must match the original transaction, full paid amount, and CNY currency.
- Deterministic configuration failures before the Provider call release the claim. Once a Provider call may have occurred, the lease is retained and retry reuses the same Provider idempotency key.
- Successful completion atomically records the refund, marks payment/order refunded, and revokes only the subscription, PLAN entitlement, and quotas created by the exact source order.
- The admin refund-review route now executes approved refunds, never executes rejected reviews, and returns safe `MANUAL_REVIEW_REQUIRED` or `RETRY_REQUIRED` state while retaining the persisted review for recovery.
- Refund HTTP semantics distinguish completed refunds (`200`), rejected reviews without execution (`200`), approved requests requiring manual action (`202`), and persisted approvals whose execution must be retried (`503`). Retry responses are top-level failures and never imply that an approved refund completed.
- The billing admin client reads `refundExecution` and shows distinct Chinese feedback for refunded, approved-pending-manual-refund, and approval-saved-execution-failed states. Other admin actions retain their generic response behavior.
- Unexpected execution failures emit only the fixed allowlisted `REFUND_EXECUTION_FAILED` event. Exception messages, secrets, and transaction identifiers are not copied; the expected manual-review branch is not logged as an error.
- Internal refund guards have no direct execute grant; the three service RPCs remain service-role-only.
- Recovery verification checks the exact trigger type, update columns, enablement, function identity, uniqueness, and actual rollback-only RPC behavior for claim/fail/reclaim/complete/replay, amount/currency/state refusal, source-order revocation, and credit manual-review refusal.
- Recovery tooling models an exact 001-012 upgrade, including 012 constraint/index/function/trigger/ACL inventory.

## TDD evidence

- Fix-round RED: 8/12 new route/service checks failed before route wiring, credit manual-review handling, and claim-failure semantics were implemented.
- Focused final suite: 53/53 passed (`refund-execution`, `refund-admin-route`, and `database-drill`).

## Final verification

- `npm.cmd run test:billing`: 363/363 passed.
- `npm.cmd run typecheck`: passed.
- Targeted ESLint for all changed TypeScript files: passed.
- `git diff --check`: passed (line-ending warnings only, no whitespace errors).

No network, remote database, migration execution, reset, push, deployment, production configuration, filing file, or `.env.example` change was performed by C2a.

## Limitations / next task

- Migration 012 has static contract and rollback-only recovery verification in this task; it still requires isolated PostgreSQL execution before any production migration approval.
- Full Mock purchase/refund/invoice/reconciliation integration belongs to C2b.
- Launch remains limited to full refunds; partial refunds are rejected by the full-order amount contract.
- Credit-pack refunds remain manual and must not call an automatic Provider until a separately designed, auditable credit-consumption attribution policy exists.
