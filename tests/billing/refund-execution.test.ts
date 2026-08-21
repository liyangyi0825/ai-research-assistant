import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import { MockPaymentProvider } from "../../lib/billing/payments/mock";
import type { RefundResult } from "../../lib/billing/payments/types";
import { WechatPayProvider } from "../../lib/billing/payments/wechat";
import { createBillingSecurityLogger } from "../../lib/billing/security-logger";
import {
  createRefundExecutionRepository,
  type RefundExecutionAdminClient,
} from "../../lib/billing/refunds";

const now = new Date("2026-08-16T02:00:00.000Z");
const config: BillingConfig = {
  featureEnabled: true,
  paymentMode: "mock",
  testUserIds: ["user-1"],
  legal: { operatorName: "", operatorCreditCode: "", contactEmail: "" },
  wechat: null,
  wechatConfigured: false,
  alipayConfigured: false,
  isProduction: false,
};

type Claim = {
  status: "CLAIMED";
  refundId: string;
  requestId: string;
  orderId: string;
  paymentId: string;
  provider: "MOCK";
  providerTransactionId: string;
  amountMinor: number;
  currency: "CNY";
  idempotencyKey: string;
};

type RefundModule = {
  executeApprovedRefund?: (
    requestId: string,
    dependencies: {
      repository: {
        claimApprovedRefund(input: {
          requestId: string;
          claimToken: string;
          claimedAt: string;
        }): Promise<
          | Claim
          | { status: "IN_PROGRESS" }
          | { status: "MANUAL_REVIEW_REQUIRED" }
          | { status: "SUCCEEDED"; refund: RefundResult }
        >;
        completeRefund(input: {
          refundId: string;
          claimToken: string;
          result: RefundResult;
        }): Promise<{ status: "SUCCEEDED"; refund: RefundResult }>;
        failRefundClaim(input: {
          refundId: string;
          claimToken: string;
          errorCode: string;
        }): Promise<void>;
      };
      getConfig: () => BillingConfig;
      getProvider: () => MockPaymentProvider;
      now: () => Date;
      createClaimToken: () => string;
    },
  ) => Promise<{ status: "SUCCEEDED"; refund: RefundResult }>;
};

async function paidProvider() {
  const provider = new MockPaymentProvider({
    secret: "refund-execution-test-secret",
    now: () => now,
  });
  const payment = await provider.createPayment({
    orderNumber: "BILL-REFUND-1",
    description: "Refundable Semester",
    amountMinor: 7_900,
    currency: "CNY",
    expiresAt: "2026-08-16T03:00:00.000Z",
    idempotencyKey: "billing-payment:MOCK:BILL-REFUND-1",
  });
  await provider.confirmPayment({
    orderNumber: payment.orderNumber,
    providerTransactionId: payment.providerTransactionId,
  });
  return { provider, payment };
}

test("an approved full refund uses the locked backend payment and completes idempotently", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  assert.equal(
    typeof refundModule.executeApprovedRefund,
    "function",
    "approved refunds need a server-side execution service",
  );
  const executeApprovedRefund = refundModule.executeApprovedRefund!;
  const { provider, payment } = await paidProvider();
  let completeCalls = 0;
  let storedResult: RefundResult | null = null;
  const claim: Claim = {
    status: "CLAIMED",
    refundId: "refund-1",
    requestId: "request-1",
    orderId: "order-1",
    paymentId: "payment-1",
    provider: "MOCK",
    providerTransactionId: payment.providerTransactionId,
    amountMinor: 7_900,
    currency: "CNY",
    idempotencyKey: "billing-refund:request-1",
  };
  const repository = {
    async claimApprovedRefund() {
      return storedResult
        ? { status: "SUCCEEDED" as const, refund: storedResult }
        : claim;
    },
    async completeRefund(input: {
      refundId: string;
      claimToken: string;
      result: RefundResult;
    }) {
      completeCalls += 1;
      assert.equal(input.refundId, "refund-1");
      assert.equal(input.claimToken, "claim-1");
      assert.equal(input.result.providerTransactionId, payment.providerTransactionId);
      assert.equal(input.result.refundedAmountMinor, 7_900);
      assert.equal(input.result.currency, "CNY");
      storedResult = input.result;
      return { status: "SUCCEEDED" as const, refund: input.result };
    },
    async failRefundClaim() {
      assert.fail("a successful refund must not release its claim");
    },
  };

  const first = await executeApprovedRefund("request-1", {
    repository,
    getConfig: () => config,
    getProvider: () => provider,
    now: () => now,
    createClaimToken: () => "claim-1",
  });
  const replay = await executeApprovedRefund("request-1", {
    repository,
    getConfig: () => config,
    getProvider: () => provider,
    now: () => now,
    createClaimToken: () => "claim-2",
  });

  assert.equal(first.status, "SUCCEEDED");
  assert.deepEqual(replay, first);
  assert.equal(completeCalls, 1);
  assert.equal(
    (await provider.queryPayment({
      orderNumber: payment.orderNumber,
      providerTransactionId: payment.providerTransactionId,
    })).status,
    "REFUNDED",
  );
});

