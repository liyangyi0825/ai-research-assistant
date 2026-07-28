type ResearchResourceScaleProps = {
  label: string;
  value: number;
  max: number;
  valueLabel: string;
  detail: string;
};

export function ResearchResourceScale({
  label,
  value,
  max,
  valueLabel,
  detail,
}: ResearchResourceScaleProps) {
  const safeMax = Math.max(1, max);
  const progress = Math.min(100, Math.max(0, (value / safeMax) * 100));

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.14em] text-slate-500">
            {label}
          </p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-slate-950">
            {valueLabel}
          </p>
        </div>
        <p className="text-right text-xs leading-5 text-slate-500">{detail}</p>
      </div>
      <div
        className="relative mt-4 h-8 overflow-hidden rounded-md border border-slate-300 bg-white"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={Math.min(safeMax, Math.max(0, value))}
      >
        <div
          className="absolute inset-y-0 left-0 bg-blue-100 transition-[width] motion-reduce:transition-none"
          style={{ width: `${progress}%` }}
        />
        <div className="absolute inset-0 flex justify-between px-2" aria-hidden>
          {Array.from({ length: 17 }, (_, index) => (
            <span
              key={index}
              className={`mt-auto w-px bg-slate-400 ${
                index % 4 === 0 ? "h-4" : "h-2"
              }`}
            />
          ))}
        </div>
        <span
          className="absolute inset-y-0 w-0.5 bg-blue-700 shadow-[0_0_0_2px_rgba(255,255,255,0.8)]"
          style={{ left: `calc(${progress}% - 1px)` }}
          aria-hidden
        />
      </div>
    </div>
  );
}
