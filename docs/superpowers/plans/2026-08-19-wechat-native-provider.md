# WeChat Pay Native Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a production-shaped, offline-testable WeChat Pay API v3 Native provider while keeping billing disabled and making no live WeChat, production database, deployment, or credential changes.

**Architecture:** Keep `WechatPayProvider` as the billing integration boundary and split cryptography, bounded HTTP transport, notification decoding, and DTO mapping into focused modules. Use Node's built-in `crypto`, injectable clocks/nonces/transport, byte-exact signature inputs, and the existing durable order/webhook/refund state machines; all tests use generated test-only keys and in-memory HTTP responses.

**Tech Stack:** TypeScript 5, Node.js 20 crypto/fetch APIs, Next.js 16.3 project conventions, `tsx --test`, ESLint 9, existing billing services and `BillingError`.

## Global Constraints

- Implement WeChat Native QR payments only; do not add JSAPI, Mini Program, H5, APP, automatic renewal, automatic debit, Alipay, profit sharing, or certificate auto-download.
- Prefer WeChat Pay public-key verification and retain platform-certificate verification compatibility; exactly one verifier mode must be configured.
- Keep `BILLING_FEATURE_ENABLED=false`; do not activate products, switch `PAYMENT_MODE`, add real credentials, call WeChat, deploy, push `main`, or connect to any production database.
- Never log or return merchant private keys, API v3 keys, public-key material, signatures, nonces, raw callbacks, decrypted resources, `code_url`, Authorization headers, or unfiltered response bodies.
- Use integer fen and currency `CNY`; never use floating-point currency arithmetic.
- Verify every WeChat response, including error responses, before trusting its body.
- Preserve the original webhook body exactly for signature verification and decrypt only after successful verification.
- Unknown verifier identifiers, ambiguous configuration, malformed cryptography, contract mismatches, and unapproved SQLSTATE/HTTP failures fail closed.
- Use no new runtime dependency unless the plan is amended and separately approved; use `node:crypto` and injected `fetch`-compatible transport.
- Read relevant Next.js 16.3 documentation under `node_modules/next/dist/docs/` before changing any route handler; this plan does not require a route change.
- Do not stage the existing `.env.example` user modification unless Task 7 confirms its exact intended billing-only additions and the user change is preserved line-for-line.

## File Structure

- `lib/billing/payments/wechat-config.ts`: parse and validate WeChat-only secrets and verifier mode without exposing values.
- `lib/billing/payments/wechat-crypto.ts`: canonical request signing, signed response/webhook verification, and AES-256-GCM resource decryption.
- `lib/billing/payments/wechat-transport.ts`: injectable bounded transport, timeout handling, response size limits, and signed response verification.
- `lib/billing/payments/wechat-mapping.ts`: strict WeChat API and notification DTO parsing and normalization.
- `lib/billing/payments/wechat.ts`: `PaymentProvider` orchestration for Native create, query, close, refund, verify, and parse.
- `lib/billing/payments/types.ts`: server-owned description and merchant-order reference required by Native requests and safe query/close recovery.
- `lib/billing/payments/service.ts`: pass the immutable order product snapshot into provider creation.
- `lib/billing/config.ts`: expose validated WeChat provider configuration and remove only the completed WeChat implementation gate.
- `lib/billing/payments/registry.ts`: construct the provider from validated configuration.
- `tests/billing/wechat-crypto.test.ts`: deterministic signing, verification, tamper, replay, and AES fixtures.
- `tests/billing/wechat-transport.test.ts`: timeout, size, signature, and error-classification tests with an in-memory transport.
- `tests/billing/wechat-provider.test.ts`: create/query/close/refund and callback mapping tests.
- Existing billing tests: integration regressions for configuration, startup, registry, service, webhooks, refunds, and secret scans.

---

### Task 1: Validated Configuration and Server-Owned Payment References

**Files:**
- Create: `lib/billing/payments/wechat-config.ts`
- Modify: `lib/billing/payments/types.ts`
- Modify: `lib/billing/payments/service.ts`
- Modify: `lib/billing/config.ts`
- Test: `tests/billing/config.test.ts`
- Test: `tests/billing/payment-service.test.ts`
- Test: `tests/billing/payment-providers.test.ts`

