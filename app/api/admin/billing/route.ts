import { createAdminBillingHandler, getBillingAdminRepository } from "@/lib/billing/admin";

const handler = createAdminBillingHandler({
  operation: () => getBillingAdminRepository().getOverview(),
});

export async function GET(request: Request) {
  return handler(request);
}
