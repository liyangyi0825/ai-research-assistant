import type { InternalReconciliationReport, ReconciliationSeverity } from "@/lib/billing/reconciliation";

const severityClassName: Record<ReconciliationSeverity, string> = {
  CRITICAL: "border-rose-400/40 bg-rose-400/10 text-rose-200",
  WARNING: "border-amber-300/40 bg-amber-300/10 text-amber-100",
  INFO: "border-sky-300/40 bg-sky-300/10 text-sky-100",
};

function SummaryCount({ name, label, value, className }: { name: string; label: string; value: number; className: string }) {
  const labelId = `summary-${name}-label`;
  return <div className={`rounded-2xl border p-4 ${className}`}>
    <dt id={labelId} className="text-xs font-semibold uppercase tracking-[0.18em]">{label}</dt>
    <dd aria-labelledby={labelId} className="mt-2 font-mono text-3xl font-semibold tabular-nums">{value}</dd>
  </div>;
}

export function ReconciliationReportView({ report }: { report: InternalReconciliationReport }) {
  return <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="border border-cyan-300/20 bg-slate-900 p-7 shadow-2xl sm:rounded-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cyan-300">Billing control room · internal audit</p>
        <h1 className="mt-3 text-3xl font-semibold">内部数据库一致性报告</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">只读报告，不会自动修改账务。不代表已与微信或支付宝完成对账。</p>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="border-l-2 border-cyan-300 pl-3">
            <dt className="text-xs uppercase tracking-[0.18em] text-slate-500">范围</dt>
            <dd className="mt-1 font-mono text-sm text-cyan-100">{report.scope}</dd>
          </div>
          <div className="border-l-2 border-cyan-300 pl-3">
            <dt className="text-xs uppercase tracking-[0.18em] text-slate-500">生成时间</dt>
            <dd className="mt-1 font-mono text-sm text-cyan-100"><time dateTime={report.generatedAt}>{report.generatedAt}</time></dd>
          </div>
        </dl>
      </header>

      <section aria-labelledby="reconciliation-summary" className="border border-slate-800 bg-slate-900 p-6 sm:rounded-3xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">检查摘要</p>
            <h2 id="reconciliation-summary" className="mt-2 text-xl font-semibold">已发现 {report.summary.total} 项内部数据异常</h2>
          </div>
          {report.truncated ? <p className="border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">仅显示前 200 项；完整计数见摘要。</p> : null}
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-4">
          <SummaryCount name="total" label="总计" value={report.summary.total} className="border-slate-700 bg-slate-950 text-slate-100" />
          <SummaryCount name="critical" label="严重" value={report.summary.critical} className="border-rose-400/40 bg-rose-400/10 text-rose-100" />
          <SummaryCount name="warning" label="警告" value={report.summary.warning} className="border-amber-300/40 bg-amber-300/10 text-amber-100" />
          <SummaryCount name="info" label="提示" value={report.summary.info} className="border-sky-300/40 bg-sky-300/10 text-sky-100" />
        </dl>
        <dl className="mt-5 grid gap-x-6 gap-y-2 border-t border-slate-800 pt-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(report.summary.byCode).map(([code, count]) => <div key={code} className="flex justify-between gap-3 font-mono text-slate-300">
            <dt id={`finding-count-${code}`}>{code}</dt><dd aria-labelledby={`finding-count-${code}`} className="tabular-nums text-slate-100">{count}</dd>
          </div>)}
        </dl>
      </section>

      <section aria-labelledby="reconciliation-findings" className="overflow-hidden border border-slate-800 bg-slate-900 sm:rounded-3xl">
        <div className="border-b border-slate-800 px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">稳定排序的报告项</p>
          <h2 id="reconciliation-findings" className="mt-2 text-xl font-semibold">异常明细</h2>
        </div>
        {report.items.length === 0 ? <p className="px-6 py-10 text-sm text-slate-400">当前快照中未发现内部数据一致性异常。</p> : <div className="overflow-x-auto">
          <table aria-label="Reconciliation findings" className="w-full min-w-[780px] border-collapse text-left text-sm">
            <thead className="bg-slate-950 text-xs uppercase tracking-[0.14em] text-slate-500"><tr>
              <th className="px-6 py-4 font-semibold">级别 / 代码</th><th className="px-6 py-4 font-semibold">记录</th><th className="px-6 py-4 font-semibold">订单号</th><th className="px-6 py-4 font-semibold">发现时间</th><th className="px-6 py-4 font-semibold">说明</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-800">
              {report.items.map((item) => <tr key={`${item.code}-${item.entityType}-${item.entityId}`} data-finding-code={item.code} data-entity-id={item.entityId} className="align-top text-slate-300">
                <td className="px-6 py-5"><span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${severityClassName[item.severity]}`}>{item.severity}</span><code className="mt-2 block text-xs text-cyan-200">{item.code}</code></td>
                <td className="px-6 py-5"><span className="block text-xs text-slate-500">{item.entityType}</span><code className="text-xs text-slate-200">{item.entityId}</code></td>
                <td className="px-6 py-5 font-mono text-xs text-slate-200">{item.orderNumber ?? "—"}</td>
                <td className="px-6 py-5 font-mono text-xs text-slate-400"><time dateTime={item.detectedAt}>{item.detectedAt}</time></td>
                <td className="px-6 py-5 leading-6 text-slate-200">{item.message}</td>
              </tr>)}
            </tbody>
          </table>
        </div>}
      </section>
    </div>
  </main>;
}
