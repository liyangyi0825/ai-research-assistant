"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import type { PublicBillingProduct } from "@/lib/billing/products";
import type { BillingAvailability } from "@/lib/billing/user-pages";
import { ResearchResourceScale } from "./ResearchResourceScale";

function money(amountMinor: number, currency: "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

export function CheckoutPanel({ productId }: { productId: string }) {
  const router = useRouter();
  const [product, setProduct] = useState<PublicBillingProduct | null>(null);
  const [availability, setAvailability] =
    useState<BillingAvailability | null>(null);
  const [acceptedAgreement, setAcceptedAgreement] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/billing/products", {
        signal: controller.signal,
        cache: "no-store",
      }),
      fetch("/api/billing/availability", {
        signal: controller.signal,
        cache: "no-store",
      }),
    ])
      .then(async ([productsResponse, availabilityResponse]) => {
        if (!productsResponse.ok || !availabilityResponse.ok) {
          throw new Error("billing data unavailable");
        }
        const productsBody = (await productsResponse.json()) as {
          products?: PublicBillingProduct[];
        };
        const availabilityBody =
          (await availabilityResponse.json()) as BillingAvailability;
        const selected = productsBody.products?.find(
          (item) => item.id === productId,
        );
        setProduct(selected ?? null);
        setAvailability(availabilityBody);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMessage("商品信息暂时无法加载，请返回套餐页后重试。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [productId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !acceptedAgreement ||
      !product ||
      !availability?.available ||
      !availability.paymentMode
    ) {
      return;
    }
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/billing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: product.id,
          provider: availability.paymentMode,
          acceptedAgreementVersion: "billing-member-v1",
        }),
      });
      if (response.status === 401) {
        setMessage("请先登录，再继续确认订单。");
        return;
      }
      if (!response.ok) {
        setMessage("订单暂时无法创建，请核对账号权限后重试。");
        return;
      }
      const body = (await response.json()) as { order?: { id?: string } };
      if (!body.order?.id) throw new Error("missing order");
      router.push(
        `/billing/payment-result?orderId=${encodeURIComponent(body.order.id)}`,
      );
    } catch {
      setMessage("订单暂时无法创建，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="h-80 animate-pulse rounded-2xl border border-slate-200 bg-white motion-reduce:animate-none" />
    );
  }

  if (!product) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <h1 className="font-semibold text-slate-900">商品不可用</h1>
        <p className="mt-2 text-sm text-slate-500">
          商品可能已下架，请返回套餐页重新选择。
        </p>
        <Link
          href="/pricing"
          className="mt-5 inline-flex rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          返回套餐页
        </Link>
      </div>
    );
  }

  const duration = product.durationDays ?? 0;
  return (
    <form
      onSubmit={submit}
      className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]"
    >
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <p className="text-xs font-semibold tracking-[0.16em] text-blue-700">
          SERVER PRODUCT SNAPSHOT
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
          {product.name}
        </h1>
        {product.description && (
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {product.description}
          </p>
        )}
        <div className="mt-6">
          <ResearchResourceScale
            label="科研资源刻度"
            value={product.creditGrant || duration}
            max={Math.max(product.creditGrant, duration, 1)}
            valueLabel={
              product.creditGrant > 0
                ? `${product.creditGrant.toLocaleString("zh-CN")} credits`
                : `${duration.toLocaleString("zh-CN")} 天`
            }
            detail={
              duration > 0
                ? `有效期 ${duration.toLocaleString("zh-CN")} 天`
                : "一次性资源包"
            }
          />
        </div>
        <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
          <input
            type="checkbox"
            checked={acceptedAgreement}
            onChange={(event) => setAcceptedAgreement(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500"
          />
          <span>
            我已阅读并同意会员服务与退款规则，确认本次订单将以服务端商品快照计价。
          </span>
        </label>
      </section>

      <aside className="h-fit rounded-2xl border border-slate-200 bg-slate-950 p-5 text-white shadow-sm sm:p-6">
        <p className="text-xs font-semibold tracking-[0.16em] text-blue-300">
          ORDER CHECK
        </p>
        <div className="mt-5 flex items-baseline justify-between gap-3">
          <span className="text-sm text-slate-300">订单金额</span>
          <strong className="text-2xl tabular-nums">
            {money(product.priceMinor, product.currency)}
          </strong>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-400">
          金额与币种由服务端商品记录决定，页面不会向后端提交计价字段。
        </p>
        {availability?.available ? (
          <button
            type="submit"
            disabled={!acceptedAgreement || submitting}
            className="mt-6 w-full rounded-lg bg-blue-500 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-blue-400 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? "正在创建订单…" : "确认并创建订单"}
          </button>
        ) : (
          <div className="mt-6 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-center text-sm text-slate-300">
            当前账号暂未开放购买
          </div>
        )}
        {message && (
          <p className="mt-4 text-sm leading-6 text-amber-200" aria-live="polite">
            {message}
          </p>
        )}
      </aside>
    </form>
  );
}
