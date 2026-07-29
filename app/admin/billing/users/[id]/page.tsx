import { AdminBillingView } from "../../AdminBillingView";
import { getBillingAdminRepository } from "@/lib/billing/admin";
import { requireBillingAdmin } from "@/lib/billing/auth";

export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireBillingAdmin();
  const { id } = await params;
  return <AdminBillingView title="用户收费档案" description="会员、权益、额度与用量状态。人工变更必须填写原因并通过审计事务。"
    data={await getBillingAdminRepository().getUser(id)} />;
}
