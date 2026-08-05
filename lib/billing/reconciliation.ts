import { BillingError } from "./errors";

export type ReconciliationCode =
  | "ORDER_EXPIRED_PENDING"
  | "PAID_ORDER_PAYMENT_MISSING"
  | "PAYMENT_ORDER_MISMATCH"
  | "WEBHOOK_STALLED"
  | "SUBSCRIPTION_GRANT_MISSING"
  | "CREDIT_GRANT_MISSING"
  | "REFUND_STATE_MISMATCH";

export type ReconciliationSeverity = "CRITICAL" | "WARNING" | "INFO";

export type ReconciliationFinding = {
  code: ReconciliationCode;
  severity: ReconciliationSeverity;
  entityType: "ORDER" | "PAYMENT" | "WEBHOOK" | "REFUND";
  entityId: string;
  orderNumber: string | null;
  detectedAt: string;
  message: string;
};

export type InternalReconciliationReport = {
  generatedAt: string;
  scope: "INTERNAL_DATABASE_ONLY";
  summary: {
    total: number;
    critical: number;
    warning: number;
    info: number;
    byCode: Record<ReconciliationCode, number>;
  };
  items: ReconciliationFinding[];
  truncated: boolean;
};

export type InternalReconciliationOrder = {
  id: string;
  orderNumber: string;
  userId: string;
  provider: "MOCK" | "WECHAT" | "ALIPAY";
  status: "PENDING" | "PAID" | "FAILED" | "CANCELLED" | "CLOSED" | "REFUNDING" | "REFUNDED";
  amountMinor: number;
  currency: "CNY";
  snapshotProductType: "SUBSCRIPTION" | "CREDIT_PACK";
  snapshotCreditGrant: number;
  expiresAt: string;
  refundStatus: "NONE" | "REQUESTED" | "PARTIAL" | "FULL";
};

export type InternalReconciliationPayment = {
  id: string;
  orderId: string;
  userId: string;
  provider: "MOCK" | "WECHAT" | "ALIPAY";
  status: "PENDING" | "PAID" | "FAILED" | "CLOSED" | "REFUNDED";
  amountMinor: number;
  currency: "CNY";
};

export type InternalReconciliationWebhookEvent = {
  id: string;
  status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED";
  updatedAt: string;
};

export type InternalReconciliationSubscription = {
  id: string;
  sourceOrderId: string | null;
};

export type InternalReconciliationCreditLedgerEntry = {
  id: string;
  entryType: "PURCHASE" | "GRANT" | "RESERVE" | "CONSUME" | "RELEASE" | "ADJUSTMENT";
  referenceOrderId: string | null;
};

export type InternalReconciliationRefundRequest = {
  id: string;
  orderId: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
};

export type InternalReconciliationRefundRecord = {
  id: string;
  orderId: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
};

export type InternalReconciliationSnapshot = {
  orders: InternalReconciliationOrder[];
  payments: InternalReconciliationPayment[];
  webhookEvents: InternalReconciliationWebhookEvent[];
  subscriptions: InternalReconciliationSubscription[];
  creditLedgerEntries: InternalReconciliationCreditLedgerEntry[];
  refundRequests: InternalReconciliationRefundRequest[];
  refundRecords: InternalReconciliationRefundRecord[];
};

const CODES: ReconciliationCode[] = [
  "ORDER_EXPIRED_PENDING",
  "PAID_ORDER_PAYMENT_MISSING",
  "PAYMENT_ORDER_MISMATCH",
  "WEBHOOK_STALLED",
  "SUBSCRIPTION_GRANT_MISSING",
  "CREDIT_GRANT_MISSING",
  "REFUND_STATE_MISMATCH",
];

const severityRank: Record<ReconciliationSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

function storageError(): BillingError {
  return new BillingError(
    "BILLING_STORAGE_UNAVAILABLE",
    "Billing data is temporarily unavailable.",
    503,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw storageError();
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw storageError();
  return value;
}

function nullableId(value: unknown): string | null {
  if (value === null) return null;
  return id(value);
}

function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw storageError();
  return value;
}

function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw storageError();
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw storageError();
  return value as T;
}