**Interfaces:**
- Consumes: existing `BillingError`, `BillingConfig`, `PaymentProvider`, order snapshot amount/currency/expiry.
- Produces: `WechatPayConfig`, `loadWechatPayConfig(env)`, `PaymentReferenceInput`, and a product description passed from the immutable order snapshot.

- [ ] **Step 1: Write configuration and DTO failure tests**

Add tests that require exact verifier exclusivity, key length, PEM parsing, variable-name-only errors, and server-owned references:

```ts
assert.throws(
  () => loadWechatPayConfig({
    ...validWechatEnvironment(),
    WECHAT_PAY_PUBLIC_KEY_ID: "PUB_KEY_ID_1",
    WECHAT_PAY_PUBLIC_KEY: testPublicKey,
    WECHAT_PAY_PLATFORM_CERT: testCertificate,
  }),
  (error: unknown) => billingErrorCode(error) === "PAYMENT_CONFIGURATION_CONFLICT",
);

const reference: PaymentReferenceInput = {
  orderNumber: "BILL-ORDER-1",
  providerTransactionId: null,
};
assert.equal(reference.orderNumber, "BILL-ORDER-1");
```

Extend the payment-service fixture so `findOwnedOrder` returns `snapshotProductName: "Pro Semester"`, then assert the provider receives `description: "Pro Semester"` and never receives a client-supplied description.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
npm.cmd exec -- tsx --test tests/billing/config.test.ts tests/billing/payment-service.test.ts tests/billing/payment-providers.test.ts
```

Expected: failure because `wechat-config.ts`, `WechatPayConfig`, the new reference shape, and `description` do not exist.

- [ ] **Step 3: Implement the configuration and type boundary**

Define exact interfaces:

```ts
export type WechatVerifierConfig =
  | { mode: "PUBLIC_KEY"; keyId: string; publicKeyPem: string }
  | { mode: "PLATFORM_CERTIFICATE"; serialNumber: string; certificatePem: string };

export type WechatPayConfig = {
  mchId: string;
  appId: string;
  apiV3Key: Buffer;
  merchantPrivateKeyPem: string;
  merchantCertificateSerialNumber: string;
  notifyUrl: string;
  verifier: WechatVerifierConfig;
};

export function loadWechatPayConfig(
  env: Readonly<Record<string, string | undefined>>,
): WechatPayConfig;
```

Validate the API v3 key as exactly 32 UTF-8 bytes, validate private/public PEM material with `createPrivateKey`/`createPublicKey` or `X509Certificate`, require HTTPS notification URL outside test-only injected unit fixtures, and report identifiers rather than secret values.

Change the payment inputs to:

```ts
export type CreatePaymentInput = {
  orderNumber: string;
  description: string;
  amountMinor: number;
  currency: PaymentCurrency;
  expiresAt: string;
  idempotencyKey: string;
};

export type PaymentReferenceInput = {
  orderNumber: string;
  providerTransactionId: string | null;
};
```

Add `snapshotProductName` to `PaymentOrderSnapshot`, select it from the existing immutable order snapshot, normalize it to 1–127 Unicode characters, and pass it as `description`. Update Mock provider tests and call sites with owned order numbers rather than manufacturing provider-only references.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run the Step 2 command. Expected: all selected tests pass and no secret value appears in thrown messages.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- lib/billing/payments/wechat-config.ts lib/billing/payments/types.ts lib/billing/payments/service.ts lib/billing/config.ts tests/billing/config.test.ts tests/billing/payment-service.test.ts tests/billing/payment-providers.test.ts
git diff --cached --check
git commit -m "feat: validate WeChat payment configuration"
```

### Task 2: API v3 Signing, Verification, and Resource Decryption

**Files:**
- Create: `lib/billing/payments/wechat-crypto.ts`
- Create: `tests/billing/wechat-crypto.test.ts`

**Interfaces:**
- Consumes: `WechatVerifierConfig` and test-only RSA/certificate fixtures generated in memory.
- Produces: `signWechatRequest`, `verifyWechatSignature`, `verifyWechatTimestamp`, and `decryptWechatResource`.

- [ ] **Step 1: Write deterministic cryptography tests**

Use test-only RSA keys generated with `generateKeyPairSync("rsa", { modulusLength: 2048 })`. Freeze timestamp and nonce, assert the canonical message includes method, path plus query, timestamp, nonce, exact body, and trailing newline:

