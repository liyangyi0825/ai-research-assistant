# WeChat Pay Native Provider Design

## Goal

Implement an offline-testable WeChat Pay API v3 provider for the billing system's first paid release. The first release supports Native QR-code payments only. It does not enable billing, use real merchant credentials, call WeChat, deploy code, or modify a production database.

## Scope

The provider implements the existing `PaymentProvider` contract:

- `createPayment`
- `queryPayment`
- `closePayment`
- `refundPayment`
- `verifyWebhook`
- `parseWebhook`

The first release does not implement JSAPI, Mini Program, H5, APP payments, automatic renewal, automatic debit, Alipay, profit sharing, physical refunds outside the existing full-refund policy, or certificate auto-download.

## Product Decisions

- Payment mode: WeChat Native payment.
- Native prepay endpoint: `POST /v3/pay/transactions/native`.
- The provider returns WeChat's `code_url` through the existing `paymentToken` field. The browser may render it as a QR code; the server does not generate or persist QR-code image files.
- The backend database remains authoritative for order number, integer minor-unit amount, currency, expiry, product snapshot, refund amount, and payment state.
- The initial public catalog remains limited to Pro Semester at CNY 79.00 for 150 days and Credit Pack 100 at CNY 9.90. Product activation remains separately gated.
- Billing remains closed until separately approved. `BILLING_FEATURE_ENABLED=false` continues to hide and reject public purchasing.

## Architecture

`WechatPayProvider` remains the integration boundary used by billing services. Its implementation is split into focused modules:

1. Configuration loader
   - Parses merchant ID, AppID, API v3 key, merchant certificate serial, merchant private key, notification URL, and verifier material.
   - Supports WeChat Pay public-key mode as the preferred verifier.
   - Supports the existing platform-certificate verifier as a compatibility mode.
   - Rejects missing, mixed, conflicting, malformed, or ambiguous verifier configuration.

2. API v3 signer and verifier
   - Builds `WECHATPAY2-SHA256-RSA2048` authorization headers.
   - Signs the exact HTTP method, request path including query, timestamp, nonce, and original request body.
   - Verifies every signed WeChat response before parsing or trusting its body, including signed error responses.
   - Selects verifier material only by the configured WeChat Pay public-key ID or platform-certificate serial number. Unknown identifiers fail closed.

3. Notification verifier and decryptor
   - Verifies callback signatures against the original, byte-exact request body.
   - Applies a bounded timestamp tolerance before accepting a callback.
   - Decrypts notification resources using AES-256-GCM with the API v3 key, nonce, associated data, ciphertext, and authentication tag.
   - Parses only the expected successful transaction event into the existing `PaymentWebhookEvent` DTO.

4. HTTP transport
   - Uses an injected interface around `fetch` with explicit timeouts and bounded response sizes.
   - Production code never interpolates shell commands and never places credentials in URLs.
   - Tests inject a deterministic in-memory transport and never access the network.

5. Provider mapping
   - Maps Native create, transaction query, close, and domestic refund operations into the existing payment DTOs.
   - Normalizes WeChat states to the existing `PENDING`, `PAID`, `FAILED`, `CLOSED`, and `REFUNDED` states without inventing a successful result.
   - Validates order number, transaction ID, amount, currency, merchant ID, AppID, timestamps, and refund result before returning.

## Configuration

Existing variables remain supported:

```text
WECHAT_PAY_MCH_ID=
WECHAT_PAY_APP_ID=
WECHAT_PAY_API_V3_KEY=
WECHAT_PAY_PRIVATE_KEY=
WECHAT_PAY_CERT_SERIAL_NO=
WECHAT_PAY_NOTIFY_URL=
```

Preferred verification mode adds:

```text
WECHAT_PAY_PUBLIC_KEY_ID=
WECHAT_PAY_PUBLIC_KEY=
```

Compatibility mode retains:

```text
WECHAT_PAY_PLATFORM_CERT=
```

Exactly one response-verification mode is accepted:

- public-key ID plus WeChat Pay public key; or
- platform certificate.

The application rejects startup when billing is enabled with WeChat mode and required configuration is missing, conflicting, or malformed. Errors name variable identifiers only and never include values. No real credential is committed, logged, returned to a client, or written to the database.

## API Operations

### Native create

- Uses the backend order number as `out_trade_no`.
- Sends AppID, merchant ID, a bounded truthful product description, notification URL, expiry in RFC 3339 form, and CNY total in integer fen.
- Uses the existing backend idempotency and durable payment-intent claim before calling the provider.
- Returns a pending `PaymentResult` containing the verified `code_url` as `paymentToken`.
- Does not generate a real QR code during tests.