test("a provider success followed by database failure retries with the same backend idempotency key", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  assert.equal(typeof refundModule.executeApprovedRefund, "function");
  const executeApprovedRefund = refundModule.executeApprovedRefund!;
  const { provider, payment } = await paidProvider();
  let claims = 0;
  let completes = 0;
  let failedClaims = 0;
  const providerRefund = provider.refundPayment.bind(provider);
  const providerInputs: unknown[] = [];
  provider.refundPayment = async (input) => {
    providerInputs.push({ ...input });
    return providerRefund(input);
  };
  const repository = {
    async claimApprovedRefund() {
      claims += 1;
      return {
        status: "CLAIMED" as const,
        refundId: "refund-1",
        requestId: "request-1",
        orderId: "order-1",
        paymentId: "payment-1",
        provider: "MOCK" as const,
        providerTransactionId: payment.providerTransactionId,
        amountMinor: 7_900,
        currency: "CNY" as const,
        idempotencyKey: "billing-refund:request-1",
      };
    },
    async completeRefund(input: { result: RefundResult }) {
      completes += 1;
      if (completes === 1) throw new Error("database password=must-not-leak");
      return { status: "SUCCEEDED" as const, refund: input.result };
    },
    async failRefundClaim() {
      failedClaims += 1;
    },
  };
  const dependencies = {
    repository,
    getConfig: () => config,
    getProvider: () => provider,
    now: () => now,
    createClaimToken: () => `claim-${claims + 1}`,
    logger: { warn() {} },
  };

  await assert.rejects(
    () => executeApprovedRefund("request-1", dependencies),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "BILLING_STORAGE_UNAVAILABLE" &&
      !error.message.includes("must-not-leak"),
  );
  const recovered = await executeApprovedRefund("request-1", dependencies);

  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(claims, 2);
  assert.equal(completes, 2);
  assert.equal(failedClaims, 0, "a provider success must retain its retryable claim");
  assert.deepEqual(providerInputs, [
    {
      providerTransactionId: payment.providerTransactionId,
      amountMinor: 7_900,
      currency: "CNY",
      idempotencyKey: "billing-refund:request-1",
    },
    {
      providerTransactionId: payment.providerTransactionId,
      amountMinor: 7_900,
      currency: "CNY",
      idempotencyKey: "billing-refund:request-1",
    },
  ]);
  assert.equal(
    (await provider.queryPayment({ orderNumber: payment.orderNumber, providerTransactionId: payment.providerTransactionId }))
      .status,
    "REFUNDED",
  );
});

test("refund execution fails closed when the approved payment provider differs from server mode", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  assert.equal(typeof refundModule.executeApprovedRefund, "function");
  const executeApprovedRefund = refundModule.executeApprovedRefund!;
  const { provider, payment } = await paidProvider();
  let providerCalls = 0;
  const failures: unknown[] = [];
  provider.refundPayment = async () => {
    providerCalls += 1;
    throw new Error("must not execute");
  };

  await assert.rejects(
    () =>
      executeApprovedRefund("request-1", {
        repository: {
          async claimApprovedRefund() {
            return {
              status: "CLAIMED" as const,
              refundId: "refund-1",
              requestId: "request-1",
              orderId: "order-1",
              paymentId: "payment-1",
              provider: "WECHAT" as const,
              providerTransactionId: payment.providerTransactionId,
              amountMinor: 7_900,
              currency: "CNY" as const,
              idempotencyKey: "billing-refund:request-1",
            };
          },
          async completeRefund() {
            throw new Error("must not complete");
          },
          async failRefundClaim(input: {
            refundId: string;
            claimToken: string;
            errorCode: string;
          }) {
            failures.push(input);
          },
        },
        getConfig: () => config,
        getProvider: () => provider,
        now: () => now,
        createClaimToken: () => "claim-1",
      } as never),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "PAYMENT_PROVIDER_MISMATCH" &&
      error.status === 409,
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(failures, [{
    refundId: "refund-1",
    claimToken: "claim-1",
    errorCode: "REFUND_EXECUTION_CONFIGURATION_FAILED",
  }]);
});

