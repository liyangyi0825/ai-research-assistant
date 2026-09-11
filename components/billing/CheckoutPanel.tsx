"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  FormEvent,
  useContext,
  useEffect,
  useState,
} from "react";

import type { PublicBillingProduct } from "@/lib/billing/products";
import type {
  BillingAvailability,
  BillingErrorResponse,
} from "@/lib/billing/user-pages";
import { ResearchResourceScale } from "./ResearchResourceScale";

function money(amountMinor: number, currency: "CNY"): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

type BillingFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type CheckoutRouter = {
  push(path: string): void;
};

export type CheckoutPanelDependencies = {
  fetcher: BillingFetch;
  router: CheckoutRouter;
};

const CheckoutPanelDependenciesContext =
  createContext<CheckoutPanelDependencies | null>(null);

export const CheckoutPanelDependenciesProvider =
  CheckoutPanelDependenciesContext.Provider;

type BillingOrderRequest = {
  productId: string;
  provider: NonNullable<BillingAvailability["paymentMode"]>;
  acceptedAgreementVersion: string;
};

export type BillingOrderRequestResult =
  | { kind: "created"; orderId: string }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string };

const ACTIVE_SUBSCRIPTION_MESSAGE =
  "当前已有有效订阅，请在现有方案到期后再购买新的订阅。credits 包仍可单独购买。";
const GENERIC_ORDER_MESSAGE = "订单暂时无法创建，请核对账号权限后重试。";
const PAYMENT_PREPARATION_MESSAGE =
  "订单已创建，但支付准备未完成，请查看订单详情。";

export async function requestBillingOrder(
  input: BillingOrderRequest,
  fetcher: BillingFetch = fetch,
): Promise<BillingOrderRequestResult> {
  const response = await fetcher("/api/billing/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productId: input.productId,
      provider: input.provider,
      acceptedAgreementVersion: input.acceptedAgreementVersion,
    }),
  });
  if (response.status === 401) return { kind: "unauthorized" };
  if (!response.ok) {
    let body: BillingErrorResponse = {};
    try {
      body = (await response.json()) as BillingErrorResponse;
    } catch {
      // The public fallback does not depend on a parseable server body.
    }
    return {
      kind: "error",
      message:
        body.error?.code === "ACTIVE_SUBSCRIPTION_EXISTS"
          ? ACTIVE_SUBSCRIPTION_MESSAGE
          : GENERIC_ORDER_MESSAGE,
    };
  }

  const body = (await response.json()) as { order?: { id?: string } };
  return body.order?.id
    ? { kind: "created", orderId: body.order.id }
    : { kind: "error", message: GENERIC_ORDER_MESSAGE };
}

export function CheckoutPanel({ productId }: { productId: string }) {
  const dependencies = useContext(CheckoutPanelDependenciesContext);
  if (dependencies) {
    return (
      <CheckoutPanelContent
        productId={productId}
        fetcher={dependencies.fetcher}
        router={dependencies.router}
      />
    );
  }

  return <CheckoutPanelWithRouter productId={productId} />;
}

function CheckoutPanelWithRouter({ productId }: { productId: string }) {
  const router = useRouter();
  return (
    <CheckoutPanelContent
      productId={productId}
      fetcher={fetch}
      router={router}
    />
  );
}

