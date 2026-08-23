import assert from "node:assert/strict";
import test from "node:test";

import { createRefundReviewHandler } from "../../app/api/admin/billing/refunds/server";
import { BillingError } from "../../lib/billing/errors";
import type { BillingSecurityLogEvent } from "../../lib/billing/security-logger";

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

function retryRequest() {
  return new Request("http://localhost/api/admin/billing/refunds", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "RETRY_EXECUTION",
      requestId: "refund-request-1",
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

test("refund route exports only the guarded default GET/PATCH handlers", async () => {
  const [route, server] = await Promise.all([
    import("../../app/api/admin/billing/refunds/route"),
    import("../../app/api/admin/billing/refunds/server"),
  ]);
  assert.deepEqual(Object.keys(route).sort(), ["GET", "PATCH"]);
  assert.equal(route.GET, server.refundGetHandler);
  assert.equal(route.PATCH, server.refundPatchHandler);
});

test("approved refund review executes and returns the persisted review plus settlement", async () => {
  let executions = 0;
  const handler = createRefundReviewHandler({
    requireAdmin: async () => admin,
    reviewRefund: async () => ({ status: "APPLIED" as const, auditId: "audit-1", resourceId: "refund-request-1" }),
    executeRefund: async () => {
      executions += 1;
      return success();
    },
  });

  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(executions, 1);
  assert.deepEqual(await response.json(), {
    success: true,
    refundCompleted: true,
    requiresManualAction: false,
    status: "APPLIED",
    auditId: "audit-1",
    resourceId: "refund-request-1",
    refundExecution: success(),
  });
});

test("rejected review never executes a provider refund", async () => {
  const handler = createRefundReviewHandler({
    requireAdmin: async () => admin,
    reviewRefund: async () => ({ status: "APPLIED" as const, auditId: "audit-1", resourceId: "refund-request-1" }),
    executeRefund: async () => assert.fail("rejection must not execute refund"),
  });
  const response = await handler(request("REJECTED"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    refundCompleted: false,
    requiresManualAction: false,
    status: "APPLIED",
    auditId: "audit-1",
    resourceId: "refund-request-1",
    refundExecution: { status: "NOT_REQUESTED" },
  });
});

test("a persisted approval distinguishes manual action from a failed execution", async () => {
  for (const [error, expected, status, success, manual] of [
    [new BillingError("REFUND_REQUIRES_MANUAL_REVIEW", "manual", 409), "MANUAL_REVIEW_REQUIRED", 202, true, true],
    [new Error("provider-secret-must-not-leak"), "RETRY_REQUIRED", 503, false, false],
  ] as const) {
    const handler = createRefundReviewHandler({
      requireAdmin: async () => admin,
      reviewRefund: async () => ({ status: "APPLIED", auditId: "audit-1", resourceId: "refund-request-1" }),
      executeRefund: async () => { throw error; },
    });
    const response = await handler(request());
    const text = await response.text();
    assert.equal(response.status, status);
    assert.equal(text.includes("provider-secret-must-not-leak"), false);
    const result = JSON.parse(text);
    assert.equal(result.success, success);
    assert.equal(result.refundCompleted, false);
    assert.equal(result.requiresManualAction, manual);
    assert.equal(result.refundExecution.status, expected);
    if (!success) {
      assert.equal(result.approvalPersisted, true);
      assert.equal(result.error.code, "REFUND_EXECUTION_RETRY_REQUIRED");
    }
  }
});

test("unexpected execution failures emit one fixed safe event while manual review emits none", async () => {
  const events: BillingSecurityLogEvent[] = [];
  const base = {
    requireAdmin: async () => admin,
    reviewRefund: async () => ({ status: "APPLIED" as const, auditId: "audit-1", resourceId: "refund-request-1" }),
    logger: { warn: (event: BillingSecurityLogEvent) => events.push(event) },
  };
  const failed = createRefundReviewHandler({
    ...base,
    executeRefund: async () => { throw new Error("secret transaction txn-123"); },
  });
  await failed(request());
  assert.deepEqual(events, [{
    eventCode: "REFUND_EXECUTION_FAILED",
    errorCode: "REFUND_EXECUTION_RETRY_REQUIRED",
    status: "FAILED",
  }]);
  const manual = createRefundReviewHandler({
    ...base,
    executeRefund: async () => { throw new BillingError("REFUND_REQUIRES_MANUAL_REVIEW", "manual", 409); },
  });
  await manual(request());
  assert.equal(events.length, 1);
});

test("an explicit retry recovers an approved refund without reviewing it again", async () => {
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
  assert.equal(first.status, 503);
  assert.equal((await first.json()).refundExecution.status, "RETRY_REQUIRED");
  const second = await handler(retryRequest());
  assert.equal((await second.json()).refundExecution.status, "SUCCEEDED");
  assert.equal(reviewCalls, 1);
  assert.equal(executionCalls, 2);
});

test("an ordinary user cannot invoke the approved refund retry action", async () => {
  let executions = 0;
  const handler = createRefundReviewHandler({
    requireAdmin: async () => {
      throw new BillingError(
        "BILLING_ADMIN_REQUIRED",
        "An active billing administrator is required.",
        403,
      );
    },
    reviewRefund: async () => assert.fail("retry must not review"),
    executeRefund: async () => {
      executions += 1;
      return success();
    },
  });

  const response = await handler(retryRequest());
  assert.equal(response.status, 403);
  assert.equal(executions, 0);
});

test("retry preserves the manual-refund outcome without starting a new review", async () => {
  const handler = createRefundReviewHandler({
    requireAdmin: async () => admin,
    reviewRefund: async () => assert.fail("retry must not review"),
    executeRefund: async () => {
      throw new BillingError("REFUND_REQUIRES_MANUAL_REVIEW", "manual", 409);
    },
  });

  const response = await handler(retryRequest());
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    success: true,
    approvalPersisted: true,
    refundCompleted: false,
    requiresManualAction: true,
    refundExecution: { status: "MANUAL_REVIEW_REQUIRED" },
  });
});
