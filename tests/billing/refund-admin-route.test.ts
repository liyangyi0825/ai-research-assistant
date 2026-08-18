import assert from "node:assert/strict";
import test from "node:test";

import { createRefundReviewHandler } from "../../app/api/admin/billing/refunds/route";
import { BillingError } from "../../lib/billing/errors";

const admin = {
  id: "admin-1",
  email: "admin@example.com",
  isAdmin: true as const,
  role: "BILLING_ADMIN" as const,
};

function request(decision: "APPROVED" | "REJECTED" = "APPROVED") {
  return new Request("http://localhost/api/admin/billing/refunds", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "refund-request-1",
      decision,
      reason: "reviewed",
      idempotencyKey: "refund-review-1",
    }),
  });
}

function success() {
  return {
    status: "SUCCEEDED" as const,
    refund: {
      providerRefundId: "provider-refund-1",
      providerTransactionId: "provider-payment-1",
      status: "SUCCEEDED" as const,
      refundedAmountMinor: 7_900,
      currency: "CNY" as const,
    },
  };
}

test("approved refund review executes and returns the persisted review plus settlement", async () => {
  let executions = 0;
  const handler = createRefundReviewHandler({
    requireAdmin: async () => admin,
    reviewRefund: async () => ({ status: "APPLIED", auditId: "audit-1", resourceId: "refund-request-1" }),
    executeRefund: async () => {
      executions += 1;
      return success();
    },
  });

  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(executions, 1);
  assert.deepEqual(await response.json(), {
    status: "APPLIED",
    auditId: "audit-1",
    resourceId: "refund-request-1",
    refundExecution: success(),
  });
});

test("rejected review never executes a provider refund", async () => {
  const handler = createRefundReviewHandler({
    requireAdmin: async () => admin,
    reviewRefund: async () => ({ status: "APPLIED", auditId: "audit-1", resourceId: "refund-request-1" }),
    executeRefund: async () => assert.fail("rejection must not execute refund"),
  });
  const response = await handler(request("REJECTED"));
  assert.deepEqual((await response.json()).refundExecution, { status: "NOT_REQUESTED" });
});

test("a persisted approval reports manual or retry state without leaking execution errors", async () => {
  for (const [error, expected] of [
    [new BillingError("REFUND_REQUIRES_MANUAL_REVIEW", "manual", 409), "MANUAL_REVIEW_REQUIRED"],
    [new Error("provider-secret-must-not-leak"), "RETRY_REQUIRED"],
  ] as const) {
    const handler = createRefundReviewHandler({
      requireAdmin: async () => admin,
      reviewRefund: async () => ({ status: "APPLIED", auditId: "audit-1", resourceId: "refund-request-1" }),
      executeRefund: async () => { throw error; },
    });
    const response = await handler(request());
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes("provider-secret-must-not-leak"), false);
    assert.equal(JSON.parse(text).refundExecution.status, expected);
  }
});

test("retrying the same idempotent approval can recover execution", async () => {
  let reviewCalls = 0;
  let executionCalls = 0;
  const handler = createRefundReviewHandler({
    requireAdmin: async () => admin,
    reviewRefund: async () => {
      reviewCalls += 1;
      return { status: "APPLIED", auditId: "audit-1", resourceId: "refund-request-1" };
    },
    executeRefund: async () => {
      executionCalls += 1;
      if (executionCalls === 1) throw new Error("transient");
      return success();
    },
  });

  const first = await handler(request());
  assert.equal((await first.json()).refundExecution.status, "RETRY_REQUIRED");
  const second = await handler(request());
  assert.equal((await second.json()).refundExecution.status, "SUCCEEDED");
  assert.equal(reviewCalls, 2);
  assert.equal(executionCalls, 2);
});
