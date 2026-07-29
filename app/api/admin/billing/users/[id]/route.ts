import { createAdminBillingHandler, getBillingAdminRepository } from "@/lib/billing/admin";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return createAdminBillingHandler({
    operation: () => getBillingAdminRepository().getUser(id),
  })(request);
}
