# Task 4 Report

## Status

Completed locally in the isolated `codex/billing-mvp` worktree. No production
database access, deployment, push, payment confirmation, webhook, UI,
middleware, AI API, or filing changes were made.

## Delivered

- Public product listing backed by an injectable Supabase admin repository;
  only enabled, sellable fields are returned.
- Secure order creation with server-owned integer-minor-unit pricing, currency,
  product/plan/version data, immutable entitlement snapshots, unique order
  numbers, and a 30-minute default expiry.
- Agreement, product, provider, ownership, and storage failure handling using
  fail-closed `BillingError` responses.
- `GET /api/billing/products`, `POST /api/billing/orders`, and
  `GET /api/billing/orders/[id]` Route Handlers. The create route executes
  authentication, feature/Mock access checks, atomic database rate limiting,
  strict body parsing, product lookup, and order insertion in that order.
- Next.js 16 asynchronous route params and authenticated owner-only order reads.

## Security Notes

- The create-order body accepts exactly `productId`, `provider`, and
  `acceptedAgreementVersion`; `amount`, `currency`, and client `userId` are
  rejected. The domain service independently ignores forged pricing fields and
  always snapshots price/currency from the active database product.
- `snapshot_entitlements` uses the snake-case JSON shape consumed by the Task 2
  settlement RPC (`feature_key`, `credit_grant`, and version/configuration
  fields).
- Supabase result errors, thrown client/network errors, and malformed database
  rows are converted to a non-sensitive 503 response.

## TDD Evidence

- Domain RED: the new suite failed because `lib/billing/orders` did not exist.
- Domain GREEN: all 59 Billing tests passed after the minimal product, order,
  and repository implementation.
- Snapshot regression RED: two assertions failed when entitlement snapshots
  used camelCase instead of the Task 2 SQL contract; both passed after mapping
  the persisted JSON to snake_case.
- Route RED: the route suite failed because the Billing Route Handlers did not
  exist.
- Route GREEN: all 67 Billing tests passed after implementing the three routes.
- Fail-closed regression RED: a thrown Supabase client exception leaked its raw
  message; the targeted suite passed 13/13 after adding a repository boundary.

## Verification

- `node_modules\.bin\tsx.cmd --test tests/billing/orders.test.ts tests/billing/order-routes.test.ts`: 21 passed, 0 failed.
- `npm.cmd test`: 70 passed, 0 failed.
- `npm.cmd run typecheck`: exit 0.
- Targeted ESLint across all Task 4 TypeScript files: exit 0.
- `git diff --cached --check`: exit 0.

## Concerns

- Repository behavior is covered with a complete injectable Supabase query
  double; by instruction, no live or online database integration was run.