```ts
const signed = signWechatRequest({
  method: "POST",
  pathWithQuery: "/v3/pay/transactions/native?x=1",
  body: "{\"amount\":{\"total\":7900}}",
  timestamp: 1_787_073_600,
  nonce: "nonce-1",
  mchId: "1900000001",
  certificateSerialNumber: "MERCHANT_SERIAL",
  privateKeyPem,
});
assert.equal(
  signed.message,
  "POST\n/v3/pay/transactions/native?x=1\n1787073600\nnonce-1\n{\"amount\":{\"total\":7900}}\n",
);
assert.match(signed.authorization, /^WECHATPAY2-SHA256-RSA2048 /);
```

Add public-key and certificate verification tests, byte/body/query tampering rejection, unknown key-ID rejection, ±300-second timestamp boundary tests, deterministic AES-256-GCM decrypt success, and failures for wrong key/nonce/AAD/tag.

- [ ] **Step 2: Run the crypto test and confirm RED**

```powershell
npm.cmd exec -- tsx --test tests/billing/wechat-crypto.test.ts
```

Expected: module-not-found failure for `wechat-crypto.ts`.

- [ ] **Step 3: Implement the cryptographic primitives**

Export these exact signatures:

```ts
export function signWechatRequest(input: WechatRequestSigningInput): {
  authorization: string;
  message: string;
};

export function verifyWechatSignature(input: {
  timestamp: string;
  nonce: string;
  body: string;
  signatureBase64: string;
  verifierId: string;
  verifier: WechatVerifierConfig;
}): void;

export function verifyWechatTimestamp(input: {
  timestamp: string;
  now: Date;
  toleranceSeconds: number;
}): void;

export function decryptWechatResource(input: {
  apiV3Key: Buffer;
  nonce: string;
  associatedData: string;
  ciphertextBase64: string;
}): string;
```

Use `RSA-SHA256`, constant validation branches, `Buffer.from(value, "base64")`, and `createDecipheriv("aes-256-gcm", key, nonce)` with the final 16 bytes as the authentication tag. Throw fixed `BillingError` codes such as `WECHAT_SIGNATURE_INVALID`, `WECHAT_VERIFIER_UNKNOWN`, `WECHAT_TIMESTAMP_INVALID`, and `WECHAT_RESOURCE_INVALID`; never include cryptographic inputs in messages.

- [ ] **Step 4: Run crypto tests and confirm GREEN**

Run the Step 2 command. Expected: all signing, verifier-mode, tamper, replay, and AES tests pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- lib/billing/payments/wechat-crypto.ts tests/billing/wechat-crypto.test.ts
git diff --cached --check
git commit -m "feat: add WeChat API v3 cryptography"
```

### Task 3: Signed and Bounded WeChat HTTP Transport

**Files:**
- Create: `lib/billing/payments/wechat-transport.ts`
- Create: `tests/billing/wechat-transport.test.ts`

**Interfaces:**
- Consumes: `WechatPayConfig`, `signWechatRequest`, `verifyWechatSignature`, injected clock/nonce/fetch.
- Produces: `WechatHttpClient.request<T>()` returning a verified status/body pair and fixed transient/permanent failures.

- [ ] **Step 1: Write transport boundary tests**

Create an injected fake fetch that records URL/method/body/headers and returns signed responses. Cover verified 2xx JSON, verified 4xx mapping, unsigned/tampered response rejection, 5xx transient classification, abort timeout, connection failure, body larger than 256 KiB, non-JSON success, and redirects disabled.

```ts
const response = await client.request<CreateNativeResponse>({
  method: "POST",
  pathWithQuery: "/v3/pay/transactions/native",
  body: { appid: "wx-test", mchid: "1900000001" },
});
assert.equal(response.body.code_url, "weixin://wxpay/test-only");
assert.equal(fetchCalls[0]?.headers.get("Authorization")?.startsWith("WECHATPAY2-"), true);
```

- [ ] **Step 2: Run the transport test and confirm RED**

```powershell
npm.cmd exec -- tsx --test tests/billing/wechat-transport.test.ts
```

Expected: module-not-found failure for `wechat-transport.ts`.

- [ ] **Step 3: Implement the injected client**

Define:

```ts
export type WechatFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export class WechatHttpClient {
  constructor(input: {
    config: WechatPayConfig;
    fetchImpl?: WechatFetch;
    now?: () => Date;
    nonce?: () => string;
    timeoutMs?: number;
    maxResponseBytes?: number;
  });

  request<T>(input: {
    method: "GET" | "POST";
    pathWithQuery: string;
    body?: Readonly<Record<string, unknown>>;
  }): Promise<{ status: number; body: T }>;
}
```

Require paths to begin with `/v3/`, construct only `https://api.mch.weixin.qq.com${pathWithQuery}`, use `redirect: "error"`, abort after 10 seconds by default, read the response stream with a 256 KiB default limit, require all WeChat signature headers, verify before JSON parsing, and map only connection/abort/verified 5xx to fixed retryable `BillingError` codes. A verified 4xx maps from an allowlist of WeChat codes to fixed local errors without exposing `message` or raw body.

