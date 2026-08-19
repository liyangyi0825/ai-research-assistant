"use client";

import { useState, type FormEvent } from "react";

export type Action = {
  title: string;
  endpoint: string;
  method?: "POST" | "PATCH";
  fields: Array<{ name: string; label: string; type?: string; options?: string[] }>;
  fixed?: Record<string, unknown>;
  requiresIdempotencyKey?: boolean;
};

export const adminBillingActions: Action[] = [
  { title: "人工调整额度", endpoint: "/api/admin/billing/credits", fields: [
    { name: "userId", label: "用户 ID" }, { name: "amount", label: "额度增减整数", type: "number" },
    { name: "reason", label: "操作原因" },
  ] },
  { title: "人工开通会员", endpoint: "/api/admin/billing/subscriptions", fields: [
    { name: "userId", label: "用户 ID" }, { name: "planId", label: "套餐 ID" },
    { name: "durationDays", label: "开通天数", type: "number" }, { name: "reason", label: "操作原因" },
  ] },
  { title: "保存套餐", endpoint: "/api/admin/billing/catalog", method: "PATCH", fixed: { kind: "plan" }, fields: [
    { name: "planId", label: "套餐 ID（新建留空）" }, { name: "code", label: "套餐编码" },
    { name: "name", label: "套餐名称" }, { name: "description", label: "说明" },
    { name: "billingPeriod", label: "周期", options: ["FREE", "MONTHLY", "YEARLY", "SEMESTER"] },
    { name: "isActive", label: "启用", options: ["false", "true"] }, { name: "reason", label: "操作原因" },
  ] },
  { title: "保存商品", endpoint: "/api/admin/billing/catalog", method: "PATCH", fixed: { kind: "product" }, fields: [
    { name: "productId", label: "商品 ID（新建留空）" }, { name: "planId", label: "套餐 ID" },
    { name: "sku", label: "SKU" }, { name: "name", label: "商品名称" },
    { name: "productType", label: "类型", options: ["SUBSCRIPTION", "CREDIT_PACK"] },
    { name: "priceMinor", label: "价格（分）", type: "number" }, { name: "durationDays", label: "有效天数", type: "number" },
    { name: "creditGrant", label: "赠送额度", type: "number" }, { name: "entitlementVersion", label: "权益版本" },
    { name: "isActive", label: "启用", options: ["false", "true"] }, { name: "reason", label: "操作原因" },
  ] },
  { title: "审核退款", endpoint: "/api/admin/billing/refunds", method: "PATCH", fields: [
    { name: "requestId", label: "退款申请 ID" }, { name: "decision", label: "结论", options: ["APPROVED", "REJECTED"] },
    { name: "reason", label: "审核原因" },
  ] },
  { title: "重试已批准退款", endpoint: "/api/admin/billing/refunds", method: "PATCH", fixed: { action: "RETRY_EXECUTION" }, requiresIdempotencyKey: false, fields: [
    { name: "requestId", label: "已批准退款申请 ID" },
  ] },
  { title: "审核发票", endpoint: "/api/admin/billing/invoices", method: "PATCH", fields: [
    { name: "requestId", label: "发票申请 ID" }, { name: "decision", label: "结论", options: ["ISSUED", "REJECTED"] },
    { name: "reason", label: "审核原因" },
  ] },
];

export function buildAdminActionBody(
  action: Pick<Action, "fields" | "fixed" | "requiresIdempotencyKey">,
  raw: Record<string, FormDataEntryValue>,
  createIdempotencyKey: () => string = () => crypto.randomUUID(),
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...action.fixed };
  if (action.requiresIdempotencyKey !== false) {
    body.idempotencyKey = createIdempotencyKey();
  }
  for (const field of action.fields) {
    const value = raw[field.name];
    if (field.type === "number") body[field.name] = value === "" ? null : Number(value);
    else if (field.name === "isActive") body[field.name] = value === "true";
    else body[field.name] = value;
  }
  return body;
}

type AdminActionResult = {
  auditId?: string;
  approvalPersisted?: boolean;
  refundCompleted?: boolean;
  requiresManualAction?: boolean;
  refundExecution?: { status?: string };
  error?: { message?: string };
};

export function formatAdminActionResult(
  endpoint: string,
  responseOk: boolean,
  result: AdminActionResult,
): string {
  if (endpoint === "/api/admin/billing/refunds") {
    if (result.refundCompleted && result.refundExecution?.status === "SUCCEEDED") {
      return `已退款，审计 ID：${result.auditId ?? "-"}`;
    }
    if (result.requiresManualAction || result.refundExecution?.status === "MANUAL_REVIEW_REQUIRED") {
      return `已批准待人工退款，审计 ID：${result.auditId ?? "-"}`;
    }
    if (result.approvalPersisted || result.refundExecution?.status === "RETRY_REQUIRED") {
      return `审批已保存但退款执行失败需重试，请使用“重试已批准退款”操作，审计 ID：${result.auditId ?? "-"}`;
    }
  }
  return responseOk
    ? `操作成功，审计 ID：${result.auditId ?? "-"}`
    : `操作失败：${result.error?.message ?? "未知错误"}`;
}

export function AdminBillingActions({ canWrite }: { canWrite: boolean }) {
  const [message, setMessage] = useState("");
  async function submit(action: Action, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    const raw = Object.fromEntries(new FormData(event.currentTarget));
    const body = buildAdminActionBody(action, raw);
    const response = await fetch(action.endpoint, {
      method: action.method ?? "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    setMessage(formatAdminActionResult(action.endpoint, response.ok, result));
  }
  return (
    <section className="grid gap-4 lg:grid-cols-2">
      {!canWrite && <p className="lg:col-span-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-amber-200">当前为审核员只读权限，所有变更按钮均已禁用。</p>}
      {message && <p className="lg:col-span-2 rounded-xl bg-slate-800 p-4 text-sm">{message}</p>}
      {adminBillingActions.map((action) => (
        <form key={action.title} onSubmit={(event) => submit(action, event)}
          className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold">{action.title}</h2>
          {action.fields.map((field) => field.options ? (
            <label key={field.name} className="block text-xs text-slate-400">{field.label}
              <select name={field.name} className="mt-1 w-full rounded-lg bg-slate-800 p-2 text-slate-100">
                {field.options.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
          ) : (
            <label key={field.name} className="block text-xs text-slate-400">{field.label}
              <input name={field.name} type={field.type ?? "text"} required={!field.label.includes("留空")}
                className="mt-1 w-full rounded-lg bg-slate-800 p-2 text-slate-100" />
            </label>
          ))}
          <button disabled={!canWrite} className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40">
            {action.title}
          </button>
        </form>
      ))}
    </section>
  );
}