function array(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw storageError();
  return value.map(record);
}

function validateSnapshot(value: unknown): InternalReconciliationSnapshot {
  const source = record(value);
  const required = ["orders", "payments", "webhookEvents", "subscriptions", "creditLedgerEntries", "refundRequests", "refundRecords"] as const;
  const rows = Object.fromEntries(required.map((name) => [name, array(source[name])])) as Record<(typeof required)[number], Record<string, unknown>[]>;
  return {
    orders: rows.orders.map((row) => ({
      id: id(row.id), orderNumber: id(row.orderNumber), userId: id(row.userId),
      provider: oneOf(row.provider, ["MOCK", "WECHAT", "ALIPAY"]),
      status: oneOf(row.status, ["PENDING", "PAID", "FAILED", "CANCELLED", "CLOSED", "REFUNDING", "REFUNDED"]),
      amountMinor: amount(row.amountMinor), currency: oneOf(row.currency, ["CNY"]),
      snapshotProductType: oneOf(row.snapshotProductType, ["SUBSCRIPTION", "CREDIT_PACK"]),
      snapshotCreditGrant: amount(row.snapshotCreditGrant), expiresAt: date(row.expiresAt),
      refundStatus: oneOf(row.refundStatus, ["NONE", "REQUESTED", "PARTIAL", "FULL"]),
    })),
    payments: rows.payments.map((row) => ({
      id: id(row.id), orderId: id(row.orderId), userId: id(row.userId),
      provider: oneOf(row.provider, ["MOCK", "WECHAT", "ALIPAY"]),
      status: oneOf(row.status, ["PENDING", "PAID", "FAILED", "CLOSED", "REFUNDED"]),
      amountMinor: amount(row.amountMinor), currency: oneOf(row.currency, ["CNY"]),
    })),
    webhookEvents: rows.webhookEvents.map((row) => ({
      id: id(row.id), status: oneOf(row.status, ["RECEIVED", "PROCESSING", "PROCESSED", "FAILED"]), updatedAt: date(row.updatedAt),
    })),
    subscriptions: rows.subscriptions.map((row) => ({ id: id(row.id), sourceOrderId: nullableId(row.sourceOrderId) })),
    creditLedgerEntries: rows.creditLedgerEntries.map((row) => ({
      id: id(row.id), entryType: oneOf(row.entryType, ["PURCHASE", "GRANT", "RESERVE", "CONSUME", "RELEASE", "ADJUSTMENT"]), referenceOrderId: nullableId(row.referenceOrderId),
    })),
    refundRequests: rows.refundRequests.map((row) => ({ id: id(row.id), orderId: id(row.orderId), status: oneOf(row.status, ["PENDING", "APPROVED", "REJECTED", "CANCELLED"]) })),
    refundRecords: rows.refundRecords.map((row) => ({ id: id(row.id), orderId: id(row.orderId), status: oneOf(row.status, ["PENDING", "SUCCEEDED", "FAILED"]) })),
  };
}

function finding(
  code: ReconciliationCode,
  severity: ReconciliationSeverity,
  entityType: ReconciliationFinding["entityType"],
  entityId: string,
  orderNumber: string | null,
  detectedAt: string,
  message: string,
): ReconciliationFinding {
  return { code, severity, entityType, entityId, orderNumber, detectedAt, message };
}

