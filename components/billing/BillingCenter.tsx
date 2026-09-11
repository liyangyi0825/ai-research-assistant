"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type {
  BillingAvailability,
  BillingSummary,
} from "@/lib/billing/user-pages";
import { billingFeatureLabel } from "@/lib/billing/order-display";
import { BillingStatusBadge } from "./BillingStatusBadge";

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

  return (
    <div className="space-y-8">
      <section
        aria-labelledby="resource-overview-heading"
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:px-7">
          <h2 id="resource-overview-heading" className="text-base font-semibold text-slate-950">资源总览</h2>
          {availability?.available && (
            <Link href="/pricing" className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
              查看套餐
            </Link>
          )}
        </div>
        <div className="grid md:grid-cols-[1.1fr_1fr]">
          <dl className="px-5 py-7 sm:px-7 sm:py-8">
            <div>
              <dt className="text-sm font-medium text-teal-800">可用 credits</dt>
              <dd className="mt-3 break-all text-5xl font-semibold tracking-tight text-teal-800 tabular-nums sm:text-6xl">
                {summary.credits.available.toLocaleString("zh-CN")}
              </dd>
            </div>
            <div className="mt-5 flex items-baseline gap-3 text-sm">
              <dt className="text-slate-500">已预占</dt>
              <dd className="font-medium text-slate-700 tabular-nums">{summary.credits.reserved.toLocaleString("zh-CN")} credits</dd>
            </div>
          </dl>
          <dl className="grid content-center gap-6 border-t border-slate-200 bg-slate-50/70 px-5 py-7 sm:px-7 md:border-t-0 md:border-l">
            <div>
              <dt className="text-xs font-medium text-slate-500">当前套餐</dt>
              <dd className="mt-2 text-xl font-semibold text-slate-950">{summary.subscription?.planName ?? "当前无付费套餐"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">有效期至</dt>
              <dd className="mt-2 text-sm text-slate-700 tabular-nums">{summary.subscription ? date(summary.subscription.endsAt) : "免费科研功能可继续使用"}</dd>
            </div>
          </dl>
        </div>
        {!availability?.available && (
          <p className="border-t border-slate-200 px-5 py-3 text-xs leading-6 text-slate-500 sm:px-7">当前未开放购买入口。账单历史和已获科研资源仍可在此查看。</p>
        )}
      </section>

      <section
        aria-labelledby="quota-heading"
        className="rounded-2xl border border-slate-200 bg-white px-5 py-5 sm:px-7"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="quota-heading" className="text-lg font-semibold text-slate-950">
            周期配额
          </h2>
          <span className="text-xs text-slate-500">
            已用与预占分别计量
          </span>
        </div>
        {summary.quotas.length === 0 ? (
          <p className="mt-6 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">
            当前没有生效中的周期配额。可继续使用现有免费科研功能。
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {summary.quotas.map((quota) => {
              const label = billingFeatureLabel(quota.featureKey);
              const occupied = quota.used + quota.reserved;
              const max = Math.max(quota.limit, 1);
              return (
                <li
                  key={`${quota.featureKey}:${quota.periodEnd}`}
                  className="grid gap-x-8 gap-y-3 py-4 sm:grid-cols-[minmax(8rem,0.65fr)_minmax(0,1.5fr)] sm:items-center"
                >
                  <div>
                    <h3 className="text-sm font-medium text-slate-900">{label}</h3>
                    <p className="mt-1 text-xs text-slate-500 tabular-nums">{date(quota.periodEnd)} 重置</p>
                  </div>
                  <div>
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                      <p className="text-slate-600">
                        <span className="mr-2">已用 / 配额</span>
                        <span className="text-sm font-medium text-slate-900 tabular-nums">
                          {quota.used.toLocaleString("zh-CN")} / {quota.limit.toLocaleString("zh-CN")}
                        </span>
                      </p>
                      <p className="text-slate-500">
                        已预占 <span className="tabular-nums">{quota.reserved.toLocaleString("zh-CN")}</span>
                      </p>
                    </div>
                    <div
                      role="meter"
                      aria-label={`${label}配额使用情况`}
                      aria-valuemin={0}
                      aria-valuemax={max}
                      aria-valuenow={Math.min(max, occupied)}
                      aria-valuetext={`已用 ${quota.used}，已预占 ${quota.reserved}，配额 ${quota.limit}`}
                      className="mt-2.5 flex h-2 overflow-hidden rounded-full bg-slate-100"
                    >
                      <span
                        className="h-full bg-blue-600"
                        style={{ width: `${Math.min(100, (quota.used / max) * 100)}%` }}
                      />
                      <span
                        className="h-full bg-blue-300"
                        style={{
                          width: `${Math.min(Math.max(0, 100 - (quota.used / max) * 100), (quota.reserved / max) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="orders-heading"
        className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-5 py-5 sm:px-7">
          <h2 id="orders-heading" className="text-lg font-semibold text-slate-950">
            订单记录
          </h2>
          <p className="text-xs text-slate-500">最近 20 笔订单</p>
        </div>
        {summary.orders.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500 sm:px-7">
            暂无订单记录。
          </div>
        ) : (
          <table role="table" className="block w-full text-left text-sm xl:table xl:table-fixed">
            <caption className="sr-only">最近订单及支付状态</caption>
            <thead role="rowgroup" className="sr-only xl:not-sr-only xl:table-header-group">
              <tr role="row" className="bg-slate-50 text-xs text-slate-500">
                <th role="columnheader" scope="col" className="w-[24%] px-7 py-3 font-medium">产品</th>
                <th role="columnheader" scope="col" className="w-[30%] px-3 py-3 font-medium">订单 / 日期</th>
                <th role="columnheader" scope="col" className="w-[17%] px-3 py-3 font-medium">状态</th>
                <th role="columnheader" scope="col" className="w-[15%] px-3 py-3 text-right font-medium">金额</th>
                <th role="columnheader" scope="col" className="px-5 py-3 text-right font-medium"><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="block divide-y divide-slate-100 xl:table-row-group">
              {summary.orders.map((item) => (
                <tr
                  role="row"
                  key={item.id}
                  className="grid grid-cols-2 items-center gap-x-3 gap-y-3 px-5 py-5 xl:table-row xl:hover:bg-slate-50/60"
                >
                  <td role="cell" className="col-span-2 break-words font-medium text-slate-900 xl:px-7 xl:py-5">{item.productName}</td>
                  <td role="cell" className="col-span-2 min-w-0 xl:px-3 xl:py-5">
                    <p className="break-all text-xs text-slate-600 tabular-nums">{item.orderNumber}</p>
                    <p className="mt-1 text-xs text-slate-500 tabular-nums">{date(item.createdAt)}</p>
                  </td>
                  <td role="cell" className="xl:px-3 xl:py-5"><BillingStatusBadge status={item.status} /></td>
                  <td role="cell" className="text-right font-medium text-slate-900 tabular-nums xl:px-3 xl:py-5">{money(item.amountMinor, item.currency)}</td>
                  <td role="cell" className="col-span-2 text-right xl:px-5 xl:py-5">
                    <Link
                      href={`/billing/orders/${encodeURIComponent(item.id)}`}
                      className="inline-flex min-h-10 items-center rounded-md px-2 font-medium whitespace-nowrap text-blue-700 outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                    >
                      查看详情<span className="sr-only">，订单 {item.orderNumber}</span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="grid gap-7 border-t border-slate-200 pt-6 lg:grid-cols-2">
        <div className="min-w-0 px-1">
          <h2 className="text-base font-semibold text-slate-700">最近使用</h2>
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
                      {billingFeatureLabel(item.featureKey)}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {date(item.createdAt)}
                    </p>
                  </div>
                  <span className="tabular-nums text-slate-600">
                    {item.quotaUnits} 配额 · {item.creditAmount} credits
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0 px-1 lg:border-l lg:border-slate-200 lg:pl-7">
          <h2 className="text-base font-semibold text-slate-700">售后申请</h2>
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
