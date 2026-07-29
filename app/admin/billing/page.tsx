import { AdminBillingView } from "./AdminBillingView";
import { getBillingAdminRepository } from "@/lib/billing/admin";
import { requireBillingAdmin } from "@/lib/billing/auth";

export const dynamic = "force-dynamic";

export default async function BillingAdminPage() {
  await requireBillingAdmin();
  const repository = getBillingAdminRepository();
  const [overview, catalog] = await Promise.all([
    repository.getOverview(),
    repository.listCatalog(),
  ]);
  return <AdminBillingView title="收费管理总览"
    description="查看待处理工作、套餐与商品配置和近期管理员操作审计。所有写操作仍由服务端事务接口处理。"
    data={{ overview, catalog }} />;
}
