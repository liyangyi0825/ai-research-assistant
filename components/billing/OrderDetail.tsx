"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

import type { BillingOrder } from "@/lib/billing/repositories";
import type {
  BillingAvailability,
  InvoiceTitleType,
  RefundReasonCode,
} from "@/lib/billing/user-pages";
import { ResearchResourceScale } from "./ResearchResourceScale";

function money(amountMinor: number, currency: "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function dateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function OrderDetail({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<BillingOrder | null>(null);
  const [availability, setAvailability] =
    useState<BillingAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refundReason, setRefundReason] =
    useState<RefundReasonCode>("NO_LONGER_NEEDED");
  const [refundDetails, setRefundDetails] = useState("");
  const [titleType, setTitleType] =
    useState<InvoiceTitleType>("PERSONAL");
  const [invoiceTitle, setInvoiceTitle] = useState("");
  const [taxIdentifier, setTaxIdentifier] = useState("");
  const [deliveryEmail, setDeliveryEmail] = useState("");
  const [submitting, setSubmitting] = useState<"refund" | "invoice" | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch(`/api/billing/orders/${encodeURIComponent(orderId)}`, {
        signal: controller.signal,
        cache: "no-store",
      }),
      fetch("/api/billing/availability", {
        signal: controller.signal,
        cache: "no-store",
      }),
    ])
      .then(async ([orderResponse, availabilityResponse]) => {
        if (orderResponse.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (orderResponse.status === 404) {
          setError("未找到该订单，或当前账号无权查看。");
          return;
        }
        if (!orderResponse.ok || !availabilityResponse.ok) {
          throw new Error("order unavailable");
        }
        const orderBody = (await orderResponse.json()) as {
          order?: BillingOrder;
        };
        setOrder(orderBody.order ?? null);
        setAvailability(
          (await availabilityResponse.json()) as BillingAvailability,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError("订单暂时无法加载，请稍后重试。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [orderId]);

  async function requestRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting("refund");
    setNotice(null);
    try {
      const response = await fetch("/api/billing/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          reasonCode: refundReason,
          details: refundDetails,
        }),
      });
      if (!response.ok) {
        setNotice("退款申请未提交，请检查原因说明或订单状态。");
        return;
      }
      setNotice("退款申请已提交，当前仅进入人工审核，不会自动退款。");
    } catch {
      setNotice("退款申请暂时无法提交，请稍后重试。");
    } finally {
      setSubmitting(null);
    }
  }

  async function requestInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting("invoice");
    setNotice(null);
    try {
      const response = await fetch("/api/billing/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          titleType,
          invoiceTitle,
          taxIdentifier:
            titleType === "ORGANIZATION" ? taxIdentifier : null,
          deliveryEmail,
        }),
      });
      if (!response.ok) {
        setNotice("发票申请未提交，请检查抬头、税号、邮箱或订单状态。");
        return;
      }
      setNotice("发票申请已提交等待审核；该状态不代表已经开票。");
    } catch {
      setNotice("发票申请暂时无法提交，请稍后重试。");
    } finally {
      setSubmitting(null);
    }
  }

  if (loading) {
    return (
      <div className="h-96 animate-pulse rounded-2xl border border-slate-200 bg-white motion-reduce:animate-none" />
    );
  }

  if (error || !order) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <p>{error ?? "订单暂时无法加载。"}</p>
        <Link
          href="/billing"
          className="mt-4 inline-flex font-medium text-blue-700 underline underline-offset-4"
        >
          返回账单中心
        </Link>
      </div>
    );
  }

  const canRequest =
    availability?.available &&
    order.status === "PAID" &&
    order.refundStatus !== "FULL";
  const primaryResource =
    order.snapshotCreditGrant ||
    order.snapshotDurationDays ||
    0;
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-[0.16em] text-blue-700">
              ORDER SNAPSHOT
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-950">
              {order.snapshotProductName}
            </h1>
            <p className="mt-2 text-xs tabular-nums text-slate-500">
              {order.orderNumber}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums text-slate-950">
              {money(order.amountMinor, order.currency)}
            </p>
            <p className="mt-1 text-sm text-slate-500">{order.status}</p>
          </div>
        </div>
        <div className="mt-6">
          <ResearchResourceScale
            label="订单科研资源刻度"
            value={primaryResource}
            max={Math.max(primaryResource, 1)}
            valueLabel={
              order.snapshotCreditGrant > 0
                ? `${order.snapshotCreditGrant.toLocaleString("zh-CN")} credits`
                : `${(order.snapshotDurationDays ?? 0).toLocaleString("zh-CN")} 天`
            }
            detail={`支付时间 ${dateTime(order.paidAt)}`}
          />
        </div>
        <dl className="mt-6 grid gap-4 border-t border-slate-100 pt-5 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-slate-500">创建时间</dt>
            <dd className="mt-1 text-slate-900">{dateTime(order.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">支付方式</dt>
            <dd className="mt-1 text-slate-900">{order.provider}</dd>
          </div>
          <div>
            <dt className="text-slate-500">退款状态</dt>
            <dd className="mt-1 text-slate-900">{order.refundStatus}</dd>
          </div>
        </dl>
      </section>

      {canRequest ? (
        <section className="grid gap-5 lg:grid-cols-2">
          <form
            onSubmit={requestRefund}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
          >
            <h2 className="text-lg font-semibold text-slate-950">申请退款审核</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              提交后仅进入人工审核，不会自动原路退款。
            </p>
            <label className="mt-5 block text-sm font-medium text-slate-700">
              申请原因
              <select
                value={refundReason}
                onChange={(event) =>
                  setRefundReason(event.target.value as RefundReasonCode)
                }
                className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200"
              >
                <option value="NO_LONGER_NEEDED">研究计划变化</option>
                <option value="DUPLICATE_ORDER">重复下单</option>
                <option value="SERVICE_ISSUE">服务问题</option>
                <option value="OTHER">其他</option>
              </select>
            </label>
            <label className="mt-4 block text-sm font-medium text-slate-700">
              说明
              <textarea
                value={refundDetails}
                onChange={(event) => setRefundDetails(event.target.value)}
                maxLength={500}
                rows={4}
                placeholder="服务问题或其他原因请填写至少 10 个字"
                className="mt-2 w-full resize-y rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200"
              />
            </label>
            <button
              type="submit"
              disabled={submitting !== null}
              className="mt-5 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {submitting === "refund" ? "正在提交…" : "提交退款申请"}
            </button>
          </form>

          <form
            onSubmit={requestInvoice}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
          >
            <h2 className="text-lg font-semibold text-slate-950">申请发票</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              提交后进入审核；“申请成功”不代表已经开票。
            </p>
            <label className="mt-5 block text-sm font-medium text-slate-700">
              抬头类型
              <select
                value={titleType}
                onChange={(event) =>
                  setTitleType(event.target.value as InvoiceTitleType)
                }
                className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200"
              >
                <option value="PERSONAL">个人</option>
                <option value="ORGANIZATION">单位</option>
              </select>
            </label>
            <label className="mt-4 block text-sm font-medium text-slate-700">
              发票抬头
              <input
                value={invoiceTitle}
                onChange={(event) => setInvoiceTitle(event.target.value)}
                minLength={2}
                maxLength={120}
                required
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200"
              />
            </label>
            {titleType === "ORGANIZATION" && (
              <label className="mt-4 block text-sm font-medium text-slate-700">
                税号
                <input
                  value={taxIdentifier}
                  onChange={(event) => setTaxIdentifier(event.target.value)}
                  minLength={15}
                  maxLength={20}
                  required
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 uppercase outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200"
                />
              </label>
            )}
            <label className="mt-4 block text-sm font-medium text-slate-700">
              接收邮箱
              <input
                type="email"
                value={deliveryEmail}
                onChange={(event) => setDeliveryEmail(event.target.value)}
                maxLength={254}
                required
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-200"
              />
            </label>
            <button
              type="submit"
              disabled={submitting !== null}
              className="mt-5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {submitting === "invoice" ? "正在提交…" : "提交发票申请"}
            </button>
          </form>
        </section>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
          当前订单或账号暂不满足售后申请条件。如需帮助，请通过意见反馈联系我们。
        </div>
      )}

      {notice && (
        <div
          className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900"
          aria-live="polite"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
