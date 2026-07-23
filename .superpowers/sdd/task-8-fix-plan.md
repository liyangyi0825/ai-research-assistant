# Task 8 Multi-stage AI Billing Hardening Plan

**Goal:** Harden task-key isolation, multi-stage continuation authorization, and SSE failure settlement without changing existing API response payloads.

**Architecture:** The AI usage adapter owns task-key construction and continuation policy. Paid continuations authenticate the server-side user and call a service-role-only RPC that verifies the same user, feature, and namespaced root task key already reached `FINALIZED`; only then does the route task run without a second reservation. Legacy-disabled continuations require the same safe root header but retain the previous single-record behavior.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Web Streams/SSE, Supabase PostgreSQL RPCs, Node test runner.

## Global constraints

- Strict red-green-refactor TDD for every behavior change.
- Do not modify `app/api/translate-page/route.ts`.
- Preserve JSON, SSE, ZIP, status-code, and error-payload shapes.
- Do not connect to an online database, push, deploy, or modify unrelated product areas.

### Task 1: Namespaced root task keys and SSE provider errors

**Files:**

- Modify: `tests/billing/ai-usage.test.ts`
- Modify: `lib/billing/ai-usage.ts`

**Interfaces:**

- `taskKey(request, feature, userId, createId)` produces `ai:<userId>:<feature>:<clientRootKey>`.
- `guardStreamingResponse` incrementally reads `data:` JSON lines without changing emitted bytes.

- [x] Add a failing test proving two authenticated users with the same header receive different task keys.
- [x] Add a failing test proving a cross-chunk `data: {"type":"error"}` event releases the reservation.
- [x] Implement the minimum namespacing and incremental SSE error detector.
- [x] Run the adapter tests until green.

### Task 2: Server-verified continuations

**Files:**

- Modify: `tests/billing/credits.test.ts`
- Modify: `tests/billing/migrations.test.ts`
- Modify: `lib/billing/usage-quota.ts`
- Modify: `lib/billing/database.types.ts`
- Modify: `supabase/migrations/202607210003_billing_functions.sql`
- Modify: `tests/billing/ai-usage.test.ts`
- Modify: `lib/billing/ai-usage.ts`

**Interfaces:**

- `BillingUsageRpcAdapter.assertFinalized(userId, taskKey, featureKey)` calls `billing_assert_usage_continuation`.
- `AiUsageOptions.continuation` requires a client root key. When billing is enabled it authenticates and verifies the finalized root before executing without a new reservation.

- [x] Add failing RPC adapter and migration contract tests.
- [x] Implement the service-role-only continuation assertion RPC, database type, permission, error mapping, and adapter method.
- [x] Add failing AI adapter tests for accepted and rejected continuations plus disabled compatibility.
- [x] Replace the trust-based legacy bypass with verified continuation handling.
- [x] Run adapter, quota/RPC, and migration tests until green.

### Task 3: Route and browser operation wiring

**Files:**

- Modify: `tests/billing/ai-route-integration.test.ts`
- Modify: `app/api/concept-explorer/ai/route.ts`
- Modify: `app/api/ppt/generate-section/route.ts`
- Modify: `app/concept-explorer/page.tsx`
- Modify: `app/ppt/page.tsx`

**Interfaces:**

- Concept blocks 1–4 share one browser-generated root `Idempotency-Key`; block 1 settles before blocks 2–4 start.
- PPT batches share one browser-generated root key; batch 0 is metered, later batches are verified continuations.

- [x] Add failing static integration tests for server-side continuation declarations, removal of `legacyUnmetered`, no empty block-2 bypass, and root-key browser headers.
- [x] Move concept block-2 empty handling inside the adapter and mark blocks 2–4 as continuations.
- [x] Mark PPT batches after index 0 as continuations.
- [x] Generate one root UUID per concept/PPT operation and send it on every stage request.
- [x] Run route integration tests and typecheck until green.

### Task 4: Verification and handoff

**Files:**

- Modify: `.superpowers/sdd/task-8-report.md`

- [x] Append the hardening design, TDD evidence, verification results, and the unchanged `translate-page` exception.
- [x] Run targeted adapter/route/migration tests, full billing tests, full tests, typecheck, target ESLint, and `git diff --check`.
- [x] Audit the final diff and prepare the `fix: harden multi-stage ai billing` commit.
