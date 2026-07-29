import { createAdminBillingHandler, getBillingAdminRepository } from "@/lib/billing/admin";

export async function GET(request: Request) {
  return createAdminBillingHandler({ operation: () => getBillingAdminRepository().listWebhookEvents() })(request);
}
