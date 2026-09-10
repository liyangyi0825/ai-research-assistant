# Monthly and Semester Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one-time WeChat purchases for a ¥19.90/30-day monthly plan and a ¥79.00/150-day semester plan while preventing overlapping subscriptions and preserving the existing credit pack.

**Architecture:** Extend the existing catalog and immutable-order-snapshot flow instead of adding recurring billing. Enforce subscription exclusivity in both TypeScript and PostgreSQL, serialize per-user subscription order creation/settlement, and reuse the existing atomic settlement and refund paths.

**Tech Stack:** Next.js 16.3 App Router, React 19, TypeScript 5, Supabase/PostgreSQL migrations and RPCs, Node test runner through `tsx`, WeChat Native Pay.

**Spec:** `docs/superpowers/specs/2026-09-09-monthly-semester-plans-design.md`

## Global Constraints

- `PRO_MONTHLY`: 1990 minor units, CNY, 30 days, `pro-v1`, no automatic renewal.
- `PRO_SEMESTER`: 7900 minor units, CNY, 150 days, `pro-semester-v1`, no automatic renewal.
- Every semester periodic quota equals the corresponding monthly quota multiplied by five and lasts for the full 150-day period.
- `CREDIT_PACK_100` remains 990 minor units, CNY, and 100 credits.
- An unexpired `ACTIVE` subscription blocks every new subscription order but never blocks a credit-pack order.
- No automatic debit, upgrade, downgrade, queued renewal, prorating, or monthly semester reset.
- Do not commit payment credentials or expose provider payloads, signatures, certificates, private keys, or API v3 keys.
- Production migration, deployment, real-payment acceptance, and public activation remain separate approval gates.

---

### Task 1: Create an isolated implementation worktree and read the Next.js 16 contracts

