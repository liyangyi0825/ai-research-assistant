import { createAdminBillingHandler } from "@/lib/billing/admin";
import type { BillingAdmin } from "@/lib/billing/auth";
import { generateInternalReconciliationReport, type InternalReconciliationReport } from "@/lib/billing/reconciliation";

type ReconciliationRouteDependencies = {
  requireAdmin?: () => Promise<BillingAdmin>;
  generateReport?: () => Promise<InternalReconciliationReport>;
};

export function createReconciliationGetHandler(dependencies: ReconciliationRouteDependencies = {}) {
  return createAdminBillingHandler({
    requireAdmin: dependencies.requireAdmin,
    operation: () => (dependencies.generateReport ?? generateInternalReconciliationReport)(),
  });
}

export async function GET(request: Request) {
  return createReconciliationGetHandler()(request);
}
