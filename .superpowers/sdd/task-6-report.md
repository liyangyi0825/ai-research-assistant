# Task 6 Report: Payment confirmation, webhook verification, and idempotent settlement

## Scope

Implemented Task 6 only. No real payment credentials, live database access,
deployment, push, UI, AI API, or filing changes were performed.

## Implementation

- Added `createOrderPayment(userId, orderId)` using the owned database order
  snapshot as the only source for order number, provider, integer-minor-unit
  amount, currency, status, and expiration.
- Added a deterministic payment request idempotency key and enforced the
  server feature flag, production Mock authorization, and server payment mode.
- Added webhook processing with the following trust boundary:
  1. preserve the exact `request.text()` body and compute SHA-256;
  2. verify the signature before trusting business fields;
  3. persist invalid signatures or parse failures as hash-only `FAILED`
     audits under `rejected:<sha256(raw_body)>`;
  4. parse valid callbacks and persist a complete `RECEIVED` event;
  5. invoke the existing nine-argument `billing_settle_paid_order` RPC;
  6. on failure, update only a still-`RECEIVED` event to `FAILED`, rereading
     and preserving a concurrent `PROCESSED` terminal state.
- Added identical replay success and changed-payload conflict handling.
- Added Mock confirmation that requires an authenticated administrator or
  allowlisted test user, verifies order ownership, creates a stable HMAC-signed
  callback, and routes it through `processPaymentWebhook`. It never writes a
  database order to `PAID` or grants entitlements directly.
- Added Next.js 16 POST routes for Mock confirmation and provider webhooks.
- Updated the webhook schema/types so rejected audits may have null business
  fields while every `RECEIVED`, `PROCESSING`, or `PROCESSED` row must remain
  complete and signature-valid. The settlement RPC signature was not changed.
- Updated `docs/billing-database.md` with the verify-before-trust and rejected
  audit contract.

## TDD evidence

- RED: migration contract rejected the original non-null webhook business
  columns; GREEN: the conditional completeness contract passed.
- RED: payment service module and behaviors were absent; GREEN: snapshot,
  state, expiration, mode, feature/runtime access, and storage failure tests
  passed.
- RED: webhook/route modules were absent; GREEN: verification, hash-only audit,
  exact nine-argument settlement, replay, mismatch, terminal-state race,
  raw-body route, authorization, ownership, and Mock pipeline tests passed.
- RED: production administrator elevation was missing; GREEN: the handler now
  verifies database administrator status before the production access check.
- RED: verifier-classified signature exceptions left no audit; GREEN: those
  exceptions now create the same hash-only rejected audit as a `false` result.

## Verification

- Task 6 focused tests: PASS.
- Billing test suite: PASS.
- Full repository test suite: PASS.
- `npm.cmd run typecheck`: PASS.
- Task 6 targeted ESLint: PASS.
- `git diff --check`: PASS.
- Full-repository ESLint remains non-zero because of pre-existing, unrelated
  errors in legacy UI/API/generated worker/test helper files. Task 6 files have
  no ESLint errors.

## Review disposition and limitations

- A read-only security review found no Critical issue. Its service-level
  feature/runtime authorization and verifier-exception audit findings were
  fixed before submission.
- Payment creation now uses the service-only `billing_payment_intents` table
  and four atomic claim/complete/fail/Mock-confirm RPCs. Cross-instance callers
  reuse one persisted provider result; only the current database lease holder
  can call the Provider, and safe failure codes permit retry after failure or
  lease expiry without persisting provider exception text.
- Mock confirmation reads the durable intent and signs that persisted paid
  result, so confirmation no longer requires the creating Provider instance's
  in-memory Map.
- Webhook routes validate provider/config mode before body access and enforce a
  64 KiB byte limit both from `Content-Length` and while streaming. Oversized
  streams are cancelled and return `WEBHOOK_BODY_TOO_LARGE` (413).
- PostgreSQL row locks, simultaneous callbacks, and migration execution were
  not tested against a database because this task explicitly prohibited live
  database access. They must be verified later against a local or fully
  isolated disposable Supabase instance.

## Final review follow-up

- Added a RED/GREEN regression for equivalent timestamp encodings such as
  `2026-07-22T03:30:00+00:00` and `2026-07-22T03:30:00.000Z`. The service now
  compares epoch instants and normalizes persisted/provider timestamps to ISO.
- `billing_complete_payment_intent` compares the Provider expiry as
  `TIMESTAMPTZ` against the stored order snapshot for every completion path and
  never overwrites that snapshot.
- Removed application `p_now` from the claim RPC. It refreshes PostgreSQL
  `clock_timestamp()` after acquiring both the order and intent locks before
  evaluating or issuing the 30-second lease.
- The lease is intentionally not renewed yet. Documentation now records the
  deterministic Provider idempotency key as the second line of defense when a
  slow Provider call outlives the lease.
