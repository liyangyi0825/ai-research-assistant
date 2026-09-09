# Billing Reconciliation Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an administrator-only, read-only internal billing consistency report and default allowlisted security logging without connecting to real payment providers or mutating accounting data.

**Architecture:** A pure engine converts a validated database snapshot into bounded, stably sorted findings. A Supabase service-role repository reads only required columns, existing admin guards expose the report, and a separate logger accepts only fixed payment event fields.

**Tech Stack:** Next.js 16.3 App Router, TypeScript, React 19, Supabase/PostgREST, Node `tsx --test`, ESLint 9.

## Global Constraints

- Work only in the existing `codex/billing-mvp` worktree; never modify or push `main`.
- Do not connect to production, modify a database, run migrations, deploy, or enable real payment.
- Keep `BILLING_FEATURE_ENABLED=false` and `PAYMENT_MODE=mock`; formal Providers remain blocked by `PROVIDER_NOT_IMPLEMENTED`.
- Scope is exactly `INTERNAL_DATABASE_ONLY`; never claim WeChat or Alipay external reconciliation.
- All reconciliation operations are read-only. No insert, update, delete, mutation RPC, repair button, or automatic state change.
- Return at most 200 findings; set `truncated=true` when more exist.
- A webhook is stalled when `updatedAt <= now - 15 minutes`.
- Storage errors and malformed rows fail closed with `BILLING_STORAGE_UNAVAILABLE`; never return a partial healthy report.
- Never expose webhook bodies, `payload_summary`, signatures, headers, tokens, secrets, emails, tax identifiers, user profiles, raw errors, or stacks.
- Billing disabled stops new sales but permits admin reconciliation and verified paid callback settlement.
- Do not modify filing, deployment, Tencent Cloud, Nginx, DNS, or SSL files.
- Never stage `.env.local`, `supabase/.temp`, `.superpowers/sdd/*`, or the content-identical `.env.example` status.

---

### Task 1: Pure Internal Reconciliation Engine

**Files:**
- Create: `lib/billing/reconciliation.ts`
- Create: `tests/billing/reconciliation.test.ts`

**Interfaces:**

```ts
export type ReconciliationCode =
  | "ORDER_EXPIRED_PENDING"
  | "PAID_ORDER_PAYMENT_MISSING"
  | "PAYMENT_ORDER_MISMATCH"
  | "WEBHOOK_STALLED"
  | "SUBSCRIPTION_GRANT_MISSING"
  | "CREDIT_GRANT_MISSING"
  | "REFUND_STATE_MISMATCH";
export type ReconciliationSeverity = "CRITICAL" | "WARNING" | "INFO";
export type ReconciliationFinding = {
  code: ReconciliationCode;
  severity: ReconciliationSeverity;
  entityType: "ORDER" | "PAYMENT" | "WEBHOOK" | "REFUND";
  entityId: string;
  orderNumber: string | null;
  detectedAt: string;
  message: string;
};
export type InternalReconciliationReport = {
  generatedAt: string;
  scope: "INTERNAL_DATABASE_ONLY";
  summary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
    byCode: Record<ReconciliationCode, number>;
  };
  items: ReconciliationFinding[];
  truncated: boolean;
};
export function buildInternalReconciliationReport(input: {
  snapshot: InternalReconciliationSnapshot;
  now: Date;
  maxItems?: number;
}): InternalReconciliationReport;
```

`InternalReconciliationSnapshot` contains arrays for orders, payments, webhook events, subscriptions, credit ledger entries, refund requests, and refund records. Use only identifiers, states, integer amounts, currency, product snapshot type/credit grant, expiration/payment timestamps, refund status, webhook timestamps, subscription source order, and ledger reference fields.

Refund contracts are exact: request status is `PENDING | APPROVED | REJECTED | CANCELLED`; refund record status is `PENDING | SUCCEEDED | FAILED`. A `REFUNDING` order is consistent only when `refund_status` is `REQUESTED` or `PARTIAL` and an `APPROVED` request exists. A `REFUNDED` order is consistent only when `refund_status` is `FULL` or `PARTIAL` and a `SUCCEEDED` refund record exists.