- [ ] **Step 4: Run transport and crypto tests and confirm GREEN**

```powershell
npm.cmd exec -- tsx --test tests/billing/wechat-crypto.test.ts tests/billing/wechat-transport.test.ts
```

Expected: all selected tests pass; fake fetch is the only network boundary invoked.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- lib/billing/payments/wechat-transport.ts tests/billing/wechat-transport.test.ts
git diff --cached --check
git commit -m "feat: add bounded WeChat payment transport"
```

### Task 4: Notification Verification, Decryption, and Strict Mapping

**Files:**
- Create: `lib/billing/payments/wechat-mapping.ts`
- Modify: `lib/billing/payments/wechat.ts`
- Create: `tests/billing/wechat-provider.test.ts`
- Test: `tests/billing/webhooks.test.ts`

**Interfaces:**
- Consumes: Task 1 config, Task 2 timestamp/signature/decrypt functions, `PaymentWebhookInput`.
- Produces: functional `WechatPayProvider.verifyWebhook`, `WechatPayProvider.parseWebhook`, and `parseWechatPaidNotification`.

- [ ] **Step 1: Write callback RED tests**

Build a deterministic encrypted notification containing `TRANSACTION.SUCCESS`, then sign the exact outer JSON. Assert success maps to:

```ts
{
  eventId: "EVT-1",
  eventType: "PAYMENT.PAID",
  providerTransactionId: "4200000000001",
  orderNumber: "BILL-ORDER-1",
  amountMinor: 7900,
  currency: "CNY",
  occurredAt: "2026-08-19T10:00:00.000Z",
}
```

Add failures for missing headers, stale timestamp, unknown verifier ID, altered whitespace/body bytes, wrong AAD/tag, non-success event type/state, wrong mchid/appid, non-integer/negative amount, non-CNY currency, malformed dates, and oversized callbacks. Also call `parseWebhook` directly without first calling `verifyWebhook` and assert it succeeds only because `parseWebhook` independently repeats verification.

- [ ] **Step 2: Run callback tests and confirm RED**

```powershell
npm.cmd exec -- tsx --test tests/billing/wechat-provider.test.ts tests/billing/webhooks.test.ts
```

Expected: callback tests fail because the provider skeleton returns `NOT_IMPLEMENTED`.

- [ ] **Step 3: Implement strict notification mapping**

Define provider construction and mapper boundaries:

```ts
export type WechatPayProviderDependencies = {
  config: WechatPayConfig;
  httpClient: WechatHttpClient;
  now?: () => Date;
  webhookToleranceSeconds?: number;
  maxWebhookBytes?: number;
};

export function parseWechatPaidNotification(input: {
  decryptedResource: string;
  expectedMchId: string;
  expectedAppId: string;
  eventId: string;
  eventType: string;
}): PaymentWebhookEvent;
```

`verifyWebhook` must return `true` only after required header normalization, body-size check, timestamp check, verifier-ID selection, and RSA verification. `parseWebhook` must repeat verification itself rather than relying on mutable in-memory verification state, parse the outer event, decrypt its resource, and validate all business fields. Normalize header names case-insensitively but reject duplicate/ambiguous values supplied through aliases.

- [ ] **Step 4: Run callback and existing webhook tests and confirm GREEN**

Run the Step 2 command. Expected: all selected tests pass and duplicate delivery remains handled by the existing webhook persistence layer.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- lib/billing/payments/wechat-mapping.ts lib/billing/payments/wechat.ts tests/billing/wechat-provider.test.ts tests/billing/webhooks.test.ts
git diff --cached --check
git commit -m "feat: verify WeChat payment notifications"
```