### Query

- The provider supports querying by a server-owned reference.
- The billing integration must retain enough immutable reference data to query by WeChat transaction ID or merchant order number without accepting a client-selected identifier.
- A query response is signature-verified and contract-validated before it can confirm payment.

### Close

- Closes only a backend-owned pending order.
- A timeout or state conflict triggers a query before the system decides the final state.
- A paid order is never reported as closed.

### Refund

- Uses the backend-approved full amount and CNY currency.
- Derives a stable merchant refund number from the durable refund idempotency key.
- A timeout or uncertain result is recovered by querying or retrying the same merchant refund number.
- The existing policy remains: only an unused subscription may be automatically refunded; Credit Pack refunds require manual handling.

## Webhook Flow

1. Preserve the original callback bytes.
2. Require timestamp, nonce, signature, and serial/public-key identifier headers.
3. Reject timestamps outside the configured tolerance.
4. Verify the RSA signature before parsing business data.
5. Decrypt the resource with AES-256-GCM.
6. Validate event type, transaction state, merchant ID, AppID, order number, amount, and CNY currency.
7. Return the normalized event to the existing webhook persistence and settlement pipeline.
8. Let the existing database event ID, immutable payload hash, retry lease, and transactional settlement provide idempotency and single entitlement/credit grant.

The frontend cannot confirm payment success. A payment-result page may poll the server, but only a verified query or callback can settle an order.

## Failure Handling

- Invalid signatures, unknown verifier IDs, malformed ciphertext, incorrect associated data, stale callbacks, contract mismatches, and WeChat 4xx business errors fail permanently.
- Only explicitly classified connection failures, timeouts, and WeChat 5xx responses are transient.
- Create uncertainty is resolved using the same merchant order number.
- Refund uncertainty is resolved using the same merchant refund number.
- Close uncertainty is followed by an order query.
- Retry operations are bounded and use the existing durable state machines. No client retry can directly mark an order paid.
- Signed WeChat error responses are verified before their codes are trusted.
- Response bodies have a strict size limit and are never logged verbatim.

## Logging and Data Handling

Logs may contain only allowlisted event codes, provider name, internal order number when safe, safe status, HTTP status class, and fixed error classifications. Logs must not contain:

- merchant private keys or public-key material;
- API v3 key;
- Authorization, signature, nonce, or complete callback headers;
- raw callbacks or decrypted notification resources;
- `code_url` or generated QR-code content;
- personal identity data;
- unfiltered WeChat error bodies;
- database URLs or service-role credentials.

## Testing

All tests are offline and use generated test-only RSA keys and deterministic AES-GCM fixtures.

Required coverage:

- canonical request construction and RSA-SHA256 authorization signing;
- path/query/body signing boundaries and tamper rejection;
- response verification in public-key and platform-certificate modes;
- unknown verifier identifier and conflicting configuration rejection;
- signed error response handling;
- callback signature verification with byte-exact bodies;
- timestamp replay rejection;
- AES-256-GCM decryption and authentication failures;
- Native create request and `code_url` mapping;
- query, close, and refund mapping;
- integer amount, CNY, order, merchant, AppID, timestamp, and transaction mismatches;
- create, close, and refund timeout recovery;
- permanent 4xx versus transient timeout/connection/5xx classification;
- bounded body handling and secret-log scans;
- webhook duplicate delivery and one-time settlement integration;
- feature-disabled and production-access gates;
- registry configuration and startup validation.

No test uses a real merchant identifier, private key, API v3 key, payment QR code, or live WeChat endpoint.

## Delivery Gates

Stage D1 is code-complete only when focused tests, the full billing suite, type checking, targeted ESLint, production build, dependency audit, and `git diff --check` pass, and an independent review has no unresolved Critical or Important finding.

Stage D1 completion does not authorize real payment. Stage D2 requires separate approval and controlled merchant-platform testing. Production migration, credential injection, provider-mode switch, deployment, internal real-money testing, and public launch each remain separate approval gates.

## References

- WeChat Pay merchant documentation, Native payment: https://pay.wechatpay.cn/doc/v3/merchant/4012791877
- WeChat Pay merchant documentation, API v3 signing and verification: https://pay.wechatpay.cn/doc/v3/merchant/4012365342
- WeChat Pay merchant documentation, platform-certificate verification: https://pay.wechatpay.cn/doc/v3/merchant/4013053420
