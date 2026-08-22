import { createAdminBillingHandler, getBillingAdminRepository } from "@/lib/billing/admin";
import { createRefundReviewHandler } from "./server";

export async function GET(request: Request) {
  return createAdminBillingHandler({ operation: () => getBillingAdminRepository().listRefunds() })(request);
}

export const PATCH = createRefundReviewHandler();