### Task 5: Native Create, Query, and Close Operations

**Files:**
- Modify: `lib/billing/payments/wechat-mapping.ts`
- Modify: `lib/billing/payments/wechat.ts`
- Test: `tests/billing/wechat-provider.test.ts`
- Test: `tests/billing/payment-service.test.ts`

**Interfaces:**
- Consumes: `WechatHttpClient`, backend-owned `CreatePaymentInput`, `PaymentReferenceInput`.
- Produces: Native create/query/close implementations with verified `PaymentResult` mapping.

- [ ] **Step 1: Write operation RED tests**

Assert Native create sends exactly `appid`, `mchid`, bounded `description`, `out_trade_no`, `time_expire`, `notify_url`, and `{ total, currency: "CNY" }`; maps verified `code_url` to `paymentToken`; and rejects response contract drift. Add query mapping for `SUCCESS`, `NOTPAY`, `USERPAYING`, `CLOSED`, `PAYERROR`, and `REFUND`, plus close tests for pending close, already-paid query recovery, timeout-followed-by-query, and order/transaction/amount/currency/mchid/appid mismatches.

```ts
assert.deepEqual(recorded.body, {
  appid: "wx-test",
  mchid: "1900000001",
  description: "Pro Semester",
  out_trade_no: "BILL-ORDER-1",
  time_expire: "2026-08-19T10:30:00+08:00",
  notify_url: "https://billing.example.test/api/billing/webhooks/wechat",
  amount: { total: 7900, currency: "CNY" },
});
```

- [ ] **Step 2: Run provider/service tests and confirm RED**

```powershell
npm.cmd exec -- tsx --test tests/billing/wechat-provider.test.ts tests/billing/payment-service.test.ts
```

Expected: create/query/close assertions fail because these methods still call the unavailable skeleton path.

- [ ] **Step 3: Implement Native operations and contract validation**

Implement create at `POST /v3/pay/transactions/native`, query by transaction ID when present or `/v3/pay/transactions/out-trade-no/{encodedOrder}?mchid={encodedMchId}`, and close by owned merchant order number. Return only validated DTOs. For create uncertainty, query the same merchant order number; for close timeout/state conflict, query before choosing `CLOSED` or `PAID`. Bound description by Unicode code points without splitting a surrogate pair and require expiry strictly in the future.

- [ ] **Step 4: Run focused operation tests and confirm GREEN**

Run the Step 2 command. Expected: all selected tests pass, including recovery and mismatch cases.

- [ ] **Step 5: Commit Task 5**

```powershell
git add -- lib/billing/payments/wechat-mapping.ts lib/billing/payments/wechat.ts tests/billing/wechat-provider.test.ts tests/billing/payment-service.test.ts
git diff --cached --check
git commit -m "feat: add WeChat Native payment operations"
```

### Task 6: Idempotent Full Refund Operation

**Files:**
- Modify: `lib/billing/payments/wechat-mapping.ts`
- Modify: `lib/billing/payments/wechat.ts`
- Test: `tests/billing/wechat-provider.test.ts`
- Test: `tests/billing/refund-execution.test.ts`

**Interfaces:**
- Consumes: existing approved refund service, stable `RefundPaymentInput.idempotencyKey`, verified transaction reference.
- Produces: stable `out_refund_no`, verified refund response, safe retry/query recovery, existing `RefundResult`.

- [ ] **Step 1: Write refund RED tests**

Assert the provider posts to `/v3/refund/domestic/refunds` with backend amount/currency, derives a deterministic 32-character merchant refund number from SHA-256 of the durable idempotency key, uses the same value on retries, maps `SUCCESS`, treats `PROCESSING` as retryable/uncertain, queries after timeouts, and rejects transaction/refund/amount/currency mismatches. Assert Credit Pack requests remain stopped by the existing manual-review policy before provider invocation.

- [ ] **Step 2: Run refund tests and confirm RED**

```powershell
npm.cmd exec -- tsx --test tests/billing/wechat-provider.test.ts tests/billing/refund-execution.test.ts
```

Expected: WeChat refund cases fail because `refundPayment` remains unavailable.

- [ ] **Step 3: Implement full-refund request and uncertainty recovery**

Send:

```ts
{
  transaction_id: input.providerTransactionId,
  out_refund_no: stableWechatRefundNumber(input.idempotencyKey),
  reason: "USER_APPROVED_FULL_REFUND",
  amount: {
    refund: input.amountMinor,
    total: input.amountMinor,
    currency: "CNY",
  },
}
```

On a timeout/connection/verified 5xx, query `/v3/refund/domestic/refunds/{out_refund_no}`. Return `SUCCEEDED` only for a verified `SUCCESS` response whose identifiers and amounts exactly match. Preserve the existing refund lease when the external result remains uncertain.

- [ ] **Step 4: Run focused refund tests and confirm GREEN**

Run the Step 2 command. Expected: all selected tests pass, with no automatic Credit Pack refund.

- [ ] **Step 5: Commit Task 6**

```powershell
git add -- lib/billing/payments/wechat-mapping.ts lib/billing/payments/wechat.ts tests/billing/wechat-provider.test.ts tests/billing/refund-execution.test.ts
git diff --cached --check
git commit -m "feat: add WeChat full refund operation"
```

### Task 7: Registry, Startup Gate, and Safe Environment Example

**Files:**
- Modify: `lib/billing/config.ts`
- Modify: `lib/billing/payments/registry.ts`
- Modify: `.env.example`
- Test: `tests/billing/config.test.ts`
- Test: `tests/billing/startup.test.ts`
- Test: `tests/billing/payment-providers.test.ts`
- Test: `tests/billing/security-coverage.test.ts`

**Interfaces:**
- Consumes: completed `WechatPayProvider`, `loadWechatPayConfig`, current billing feature/runtime gates.
- Produces: config-backed provider construction while leaving billing disabled by default; Alipay remains blocked as unimplemented.

- [ ] **Step 1: Write startup and registry RED tests**

Assert `BILLING_FEATURE_ENABLED=true` plus `PAYMENT_MODE=wechat` accepts exactly one complete verifier mode and constructs a configured provider; missing/conflicting/malformed WeChat variables reject startup; `PAYMENT_MODE=alipay` still throws `PROVIDER_NOT_IMPLEMENTED`; default disabled configuration exposes no purchase access. Add a recursive error/log scan using sentinel secret values and assert none are present.

- [ ] **Step 2: Run configuration and registry tests and confirm RED**

```powershell
npm.cmd exec -- tsx --test tests/billing/config.test.ts tests/billing/startup.test.ts tests/billing/payment-providers.test.ts tests/billing/security-coverage.test.ts
```

Expected: WeChat-enabled startup still fails through `assertProviderImplemented` and registry still passes only a boolean.

- [ ] **Step 3: Wire validated configuration without enabling billing**

Extend `BillingConfig` with a secret-bearing server-only `wechat: WechatPayConfig | null` value or an equivalent lazy server-only loader, ensure no client module imports it, change registry construction to `new WechatPayProvider({ config, httpClient })`, and change the implementation gate to:

```ts
function assertProviderImplemented(mode: PaymentMode): void {
  if (mode === "mock" || mode === "wechat") return;
  throw new BillingError(
    "PROVIDER_NOT_IMPLEMENTED",
    "The selected payment provider is not implemented.",
    503,
  );
}
```

In `.env.example`, preserve every existing user line and add empty `WECHAT_PAY_PUBLIC_KEY_ID=` and `WECHAT_PAY_PUBLIC_KEY=` entries with comments stating that exactly one verifier mode is used. Keep `BILLING_FEATURE_ENABLED=false` and `PAYMENT_MODE=mock`; add no key material.

- [ ] **Step 4: Run startup/registry/security tests and confirm GREEN**

Run the Step 2 command. Expected: all selected tests pass; disabled defaults remain unchanged; Alipay remains blocked.

- [ ] **Step 5: Commit Task 7 with exact-path review**

Before staging, inspect `git diff -- .env.example` and verify the pre-existing user edit is preserved. Stage only intended hunks; if separation is ambiguous, stop and report rather than overwrite or co-commit unrelated content.

```powershell
git add -- lib/billing/config.ts lib/billing/payments/registry.ts tests/billing/config.test.ts tests/billing/startup.test.ts tests/billing/payment-providers.test.ts tests/billing/security-coverage.test.ts
git add -p -- .env.example
git diff --cached --check
git commit -m "feat: register WeChat payment provider"
```

### Task 8: Offline End-to-End Security and Delivery Gates

