import { randomUUID } from "node:crypto";

import { getSupabaseAdminClient } from "../supabase";
import { getBillingConfig, type BillingConfig, type PaymentMode } from "./config";
import { BillingError } from "./errors";
import { getPaymentProvider } from "./payments/registry";
import type { PaymentProvider } from "./payments/provider";
import type { RefundResult } from "./payments/types";
import type { BillingProvider } from "./repositories";
import {
  billingSecurityLogger,
  type BillingSecurityLogger,
  warnBillingSecurity,
} from "./security-logger";

export type ApprovedRefundClaim = {
  status: "CLAIMED";
  refundId: string;
  requestId: string;
  orderId: string;
  paymentId: string;
  provider: BillingProvider;
  providerTransactionId: string;
  amountMinor: number;
  currency: "CNY";
  idempotencyKey: string;
};

export type RefundClaimResult =
  | ApprovedRefundClaim
  | { status: "IN_PROGRESS" }
  | { status: "FAILED" }
  | { status: "MANUAL_REVIEW_REQUIRED" }
  | { status: "SUCCEEDED"; refund: RefundResult };

export type RefundExecutionResult = {
  status: "SUCCEEDED";
  refund: RefundResult;
};

export type RefundExecutionRepository = {
  claimApprovedRefund(input: {
    requestId: string;
    claimToken: string;
    claimedAt: string;
  }): Promise<RefundClaimResult>;
  completeRefund(input: {
    refundId: string;
    claimToken: string;
    result: RefundResult;
  }): Promise<RefundExecutionResult>;
  failRefundClaim(input: {
    refundId: string;
    claimToken: string;
    errorCode: string;
  }): Promise<void>;
};

type DatabaseResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

export type RefundExecutionAdminClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<DatabaseResult>;
};

export type ExecuteApprovedRefundDependencies = {
  repository?: RefundExecutionRepository;
  getConfig?: () => BillingConfig;
  getProvider?: (
    mode: PaymentMode,
    config: BillingConfig,
  ) => PaymentProvider;
  now?: () => Date;
  createClaimToken?: () => string;
  logger?: BillingSecurityLogger;
};

function storageError(): BillingError {
  return new BillingError(
    "BILLING_STORAGE_UNAVAILABLE",
    "Billing data is temporarily unavailable.",
    503,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw storageError();
  return value.trim();
}

function amount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw storageError();
  }
  return value;
}

function provider(value: unknown): BillingProvider {
  if (value !== "MOCK" && value !== "WECHAT" && value !== "ALIPAY") {
    throw storageError();
  }
  return value;
}

function mapRefundResult(value: unknown): RefundResult {
  const row = record(value);
  if (row.status !== "SUCCEEDED" || row.currency !== "CNY") {
    throw storageError();
  }
  return {
    providerRefundId: requiredString(row.provider_refund_id),
    providerTransactionId: requiredString(row.provider_transaction_id),
    status: "SUCCEEDED",
    refundedAmountMinor: amount(row.refunded_amount_minor),
    currency: "CNY",
  };
}

function mapClaim(value: unknown): RefundClaimResult {
  const row = record(value);
  if (row.status === "IN_PROGRESS") return { status: "IN_PROGRESS" };
  if (row.status === "FAILED") return { status: "FAILED" };
  if (row.status === "MANUAL_REVIEW_REQUIRED") {
    return { status: "MANUAL_REVIEW_REQUIRED" };
  }
  if (row.status === "SUCCEEDED") {
    return { status: "SUCCEEDED", refund: mapRefundResult(row) };
  }
  if (row.status !== "CLAIMED" || row.currency !== "CNY") {
    throw storageError();
  }
  return {
    status: "CLAIMED",
    refundId: requiredString(row.refund_id),
    requestId: requiredString(row.request_id),
    orderId: requiredString(row.order_id),
    paymentId: requiredString(row.payment_id),
    provider: provider(row.provider),
    providerTransactionId: requiredString(row.provider_transaction_id),
    amountMinor: amount(row.amount_minor),
    currency: "CNY",
    idempotencyKey: requiredString(row.idempotency_key),
  };
}

function mapCompletion(value: unknown): RefundExecutionResult {
  const row = record(value);
  if (row.status !== "SUCCEEDED") throw storageError();
  return { status: "SUCCEEDED", refund: mapRefundResult(row) };
}