- [ ] **Step 1: Write failing tests for all seven finding codes**

Create one clean fixture and one exact inconsistency per code. Assert code, severity, entity type/ID, fixed message, and the absence of source rows or extra fields.

```ts
assert.deepEqual(new Set(report.items.map((item) => item.code)), new Set([
  "ORDER_EXPIRED_PENDING", "PAID_ORDER_PAYMENT_MISSING",
  "PAYMENT_ORDER_MISMATCH", "WEBHOOK_STALLED",
  "SUBSCRIPTION_GRANT_MISSING", "CREDIT_GRANT_MISSING",
  "REFUND_STATE_MISMATCH",
]));
```

- [ ] **Step 2: Write failing boundary tests**

Cover a webhook exactly 15 minutes old, clean subscription/Credit Pack grants, matching refund state, 201 findings, stable ordering, invalid `maxItems`, malformed dates, negative/non-integer amounts, and missing IDs.

- [ ] **Step 3: Run RED**

```powershell
npx.cmd tsx --test tests/billing/reconciliation.test.ts
```

Expected: FAIL because `lib/billing/reconciliation.ts` is absent.

- [ ] **Step 4: Implement validation and detection**

Malformed input throws `new BillingError("BILLING_STORAGE_UNAVAILABLE", "Billing data is temporarily unavailable.", 503)`. Use maps keyed by order ID. Severity: missing payment, payment mismatch, missing subscription/credit, and refund mismatch are `CRITICAL`; stalled webhook is `WARNING`; expired pending order is `INFO`. Sort by severity rank, code, entity type, then entity ID. Compute summary before slicing.

- [ ] **Step 5: Run GREEN and quality checks**

