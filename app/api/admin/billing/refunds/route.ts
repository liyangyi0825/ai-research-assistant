import { createAdminBillingHandler, getBillingAdminRepository, reviewRefundRequest } from "@/lib/billing/admin";
import type { BillingAdmin } from "@/lib/billing/auth";
import { BillingError } from "@/lib/billing/errors";
import { executeApprovedRefund } from "@/lib/billing/refunds";

export async function GET(request: Request) {
  return createAdminBillingHandler({ operation: () => getBillingAdminRepository().listRefunds() })(request);
}

type RefundReviewDependencies = {
  requireAdmin?: () => Promise<BillingAdmin>;
  reviewRefund?: typeof reviewRefundRequest;
  executeRefund?: typeof executeApprovedRefund;
};

export function createRefundReviewHandler(
  dependencies: RefundReviewDependencies = {},
) {
  return createAdminBillingHandler({
    requireAdmin: dependencies.requireAdmin,
    operation: async (admin, request) => {
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
        return { ...review, refundExecution: { status: "NOT_REQUESTED" as const } };
      }
      try {
        const execution = await (
          dependencies.executeRefund ?? executeApprovedRefund
        )(requestId);
        return { ...review, refundExecution: execution };
      } catch (error) {
        if (
          error instanceof BillingError &&
          error.code === "REFUND_REQUIRES_MANUAL_REVIEW"
        ) {
          return {
            ...review,
            refundExecution: { status: "MANUAL_REVIEW_REQUIRED" as const },
          };
        }
        return {
          ...review,
          refundExecution: { status: "RETRY_REQUIRED" as const },
        };
      }
    },
  });
}

export const PATCH = createRefundReviewHandler();
