import { AdminBillingView } from "../AdminBillingView";
import { getBillingAdminRepository } from "@/lib/billing/admin";
import { requireBillingAdmin } from "@/lib/billing/auth";

export const dynamic = "force-dynamic";
export default async function Page() {
  await requireBillingAdmin();
  return <AdminBillingView title="订单与支付记录" description="订单金额是服务端商品快照，只读且不可由管理端改写。"
    data={await getBillingAdminRepository().listOrders()} />;
}