export function buildInternalReconciliationReport(input: {
  snapshot: InternalReconciliationSnapshot;
  now: Date;
  maxItems?: number;
}): InternalReconciliationReport {
  if (!input || typeof input !== "object" || !(input.now instanceof Date) || Number.isNaN(input.now.getTime()) || (input.maxItems !== undefined && (!Number.isInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 200))) throw storageError();
  const snapshot = validateSnapshot(input.snapshot);
  const generatedAt = input.now.toISOString();
  const orders = new Map(snapshot.orders.map((order) => [order.id, order]));
  const paidPayments = snapshot.payments.filter((payment) => payment.status === "PAID");
  const paidPaymentOrderIds = new Set(paidPayments.map((payment) => payment.orderId));
  const subscriptionOrderIds = new Set(snapshot.subscriptions.flatMap((subscription) => subscription.sourceOrderId === null ? [] : [subscription.sourceOrderId]));
  const purchaseCreditOrderIds = new Set(snapshot.creditLedgerEntries.flatMap((entry) => entry.entryType === "PURCHASE" && entry.referenceOrderId !== null ? [entry.referenceOrderId] : []));
  const approvedRefundOrderIds = new Set(snapshot.refundRequests.filter((request) => request.status === "APPROVED").map((request) => request.orderId));
  const succeededRefundOrderIds = new Set(snapshot.refundRecords.filter((refund) => refund.status === "SUCCEEDED").map((refund) => refund.orderId));
  const findings: ReconciliationFinding[] = [];

  for (const order of snapshot.orders) {
    if (order.status === "PENDING" && Date.parse(order.expiresAt) <= input.now.getTime()) findings.push(finding("ORDER_EXPIRED_PENDING", "INFO", "ORDER", order.id, order.orderNumber, generatedAt, "Pending order has expired."));
    if (order.status === "PAID" && !paidPaymentOrderIds.has(order.id)) findings.push(finding("PAID_ORDER_PAYMENT_MISSING", "CRITICAL", "ORDER", order.id, order.orderNumber, generatedAt, "Paid order is missing a paid payment record."));
    if (order.status === "PAID" && order.snapshotProductType === "SUBSCRIPTION" && !subscriptionOrderIds.has(order.id)) findings.push(finding("SUBSCRIPTION_GRANT_MISSING", "CRITICAL", "ORDER", order.id, order.orderNumber, generatedAt, "Paid subscription order is missing its subscription grant."));
    if (order.status === "PAID" && order.snapshotProductType === "CREDIT_PACK" && order.snapshotCreditGrant > 0 && !purchaseCreditOrderIds.has(order.id)) findings.push(finding("CREDIT_GRANT_MISSING", "CRITICAL", "ORDER", order.id, order.orderNumber, generatedAt, "Paid credit-pack order is missing its purchase credit grant."));
    const refundingStatusIsValid = order.refundStatus === "REQUESTED" || order.refundStatus === "PARTIAL";
    const refundedStatusIsValid = order.refundStatus === "FULL" || order.refundStatus === "PARTIAL";
    if ((order.status === "REFUNDING" && (!refundingStatusIsValid || !approvedRefundOrderIds.has(order.id))) || (order.status === "REFUNDED" && (!refundedStatusIsValid || !succeededRefundOrderIds.has(order.id)))) findings.push(finding("REFUND_STATE_MISMATCH", "CRITICAL", "REFUND", order.id, order.orderNumber, generatedAt, "Order refund state does not match its refund records."));
  }

  for (const payment of paidPayments) {
    const order = orders.get(payment.orderId);
    if (order && (payment.userId !== order.userId || payment.provider !== order.provider || payment.amountMinor !== order.amountMinor || payment.currency !== order.currency)) findings.push(finding("PAYMENT_ORDER_MISMATCH", "CRITICAL", "PAYMENT", payment.id, order.orderNumber, generatedAt, "Paid payment does not match its order."));
  }
  for (const webhook of snapshot.webhookEvents) if ((webhook.status === "RECEIVED" || webhook.status === "PROCESSING") && Date.parse(webhook.updatedAt) <= input.now.getTime() - 15 * 60 * 1000) findings.push(finding("WEBHOOK_STALLED", "WARNING", "WEBHOOK", webhook.id, null, generatedAt, "Webhook processing has stalled."));

  findings.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || left.code.localeCompare(right.code) || left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId));
  const byCode = Object.fromEntries(CODES.map((code) => [code, 0])) as Record<ReconciliationCode, number>;
  for (const item of findings) byCode[item.code] += 1;
  const summary = { total: findings.length, critical: findings.filter((item) => item.severity === "CRITICAL").length, warning: findings.filter((item) => item.severity === "WARNING").length, info: findings.filter((item) => item.severity === "INFO").length, byCode };
  const maxItems = input.maxItems ?? 200;
  return { generatedAt, scope: "INTERNAL_DATABASE_ONLY", summary, items: findings.slice(0, maxItems), truncated: findings.length > maxItems };
}