function modeForProvider(value: BillingProvider): PaymentMode {
  switch (value) {
    case "MOCK":
      return "mock";
    case "WECHAT":
      return "wechat";
    case "ALIPAY":
      return "alipay";
  }
}

function normalizeRequestId(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BillingError(
      "INVALID_REFUND_REQUEST",
      "A refund request ID is required.",
      400,
    );
  }
  return value.trim();
}

function normalizeTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw storageError();
  }
  return value.toISOString();
}

function validateClaim(
  claim: ApprovedRefundClaim,
  requestId: string,
  config: BillingConfig,
): void {
  if (
    claim.requestId !== requestId ||
    !claim.refundId.trim() ||
    !claim.orderId.trim() ||
    !claim.paymentId.trim() ||
    !claim.providerTransactionId.trim() ||
    !claim.idempotencyKey.trim() ||
    !Number.isSafeInteger(claim.amountMinor) ||
    claim.amountMinor <= 0 ||
    claim.currency !== "CNY"
  ) {
    throw storageError();
  }
  if (modeForProvider(claim.provider) !== config.paymentMode) {
    throw new BillingError(
      "PAYMENT_PROVIDER_MISMATCH",
      "Approved refund provider does not match the server payment mode.",
      409,
    );
  }
}

function validateProviderResult(
  claim: ApprovedRefundClaim,
  result: RefundResult,
): void {
  if (
    result.status !== "SUCCEEDED" ||
    !result.providerRefundId.trim() ||
    result.providerTransactionId !== claim.providerTransactionId ||
    result.refundedAmountMinor !== claim.amountMinor ||
    result.currency !== claim.currency
  ) {
    throw new BillingError(
      "REFUND_PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an invalid refund response.",
      503,
    );
  }
}

type RefundFailureDisposition = "UNCERTAIN" | "FAILED" | "MANUAL";

function refundFailureDisposition(error: unknown): RefundFailureDisposition {
  if (
    error instanceof BillingError &&
    (error.code === "PAYMENT_PROVIDER_UNAVAILABLE" ||
      error.code === "PAYMENT_PROVIDER_TRANSPORT_FAILED" ||
      error.code === "PAYMENT_PROVIDER_REFUND_PROCESSING")
  ) {
    return "UNCERTAIN";
  }
  if (
    !(error instanceof BillingError) ||
    error.code === "PAYMENT_PROVIDER_INVALID_RESPONSE" ||
    error.code === "REFUND_PROVIDER_INVALID_RESPONSE" ||
    error.code === "PAYMENT_PROVIDER_REFUND_MANUAL_REVIEW"
  ) {
    return "MANUAL";
  }
  return "FAILED";
}

