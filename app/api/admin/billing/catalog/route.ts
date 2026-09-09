import {
  createAdminBillingHandler,
  getBillingAdminRepository,
  upsertBillingPlan,
  upsertBillingProduct,
} from "@/lib/billing/admin";
import { BillingError } from "@/lib/billing/errors";

export async function GET(request: Request) {
  return createAdminBillingHandler({ operation: () => getBillingAdminRepository().listCatalog() })(request);
}

export async function PATCH(request: Request) {
  return createAdminBillingHandler({
    operation: async (admin) => {
      const body = await request.json() as Record<string, unknown>;
      if (body.kind === "plan") return upsertBillingPlan(admin, body);
      if (body.kind === "product") return upsertBillingProduct(admin, body);
      throw new BillingError("INVALID_ADMIN_INPUT", "Unknown catalog resource.", 400);
    },
  })(request);
}
