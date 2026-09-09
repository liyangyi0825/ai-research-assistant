import Link from "next/link";

const links = [
  ["/admin/billing", "总览"],
  ["/admin/billing/orders", "订单"],
  ["/admin/billing/refunds", "退款审核"],
  ["/admin/billing/invoices", "发票申请"],
  ["/admin/billing/webhooks", "回调事件"],
] as const;

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item, 2);
}

export function AdminBillingView({ title, description, data }: {
  title: string;
  description: string;
  data: unknown;
}) {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="rounded-3xl border border-cyan-300/20 bg-slate-900 p-7 shadow-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cyan-300">
            Billing control room · 测试功能
          </p>
          <h1 className="mt-3 text-3xl font-semibold">{title}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">{description}</p>
          <nav className="mt-6 flex flex-wrap gap-2">
            {links.map(([href, label]) => (
              <Link key={href} href={href}
                className="rounded-full border border-slate-700 px-4 py-2 text-sm hover:border-cyan-300 hover:text-cyan-200">
                {label}
              </Link>
            ))}
          </nav>
        </header>
        <section className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900">
          <div className="border-b border-slate-800 px-6 py-4 text-sm text-slate-400">
            仅展示脱敏业务字段；不会展示密钥或完整 webhook 载荷。
          </div>
          <pre className="max-h-[65vh] overflow-auto p-6 text-xs leading-6 text-slate-300">
            {safeJson(data)}
          </pre>
        </section>
      </div>
    </main>
  );
}
