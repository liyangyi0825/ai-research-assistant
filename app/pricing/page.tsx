import { connection } from "next/server";

import { BillingFeatureUnavailable } from "@/components/billing/BillingFeatureUnavailable";
import { PricingProducts } from "@/components/billing/PricingProducts";
import { getBillingConfig } from "@/lib/billing/config";

export default async function PricingPage() {
  await connection();
  let enabled = false;
  try {
    enabled = getBillingConfig().featureEnabled;
  } catch {
    enabled = false;
  }

  if (!enabled) {
    return <BillingFeatureUnavailable />;
  }

  return (
    <div className="min-h-full bg-slate-50 px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 max-w-2xl">
          <p className="text-xs font-semibold tracking-[0.18em] text-blue-700">
            RESEARCH ACCESS
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            套餐与科研资源
          </h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            价格、有效期与资源额度均来自服务端当前商品记录。选择前请核对科研资源刻度，
            页面不会以浏览器提交的金额作为计价依据。
          </p>
        </header>
        <PricingProducts />
      </div>
    </div>
  );
}
