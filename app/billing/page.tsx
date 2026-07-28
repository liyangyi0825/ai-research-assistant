import { BillingCenter } from "@/components/billing/BillingCenter";

export default function BillingPage() {
  return (
    <div className="min-h-full bg-slate-50 px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 max-w-2xl">
          <p className="text-xs font-semibold tracking-[0.18em] text-blue-700">
            BILLING LAB NOTE
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            账单与科研资源
          </h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            查看当前套餐有效期、credits、周期配额、订单与售后申请。所有状态均以服务端账务记录为准。
          </p>
        </header>
        <BillingCenter />
      </div>
    </div>
  );
}