test("provider errors preserve the claim for same-key recovery and emit only safe diagnostics", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  assert.equal(typeof refundModule.executeApprovedRefund, "function");
  const executeApprovedRefund = refundModule.executeApprovedRefund!;
  const { provider, payment } = await paidProvider();
  const transactionSecret = payment.providerTransactionId;
  provider.refundPayment = async () => {
    throw new Error(`private-key=must-not-leak transaction=${transactionSecret}`);
  };
  const logs: string[] = [];
  const failures: unknown[] = [];

  await assert.rejects(
    () =>
      executeApprovedRefund("request-1", {
        repository: {
          async claimApprovedRefund() {
            return {
              status: "CLAIMED" as const,
              refundId: "refund-1",
              requestId: "request-1",
              orderId: "order-1",
              paymentId: "payment-1",
              provider: "MOCK" as const,
              providerTransactionId: payment.providerTransactionId,
              amountMinor: 7_900,
              currency: "CNY" as const,
              idempotencyKey: "billing-refund:request-1",
            };
          },
          async completeRefund() {
            throw new Error("must not complete");
          },
          async failRefundClaim(input: {
            refundId: string;
            claimToken: string;
            errorCode: string;
          }) {
            failures.push({ ...input });
          },
        },
        getConfig: () => config,
        getProvider: () => provider,
        now: () => now,
        createClaimToken: () => "claim-1",
        logger: createBillingSecurityLogger((line) => logs.push(line)),
      } as never),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "REFUND_PROVIDER_UNAVAILABLE" &&
      error.status === 503 &&
      !error.message.includes("must-not-leak") &&
      !error.message.includes(transactionSecret),
  );

  assert.deepEqual(failures, []);
  assert.equal(logs.length, 1);
  assert.deepEqual(
    JSON.parse(logs[0].slice("billing_security_event ".length)),
    {
      eventCode: "REFUND_PROVIDER_FAILED",
      provider: "MOCK",
      errorCode: "REFUND_PROVIDER_FAILED",
      status: "FAILED",
    },
  );
  assert.equal(logs[0].includes("must-not-leak"), false);
  assert.equal(logs[0].includes(transactionSecret), false);
});

test("deterministic provider preflight failures release the refund claim", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  const executeApprovedRefund = refundModule.executeApprovedRefund!;
  const provider = new MockPaymentProvider({ secret: "unused" });
  provider.refundPayment = async () => {
    throw new BillingError(
      "PAYMENT_PROVIDER_REFUND_PRECHECK_FAILED",
      "The WeChat Pay request is invalid.",
      400,
    );
  };
  const failures: unknown[] = [];

  await assert.rejects(
    () => executeApprovedRefund("request-1", {
      repository: {
        async claimApprovedRefund() {
          return {
            status: "CLAIMED" as const,
            refundId: "refund-1",
            requestId: "request-1",
            orderId: "order-1",
            paymentId: "payment-1",
            provider: "MOCK" as const,
            providerTransactionId: "mock-tx-1",
            amountMinor: 7_900,
            currency: "CNY" as const,
            idempotencyKey: "billing-refund:request-1",
          };
        },
        async completeRefund() {
          assert.fail("preflight failures cannot complete refunds");
        },
        async failRefundClaim(input: {
          refundId: string;
          claimToken: string;
          errorCode: string;
        }) {
          failures.push(input);
        },
      },
      getConfig: () => config,
      getProvider: () => provider,
      now: () => now,
      createClaimToken: () => "claim-1",
    }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "REFUND_PROVIDER_UNAVAILABLE" &&
      error.status === 503,
  );
  assert.deepEqual(failures, [{
    refundId: "refund-1",
    claimToken: "claim-1",
    errorCode: "REFUND_PROVIDER_REFUND_PRECHECK_FAILED",
  }]);
});