```powershell
npx.cmd tsx --test tests/billing/reconciliation.test.ts
npm.cmd run typecheck
npx.cmd eslint lib/billing/reconciliation.ts tests/billing/reconciliation.test.ts
git diff --check
```

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- lib/billing/reconciliation.ts tests/billing/reconciliation.test.ts
git commit -m "feat: add internal billing reconciliation engine"
```

---

### Task 2: Read-Only Supabase Snapshot Repository

**Files:**
- Modify: `lib/billing/reconciliation.ts`
- Modify: `tests/billing/reconciliation.test.ts`

**Interfaces:**

```ts
export type ReconciliationRepository = {
  loadSnapshot(): Promise<InternalReconciliationSnapshot>;
};
export function createReconciliationRepository(client: ReconciliationAdminClient): ReconciliationRepository;
export function getReconciliationRepository(): ReconciliationRepository;
export async function generateInternalReconciliationReport(input?: {
  repository?: ReconciliationRepository;
  now?: () => Date;
}): Promise<InternalReconciliationReport>;
```

- [ ] **Step 1: Write a failing query-contract test**

Record `from`, `select`, `order`, and `limit`. Require exactly:

```text
billing_orders: id, order_number, user_id, provider, status, amount_minor, currency, snapshot_product_type, snapshot_credit_grant, expires_at, paid_at, refund_status
billing_payments: id, order_id, user_id, provider, status, amount_minor, currency
billing_webhook_events: id, order_id, provider_event_id, status, created_at, updated_at
billing_subscriptions: id, source_order_id
billing_credit_ledger: id, entry_type, reference_type, reference_id
billing_refund_requests: id, order_id, status
billing_refunds: id, refund_request_id, order_id, status
```

The client type must not require write methods or RPC.

- [ ] **Step 2: Write failing mapping/error tests**

Assert snake_case to camelCase mapping. Any query error, non-array response, or malformed row rejects with `BILLING_STORAGE_UNAVAILABLE`. `generateInternalReconciliationReport` loads once.

- [ ] **Step 3: Run RED**

```powershell
npx.cmd tsx --test tests/billing/reconciliation.test.ts
```

- [ ] **Step 4: Implement the repository**

Use `getSupabaseAdminClient()` only in the default factory. Read all seven sources with `Promise.all`, selecting only listed fields and limiting each to 1000 rows. Do not expose write methods. Validate every result before returning the complete snapshot.

- [ ] **Step 5: Run GREEN, checks, and commit**

```powershell
npx.cmd tsx --test tests/billing/reconciliation.test.ts
npm.cmd run typecheck
npx.cmd eslint lib/billing/reconciliation.ts tests/billing/reconciliation.test.ts
git diff --check
git add -- lib/billing/reconciliation.ts tests/billing/reconciliation.test.ts
git commit -m "feat: read billing reconciliation snapshot"
```

---

### Task 3: Administrator API and Read-Only Page

**Files:**
- Create: `app/api/admin/billing/reconciliation/route.ts`
- Create: `app/admin/billing/reconciliation/page.tsx`
- Create: `components/billing/ReconciliationReportView.tsx`
- Modify: `tests/billing/admin.test.ts`
- Modify: `tests/billing/security-coverage.test.ts`
- Modify: `docs/billing-operations-runbook.md`

**Consumes:** `generateInternalReconciliationReport()` and `InternalReconciliationReport`.

- [ ] **Step 1: Write failing API tests**

Add the route to the admin matrix. Assert a regular user is rejected before the operation spy executes, an admin receives the report, and the module exports GET but no mutation methods.

- [ ] **Step 2: Write failing page tests**

Render a sample report. Require the phrases “内部数据库一致性报告”, “只读报告，不会自动修改账务”, and “不代表已与微信或支付宝完成对账”. Assert no button, form, mutation endpoint, “自动修复”, or “一键修复”.

- [ ] **Step 3: Run RED**

```powershell
npx.cmd tsx --test tests/billing/admin.test.ts tests/billing/security-coverage.test.ts
```

- [ ] **Step 4: Implement the route**

```ts
export async function GET(request: Request) {
  return createAdminBillingHandler({
    operation: () => generateInternalReconciliationReport(),
  })(request);
}
```

Do not export POST, PATCH, PUT, or DELETE.

- [ ] **Step 5: Implement the page and component**

The server page calls `requireBillingAdmin()` before report loading. Render only the public report contract, counts, stable identifiers, and fixed messages. A report failure uses the existing safe admin error behavior and must not render a partial healthy state.

- [ ] **Step 6: Update the runbook**

Document the page/API, seven codes, 200-item limit, manual investigation, no Provider data, and prohibition on automatic state changes.

- [ ] **Step 7: Run GREEN, checks, and commit**

```powershell
npx.cmd tsx --test tests/billing/admin.test.ts tests/billing/security-coverage.test.ts
npm.cmd run typecheck
npx.cmd eslint app/api/admin/billing/reconciliation app/admin/billing/reconciliation components/billing/ReconciliationReportView.tsx tests/billing/admin.test.ts tests/billing/security-coverage.test.ts
git diff --check
git add -- app/api/admin/billing/reconciliation/route.ts app/admin/billing/reconciliation/page.tsx components/billing/ReconciliationReportView.tsx tests/billing/admin.test.ts tests/billing/security-coverage.test.ts docs/billing-operations-runbook.md
git commit -m "feat: add admin billing reconciliation report"
```

---

### Task 4: Allowlisted Billing Security Logger

**Files:**
- Create: `lib/billing/security-logger.ts`
- Create: `tests/billing/security-logger.test.ts`
- Modify: `lib/billing/payments/webhooks.ts`
- Modify: `lib/billing/payments/service.ts`
- Modify: `tests/billing/webhooks.test.ts`
- Modify: `tests/billing/payment-service.test.ts`
- Modify: `docs/billing-security.md`
- Modify: `docs/billing-operations-runbook.md`

**Interfaces:**

```ts
export type BillingSecurityEventCode =
  | "WEBHOOK_SIGNATURE_REJECTED"
  | "WEBHOOK_PARSE_REJECTED"
  | "WEBHOOK_SETTLEMENT_FAILED"
  | "PAYMENT_CREATE_FAILED"
  | "PAYMENT_INTENT_PERSIST_FAILED";