export function createRefundExecutionRepository(
  client: RefundExecutionAdminClient,
): RefundExecutionRepository {
  async function rpc(name: string, args: Record<string, unknown>) {
    try {
      const result = await client.rpc(name, args);
      if (result.error) throw storageError();
      return result.data;
    } catch (error) {
      if (error instanceof BillingError) throw error;
      throw storageError();
    }
  }

  return {
    async claimApprovedRefund(input) {
      try {
        const result = await client.rpc("billing_claim_approved_refund", {
          p_request_id: input.requestId,
          p_claim_token: input.claimToken,
          p_claimed_at: input.claimedAt,
        });
        if (result.error?.code === "P2101") return { status: "FAILED" };
        if (result.error?.code === "P2102") {
          return { status: "MANUAL_REVIEW_REQUIRED" };
        }
        if (result.error) throw storageError();
        return mapClaim(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
    async completeRefund(input) {
      return mapCompletion(
        await rpc("billing_complete_refund", {
          p_refund_id: input.refundId,
          p_claim_token: input.claimToken,
          p_provider_refund_id: input.result.providerRefundId,
          p_provider_transaction_id: input.result.providerTransactionId,
          p_refunded_amount_minor: input.result.refundedAmountMinor,
          p_currency: input.result.currency,
          p_response_summary: { status: input.result.status },
        }),
      );
    },
    async failRefundClaim(input) {
      await rpc("billing_fail_refund_claim", {
        p_refund_id: input.refundId,
        p_claim_token: input.claimToken,
        p_error_code: input.errorCode,
      });
    },
  };
}

function defaultRepository(): RefundExecutionRepository {
  const client = getSupabaseAdminClient();
  if (!client) throw storageError();
  return createRefundExecutionRepository(
    client as unknown as RefundExecutionAdminClient,
  );
}

export async function executeApprovedRefund(
  requestIdValue: string,
  dependencies: ExecuteApprovedRefundDependencies = {},
): Promise<RefundExecutionResult> {
  const requestId = normalizeRequestId(requestIdValue);
  const config = (dependencies.getConfig ?? getBillingConfig)();
  const repository = dependencies.repository ?? defaultRepository();
  const claimToken = (dependencies.createClaimToken ?? randomUUID)();
  if (!claimToken.trim()) throw storageError();
  const claimedAt = normalizeTimestamp(
    (dependencies.now ?? (() => new Date()))(),
  );
  let claim: RefundClaimResult;
  try {
    claim = await repository.claimApprovedRefund({
      requestId,
      claimToken,
      claimedAt,
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
  if (claim.status === "SUCCEEDED") return claim;
  if (claim.status === "FAILED") {
    throw new BillingError(
      "REFUND_PROVIDER_FAILED",
      "The payment provider permanently rejected the refund.",
      409,
    );
  }
  if (claim.status === "MANUAL_REVIEW_REQUIRED") {
    throw new BillingError(
      "REFUND_REQUIRES_MANUAL_REVIEW",
      "This refund requires manual review and cannot be executed automatically.",
      409,
    );
  }
  if (claim.status === "IN_PROGRESS") {
    throw new BillingError(
      "REFUND_EXECUTION_IN_PROGRESS",
      "Refund execution is already in progress. Please retry shortly.",
      409,
    );
  }
  let paymentProvider: PaymentProvider;
  try {
    validateClaim(claim, requestId, config);
    paymentProvider = (dependencies.getProvider ?? getPaymentProvider)(
      modeForProvider(claim.provider),
      config,
    );
  } catch (error) {
    try {
      await repository.failRefundClaim({
        refundId: claim.refundId,
        claimToken,
        errorCode: "REFUND_EXECUTION_CONFIGURATION_FAILED",
      });
    } catch {
      // The bounded lease remains recoverable if deterministic cleanup fails.
    }
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
  const logger = dependencies.logger ?? billingSecurityLogger;
  let refund: RefundResult;
  try {
    refund = await paymentProvider.refundPayment({
      providerTransactionId: claim.providerTransactionId,
      amountMinor: claim.amountMinor,
      currency: claim.currency,
      idempotencyKey: claim.idempotencyKey,
    });
    validateProviderResult(claim, refund);
  } catch (error) {
    const disposition = refundFailureDisposition(error);
    if (disposition !== "UNCERTAIN") {
      try {
        await repository.failRefundClaim({
          refundId: claim.refundId,
          claimToken,
          errorCode:
            disposition === "MANUAL"
              ? "REFUND_PROVIDER_CONTRACT_MISMATCH"
              : error instanceof BillingError &&
                  error.code === "PAYMENT_PROVIDER_REFUND_PRECHECK_FAILED"
                ? "REFUND_PROVIDER_REFUND_PRECHECK_FAILED"
                : "REFUND_PROVIDER_REJECTED",
        });
      } catch {
        // The bounded lease remains recoverable if deterministic cleanup fails.
      }
    }
    warnBillingSecurity(logger, {
      eventCode: "REFUND_PROVIDER_FAILED",
      provider: claim.provider,
      errorCode: "REFUND_PROVIDER_FAILED",
      status: "FAILED",
    });
    if (disposition === "MANUAL") {
      throw new BillingError(
        "REFUND_REQUIRES_MANUAL_REVIEW",
        "This refund requires manual review and cannot be retried automatically.",
        409,
      );
    }
    if (disposition === "FAILED") {
      throw new BillingError(
        "REFUND_PROVIDER_FAILED",
        "The payment provider permanently rejected the refund.",
        409,
      );
    }
    // Only explicitly nonterminal or transport-uncertain outcomes retain the
    // claim for a same-idempotency-key retry after its lease expires.
    throw new BillingError(
      "REFUND_PROVIDER_UNAVAILABLE",
      "The payment provider could not complete the refund.",
      503,
    );
  }
  try {
    return await repository.completeRefund({
      refundId: claim.refundId,
      claimToken,
      result: refund,
    });
  } catch {
    warnBillingSecurity(logger, {
      eventCode: "REFUND_PERSIST_FAILED",
      provider: claim.provider,
      errorCode: "REFUND_PERSIST_FAILED",
      status: "FAILED",
    });
    // Do not release after provider success. The durable lease and provider
    // idempotency key let a later execution recover the same successful refund.
    throw storageError();
  }
}