test("verified remote provider rejections retain the refund claim", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  const executeApprovedRefund = refundModule.executeApprovedRefund!;
  const provider = new MockPaymentProvider({ secret: "unused" });
  let providerCalls = 0;
  provider.refundPayment = async () => {
    providerCalls += 1;
    throw new BillingError(
      "PAYMENT_PROVIDER_REQUEST_INVALID",
      "The WeChat Pay request is invalid.",
      400,
    );
  };
  const failures: unknown[] = [];

  await assert.rejects(
    () => executeApprovedRefund("request-1", {
      repository: {
        async claimApprovedRefund() {
          return {
            status: "CLAIMED" as const,
            refundId: "refund-1",
            requestId: "request-1",
            orderId: "order-1",
            paymentId: "payment-1",
            provider: "MOCK" as const,
            providerTransactionId: "mock-tx-1",
            amountMinor: 7_900,
            currency: "CNY" as const,
            idempotencyKey: "billing-refund:request-1",
          };
        },
        async completeRefund() {
          assert.fail("remote rejections cannot complete refunds");
        },
        async failRefundClaim(input: unknown) {
          failures.push(input);
        },
      },
      getConfig: () => config,
      getProvider: () => provider,
      now: () => now,
      createClaimToken: () => "claim-1",
    }),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "REFUND_PROVIDER_UNAVAILABLE" &&
      error.status === 503,
  );
  assert.equal(providerCalls, 1);
  assert.deepEqual(failures, []);
});

test("explicit unavailable provider outcomes retain the refund claim", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  const executeApprovedRefund = refundModule.executeApprovedRefund!;

  for (const code of [
    "PAYMENT_PROVIDER_UNAVAILABLE",
    "PAYMENT_PROVIDER_TRANSPORT_FAILED",
  ]) {
    const provider = new MockPaymentProvider({ secret: "unused" });
    provider.refundPayment = async () => {
      throw new BillingError(code, "Provider result is uncertain.", 503);
    };
    const failures: unknown[] = [];

    await assert.rejects(
      () => executeApprovedRefund("request-1", {
        repository: {
          async claimApprovedRefund() {
            return {
              status: "CLAIMED" as const,
              refundId: "refund-1",
              requestId: "request-1",
              orderId: "order-1",
              paymentId: "payment-1",
              provider: "MOCK" as const,
              providerTransactionId: "mock-tx-1",
              amountMinor: 7_900,
              currency: "CNY" as const,
              idempotencyKey: "billing-refund:request-1",
            };
          },
          async completeRefund() {
            assert.fail("uncertain provider outcomes cannot complete refunds");
          },
          async failRefundClaim(input: unknown) {
            failures.push(input);
          },
        },
        getConfig: () => config,
        getProvider: () => provider,
        now: () => now,
        createClaimToken: () => "claim-1",
      }),
      (error: unknown) =>
        error instanceof BillingError &&
        error.code === "REFUND_PROVIDER_UNAVAILABLE" &&
        error.status === 503,
    );
    assert.deepEqual(failures, [], code);
  }
});

