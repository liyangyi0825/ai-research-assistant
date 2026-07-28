"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { BillingOrder } from "@/lib/billing/repositories";

export function PaymentResult({
  orderId,
  mockConfirmationAllowed,
}: {
  orderId: string;
  mockConfirmationAllowed: boolean;
}) {
  const [order, setOrder] = useState<BillingOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!orderId) {
      setMessage("缺少订单编号，请从账单中心重新进入。");
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(
        `/api/billing/orders/${encodeURIComponent(orderId)}`,
        { cache: "no-store" },
      );
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!response.ok) {
        setMessage("未找到该订单，或当前账号无权查看。");
        return;
      }
      const body = (await response.json()) as { order?: BillingOrder };
      setOrder(body.order ?? null);
    } catch {
      setMessage("支付结果暂时无法查询，请稍后刷新。");
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function confirmMockPayment() {
    if (!mockConfirmationAllowed || !order) return;
    setConfirming(true);
    setMessage(null);
    try {
      const response = await fetch("/api/billing/payments/mock/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: order.id,
          providerTransactionId: `mock-ui-${crypto.randomUUID()}`,
        }),
      });
      if (!response.ok) {
        setMessage("测试确认未执行，请核对测试账号权限。");
        return;
      }
      await refresh();
      setMessage("Mock 测试确认已完成，订单状态已从服务端重新读取。");
    } catch {
      setMessage("测试确认暂时无法执行，请稍后重试。");
    } finally {
      setConfirming(false);
    }
  }

  if (loading) {
    return (
      <div className="h-72 animate-pulse rounded-2xl border border-slate-200 bg-white motion-reduce:animate-none" />
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-9">
      <p className="text-xs font-semibold tracking-[0.16em] text-blue-700">
        PAYMENT RESULT
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
        {order?.status === "PAID"
          ? "订单已支付"
          : order?.status === "PENDING"
            ? "等待支付确认"
            : "订单状态"}
      </h1>
      {order ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="font-medium text-slate-900">
            {order.snapshotProductName}
          </p>
          <p className="mt-1 text-xs tabular-nums text-slate-500">
            {order.orderNumber} · {order.status}
          </p>
        </div>
      ) : (
        <p className="mt-4 text-sm leading-6 text-slate-600">
          {message ?? "订单信息暂时不可用。"}
        </p>
      )}
      {order?.status === "PENDING" && mockConfirmationAllowed && (
        <div className="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm leading-6 text-blue-900">
            这是仅对管理员或测试白名单开放的 Mock 动作，不代表真实收款。
          </p>
          <button
            type="button"
            onClick={confirmMockPayment}
            disabled={confirming}
            className="mt-3 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {confirming ? "正在确认…" : "执行 Mock 测试确认"}
          </button>
        </div>
      )}
      {order?.status === "PENDING" && !mockConfirmationAllowed && (
        <p className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
          当前账号没有测试确认权限。请等待服务端支付结果更新。
        </p>
      )}
      {message && order && (
        <p
          className="mt-4 text-sm leading-6 text-slate-600"
          aria-live="polite"
        >
          {message}
        </p>
      )}
      <div className="mt-7 flex flex-wrap gap-3">
        <Link
          href="/billing"
          className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
        >
          返回账单中心
        </Link>
        {order && (
          <Link
            href={`/billing/orders/${encodeURIComponent(order.id)}`}
            className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 outline-none transition hover:border-blue-400 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            查看订单详情
          </Link>
        )}
      </div>
    </section>
  );
}
