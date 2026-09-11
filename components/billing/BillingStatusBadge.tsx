import { ORDER_STATUS_DISPLAY } from "@/lib/billing/order-display";
import type { BillingOrderStatus } from "@/lib/billing/repositories";

const TONE_CLASSES = {
  attention: "border-amber-200 bg-amber-50 text-amber-900",
  success: "border-teal-200 bg-teal-50 text-teal-800",
  neutral: "border-slate-200 bg-slate-50 text-slate-600",
};

export function BillingStatusBadge({ status }: { status: BillingOrderStatus }) {
  const { label, tone } = ORDER_STATUS_DISPLAY[status];
  return (
    <span
      aria-label={`订单状态：${label}`}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
