import { createAdminBillingHandler, getBillingAdminRepository, reviewRefundRequest } from "@/lib/billing/admin";
import { BillingError } from "@/lib/billing/errors";

export async function GET(request: Request) {
  return createAdminBillingHandler({ operation: () => getBillingAdminRepository().listRefunds() })(request);
}

export async function PATCH(request: Request) {
  return createAdminBillingHandler({
    operation: async (admin) => {
      const body = await request.json() as Record<string, unknown>;
      if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
        throw new BillingError("INVALID_ADMIN_INPUT", "Unknown refund decision.", 400);
      }
      return reviewRefundRequest(admin, {
        requestId: String(body.requestId ?? ""),
        decision: body.decision,
        reason: String(body.reason ?? ""),
        idempotencyKey: String(body.idempotencyKey ?? ""),
      });
    },
  })(request);
}
