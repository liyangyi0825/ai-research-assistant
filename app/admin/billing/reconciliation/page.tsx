import { ReconciliationReportView } from "@/components/billing/ReconciliationReportView";
import { requireBillingAdmin } from "@/lib/billing/auth";
import { generateInternalReconciliationReport } from "@/lib/billing/reconciliation";

export const dynamic = "force-dynamic";

export default async function ReconciliationReportPage() {
  await requireBillingAdmin();
  const report = await generateInternalReconciliationReport();

  return <ReconciliationReportView report={report} />;
}
