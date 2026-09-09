import { AdminBillingView } from "../AdminBillingView";
import { getBillingAdminRepository } from "@/lib/billing/admin";
import { requireBillingAdmin } from "@/lib/billing/auth";

export const dynamic = "force-dynamic";
export default async function Page() {
  await requireBillingAdmin();
  return <AdminBillingView title="退款申请审核" description="审核仅改变申请与订单退款状态；真实 Provider 退款尚未启用。"
    data={await getBillingAdminRepository().listRefunds()} />;
}