export type BillingSecurityLogEvent = {
  eventCode: BillingSecurityEventCode;
  provider?: "MOCK" | "WECHAT" | "ALIPAY";
  orderNumber?: string;
  providerEventId?: string;
  errorCode?: string;
  status?: string;
};
export type BillingSecurityLogger = { warn(event: BillingSecurityLogEvent): void };
export const billingSecurityLogger: BillingSecurityLogger;
```

- [ ] **Step 1: Write failing logger tests**

Capture the sink. Assert allowed events serialize only declared keys. Runtime/compile-time tests reject `rawBody`, `signature`, `headers`, `privateKey`, `token`, `email`, `taxIdentifier`, `error`, and `stack`. Reject/control-normalize control characters and values over 160 characters.

- [ ] **Step 2: Write failing integration tests**

Webhook invalid signature, parse rejection, and settlement failure each emit one fixed event. Provider create failure and intent persistence failure each emit one fixed event. Serialized logs must exclude sample secrets, raw payload, signature, email, and stack.

- [ ] **Step 3: Run RED**

```powershell
npx.cmd tsx --test tests/billing/security-logger.test.ts tests/billing/webhooks.test.ts tests/billing/payment-service.test.ts
```

- [ ] **Step 4: Implement the logger**

Build a fresh object from known fields; never spread caller input. Output one JSON record prefixed `billing_security_event`. The interface must not accept unknown metadata or raw `Error`.

- [ ] **Step 5: Integrate webhooks and payment creation**

Default both dependency sets to `billingSecurityLogger`. Invalid signatures must not log parsed business fields. Only server-owned or verified identifiers may be logged. Preserve existing safe client errors, intent leases, and callback settlement semantics.

- [ ] **Step 6: Update documentation**

Document the five event codes and that the default sink is server stderr. State explicitly that external alert delivery is not configured and production monitoring is not complete.

- [ ] **Step 7: Run GREEN, checks, and commit**

```powershell
npx.cmd tsx --test tests/billing/security-logger.test.ts tests/billing/webhooks.test.ts tests/billing/payment-service.test.ts
npm.cmd run typecheck
npx.cmd eslint lib/billing/security-logger.ts lib/billing/payments/webhooks.ts lib/billing/payments/service.ts tests/billing/security-logger.test.ts tests/billing/webhooks.test.ts tests/billing/payment-service.test.ts
git diff --check
git add -- lib/billing/security-logger.ts lib/billing/payments/webhooks.ts lib/billing/payments/service.ts tests/billing/security-logger.test.ts tests/billing/webhooks.test.ts tests/billing/payment-service.test.ts docs/billing-security.md docs/billing-operations-runbook.md
git commit -m "feat: add allowlisted billing security logs"
```

---

### Task 5: Whole-Stage Verification and Final Review

**Files:** Modify only for a verified Stage E defect, with a focused regression test.

- [ ] **Step 1: Run the complete gate**

```powershell
npm.cmd test
npm.cmd run typecheck
npx.cmd eslint lib/billing app/api/admin/billing app/admin/billing components/billing tests/billing
npm.cmd run build
npm.cmd audit --audit-level=low
git diff --check
```

- [ ] **Step 2: Verify scope**

```powershell
git status --short
git diff --name-only -- components/SiteFilingFooter.tsx public/beian-police.svg app/layout.tsx .github
git diff --cached --name-only
```

Expected: no filing/deployment diff and no ignored/scratch files staged.

- [ ] **Step 3: Independent whole-stage review**

Review admin authorization, repository read-only shape, all seven rules, 15-minute boundary, truncation/count semantics, malformed-row failure, sensitive output, logger allowlist, and absence of repair actions.

- [ ] **Step 4: Report remaining blockers**

Retain: real WeChat/Alipay Providers, external alert delivery, merchant statement reconciliation, approved owners/thresholds/response times, backup/restore and financial drills, and professional legal review.

- [ ] **Step 5: Stop locally**

Do not push, merge, modify production, activate billing, or deploy without a new explicit instruction.