function CheckoutPanelContent({
  productId,
  fetcher,
  router,
}: {
  productId: string;
  fetcher: BillingFetch;
  router: CheckoutRouter;
}) {
  const [product, setProduct] = useState<PublicBillingProduct | null>(null);
  const [availability, setAvailability] =
    useState<BillingAvailability | null>(null);
  const [acceptedAgreement, setAcceptedAgreement] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [wechatQrCode, setWechatQrCode] = useState<string | null>(null);
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetcher("/api/billing/products", {
        signal: controller.signal,
        cache: "no-store",
      }),
      fetcher("/api/billing/availability", {
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
  }, [fetcher, productId]);

  useEffect(() => {
    if (!pendingOrderId || !wechatQrCode) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetcher(
          `/api/billing/orders/${encodeURIComponent(pendingOrderId)}/payment`,
          { cache: "no-store" },
        );
        if (response.status === 401) {
          router.push("/login");
          return;
        }
        if (response.ok) {
          const body = (await response.json()) as {
            payment?: { status?: string };
          };
          if (body.payment?.status === "PAID") {
            router.push(
              `/billing/payment-result?orderId=${encodeURIComponent(pendingOrderId)}`,
            );
            return;
          }
        }
      } catch {
        // A bounded owner-authenticated retry follows below.
      }
      if (!cancelled) timer = setTimeout(poll, 3_000);
    };
    timer = setTimeout(poll, 1_500);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [fetcher, pendingOrderId, router, wechatQrCode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      submitting ||
      pendingOrderId ||
      !acceptedAgreement ||
      !product ||
      !availability?.available ||
      !availability.paymentMode ||
      !availability.agreementVersion
    ) {
      return;
    }
    setSubmitting(true);
    setMessage(null);
    let createdOrderId: string | null = null;
    try {
      const orderResult = await requestBillingOrder(
        {
          productId: product.id,
          provider: availability.paymentMode,
          acceptedAgreementVersion: availability.agreementVersion,
        },
        fetcher,
      );
      if (orderResult.kind === "unauthorized") {
        setMessage("请先登录，再继续确认订单。");
        return;
      }
      if (orderResult.kind === "error") {
        setMessage(orderResult.message);
        return;
      }
      createdOrderId = orderResult.orderId;
      setPendingOrderId(createdOrderId);
      const paymentResponse = await fetcher(
        `/api/billing/orders/${encodeURIComponent(orderResult.orderId)}/payment`,
        { method: "POST" },
      );
      if (!paymentResponse.ok) {
        setMessage(PAYMENT_PREPARATION_MESSAGE);
        return;
      }
      const paymentBody = (await paymentResponse.json()) as {
        payment?: {
          status?: string;
          qrCodeDataUrl?: string;
        };
      };
      if (
        paymentBody.payment?.status === "PENDING" &&
        paymentBody.payment.qrCodeDataUrl?.startsWith(
          "data:image/svg+xml;base64,",
        )
      ) {
        setWechatQrCode(paymentBody.payment.qrCodeDataUrl);
        setMessage("请使用微信扫描二维码完成支付，页面会自动核验结果。");
        return;
      }
      router.push(
        `/billing/payment-result?orderId=${encodeURIComponent(orderResult.orderId)}`,
      );
    } catch {
      setMessage(
        createdOrderId
          ? PAYMENT_PREPARATION_MESSAGE
          : "订单暂时无法创建，请稍后重试。",
      );
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
        {wechatQrCode && (
          <div className="mt-5 rounded-xl bg-white p-3 text-center text-slate-900">
            <Image
              src={wechatQrCode}
              alt="微信支付二维码"
              width={256}
              height={256}
              unoptimized
              className="mx-auto h-auto w-full max-w-64"
            />
            <p className="mt-2 text-xs text-slate-600">
              二维码仅对当前订单持有人显示，请勿转发。
            </p>
          </div>
        )}
        {availability?.available ? (
          <button
            type="submit"
            disabled={!acceptedAgreement || submitting || pendingOrderId !== null}
            className="mt-6 w-full rounded-lg bg-blue-500 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-blue-400 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting
              ? "正在创建订单…"
              : pendingOrderId
                ? "订单已创建"
                : "确认并创建订单"}
          </button>
        ) : (
          <div className="mt-6 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-center text-sm text-slate-300">
            当前账号暂未开放购买
          </div>
        )}
        {pendingOrderId && (
          <Link
            href={`/billing/orders/${encodeURIComponent(pendingOrderId)}`}
            className="mt-4 inline-flex text-sm text-blue-200 underline outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
          >
            查看订单详情
          </Link>
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
