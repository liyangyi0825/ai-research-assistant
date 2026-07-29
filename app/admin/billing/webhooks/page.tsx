import { AdminBillingView } from "../AdminBillingView";
import { getBillingAdminRepository } from "@/lib/billing/admin";
import { requireBillingAdmin } from "@/lib/billing/auth";

export const dynamic = "force-dynamic";
export default async function Page() {
  await requireBillingAdmin();
  return <AdminBillingView title="支付回调事件" description="只展示事件标识、哈希、状态和安全错误码，不展示完整敏感载荷。"
    data={await getBillingAdminRepository().listWebhookEvents()} />;
}