test("actual WeChat provider retains the lease when query recovery fails", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  const executeApprovedRefund = refundModule.executeApprovedRefund!;
  const requests: string[] = [];
  const provider = new WechatPayProvider({
    config: {
      mchId: "1900000109",
      appId: "wx-app-1",
      apiV3Key: Buffer.alloc(32),
      merchantPrivateKeyPem: "test-only",
      merchantCertificateSerialNumber: "serial-test-only",
      notifyUrl: "https://billing.example.test/webhook",
      verifier: { mode: "PUBLIC_KEY", keyId: "key-id", publicKeyPem: "test-only" },
    },
    httpClient: {
      async request(input: { pathWithQuery: string }) {
        requests.push(input.pathWithQuery);
        throw new BillingError(
          requests.length === 1
            ? "PAYMENT_PROVIDER_UNAVAILABLE"
            : "PAYMENT_PROVIDER_REQUEST_REJECTED",
          "Provider result is unavailable.",
          503,
        );
      },
    } as never,
  });
  const failures: unknown[] = [];

  await assert.rejects(
    () => executeApprovedRefund("request-1", {
      repository: {
        async claimApprovedRefund() {
          return {
            status: "CLAIMED" as const,
            refundId: "refund-1",
            requestId: "request-1",
            orderId: "order-1",
            paymentId: "payment-1",
            provider: "WECHAT" as const,
            providerTransactionId: "4200000000001",
            amountMinor: 7_900,
            currency: "CNY" as const,
            idempotencyKey: "billing-refund:request-1",
          };
        },
        async completeRefund() {
          assert.fail("query failure cannot complete refunds");
        },
        async failRefundClaim(input: unknown) {
          failures.push(input);
        },
      },
      getConfig: () => ({ ...config, paymentMode: "wechat", wechatConfigured: true }),
      getProvider: () => provider,
      now: () => now,
      createClaimToken: () => "claim-1",
    } as never),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "REFUND_PROVIDER_UNAVAILABLE" &&
      error.status === 503,
  );
  assert.deepEqual(requests, [
    "/v3/refund/domestic/refunds",
    "/v3/refund/domestic/refunds/a1a255e9c5297ead756ecb2f4117ffe0",
  ]);
  assert.deepEqual(failures, []);
});

test("credit-pack refunds require manual review before provider construction", async () => {
  const refundModule = (await import("../../lib/billing/refunds")) as RefundModule;
  const executeApprovedRefund = refundModule.executeApprovedRefund!;
  let providerConstructed = false;

  await assert.rejects(
    () => executeApprovedRefund("credit-refund-1", {
      repository: {
        async claimApprovedRefund() {
          return { status: "MANUAL_REVIEW_REQUIRED" as const };
        },
        async completeRefund() {
          assert.fail("manual refunds cannot complete automatically");
        },
        async failRefundClaim() {
          assert.fail("manual refunds must not create a lease to release");
        },
      },
      getConfig: () => config,
      getProvider: () => {
        providerConstructed = true;
        return new MockPaymentProvider({ secret: "unused" });
      },
      now: () => now,
      createClaimToken: () => "claim-credit",
    }),
    (error: unknown) => error instanceof BillingError &&
      error.code === "REFUND_REQUIRES_MANUAL_REVIEW" &&
      error.status === 409,
  );
  assert.equal(providerConstructed, false);
});

