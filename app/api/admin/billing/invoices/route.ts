import { createAdminBillingHandler, getBillingAdminRepository, reviewInvoiceRequest } from "@/lib/billing/admin";
import { BillingError } from "@/lib/billing/errors";

export async function GET(request: Request) {
  return createAdminBillingHandler({ operation: () => getBillingAdminRepository().listInvoices() })(request);
}

export async function PATCH(request: Request) {
  return createAdminBillingHandler({
    operation: async (admin) => {
      const body = await request.json() as Record<string, unknown>;
      if (body.decision !== "ISSUED" && body.decision !== "REJECTED") {
        throw new BillingError("INVALID_ADMIN_INPUT", "Unknown invoice decision.", 400);
      }
      return reviewInvoiceRequest(admin, {
        requestId: String(body.requestId ?? ""),
        decision: body.decision,
        reason: String(body.reason ?? ""),
        idempotencyKey: String(body.idempotencyKey ?? ""),
      });
    },
  })(request);
}
