import { createAdminBillingHandler, getBillingAdminRepository } from "@/lib/billing/admin";

const handler = createAdminBillingHandler({
  operation: () => getBillingAdminRepository().listOrders(),
});

export async function GET(request: Request) {
  return handler(request);
}
