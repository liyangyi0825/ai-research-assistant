import {
  createAdminBillingHandler,
  getBillingAdminRepository,
  reviewRefundRequest,
  type BillingAdminRepository,
} from "@/lib/billing/admin";
import { requireBillingAdmin, type BillingAdmin } from "@/lib/billing/auth";
import { BillingError } from "@/lib/billing/errors";
import { executeApprovedRefund } from "@/lib/billing/refunds";
import {
  billingSecurityLogger,
  type BillingSecurityLogger,
  warnBillingSecurity,
} from "@/lib/billing/security-logger";

type RefundReviewDependencies = {
  requireAdmin?: () => Promise<BillingAdmin>;
  reviewRefund?: typeof reviewRefundRequest;
  executeRefund?: typeof executeApprovedRefund;
  logger?: BillingSecurityLogger;
};

type RefundListDependencies = {
  requireAdmin?: () => Promise<BillingAdmin>;
  listRefunds?: BillingAdminRepository["listRefunds"];
};

export function createRefundListHandler(
  dependencies: RefundListDependencies = {},
) {
  return createAdminBillingHandler({
    requireAdmin: dependencies.requireAdmin,
    operation: () =>
      (dependencies.listRefunds ?? (() =>
        getBillingAdminRepository().listRefunds()))(),
  });
}

export function createRefundReviewHandler(
  dependencies: RefundReviewDependencies = {},
) {
  return async (request: Request): Promise<Response> => {
    try {
      const admin = await (dependencies.requireAdmin ?? requireBillingAdmin)();
      const body = await request.json() as Record<string, unknown>;
      const requestId = String(body.requestId ?? "");
      const action = body.action ?? "REVIEW";
      if (action !== "REVIEW" && action !== "RETRY_EXECUTION") {
        throw new BillingError("INVALID_ADMIN_INPUT", "Unknown refund action.", 400);
      }

      const execute = async (
        persisted: Record<string, unknown>,
      ): Promise<Response> => {
        try {
          const execution = await (
            dependencies.executeRefund ?? executeApprovedRefund
          )(requestId);
          return Response.json({
            success: true,
            refundCompleted: true,
            requiresManualAction: false,
            ...persisted,
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
              ...persisted,
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
            ...persisted,
            refundExecution: { status: "RETRY_REQUIRED" as const },
            error: {
              code: "REFUND_EXECUTION_RETRY_REQUIRED",
              message: "Refund approval was saved. Use the approved refund retry action.",
            },
          }, { status: 503 });
        }
      };

      if (action === "RETRY_EXECUTION") {
        return execute({ approvalPersisted: true });
      }

      if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
        throw new BillingError("INVALID_ADMIN_INPUT", "Unknown refund decision.", 400);
      }
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
      return execute(review);
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

export const refundGetHandler = createRefundListHandler();
export const refundPatchHandler = createRefundReviewHandler();
