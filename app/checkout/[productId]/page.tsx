import { connection } from "next/server";

import { BillingFeatureUnavailable } from "@/components/billing/BillingFeatureUnavailable";
import { CheckoutPanel } from "@/components/billing/CheckoutPanel";
import { getBillingConfig } from "@/lib/billing/config";

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
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

  const { productId } = await params;
  return (
    <div className="min-h-full bg-slate-50 px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-7">
          <p className="text-xs font-semibold tracking-[0.18em] text-blue-700">
            CHECKOUT
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            核对订单
          </h1>
        </header>
        <CheckoutPanel productId={productId} />
      </div>
    </div>
  );
}
