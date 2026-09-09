import { OrderDetail } from "@/components/billing/OrderDetail";

export default async function BillingOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="min-h-full bg-slate-50 px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <OrderDetail orderId={id} />
      </div>
    </div>
  );
}
