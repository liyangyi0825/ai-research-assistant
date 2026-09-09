# Task 5 Report: Payment Providers

## Scope

Implemented only the Task 5 payment-provider layer:

- Shared payment request, result, status, refund, and webhook types.
- The six-method `PaymentProvider` contract.
- An in-memory `MockPaymentProvider` with opaque test tokens, expiration,
  server-only confirmation, query, close, full refund, idempotency checks, and
  HMAC-SHA256 webhook verification.
- WeChat Pay and Alipay fail-closed configuration skeletons.
- A registry that rejects a mode differing from the server configuration.
  Its Mock instance and signing secret remain stable for the process so payment
  lifecycle operations work across registry acquisitions.

No route, settlement, UI, migration, payment SDK, real credential, QR code,
deployment, filing, or production-database change was made.

## TDD Evidence

The provider contract tests were written first. The initial run failed because
the payment-provider modules did not exist. After the minimum implementation,
the targeted suite passed. A response-shape regression test then failed because
an internal create request was copied into the public result; the result copier
was narrowed and the suite returned to green. The formal-provider configured
error-code test was also observed failing before aligning the skeletons to the
brief's exact `NOT_IMPLEMENTED` code.

An independent pre-commit review found two lifecycle gaps. New failing tests
proved that registry re-acquisition lost Mock state and that a delayed identical
create retry failed after expiration. The registry now retains one process-level
Mock provider and uses overloads to expose its server confirmation method, while
create idempotency is checked before the first-execution expiration rule.

A formal follow-up review found that Mock confirmation read the clock once for
the expiration check and again for `paidAt`. A controlled clock crossing the
expiration boundary reproduced a paid-after-expiry result. `confirmPayment`
now captures one `confirmationNow` value and uses it for both operations, so
the transition and its timestamp are atomic with respect to the injected clock.

## Security and State Rules

- Amounts must be non-negative safe integers in minor units; refunds must be
  positive safe integers and Mock currently supports full refunds only.
- Currency is fixed to `CNY`.
- Mock transitions are limited to `PENDING -> PAID -> REFUNDED` or
  `PENDING -> CLOSED`; duplicate identical operations are idempotent and
  conflicting transitions fail closed.
- Expired Mock payments cannot be confirmed.
- The Mock signing secret is generated at runtime or injected by tests, stored
  in a JavaScript private field, and never included in provider responses.
- HMAC verification compares SHA-256 digests with `timingSafeEqual` and rejects
  missing, malformed, or tampered signatures.
- Unconfigured WeChat Pay and Alipay methods throw
  `PROVIDER_NOT_CONFIGURED`; configured skeletons throw `NOT_IMPLEMENTED`.

## Verification

- `npx.cmd tsx --test tests/billing/payment-providers.test.ts`: 13 passed.
- `npm.cmd run test`: 88 passed.
- `npm.cmd run typecheck`: passed.
- `npx.cmd eslint lib/billing/payments tests/billing/payment-providers.test.ts`:
  passed with zero warnings.
