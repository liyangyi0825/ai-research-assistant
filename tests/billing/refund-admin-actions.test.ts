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
  assert.match(formatAdminActionResult("/api/admin/billing/refunds", false, {
    auditId: "audit-1",
    approvalPersisted: true,
    refundExecution: { status: "RETRY_REQUIRED" },
  }), /审批已保存但退款执行失败需重试/);
});

test("non-refund admin feedback preserves generic response semantics", () => {
  assert.match(formatAdminActionResult("/api/admin/billing/invoices", true, { auditId: "audit-2" }), /操作成功/);
  assert.match(formatAdminActionResult("/api/admin/billing/invoices", false, {
    error: { message: "invalid" },
  }), /操作失败.*invalid/);
});