test("the forward refund migration claims approved full refunds and completes all final state atomically", async () => {
  const sql = await readFile(
    "supabase/migrations/202608160012_billing_refund_execution.sql",
    "utf8",
  ).catch(() => "");

  assert.match(sql, /ALTER TABLE public\.billing_refunds[\s\S]*claim_token UUID[\s\S]*claim_expires_at TIMESTAMPTZ[\s\S]*last_error_code TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS execution_managed BOOLEAN/i);
  const addMarker = sql.indexOf("ADD COLUMN IF NOT EXISTS execution_managed BOOLEAN");
  const markLegacy = sql.indexOf("SET execution_managed = FALSE");
  const futureDefault = sql.indexOf("ALTER COLUMN execution_managed SET DEFAULT TRUE");
  const requireMarker = sql.indexOf("ALTER COLUMN execution_managed SET NOT NULL");
  assert.ok(addMarker >= 0 && addMarker < markLegacy && markLegacy < futureDefault && futureDefault < requireMarker);
  assert.doesNotMatch(sql.slice(0, markLegacy), /execution_managed[^;]*DEFAULT\s+TRUE/i);
  assert.match(sql, /billing_refunds_claim_state_check[\s\S]*NOT execution_managed[\s\S]*execution_managed[\s\S]*status\s*=\s*'FAILED'/i);
  assert.match(sql, /CREATE TRIGGER billing_refunds_execution_management_immutable[\s\S]*BEFORE INSERT OR UPDATE[\s\S]*billing_guard_refund_execution_management\(\)/i);
  assert.match(sql, /UPDATE public\.billing_refunds[\s\S]*status\s*=\s*'FAILED'[\s\S]*last_error_code/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.billing_claim_approved_refund\s*\(/i);
  assert.match(sql, /snapshot_product_type\s*=\s*'CREDIT_PACK'[\s\S]*'status',\s*'MANUAL_REVIEW_REQUIRED'/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.billing_assert_refund_reversible\s*\(/i);
  assert.match(sql, /snapshot_product_type\s*<>\s*'SUBSCRIPTION'/i);
  assert.match(sql, /billing_subscriptions[\s\S]*source_order_id\s*=\s*v_order\.id[\s\S]*status\s*=\s*'ACTIVE'/i);
  assert.match(sql, /billing_usage_records[\s\S]*status\s+IN\s*\('RESERVED',\s*'FINALIZED'\)/i);
  assert.match(sql, /billing_usage_quotas[\s\S]*reserved_units\s*<>\s*0[\s\S]*used_units\s*<>\s*0/i);
  assert.doesNotMatch(sql, /billing_credit_accounts[\s\S]*available_balance\s*-\s*v_credit_grant/i);
  assert.match(sql, /CREATE TRIGGER billing_block_refunding_quota_usage/i);
  assert.doesNotMatch(sql, /CREATE TRIGGER billing_block_refunding_credit_debit/i);
  assert.match(sql, /v_request\.status\s*<>\s*'APPROVED'/i);
  assert.match(sql, /v_order\.status\s*<>\s*'REFUNDING'/i);
  assert.match(sql, /v_payment\.status\s*<>\s*'PAID'/i);
  assert.match(sql, /v_request\.requested_amount_minor\s+IS DISTINCT FROM\s+v_order\.amount_minor/i);
  assert.match(sql, /v_payment\.amount_minor\s+IS DISTINCT FROM\s+v_order\.amount_minor/i);
  assert.match(sql, /'billing-refund:'\s*\|\|\s*p_request_id::TEXT/i);
  assert.match(sql, /v_refund_exists\s+AND\s+NOT v_refund\.execution_managed[\s\S]*legacy refund is not execution managed/i);
  assert.match(sql, /INSERT INTO public\.billing_refunds[\s\S]*execution_managed[\s\S]*TRUE/i);
  assert.match(sql, /v_claimed_at\s+TIMESTAMPTZ\s*:=\s*clock_timestamp\(\)/i);
  assert.match(sql, /claim_expires_at\s*=\s*v_claimed_at\s*\+\s*interval\s*'5 minutes'/i);
  assert.doesNotMatch(sql, /claim_expires_at\s*=\s*p_claimed_at\s*\+/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.billing_complete_refund\s*\(/i);
  assert.match(sql, /v_refund\.claim_token\s+IS DISTINCT FROM\s+p_claim_token/i);
  assert.match(sql, /NOT v_refund\.execution_managed[\s\S]*refund claim is not completable/i);
  assert.match(sql, /p_provider_transaction_id\s+IS DISTINCT FROM\s+v_payment\.provider_transaction_id/i);
  assert.match(sql, /p_refunded_amount_minor\s+IS DISTINCT FROM\s+v_refund\.refunded_amount_minor/i);
  assert.match(sql, /UPDATE public\.billing_refunds[\s\S]*status\s*=\s*'SUCCEEDED'/i);
  assert.match(sql, /UPDATE public\.billing_payments[\s\S]*status\s*=\s*'REFUNDED'/i);
  assert.match(sql, /UPDATE public\.billing_orders[\s\S]*status\s*=\s*'REFUNDED'[\s\S]*refund_status\s*=\s*'FULL'/i);
  assert.match(sql, /UPDATE public\.billing_subscriptions[\s\S]*status\s*=\s*'CANCELLED'[\s\S]*source_order_id\s*=\s*v_order\.id/i);
  assert.match(sql, /UPDATE public\.billing_user_entitlements[\s\S]*valid_until\s*=[\s\S]*source_order_id\s*=\s*v_order\.id[\s\S]*source_type\s*=\s*'PLAN'/i);
  assert.match(sql, /UPDATE public\.billing_usage_quotas[\s\S]*quota_limit\s*=\s*0[\s\S]*subscription_id\s*=\s*v_subscription_id/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.billing_credit_ledger/i);
  assert.doesNotMatch(sql, /credit-reversal/i);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.billing_(?:subscriptions|user_entitlements|usage_quotas|credit_ledger)/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.billing_fail_refund_claim\s*\(/i);
  assert.match(sql, /NOT v_refund\.execution_managed[\s\S]*refund claim cannot be failed/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.billing_claim_approved_refund[\s\S]*FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.billing_complete_refund[\s\S]*TO service_role/i);
  assert.match(sql, /SET search_path = pg_catalog, public/gi);
});

test("database types expose the durable refund lease and service-role RPC contracts", async () => {
  const source = await readFile("lib/billing/database.types.ts", "utf8");
  assert.match(source, /export type BillingRefundRow = \{[\s\S]*claim_token: UUID \| null;[\s\S]*claim_expires_at: Timestamp \| null;[\s\S]*last_error_code: string \| null;/i);
  assert.match(source, /billing_claim_approved_refund: \{[\s\S]*p_request_id: UUID;[\s\S]*p_claim_token: UUID;[\s\S]*p_claimed_at: Timestamp;[\s\S]*Returns: Json;/i);
  assert.match(source, /billing_complete_refund: \{[\s\S]*p_refund_id: UUID;[\s\S]*p_claim_token: UUID;[\s\S]*p_provider_refund_id: string;[\s\S]*p_provider_transaction_id: string;[\s\S]*p_refunded_amount_minor: number;[\s\S]*p_currency: string;[\s\S]*p_response_summary: Json;[\s\S]*Returns: Json;/i);
  assert.match(source, /billing_fail_refund_claim: \{[\s\S]*p_refund_id: UUID;[\s\S]*p_claim_token: UUID;[\s\S]*p_error_code: string;[\s\S]*Returns: Json;/i);
  assert.match(source, /BillingRefundRow = \{[\s\S]*execution_managed: boolean;/i);
});

test("refund repository sends only server claim and provider result fields to the three RPCs", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: RefundExecutionAdminClient = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === "billing_claim_approved_refund") {
        return {
          data: {
            status: "CLAIMED",
            refund_id: "refund-1",
            request_id: "request-1",
            order_id: "order-1",
            payment_id: "payment-1",
            provider: "MOCK",
            provider_transaction_id: "mock-tx-1",
            amount_minor: 7_900,
            currency: "CNY",
            idempotency_key: "billing-refund:request-1",
          },
          error: null,
        };
      }
      if (name === "billing_complete_refund") {
        return {
          data: {
            status: "SUCCEEDED",
            provider_refund_id: "mock-refund-1",
            provider_transaction_id: "mock-tx-1",
            refunded_amount_minor: 7_900,
            currency: "CNY",
          },
          error: null,
        };
      }
      return { data: { status: "RELEASED" }, error: null };
    },
  };
  const repository = createRefundExecutionRepository(client);
  const claim = await repository.claimApprovedRefund({
    requestId: "request-1",
    claimToken: "claim-1",
    claimedAt: now.toISOString(),
  });
  assert.equal(claim.status, "CLAIMED");
  const completed = await repository.completeRefund({
    refundId: "refund-1",
    claimToken: "claim-1",
    result: {
      providerRefundId: "mock-refund-1",
      providerTransactionId: "mock-tx-1",
      status: "SUCCEEDED",
      refundedAmountMinor: 7_900,
      currency: "CNY",
    },
  });
  await repository.failRefundClaim({
    refundId: "refund-2",
    claimToken: "claim-2",
    errorCode: "REFUND_PROVIDER_FAILED",
  });

  assert.equal(completed.refund.refundedAmountMinor, 7_900);
  assert.deepEqual(calls, [
    {
      name: "billing_claim_approved_refund",
      args: {
        p_request_id: "request-1",
        p_claim_token: "claim-1",
        p_claimed_at: now.toISOString(),
      },
    },
    {
      name: "billing_complete_refund",
      args: {
        p_refund_id: "refund-1",
        p_claim_token: "claim-1",
        p_provider_refund_id: "mock-refund-1",
        p_provider_transaction_id: "mock-tx-1",
        p_refunded_amount_minor: 7_900,
        p_currency: "CNY",
        p_response_summary: { status: "SUCCEEDED" },
      },
    },
    {
      name: "billing_fail_refund_claim",
      args: {
        p_refund_id: "refund-2",
        p_claim_token: "claim-2",
        p_error_code: "REFUND_PROVIDER_FAILED",
      },
    },
  ]);
  assert.equal(JSON.stringify(calls).includes("amountFromClient"), false);
});
