"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type {
  BillingAvailability,
  BillingSummary,
} from "@/lib/billing/user-pages";
import { ResearchResourceScale } from "./ResearchResourceScale";

function date(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function money(amountMinor: number, currency: "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

const ORDER_STATUS: Record<string, string> = {
  PENDING: "待支付",
  PAID: "已支付",
  FAILED: "支付失败",
  CANCELLED: "已取消",
  CLOSED: "已关闭",
  REFUNDING: "退款审核中",
  REFUNDED: "已退款",
};

export function BillingCenter() {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [availability, setAvailability] =
    useState<BillingAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/billing/summary", {
        signal: controller.signal,
        cache: "no-store",
      }),
      fetch("/api/billing/availability", {
        signal: controller.signal,
        cache: "no-store",
      }),
    ])
      .then(async ([summaryResponse, availabilityResponse]) => {
        if (summaryResponse.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!summaryResponse.ok || !availabilityResponse.ok) {
          throw new Error("billing data unavailable");
        }
        const summaryBody = (await summaryResponse.json()) as {
          summary?: BillingSummary;
        };
        setSummary(summaryBody.summary ?? null);
        setAvailability(
          (await availabilityResponse.json()) as BillingAvailability,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  if (loading) {
    return (
      <div
        className="h-96 animate-pulse rounded-2xl border border-slate-200 bg-white motion-reduce:animate-none"
        aria-label="正在加载账单信息"
      />
    );
  }

  if (error || !summary) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm leading-6 text-amber-900">
        账单信息暂时无法加载。请刷新页面重试；若持续失败，请通过意见反馈联系支持。
      </div>
    );
  }

  const totalCredits = summary.credits.available + summary.credits.reserved;
  return (
    <div className="space-y-5">
      <section className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-blue-700">
                CURRENT RESEARCH ACCESS
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                {summary.subscription?.planName ?? "当前无付费套餐"}
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {summary.subscription
                  ? `有效期至 ${date(summary.subscription.endsAt)}`
                  : "免费科研功能可继续使用"}
              </p>
            </div>
            {availability?.available && (
              <Link
                href="/pricing"
                className="rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-sm font-medium text-blue-700 outline-none transition hover:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                查看套餐
              </Link>
            )}
          </div>
          <div className="mt-6">
            <ResearchResourceScale
              label="CREDITS 刻度"
              value={summary.credits.available}
              max={Math.max(totalCredits, 1)}
              valueLabel={`${summary.credits.available.toLocaleString("zh-CN")} 可用`}
              detail={`${summary.credits.reserved.toLocaleString("zh-CN")} 已预占`}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-950 p-5 text-slate-100 shadow-sm sm:p-7">
          <p className="text-xs font-semibold tracking-[0.16em] text-blue-300">
            ACCOUNT NOTE
          </p>
          <h2 className="mt-3 text-lg font-semibold">收费入口状态</h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            {availability?.available
              ? "当前账号可进入套餐确认流程；最终金额仍由服务端商品记录决定。"
              : "当前未开放购买入口。账单历史和已获科研资源仍可在此查看。"}
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-[0.16em] text-blue-700">
              PERIOD QUOTAS
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              周期配额
            </h2>
          </div>
          <span className="text-xs text-slate-500">
            已用与预占分别计量
          </span>
        </div>
        {summary.quotas.length === 0 ? (
          <p className="mt-6 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">
            当前没有生效中的周期配额。可继续使用现有免费科研功能。
          </p>
        ) : (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {summary.quotas.map((quota) => (
              <ResearchResourceScale
                key={`${quota.featureKey}:${quota.periodEnd}`}
                label={quota.featureKey}
                value={quota.used + quota.reserved}
                max={Math.max(quota.limit, 1)}
                valueLabel={`${quota.used.toLocaleString("zh-CN")} / ${quota.limit.toLocaleString("zh-CN")}`}
                detail={`${quota.reserved.toLocaleString("zh-CN")} 已预占 · ${date(quota.periodEnd)} 重置`}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-5 sm:px-7">
          <p className="text-xs font-semibold tracking-[0.16em] text-blue-700">
            ORDERS
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            订单记录
          </h2>
        </div>
        {summary.orders.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500 sm:px-7">
            暂无订单记录。
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {summary.orders.map((item) => (
              <Link
                key={item.id}
                href={`/billing/orders/${encodeURIComponent(item.id)}`}
                className="grid gap-2 px-5 py-4 outline-none transition hover:bg-slate-50 focus-visible:bg-blue-50 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:px-7"
              >
                <div>
                  <p className="font-medium text-slate-900">
                    {item.productName}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-slate-500">
                    {item.orderNumber} · {date(item.createdAt)}
                  </p>
                </div>
                <span className="text-sm text-slate-600">
                  {ORDER_STATUS[item.status] ?? item.status}
                </span>
                <strong className="text-sm tabular-nums text-slate-900">
                  {money(item.amountMinor, item.currency)}
                </strong>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h2 className="text-lg font-semibold text-slate-950">最近使用</h2>
          {summary.usage.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">暂无计费使用记录。</p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {summary.usage.slice(0, 6).map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-4 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium text-slate-800">
                      {item.featureKey}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {date(item.createdAt)}
                    </p>
                  </div>
                  <span className="tabular-nums text-slate-600">
                    {item.quotaUnits} quota · {item.creditAmount} credits
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h2 className="text-lg font-semibold text-slate-950">售后申请</h2>
          {summary.refunds.length === 0 &&
          summary.invoices.length === 0 ? (
            <p className="mt-4 text-sm leading-6 text-slate-500">
              暂无退款或发票申请。进入已支付订单详情可提交审核申请。
            </p>
          ) : (
            <ul className="mt-4 space-y-3 text-sm text-slate-600">
              {summary.refunds.map((item) => (
                <li
                  key={item.id}
                  className="rounded-xl border border-slate-200 p-3"
                >
                  退款申请 · {item.status} · {date(item.createdAt)}
                </li>
              ))}
              {summary.invoices.map((item) => (
                <li
                  key={item.id}
                  className="rounded-xl border border-slate-200 p-3"
                >
                  发票申请 · {item.status} · {date(item.createdAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
