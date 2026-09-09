import assert from "node:assert/strict";
import test from "node:test";

import { formatAdminActionResult } from "../../app/admin/billing/AdminBillingActions";

test("refund admin feedback distinguishes completion, manual action, and retry", () => {
  assert.match(formatAdminActionResult("/api/admin/billing/refunds", true, {
    auditId: "audit-1",
    refundCompleted: true,
    refundExecution: { status: "SUCCEEDED" },
  }), /已退款/);
  assert.match(formatAdminActionResult("/api/admin/billing/refunds", true, {
    auditId: "audit-1",
    requiresManualAction: true,
    refundExecution: { status: "MANUAL_REVIEW_REQUIRED" },
  }), /已批准待人工退款/);
  const retryFeedback = formatAdminActionResult("/api/admin/billing/refunds", false, {
    auditId: "audit-1",
    approvalPersisted: true,
    refundExecution: { status: "RETRY_REQUIRED" },
  });
  assert.match(retryFeedback, /审批已保存但退款执行失败需重试/);
  assert.match(retryFeedback, /重试已批准退款/);
});

test("non-refund admin feedback preserves generic response semantics", () => {
  assert.match(formatAdminActionResult("/api/admin/billing/invoices", true, { auditId: "audit-2" }), /操作成功/);
  assert.match(formatAdminActionResult("/api/admin/billing/invoices", false, {
    error: { message: "invalid" },
  }), /操作失败.*invalid/);
});

test("the approved-refund retry action sends only its action and request id", async () => {
  const adminActionsModule = await import("../../app/admin/billing/AdminBillingActions") as typeof import("../../app/admin/billing/AdminBillingActions") & {
    adminBillingActions?: Array<{
      fixed?: Record<string, unknown>;
      fields: Array<{ name: string; type?: string }>;
      requiresIdempotencyKey?: boolean;
    }>;
    buildAdminActionBody?: (
      action: {
        fixed?: Record<string, unknown>;
        fields: Array<{ name: string; type?: string }>;
        requiresIdempotencyKey?: boolean;
      },
      raw: Record<string, FormDataEntryValue>,
      createIdempotencyKey: () => string,
    ) => Record<string, unknown>;
  };
  assert.ok(adminActionsModule.adminBillingActions, "admin actions must be observable for request construction tests");
  assert.equal(typeof adminActionsModule.buildAdminActionBody, "function");
  const retry = adminActionsModule.adminBillingActions.find(
    (action) => action.fixed?.action === "RETRY_EXECUTION",
  );
  assert.ok(retry, "an explicit retry action must be available");

  const body = adminActionsModule.buildAdminActionBody!(
    retry,
    { requestId: "refund-request-1" },
    () => "must-not-be-used",
  );
  assert.deepEqual(body, {
    action: "RETRY_EXECUTION",
    requestId: "refund-request-1",
  });
});