**Files:**
- Read: `AGENTS.md`
- Read: `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
- Read: `node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md`
- Read: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
- Read: `node_modules/next/dist/docs/01-app/02-guides/forms.md`
- Read: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`
- Read: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`

**Interfaces:**
- Consumes: committed `main` at or after design commit `27b69b1`.
- Produces: isolated branch `codex/monthly-semester-plans` and written implementation notes about async `params`, client fetching, route handlers, and form behavior.

- [ ] **Step 1: Use the worktree workflow**

Read `superpowers:using-git-worktrees`, verify `git status`, and create a worktree for `codex/monthly-semester-plans` without moving or deleting user files.

- [ ] **Step 2: Read every listed Next.js document completely**

Record only rules relevant to `app/pricing/page.tsx`, `app/checkout/[productId]/page.tsx`, client-side fetching, and billing route handlers. Do not change code in this step.

- [ ] **Step 3: Establish the baseline**

Run:

```powershell
npm run test:billing
npm run typecheck
npm run lint
```

Expected: exit code 0 for all three commands. If not, stop and diagnose the baseline before feature work.

### Task 2: Approve both subscription products in the admin safety layer

**Files:**
- Modify: `lib/billing/admin.ts`
- Test: `tests/billing/admin.test.ts`

**Interfaces:**
- Consumes: `BillingConfig`, `upsertBillingPlan`, and `upsertBillingProduct`.
- Produces: `APPROVED_SUBSCRIPTION_PLANS` and `APPROVED_PRODUCTS` definitions that accept only the exact monthly, semester, and credit-pack configurations.

- [ ] **Step 1: Write failing admin tests**

Add cases asserting that active `PRO_MONTHLY` is accepted only with:

```ts
{
  code: "PRO",
  name: "Pro",
  billingPeriod: "MONTHLY",
  sku: "PRO_MONTHLY",
  productType: "SUBSCRIPTION",
  priceMinor: 1_990,
  durationDays: 30,
  creditGrant: 0,
  entitlementVersion: "pro-v1",
}
```

Retain the exact semester and credit-pack assertions. Add negative cases for wrong monthly price, duration, plan, entitlement version, and attempts to activate `PRO_YEARLY` or `FREE`.

- [ ] **Step 2: Verify the tests fail for the expected fast-launch rejection**

Run:

```powershell
npx tsx --test --test-name-pattern "monthly.*activation|approved.*catalog" tests/billing/admin.test.ts
```

Expected: the monthly success cases fail with `PLAN_ACTIVATION_NOT_APPROVED` or `PRODUCT_ACTIVATION_NOT_APPROVED`.

- [ ] **Step 3: Implement the exact allowlists**

Replace the single-plan conditional with a keyed definition containing `PRO`/`MONTHLY` and `PRO_SEMESTER`/`SEMESTER`. Extend the product definition with:

```ts
PRO_MONTHLY: {
  name: "Pro Monthly",
  productType: "SUBSCRIPTION",
  priceMinor: 1_990,
  durationDays: 30,
  creditGrant: 0,
  entitlementVersion: "pro-v1",
}
```

Require a non-null plan ID for both subscription SKUs and a null plan ID for `CREDIT_PACK_100`.

- [ ] **Step 4: Run focused tests and commit**

```powershell
npx tsx --test tests/billing/admin.test.ts
git add lib/billing/admin.ts tests/billing/admin.test.ts
git commit -m "feat: approve monthly subscription catalog"
```

Expected: all admin tests pass.

### Task 3: Add the service-level active-subscription order gate

**Files:**
- Modify: `lib/billing/repositories.ts`
- Modify: `lib/billing/orders.ts`
- Test: `tests/billing/orders.test.ts`
- Test: `tests/billing/order-routes.test.ts`

**Interfaces:**
- Consumes: `BillingProduct.productType`, authenticated `CreateOrderInput.userId`, and repository failures mapped by `storageFailure`.
- Produces: `BillingRepository.hasActiveSubscription(userId: string, nowIso: string): Promise<boolean>` and `BillingError("ACTIVE_SUBSCRIPTION_EXISTS", ..., 409)`.

- [ ] **Step 1: Write failing service tests**

Extend the in-memory repository with a controllable active-subscription result. Add tests proving:

```ts
await assert.rejects(
  () => createOrder(subscriptionInput, { repository, now: () => now }),
  (error: unknown) =>
    error instanceof BillingError &&
    error.code === "ACTIVE_SUBSCRIPTION_EXISTS" &&
    error.status === 409,
);
assert.equal(repository.orders.length, 0);
```

Also prove an expired subscription does not block, a storage failure maps to `BILLING_STORAGE_UNAVAILABLE`, and `CREDIT_PACK_100` never calls or obeys this gate.

- [ ] **Step 2: Verify the focused tests fail**

```powershell
npx tsx --test --test-name-pattern "active subscription|expired subscription|credit pack.*subscription" tests/billing/orders.test.ts tests/billing/order-routes.test.ts
```

Expected: failures because the repository method and 409 error do not exist.

- [ ] **Step 3: Implement the repository query and service ordering**

Add `gt` and `limit` to `BillingSupabaseQuery` if required by the current client wrapper. Query `billing_subscriptions` for the same user with `status = ACTIVE` and `ends_at > nowIso`, ordered by `ends_at`, limited to one. In `createOrder`, call the gate only after loading the server-owned product and only when `product.productType === "SUBSCRIPTION"`; perform it before generating an order number or inserting an order.

- [ ] **Step 4: Run focused tests and commit**

```powershell
npx tsx --test tests/billing/orders.test.ts tests/billing/order-routes.test.ts
git add lib/billing/repositories.ts lib/billing/orders.ts tests/billing/orders.test.ts tests/billing/order-routes.test.ts
git commit -m "feat: block overlapping subscription orders"
```

### Task 4: Add migration 019 with catalog activation and concurrency-safe database gates

**Files:**
- Create: `supabase/migrations/202609100019_monthly_semester_catalog.sql`
- Modify: `tests/billing/migrations.test.ts`
- Modify: `tests/billing/database-drill.test.ts`
- Modify: `scripts/billing-db-drill/sql/verify.sql`

**Interfaces:**
- Consumes: existing product/plan tables, `billing_orders`, `billing_subscriptions`, the admin upsert RPCs, and the settlement function created by migration 014 and amended by 018.
- Produces: active exact catalog rows, database-side activation allowlists, and per-user serialized subscription order/settlement guards.

- [ ] **Step 1: Write failing migration structure tests**

Assert migration 019 contains exact values for both SKUs, preserves the credit pack, keeps `auto_renew=false`, and rejects every other active SKU. Assert it uses a transaction-scoped per-user advisory lock in both subscription-order insertion and subscription settlement paths, checks unexpired `ACTIVE` subscriptions, and rejects another unexpired `PENDING` subscription order.

- [ ] **Step 2: Add failing database-drill expectations**

Extend `verify.sql` and its test so a rollback-only drill demonstrates:

- first subscription order is accepted;
- a concurrent/equivalent second unexpired pending subscription order is rejected;
- an active subscription rejects a new subscription order;
- an expired subscription permits a new order;
- a credit-pack order remains permitted;
- duplicate settlement cannot create a second subscription or quota set.

- [ ] **Step 3: Verify migration tests fail because migration 019 is absent**

```powershell
npx tsx --test tests/billing/migrations.test.ts tests/billing/database-drill.test.ts
```

- [ ] **Step 4: Implement the migration atomically**

Use `BEGIN`/`COMMIT`. Upsert and validate the `PRO` monthly plan, `PRO_SEMESTER` plan, both products, their entitlement rows, and display metadata. Replace the admin RPC allowlist predicates with exact monthly/semester/credit-pack predicates.

Create a trigger function for subscription order inserts that obtains a transaction advisory lock derived from `NEW.user_id`, ignores expired pending orders, and raises SQLSTATE `23505` with a stable constraint/message identifier when a conflicting pending order or active subscription exists. Obtain the same per-user lock in settlement before creating a subscription, and fail closed if an active subscription already exists. Preserve all existing payment terminal-state and idempotency checks.

- [ ] **Step 5: Map the stable database conflict to the public 409**

In `lib/billing/repositories.ts`, recognize only the migration's stable conflict identifier and throw `BillingError("ACTIVE_SUBSCRIPTION_EXISTS", "An active subscription already exists.", 409)`. Map all unrelated database errors to `BILLING_STORAGE_UNAVAILABLE`.

- [ ] **Step 6: Run migration tests and commit**

```powershell
npx tsx --test tests/billing/migrations.test.ts tests/billing/database-drill.test.ts tests/billing/orders.test.ts
git add supabase/migrations/202609100019_monthly_semester_catalog.sql scripts/billing-db-drill/sql/verify.sql lib/billing/repositories.ts tests/billing/migrations.test.ts tests/billing/database-drill.test.ts tests/billing/orders.test.ts
git commit -m "feat: add monthly and semester catalog migration"
```

### Task 5: Show subscription availability and disable conflicting purchases in the UI

**Files:**
- Modify: `components/billing/PricingProducts.tsx`
- Modify: `components/billing/CheckoutPanel.tsx`
- Modify: `lib/billing/user-pages.ts`
- Test: `tests/billing/user-pages.test.ts`

**Interfaces:**
- Consumes: `/api/billing/products`, `/api/billing/availability`, `/api/billing/summary`, `BillingSummary.subscription`, and the server 409 error.
- Produces: subscription cards with duration/non-renewal copy and a disabled state carrying the current subscription end time.

- [ ] **Step 1: Write failing source and handler tests**

Add tests that the pricing client fetches the billing summary, disables only products whose `productType` is `SUBSCRIPTION` when `summary.subscription` is non-null, keeps credit packs linked, and renders “不自动续费” plus the server-formatted expiry date. Add a checkout test that displays the `ACTIVE_SUBSCRIPTION_EXISTS` message without retrying order creation.

- [ ] **Step 2: Verify the UI tests fail**

```powershell
npx tsx --test --test-name-pattern "active subscription|not auto-renew|subscription purchase" tests/billing/user-pages.test.ts
```

- [ ] **Step 3: Implement minimal UI state**

Fetch the summary alongside products and availability using the existing abort controller. Derive:

```ts
const subscriptionBlocked =
  product.productType === "SUBSCRIPTION" && summary?.subscription !== null;
