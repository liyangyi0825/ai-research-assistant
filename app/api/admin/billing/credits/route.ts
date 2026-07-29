import { adjustUserCredit, createAdminBillingHandler } from "@/lib/billing/admin";
import { BillingError } from "@/lib/billing/errors";

export async function POST(request: Request) {
  return createAdminBillingHandler({
    operation: async (admin) => {
      const body = await request.json() as Record<string, unknown>;
      if (!Number.isSafeInteger(body.amount)) {
        throw new BillingError("INVALID_ADMIN_INPUT", "Amount must be an integer.", 400);
      }
      return adjustUserCredit(admin, {
        userId: String(body.userId ?? ""),
        amount: Number(body.amount),
        reason: String(body.reason ?? ""),
        idempotencyKey: String(body.idempotencyKey ?? ""),
      });
    },
  })(request);
}
