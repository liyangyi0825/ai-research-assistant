"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { Json } from "@/lib/billing/database.types";
import type { PublicBillingProduct } from "@/lib/billing/products";
import type {
  BillingAvailability,
  BillingSummary,
} from "@/lib/billing/user-pages";
import { ResearchResourceScale } from "./ResearchResourceScale";

function money(amountMinor: number, currency: "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function highlights(metadata: Json): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const candidate =
    metadata.highlights ?? metadata.benefits ?? metadata.features;
  return Array.isArray(candidate)
    ? candidate.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function subscriptionEndDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

export type PricingProductAction =
  | { kind: "link"; href: string }
  | {
      kind: "subscription-blocked";
      planName: string;
      endsAt: string;
    }
  | { kind: "unavailable" };

export function getPricingProductAction(
  product: PublicBillingProduct,
  available: boolean,
  summary: BillingSummary | null,
): PricingProductAction {
  if (!available) return { kind: "unavailable" };

  const subscriptionBlocked =
    product.productType === "SUBSCRIPTION" && summary?.subscription !== null;
  if (subscriptionBlocked) {
    if (!summary?.subscription) return { kind: "unavailable" };
    return {
      kind: "subscription-blocked",
      planName: summary.subscription.planName,
      endsAt: subscriptionEndDate(summary.subscription.endsAt),
    };
  }

  return {
    kind: "link",
    href: `/checkout/${encodeURIComponent(product.id)}`,
  };
}

export type ProductPurchaseTerms = {
  label: string;
  value: string;
  payment: string;
  periodNote: string;
};

export function getProductPurchaseTerms(
  product: PublicBillingProduct,
): ProductPurchaseTerms {
  if (product.productType === "SUBSCRIPTION") {
    const duration = product.durationDays ?? 0;
    return {
      label: "本次使用期",
      value: `${duration.toLocaleString("zh-CN")} 天`,
      payment: "一次性支付，不自动续费",
      periodNote:
        duration === 150
          ? "额度覆盖一个完整的 150 天周期，不按月重置。"
          : `开通后连续使用一个完整的 ${duration.toLocaleString("zh-CN")} 天周期。`,
    };
  }

  return {
    label: "独立资源",
    value: `${product.creditGrant.toLocaleString("zh-CN")} credits`,
    payment: "一次性购买，可与订阅分开使用",
    periodNote: "购买 credits 不改变当前订阅的有效期。",
  };
}

export type PricingResponseData = {
  products: PublicBillingProduct[];
  availability: BillingAvailability;
  summary: BillingSummary | null;
};

export async function readPricingResponses(
  responses: [Response, Response, Response],
): Promise<PricingResponseData> {
  const [productsResponse, availabilityResponse, summaryResponse] = responses;
  const summaryIsUnauthenticated = summaryResponse.status === 401;
  if (
    !productsResponse.ok ||
    !availabilityResponse.ok ||
    (!summaryResponse.ok && !summaryIsUnauthenticated)
  ) {
    throw new Error("billing data unavailable");
  }

  const productsBody = (await productsResponse.json()) as {
    products?: PublicBillingProduct[];
  };
  const availability =
    (await availabilityResponse.json()) as BillingAvailability;
  let summary: BillingSummary | null = null;
  if (summaryResponse.ok) {
    const summaryBody = (await summaryResponse.json()) as {
      summary?: BillingSummary;
    };
    summary = summaryBody.summary ?? null;
  }

  return {
    products: Array.isArray(productsBody.products) ? productsBody.products : [],
    availability,
    summary,
  };
}

export function PricingProducts() {
  const [products, setProducts] = useState<PublicBillingProduct[]>([]);
  const [availability, setAvailability] =
    useState<BillingAvailability | null>(null);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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
      fetch("/api/billing/summary", {
        signal: controller.signal,
        cache: "no-store",
      }),
    ])
      .then(readPricingResponses)
      .then((data) => {
        setProducts(data.products);
        setAvailability(data.availability);
        setSummary(data.summary);
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
        className="grid gap-5 md:grid-cols-2 xl:grid-cols-3"
        aria-label="正在加载套餐"
      >
        {[0, 1, 2].map((item) => (
          <div
            key={item}
            className="h-80 animate-pulse rounded-2xl border border-slate-200 bg-white motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm leading-6 text-amber-900">
        套餐信息暂时无法加载。请稍后刷新页面；现有科研功能仍可继续使用。
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <h2 className="font-semibold text-slate-900">暂无可用套餐</h2>
        <p className="mt-2 text-sm text-slate-500">
          套餐仍在准备中，请等待站内通知。
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {products.map((product) => {
        const productHighlights = highlights(product.displayMetadata);
        const duration = product.durationDays ?? 0;
        const scaleMax = Math.max(duration, product.creditGrant, 1);
        const terms = getProductPurchaseTerms(product);
        const action = getPricingProductAction(
          product,
          availability?.available === true,
          summary,
        );
        return (
          <article
            key={product.id}
            className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.16em] text-blue-700">
                  {product.productType === "SUBSCRIPTION"
                    ? "订阅方案"
                    : "独立 credits 包"}
                </p>
                <h2 className="mt-2 text-xl font-semibold text-slate-950">
                  {product.name}
                </h2>
              </div>
              <p className="text-xl font-semibold tabular-nums text-slate-950">
                {money(product.priceMinor, product.currency)}
              </p>
            </div>
            {product.description && (
              <p className="mt-4 text-sm leading-6 text-slate-600">
                {product.description}
              </p>
            )}
            <div className="mt-5 border-y border-slate-200 py-4">
              <dl>
                <dt className="text-sm text-slate-500">{terms.label}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-slate-950">
                  {terms.value}
                </dd>
              </dl>
              <p className="mt-3 text-sm font-medium text-blue-800">
                {terms.payment}
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                {terms.periodNote}
              </p>
            </div>
            <div className="mt-5">
              <ResearchResourceScale
                label="科研资源刻度"
                value={product.creditGrant || duration}
                max={scaleMax}
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
            {productHighlights.length > 0 && (
              <ul className="mt-5 space-y-2 text-sm text-slate-600">
                {productHighlights.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-auto pt-6">
              {action.kind === "link" ? (
                <Link
                  href={action.href}
                  className="inline-flex w-full items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  查看并确认
                </Link>
              ) : action.kind === "subscription-blocked" ? (
                <div
                  aria-disabled="true"
                  className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-5 text-blue-950"
                >
                  <p className="font-medium">已有有效订阅，暂不能重复购买</p>
                  <p className="mt-1 text-blue-800">
                    当前方案：{action.planName}
                  </p>
                  <p className="text-blue-800">有效期至 {action.endsAt}</p>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-center text-sm text-slate-600">
                  当前账号暂未开放购买
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
