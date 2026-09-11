import { BillingCenter } from "@/components/billing/BillingCenter";

export default function BillingPage() {
  return (
    <div className="min-h-full bg-slate-50 px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto max-w-6xl">
        <header className="mb-7 max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
            账单与科研资源
          </h1>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            了解可用资源与配额使用情况，查看订单和售后进度。
          </p>
        </header>
        <BillingCenter />
      </div>
    </div>
  );
}
