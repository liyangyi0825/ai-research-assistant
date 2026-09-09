import { createAdminBillingHandler, grantUserSubscription } from "@/lib/billing/admin";

export async function POST(request: Request) {
  return createAdminBillingHandler({
    operation: async (admin) => {
      const body = await request.json() as Record<string, unknown>;
      return grantUserSubscription(admin, {
        userId: String(body.userId ?? ""),
        planId: String(body.planId ?? ""),
        durationDays: Number(body.durationDays),
        reason: String(body.reason ?? ""),
        idempotencyKey: String(body.idempotencyKey ?? ""),
      });
    },
  })(request);
}
