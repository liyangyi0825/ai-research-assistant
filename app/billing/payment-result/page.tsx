import { connection } from "next/server";

import { BillingFeatureUnavailable } from "@/components/billing/BillingFeatureUnavailable";
import { PaymentResult } from "@/components/billing/PaymentResult";
import { getBillingConfig } from "@/lib/billing/config";
import { getCurrentBillingAvailability } from "@/lib/billing/user-pages";

export default async function BillingPaymentResultPage({
  searchParams,
}: {
  searchParams: Promise<{
    orderId?: string | string[];
  }>;
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

  const availability = await getCurrentBillingAvailability();
  const query = await searchParams;
  const orderId =
    typeof query.orderId === "string" ? query.orderId : "";

  return (
    <div className="min-h-full bg-slate-50 px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <PaymentResult
          orderId={orderId}
          mockConfirmationAllowed={
            availability.available &&
            availability.mockConfirmationAllowed
          }
        />
      </div>
    </div>
  );
}
