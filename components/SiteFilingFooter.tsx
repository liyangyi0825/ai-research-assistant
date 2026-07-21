import Image from "next/image";

const linkClass =
  "rounded-sm transition-colors hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500";

export function SiteFilingFooter() {
  return (
    <footer className="shrink-0 border-t border-slate-200/70 bg-white px-4 py-2 text-[11px] text-slate-400">
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <a
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          津ICP备2026007356号
        </a>
        <span aria-hidden="true" className="hidden text-slate-300 sm:inline">
          |
        </span>
        <a
          href="https://beian.mps.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 ${linkClass}`}
        >
          <Image
            src="/beian-police.png"
            alt="公安备案"
            width={14}
            height={14}
          />
          冀公网安备13028302000277号
        </a>
      </div>
    </footer>
  );
}
