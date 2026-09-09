"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { Json } from "@/lib/billing/database.types";
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

export function PricingProducts() {
  const [products, setProducts] = useState<PublicBillingProduct[]>([]);
  const [availability, setAvailability] =
    useState<BillingAvailability | null>(null);
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
        setProducts(
          Array.isArray(productsBody.products) ? productsBody.products : [],
        );
        setAvailability(availabilityBody);
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
      <div className="grid gap-5 lg:grid-cols-2" aria-label="正在加载套餐">
        {[0, 1].map((item) => (
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
    <div className="grid gap-5 lg:grid-cols-2">
      {products.map((product) => {
        const productHighlights = highlights(product.displayMetadata);
        const duration = product.durationDays ?? 0;
        const scaleMax = Math.max(duration, product.creditGrant, 1);
        return (
          <article
            key={product.id}
            className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.16em] text-blue-700">
                  {product.productType === "SUBSCRIPTION"
                    ? "RESEARCH PLAN"
                    : "CREDIT PACK"}
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
              {availability?.available ? (
                <Link
                  href={`/checkout/${encodeURIComponent(product.id)}`}
                  className="inline-flex w-full items-center justify-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  查看并确认
                </Link>
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
