import Link from "next/link";

import {
  LEGAL_DOCUMENTS,
  getLegalDocument,
  type LegalDocumentSlug,
} from "@/lib/legal/documents";
import { getLegalOperatorConfig } from "@/lib/legal/config";

export function LegalDocumentPage({ slug }: { slug: LegalDocumentSlug }) {
  const document = getLegalDocument(slug);
  const operator = getLegalOperatorConfig();

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-10 text-slate-900 sm:px-8 sm:py-14">
      <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <p className="text-xs font-semibold tracking-[0.2em] text-blue-700">
            RESEARCH / LEGAL
          </p>
          <nav aria-label="法律文件" className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-1">
            {LEGAL_DOCUMENTS.map((item) => {
              const current = item.slug === slug;
              return (
                <Link
                  key={item.slug}
                  href={`/legal/${item.slug}`}
                  aria-current={current ? "page" : undefined}
                  className={`rounded-lg border px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    current
                      ? "border-blue-200 bg-blue-50 font-semibold text-blue-800"
                      : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-950"
                  }`}
                >
                  {item.shortTitle}
                </Link>
              );
            })}
          </nav>
        </aside>

        <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-6 py-8 sm:px-10 sm:py-10">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
                草案 · 未正式生效
              </span>
              <span className="text-xs text-slate-500">版本：2026-07 草案</span>
            </div>
            <h1 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {document.title}
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-8 text-slate-600">
              {document.summary}
            </p>
            <div className="mt-6 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
              <p>{document.statusNotice}</p>
              <p className="mt-1">{document.reviewNotice}</p>
            </div>
          </header>

          <div className="space-y-10 px-6 py-8 sm:px-10 sm:py-10">
            {document.sections.map((section, index) => (
              <section key={section.heading} aria-labelledby={`section-${index}`}>
                <div className="flex items-baseline gap-4">
                  <span className="font-mono text-xs text-blue-700">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h2
                    id={`section-${index}`}
                    className="text-xl font-semibold tracking-tight text-slate-950"
                  >
                    {section.heading}
                  </h2>
                </div>
                <div className="mt-4 space-y-3 pl-9 text-sm leading-7 text-slate-700 sm:text-base sm:leading-8">
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <footer className="grid gap-4 border-t border-slate-200 bg-slate-50 px-6 py-6 text-sm sm:grid-cols-3 sm:px-10">
            <OperatorField label="运营主体" value={operator.operatorName} />
            <OperatorField
              label="统一社会信用代码"
              value={operator.operatorCreditCode}
            />
            <OperatorField label="联系邮箱" value={operator.contactEmail} />
            {operator.isPlaceholder ? (
              <p className="text-xs leading-5 text-slate-500 sm:col-span-3">
                主体信息尚未完整配置，正式生效前将依法确认并更新。
              </p>
            ) : null}
          </footer>
        </article>
      </div>
    </main>
  );
}

function OperatorField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 break-words font-medium text-slate-800">{value}</p>
    </div>
  );
}