**Files:**
- Modify: `tests/billing/wechat-provider.test.ts`
- Modify: `tests/billing/webhooks.test.ts`
- Modify: `tests/billing/payment-service.test.ts`
- Modify: `tests/billing/refund-execution.test.ts`
- Modify: `tests/billing/security-coverage.test.ts`
- Modify: `docs/billing-fast-launch.md`

**Interfaces:**
- Consumes: all completed Stage D1 modules and existing order/webhook/refund state machines.
- Produces: offline acceptance evidence and operational documentation; no live-payment capability is enabled.

- [ ] **Step 1: Add cross-boundary acceptance tests**

Use an in-memory signed WeChat transport to exercise backend order snapshot → Native create → signed query/callback → existing webhook settlement → one subscription grant; duplicate callbacks must not duplicate grants. Add an unused Pro Semester full refund through existing approval/execution → signed WeChat refund → entitlement revocation. Assert the Credit Pack refund remains manual, public purchase remains unavailable while the feature flag is false, and every captured log/response excludes all sentinel secrets, `code_url`, raw callbacks, decrypted resources, Authorization, signatures, and nonces.

- [ ] **Step 2: Run Stage D1 focused tests and confirm behavior**

```powershell
npm.cmd exec -- tsx --test tests/billing/wechat-crypto.test.ts tests/billing/wechat-transport.test.ts tests/billing/wechat-provider.test.ts tests/billing/payment-service.test.ts tests/billing/webhooks.test.ts tests/billing/refund-execution.test.ts tests/billing/security-coverage.test.ts
```

Expected: all Stage D1 focused tests pass without network access.

- [ ] **Step 3: Update the launch guide with disabled-state instructions**

Document the two verifier modes, required variable names, offline validation command, merchant-platform materials still needed, and explicit non-activation state:

```text
BILLING_FEATURE_ENABLED=false
PAYMENT_MODE=mock
```

State that Stage D2 sandbox/controlled merchant testing, credential injection, provider switch, production migration, deployment, internal real-money payment, and public purchase activation each require separate approval.

- [ ] **Step 4: Run all delivery gates with fresh output**

```powershell
npm.cmd run test:billing
npm.cmd run typecheck
npx.cmd eslint lib/billing/config.ts lib/billing/payments tests/billing/wechat-crypto.test.ts tests/billing/wechat-transport.test.ts tests/billing/wechat-provider.test.ts tests/billing/payment-service.test.ts tests/billing/webhooks.test.ts tests/billing/refund-execution.test.ts tests/billing/security-coverage.test.ts
npm.cmd run build
npm.cmd audit --omit=dev
git diff --check
git status --short
git diff --name-only -- components/SiteFilingFooter.tsx public/beian-police.svg app/layout.tsx .github
```

Expected: billing tests, typecheck, targeted ESLint, production build, and diff check pass; dependency audit findings are recorded with severity and exploitability rather than silently ignored; protected filing/deployment diff is empty. `git status` may still show the user's pre-existing `.env.example` or `.superpowers` material, which must remain unstaged unless explicitly included by Task 7.

- [ ] **Step 5: Request independent review and resolve findings**

Dispatch a fresh reviewer with the design, this plan, and the exact commit range. Require separate findings for cryptographic correctness, signed-response trust boundary, webhook byte preservation/replay, API contract mapping, timeout uncertainty, refund idempotency, secret handling, configuration ambiguity, and feature gates. Resolve every Critical or Important finding with a new failing test, minimal fix, full relevant verification, and another independent re-review.

- [ ] **Step 6: Commit Task 8**

```powershell
git add -- tests/billing/wechat-provider.test.ts tests/billing/webhooks.test.ts tests/billing/payment-service.test.ts tests/billing/refund-execution.test.ts tests/billing/security-coverage.test.ts docs/billing-fast-launch.md
git diff --cached --check
git commit -m "test: validate WeChat payment security"
```

## Completion Report Requirements

The Stage D1 report must list the commit range, files changed, configuration variable names, verifier modes, offline fixture strategy, focused/full test counts, typecheck, ESLint, build, audit, and diff-check results. It must explicitly state that no live WeChat request, real credential, database migration, product activation, provider-mode switch, push, or deployment occurred; that filing/deployment files remained unchanged; and that Stage D2 and every production activation gate still require separate approval.
