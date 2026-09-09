import { AdminBillingView } from "../AdminBillingView";
import { getBillingAdminRepository } from "@/lib/billing/admin";
import { requireBillingAdmin } from "@/lib/billing/auth";

export const dynamic = "force-dynamic";
export default async function Page() {
  await requireBillingAdmin();
  return <AdminBillingView title="发票申请" description="查看申请字段与处理状态；当前阶段不对接真实开票系统。"
    data={await getBillingAdminRepository().listInvoices()} />;
}
