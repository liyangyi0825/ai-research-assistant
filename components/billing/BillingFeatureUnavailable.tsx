import Link from "next/link";

export function BillingFeatureUnavailable() {
  return (
    <section className="mx-auto flex min-h-[70vh] max-w-3xl items-center px-5 py-12 sm:px-8">
      <div className="w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-9">
        <div className="mb-5 h-1.5 w-20 rounded-full bg-blue-600" />
        <p className="text-xs font-semibold tracking-[0.18em] text-blue-700">
          BILLING / CLOSED
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          收费功能暂未开放
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-7 text-slate-600">
          当前处于备案信息变更期，套餐购买与支付入口保持关闭。现有科研功能不受影响，
          开放时间请以站内通知为准。
        </p>
        <Link
          href="/"
          className="mt-7 inline-flex rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 outline-none transition hover:border-blue-400 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          返回科研工作台
        </Link>
      </div>
    </section>
  );
}