```

Render the disabled explanation with `summary.subscription.planName` and `endsAt`. Add explicit one-time-payment and no-auto-renew copy to subscription cards. Preserve existing service-owned money and duration values.

- [ ] **Step 4: Run focused tests and commit**

```powershell
npx tsx --test tests/billing/user-pages.test.ts
git add components/billing/PricingProducts.tsx components/billing/CheckoutPanel.tsx lib/billing/user-pages.ts tests/billing/user-pages.test.ts
git commit -m "feat: present subscription purchase rules"
```

### Task 6: Prove settlement, quota, and refund behavior end to end

**Files:**
- Modify: `tests/billing/helpers/mock-billing-state.ts`
- Modify: `tests/billing/mock-e2e.test.ts`
- Modify: `tests/billing/wechat-provider.test.ts`
- Modify: `tests/billing/refund-execution.test.ts`
- Modify only if a failing test exposes a gap: `lib/billing/payments/service.ts`
- Modify only if a failing test exposes a gap: `lib/billing/refunds.ts`
- Modify only if a failing test exposes a gap: `supabase/migrations/202609100019_monthly_semester_catalog.sql`

**Interfaces:**
- Consumes: migration 019 catalog/settlement behavior and the existing verified WeChat payment result.
- Produces: executable acceptance evidence for exact periods, five-times quotas, idempotency, and refund policy.

- [ ] **Step 1: Add monthly and semester end-to-end cases**

For each SKU, create an order from the immutable product snapshot, settle a verified WeChat payment twice, and assert exactly one paid order, one subscription, one entitlement set, and one quota per feature. Assert monthly end time is start plus 30 days and semester end time is start plus 150 days.

- [ ] **Step 2: Add quota relationship assertions**

Build maps keyed by `feature_key` and assert all 13 semester limits equal monthly limits multiplied by five, with identical entitlement keys and no intermediate monthly reset records.

- [ ] **Step 3: Add refund cases**

Assert an entirely unused monthly and semester subscription can complete a full refund and revoke its subscription/entitlements/quotas. Assert any non-released usage causes automatic execution to reject and leaves the request for manual review.

- [ ] **Step 4: Run tests, implement only demonstrated gaps, and commit**

```powershell
npx tsx --test tests/billing/mock-e2e.test.ts tests/billing/wechat-provider.test.ts tests/billing/refund-execution.test.ts
git add tests/billing/helpers/mock-billing-state.ts tests/billing/mock-e2e.test.ts tests/billing/wechat-provider.test.ts tests/billing/refund-execution.test.ts lib/billing/payments/service.ts lib/billing/refunds.ts supabase/migrations/202609100019_monthly_semester_catalog.sql
git commit -m "test: cover subscription payment lifecycle"
```

Do not modify optional implementation files unless a new failing test proves the existing path is insufficient; omit untouched paths from `git add`.

### Task 7: Update operational documentation and run complete verification

**Files:**
- Modify: `docs/billing-fast-launch.md`
- Modify: `docs/billing-setup.md`
- Modify: `docs/billing-operations-runbook.md`
- Modify: `docs/billing-stage-f-acceptance.md`

**Interfaces:**
- Consumes: the final catalog and operational behavior from Tasks 2–6.
- Produces: exact operator instructions and complete local verification evidence.

- [ ] **Step 1: Update documentation**

Document the three active SKUs, prices, durations, quota rules, no-auto-renew behavior, active-subscription 409, refund rules, and the separate approval gates. Remove statements that monthly must remain inactive, without weakening restrictions on yearly/free products.

- [ ] **Step 2: Run focused billing verification**

```powershell
npm run test:billing
```

Expected: zero failed billing tests.

- [ ] **Step 3: Run full repository verification**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0. Existing non-error lint warnings must be reported, not silently described as clean.

- [ ] **Step 4: Review the branch diff for secrets and scope**

```powershell
git status --short
git diff --stat main...HEAD
git diff main...HEAD -- . ':!package-lock.json'
git grep -n -E "API_V3|PRIVATE_KEY|BEGIN (RSA |EC )?PRIVATE KEY|WECHAT_PAY.*=" HEAD -- ':!docs/superpowers/**'
```

Expected: only planned files changed and no real credential material appears.

- [ ] **Step 5: Commit documentation**

```powershell
git add docs/billing-fast-launch.md docs/billing-setup.md docs/billing-operations-runbook.md docs/billing-stage-f-acceptance.md
git commit -m "docs: document subscription plan operations"
```

### Task 8: Prepare artifacts and stop at production approval gates

**Files:**
- Create outside Git: a deployment archive named from the final commit.
- Do not modify production in this task.

**Interfaces:**
- Consumes: a verified clean branch and migration 019.
- Produces: archive path, byte size, SHA-256, migration checksum, commit ID, and a rollback checklist.

- [ ] **Step 1: Request code review**

Use `superpowers:requesting-code-review`, address only evidence-backed findings, and rerun every affected focused test.

- [ ] **Step 2: Prepare a secret-free deployment archive**

Exclude `.git`, `.env*`, credentials, certificates, build output, backups, prior archives, and local tooling binaries. Report archive size and SHA-256 without uploading it.

- [ ] **Step 3: Prepare the production sequence without executing it**

Document these explicit stops:

1. approval to back up and execute migration `202609100019`;
2. read-only verification of catalog, constraints, RPC definitions, and migration history;
3. approval to upload/build/start a canary while the current release remains live;
4. approval to switch production with automatic rollback and without touching staging;
5. approval for controlled monthly and semester real-payment tests;
6. approval to leave both subscription products publicly active.

- [ ] **Step 4: Report and wait**

Provide commit, test totals, warnings, archive checksum, migration checksum, expected production changes, and exact rollback targets. Do not migrate, deploy, push, create orders, scan QR codes, collect payment, or refund without the corresponding explicit authorization.
