import { createAdminBillingHandler, getBillingAdminRepository, reviewRefundRequest } from "@/lib/billing/admin";
import { requireBillingAdmin, type BillingAdmin } from "@/lib/billing/auth";
import { BillingError } from "@/lib/billing/errors";
import { executeApprovedRefund } from "@/lib/billing/refunds";
import {
  billingSecurityLogger,
  type BillingSecurityLogger,
  warnBillingSecurity,
} from "@/lib/billing/security-logger";

export async function GET(request: Request) {
  return createAdminBillingHandler({ operation: () => getBillingAdminRepository().listRefunds() })(request);
}

type RefundReviewDependencies = {
  requireAdmin?: () => Promise<BillingAdmin>;
  reviewRefund?: typeof reviewRefundRequest;
  executeRefund?: typeof executeApprovedRefund;
  logger?: BillingSecurityLogger;
};

export function createRefundReviewHandler(
  dependencies: RefundReviewDependencies = {},
) {
  return async (request: Request): Promise<Response> => {
    try {
      const admin = await (dependencies.requireAdmin ?? requireBillingAdmin)();
      const body = await request.json() as Record<string, unknown>;
      if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
        throw new BillingError("INVALID_ADMIN_INPUT", "Unknown refund decision.", 400);
      }
      const requestId = String(body.requestId ?? "");
      const review = await (dependencies.reviewRefund ?? reviewRefundRequest)(admin, {
        requestId,
        decision: body.decision,
        reason: String(body.reason ?? ""),
        idempotencyKey: String(body.idempotencyKey ?? ""),
      });

      if (body.decision === "REJECTED") {
        return Response.json({
          success: true,
          refundCompleted: false,
          requiresManualAction: false,
          ...review,
          refundExecution: { status: "NOT_REQUESTED" as const },
        });
      }
      try {
        const execution = await (
          dependencies.executeRefund ?? executeApprovedRefund
        )(requestId);
        return Response.json({
          success: true,
          refundCompleted: true,
          requiresManualAction: false,
          ...review,
          refundExecution: execution,
        });
      } catch (error) {
        if (
          error instanceof BillingError &&
          error.code === "REFUND_REQUIRES_MANUAL_REVIEW"
        ) {
          return Response.json({
            success: true,
            refundCompleted: false,
            requiresManualAction: true,
            ...review,
            refundExecution: { status: "MANUAL_REVIEW_REQUIRED" as const },
          }, { status: 202 });
        }
        warnBillingSecurity(dependencies.logger ?? billingSecurityLogger, {
          eventCode: "REFUND_EXECUTION_FAILED",
          errorCode: "REFUND_EXECUTION_RETRY_REQUIRED",
          status: "FAILED",
        });
        return Response.json({
          success: false,
          approvalPersisted: true,
          refundCompleted: false,
          requiresManualAction: false,
          ...review,
          refundExecution: { status: "RETRY_REQUIRED" as const },
          error: {
            code: "REFUND_EXECUTION_RETRY_REQUIRED",
            message: "Refund approval was saved, but execution must be retried.",
          },
        }, { status: 503 });
      }
    } catch (error) {
      const safe = error instanceof BillingError
        ? error
        : new BillingError("BILLING_STORAGE_UNAVAILABLE", "Billing storage is unavailable.", 503);
      return Response.json(
        { success: false, error: { code: safe.code, message: safe.message } },
        { status: safe.status },
      );
    }
  };
}

export const PATCH = createRefundReviewHandler();
