import { getSupabaseAdminClient } from "../supabase";
import {
  assertBillingAccess,
  requireBillingActor,
  requireBillingUser,
  type BillingActor,
  type BillingUser,
} from "./auth";
import {
  BILLING_AGREEMENT_VERSION,
  assertPaymentRuntimeSafe,
  getBillingConfig,
  type BillingConfig,
  type PaymentMode,
} from "./config";
import { BillingError } from "./errors";
import type { BillingOrder } from "./repositories";

export type RefundReasonCode =
  | "DUPLICATE_ORDER"
  | "NO_LONGER_NEEDED"
  | "SERVICE_ISSUE"
  | "OTHER";

export type InvoiceTitleType = "PERSONAL" | "ORGANIZATION";

export type BillingSummary = {
  subscription: {
    planId: string;
    planName: string;
    startsAt: string;
    endsAt: string;
  } | null;
  credits: {
    available: number;
    reserved: number;
  };
  quotas: Array<{
    featureKey: string;
    periodStart: string;
    periodEnd: string;
    limit: number;
    reserved: number;
    used: number;
  }>;
  orders: Array<{
    id: string;
    orderNumber: string;
    status: BillingOrder["status"];
    productName: string;
    amountMinor: number;
    currency: "CNY";
    refundStatus: BillingOrder["refundStatus"];
    createdAt: string;
    paidAt: string | null;
  }>;
  usage: Array<{
    id: string;
    featureKey: string;
    status: "RESERVED" | "FINALIZED" | "RELEASED";
    quotaUnits: number;
    creditAmount: number;
    createdAt: string;
  }>;
  refunds: RefundRequest[];
  invoices: InvoiceRequest[];
};

export type RefundRequest = {
  id: string;
  orderId: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  requestedAmountMinor: number;
  currency: "CNY";
  reasonCode: RefundReasonCode;
  details: string;
  createdAt: string;
};

export type InvoiceRequest = {
  id: string;
  orderId: string;
  status: "PENDING" | "ISSUED" | "REJECTED" | "CANCELLED";
  titleType: InvoiceTitleType;
  invoiceTitle: string;
  taxIdentifier: string | null;
  amountMinor: number;
  currency: "CNY";
  deliveryEmail: string;
  createdAt: string;
};

export type RefundRequestInsert = {
  userId: string;
  orderId: string;
  reasonCode: RefundReasonCode;
  details: string;
};

export type InvoiceRequestInsert = {
  userId: string;
  orderId: string;
  titleType: InvoiceTitleType;
  invoiceTitle: string;
  taxIdentifier: string | null;
  deliveryEmail: string;
};

export type BillingUserPageRepository = {
  getSummary(userId: string): Promise<BillingSummary>;
  requestRefund(input: RefundRequestInsert): Promise<RefundRequest>;
  requestInvoice(input: InvoiceRequestInsert): Promise<InvoiceRequest>;
};

type DatabaseResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

export type BillingUserPageQuery = PromiseLike<DatabaseResult> & {
  select(columns: string): BillingUserPageQuery;
  eq(column: string, value: unknown): BillingUserPageQuery;
  lte(column: string, value: unknown): BillingUserPageQuery;
  gt(column: string, value: unknown): BillingUserPageQuery;
  order(
    column: string,
    options?: { ascending?: boolean },
  ): BillingUserPageQuery;
  limit(count: number): BillingUserPageQuery;
  maybeSingle(): BillingUserPageQuery;
};

export type BillingUserPageClient = {
  from(table: string): BillingUserPageQuery;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<DatabaseResult>;
};

const ORDER_SUMMARY_COLUMNS = [
  "id",
  "order_number",
  "status",
  "snapshot_product_name",
  "amount_minor",
  "currency",
  "refund_status",
  "created_at",
  "paid_at",
].join(", ");

const REFUND_COLUMNS = [
  "id",
  "order_id",
  "status",
  "requested_amount_minor",
  "currency",
  "reason",
  "created_at",
].join(", ");

const INVOICE_COLUMNS = [
  "id",
  "order_id",
  "status",
  "invoice_title",
  "tax_identifier",
  "amount_minor",
  "currency",
  "delivery_email",
  "created_at",
].join(", ");

function storageError(): BillingError {
  return new BillingError(
    "BILLING_STORAGE_UNAVAILABLE",
    "账单数据暂时不可用，请稍后重试。",
    503,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw storageError();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : requiredString(value);
}

function nonNegativeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw storageError();
  }
  return value;
}

function timestamp(value: unknown): string {
  const result = requiredString(value);
  if (!Number.isFinite(Date.parse(result))) throw storageError();
  return result;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw storageError();
  }
  return value as T;
}

function rows(result: DatabaseResult): unknown[] {
  if (result.error || !Array.isArray(result.data)) throw storageError();
  return result.data;
}

function optionalRow(result: DatabaseResult): unknown | null {
  if (result.error || (result.data !== null && typeof result.data !== "object")) {
    throw storageError();
  }
  return result.data;
}

function planName(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw storageError();
    return requiredString(record(value[0]).name);
  }
  return requiredString(record(value).name);
}

function mapSubscription(value: unknown): BillingSummary["subscription"] {
  const row = record(value);
  return {
    planId: requiredString(row.plan_id),
    planName: planName(row.billing_plans),
    startsAt: timestamp(row.starts_at),
    endsAt: timestamp(row.ends_at),
  };
}

function mapQuota(value: unknown): BillingSummary["quotas"][number] {
  const row = record(value);
  return {
    featureKey: requiredString(row.feature_key),
    periodStart: timestamp(row.period_start),
    periodEnd: timestamp(row.period_end),
    limit: nonNegativeInteger(row.quota_limit),
    reserved: nonNegativeInteger(row.reserved_units),
    used: nonNegativeInteger(row.used_units),
  };
}

function mapOrder(value: unknown): BillingSummary["orders"][number] {
  const row = record(value);
  return {
    id: requiredString(row.id),
    orderNumber: requiredString(row.order_number),
    status: enumValue(row.status, [
      "PENDING",
      "PAID",
      "FAILED",
      "CANCELLED",
      "CLOSED",
      "REFUNDING",
      "REFUNDED",
    ]),
    productName: requiredString(row.snapshot_product_name),
    amountMinor: nonNegativeInteger(row.amount_minor),
    currency: enumValue(row.currency, ["CNY"]),
    refundStatus: enumValue(row.refund_status, [
      "NONE",
      "REQUESTED",
      "PARTIAL",
      "FULL",
    ]),
    createdAt: timestamp(row.created_at),
    paidAt: nullableTimestamp(row.paid_at),
  };
}

function mapUsage(value: unknown): BillingSummary["usage"][number] {
  const row = record(value);
  return {
    id: requiredString(row.id),
    featureKey: requiredString(row.feature_key),
    status: enumValue(row.status, ["RESERVED", "FINALIZED", "RELEASED"]),
    quotaUnits: nonNegativeInteger(row.quota_units),
    creditAmount: nonNegativeInteger(row.credit_amount),
    createdAt: timestamp(row.created_at),
  };
}

function decodeRefundReason(value: unknown): {
  reasonCode: RefundReasonCode;
  details: string;
} {
  const raw = requiredString(value);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw storageError();
  }
  const data = record(decoded);
  return {
    reasonCode: enumValue(data.reasonCode, [
      "DUPLICATE_ORDER",
      "NO_LONGER_NEEDED",
      "SERVICE_ISSUE",
      "OTHER",
    ]),
    details:
      typeof data.details === "string" && data.details.length <= 500
        ? data.details
        : (() => {
            throw storageError();
          })(),
  };
}

function mapRefund(value: unknown): RefundRequest {
  const row = record(value);
  const reason = decodeRefundReason(row.reason);
  return {
    id: requiredString(row.id),
    orderId: requiredString(row.order_id),
    status: enumValue(row.status, [
      "PENDING",
      "APPROVED",
      "REJECTED",
      "CANCELLED",
    ]),
    requestedAmountMinor: nonNegativeInteger(row.requested_amount_minor),
    currency: enumValue(row.currency, ["CNY"]),
    ...reason,
    createdAt: timestamp(row.created_at),
  };
}

function mapInvoice(value: unknown): InvoiceRequest {
  const row = record(value);
  const taxIdentifier = nullableString(row.tax_identifier);
  return {
    id: requiredString(row.id),
    orderId: requiredString(row.order_id),
    status: enumValue(row.status, [
      "PENDING",
      "ISSUED",
      "REJECTED",
      "CANCELLED",
    ]),
    titleType: taxIdentifier === null ? "PERSONAL" : "ORGANIZATION",
    invoiceTitle: requiredString(row.invoice_title),
    taxIdentifier,
    amountMinor: nonNegativeInteger(row.amount_minor),
    currency: enumValue(row.currency, ["CNY"]),
    deliveryEmail: requiredString(row.delivery_email),
    createdAt: timestamp(row.created_at),
  };
}

async function failClosed<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
}

function afterSalesRpcError(
  error: DatabaseResult["error"],
  kind: "refund" | "invoice",
): BillingError {
  if (error?.code === "P0002") {
    return new BillingError(
      "ORDER_NOT_FOUND",
      kind === "refund"
        ? "未找到可申请售后的订单。"
        : "未找到可申请发票的订单。",
      404,
    );
  }
  if (error?.code === "55000") {
    return new BillingError(
      kind === "refund" ? "REFUND_NOT_ALLOWED" : "INVOICE_NOT_ALLOWED",
      kind === "refund"
        ? "当前订单状态不能提交退款申请。"
        : "当前订单状态不能提交发票申请。",
      409,
    );
  }
  return storageError();
}

export function createBillingUserPageRepository(
  client: BillingUserPageClient,
): BillingUserPageRepository {
  return {
    getSummary(userId) {
      return failClosed(async () => {
        const [
          subscriptionResult,
          creditResult,
          quotaResult,
          orderResult,
          usageResult,
          refundResult,
          invoiceResult,
        ] = await Promise.all([
          client
            .from("billing_subscriptions")
            .select("plan_id, starts_at, ends_at, billing_plans(name)")
            .eq("user_id", userId)
            .eq("status", "ACTIVE")
            .lte("starts_at", "now")
            .gt("ends_at", "now")
            .order("ends_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          client
            .from("billing_credit_accounts")
            .select("available_balance, reserved_balance")
            .eq("user_id", userId)
            .maybeSingle(),
          client
            .from("billing_usage_quotas")
            .select(
              "feature_key, period_start, period_end, quota_limit, reserved_units, used_units",
            )
            .eq("user_id", userId)
            .lte("period_start", "now")
            .gt("period_end", "now")
            .order("period_end", { ascending: true }),
          client
            .from("billing_orders")
            .select(ORDER_SUMMARY_COLUMNS)
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(20),
          client
            .from("billing_usage_records")
            .select(
              "id, feature_key, status, quota_units, credit_amount, created_at",
            )
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(20),
          client
            .from("billing_refund_requests")
            .select(REFUND_COLUMNS)
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(20),
          client
            .from("billing_invoice_requests")
            .select(INVOICE_COLUMNS)
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(20),
        ]);

        const subscriptionData = optionalRow(subscriptionResult);
        const creditData = optionalRow(creditResult);
        const credit = creditData === null ? null : record(creditData);

        return {
          subscription:
            subscriptionData === null
              ? null
              : mapSubscription(subscriptionData),
          credits: {
            available:
              credit === null
                ? 0
                : nonNegativeInteger(credit.available_balance),
            reserved:
              credit === null
                ? 0
                : nonNegativeInteger(credit.reserved_balance),
          },
          quotas: rows(quotaResult).map(mapQuota),
          orders: rows(orderResult).map(mapOrder),
          usage: rows(usageResult).map(mapUsage),
          refunds: rows(refundResult).map(mapRefund),
          invoices: rows(invoiceResult).map(mapInvoice),
        };
      });
    },

    requestRefund(request) {
      return failClosed(async () => {
        const result = await client.rpc("billing_request_refund", {
          p_user_id: request.userId,
          p_order_id: request.orderId,
          p_reason: JSON.stringify({
            reasonCode: request.reasonCode,
            details: request.details,
          }),
        });
        if (result.error) throw afterSalesRpcError(result.error, "refund");
        const data = optionalRow(result);
        if (data === null) throw storageError();
        return mapRefund(data);
      });
    },

    requestInvoice(request) {
      return failClosed(async () => {
        const result = await client.rpc("billing_request_invoice", {
          p_user_id: request.userId,
          p_order_id: request.orderId,
          p_invoice_title: request.invoiceTitle,
          p_tax_identifier: request.taxIdentifier,
          p_delivery_email: request.deliveryEmail,
        });
        if (result.error) throw afterSalesRpcError(result.error, "invoice");
        const data = optionalRow(result);
        if (data === null) throw storageError();
        return mapInvoice(data);
      });
    },
  };
}

function defaultRepository(): BillingUserPageRepository {
  const client = getSupabaseAdminClient();
  if (!client) throw storageError();
  return createBillingUserPageRepository(
    client as unknown as BillingUserPageClient,
  );
}

const billingUserPageRepository: BillingUserPageRepository = {
  getSummary(userId) {
    return defaultRepository().getSummary(userId);
  },
  requestRefund(input) {
    return defaultRepository().requestRefund(input);
  },
  requestInvoice(input) {
    return defaultRepository().requestInvoice(input);
  },
};

export async function getBillingSummary(
  userId: string,
  repository: BillingUserPageRepository = billingUserPageRepository,
): Promise<BillingSummary> {
  return failClosed(() => repository.getSummary(userId));
}

export type SubmitRefundInput = {
  userId: string;
  orderId: string;
  reasonCode: RefundReasonCode;
  details: string;
};

export type SubmitInvoiceInput = {
  userId: string;
  orderId: string;
  titleType: InvoiceTitleType;
  invoiceTitle: string;
  taxIdentifier: string | null;
  deliveryEmail: string;
};

export async function submitRefundRequest(
  input: SubmitRefundInput,
  dependencies: {
    repository?: BillingUserPageRepository;
  } = {},
): Promise<RefundRequest> {
  const repository = dependencies.repository ?? billingUserPageRepository;
  try {
    return await repository.requestRefund({
      userId: input.userId,
      orderId: input.orderId,
      reasonCode: input.reasonCode,
      details: input.details,
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
}

export async function submitInvoiceRequest(
  input: SubmitInvoiceInput,
  dependencies: {
    repository?: BillingUserPageRepository;
  } = {},
): Promise<InvoiceRequest> {
  const repository = dependencies.repository ?? billingUserPageRepository;
  try {
    return await repository.requestInvoice({
      userId: input.userId,
      orderId: input.orderId,
      titleType: input.titleType,
      invoiceTitle: input.invoiceTitle,
      taxIdentifier: input.taxIdentifier,
      deliveryEmail: input.deliveryEmail,
    });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw storageError();
  }
}

function errorResponse(
  error: unknown,
  fallbackMessage: string,
): Response {
  const billingError =
    error instanceof BillingError
      ? error
      : new BillingError("INTERNAL_BILLING_ERROR", fallbackMessage, 500);
  return Response.json(
    {
      error: {
        code: billingError.code,
        message: billingError.message,
      },
    },
    { status: billingError.status },
  );
}

export type BillingAvailabilityHandlerDependencies = {
  getConfig: () => BillingConfig;
  requireActor: () => Promise<BillingActor>;
};

const unavailable = {
  available: false,
  paymentMode: null,
  mockConfirmationAllowed: false,
  agreementVersion: null,
} as const;

export async function getCurrentBillingAvailability(
  dependencies: BillingAvailabilityHandlerDependencies = {
    getConfig: getBillingConfig,
    requireActor: requireBillingActor,
  },
): Promise<BillingAvailability> {
  try {
    const config = dependencies.getConfig();
    if (!config.featureEnabled) return unavailable;
    if (!config.isProduction && config.paymentMode === "mock") {
      return {
        available: true,
        paymentMode: config.paymentMode,
        mockConfirmationAllowed: config.paymentMode === "mock",
        agreementVersion: BILLING_AGREEMENT_VERSION,
      };
    }

    const actor = await dependencies.requireActor();
    try {
      assertPaymentRuntimeSafe(config, {
        userId: actor.id,
        isAdmin: actor.isAdmin,
      });
    } catch {
      return unavailable;
    }
    return {
      available: true,
      paymentMode: config.paymentMode,
      mockConfirmationAllowed: config.paymentMode === "mock",
      agreementVersion: BILLING_AGREEMENT_VERSION,
    };
  } catch {
    return unavailable;
  }
}

export function createBillingAvailabilityGetHandler(
  dependencies: BillingAvailabilityHandlerDependencies = {
    getConfig: getBillingConfig,
    requireActor: requireBillingActor,
  },
): () => Promise<Response> {
  return async function availabilityHandler() {
    return Response.json(await getCurrentBillingAvailability(dependencies));
  };
}

export type BillingSummaryHandlerDependencies = {
  requireUser: () => Promise<BillingUser>;
  getSummary: (userId: string) => Promise<BillingSummary>;
};

export function createBillingSummaryGetHandler(
  dependencies: BillingSummaryHandlerDependencies = {
    requireUser: requireBillingUser,
    getSummary: getBillingSummary,
  },
): () => Promise<Response> {
  return async function summaryHandler() {
    try {
      const billingUser = await dependencies.requireUser();
      const summary = await dependencies.getSummary(billingUser.id);
      return Response.json({ summary });
    } catch (error) {
      return errorResponse(
        error,
        "账单信息暂时无法加载，请稍后重试。",
      );
    }
  };
}

const REFUND_BODY_KEYS = new Set(["orderId", "reasonCode", "details"]);
const REFUND_REASONS: readonly RefundReasonCode[] = [
  "DUPLICATE_ORDER",
  "NO_LONGER_NEEDED",
  "SERVICE_ISSUE",
  "OTHER",
];

function invalidBody(message: string): BillingError {
  return new BillingError("INVALID_BILLING_REQUEST", message, 400);
}

async function bodyRecord(
  request: Request,
  allowedKeys: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw invalidBody("请求内容不是有效的 JSON。");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidBody("请求内容格式不正确。");
  }
  const values = body as Record<string, unknown>;
  if (Object.keys(values).some((key) => !allowedKeys.has(key))) {
    throw invalidBody("请求包含不允许的字段。");
  }
  return values;
}

async function parseRefundBody(
  request: Request,
): Promise<Omit<SubmitRefundInput, "userId">> {
  const values = await bodyRecord(request, REFUND_BODY_KEYS);
  const orderId =
    typeof values.orderId === "string" ? values.orderId.trim() : "";
  const reasonCode = values.reasonCode;
  const details =
    typeof values.details === "string" ? values.details.trim() : "";
  if (
    !orderId ||
    orderId.length > 128 ||
    typeof reasonCode !== "string" ||
    !REFUND_REASONS.includes(reasonCode as RefundReasonCode) ||
    details.length > 500 ||
    ((reasonCode === "SERVICE_ISSUE" || reasonCode === "OTHER") &&
      details.length < 10)
  ) {
    throw invalidBody("请选择有效原因，并在需要时填写 10–500 字说明。");
  }
  return {
    orderId,
    reasonCode: reasonCode as RefundReasonCode,
    details,
  };
}

export type RefundPostHandlerDependencies = {
  requireActor: () => Promise<BillingActor>;
  getConfig: () => BillingConfig;
  assertAccess: (user: BillingUser, config: BillingConfig) => void;
  submitRefund: (input: SubmitRefundInput) => Promise<RefundRequest>;
};

export function createRefundPostHandler(
  dependencies: RefundPostHandlerDependencies = {
    requireActor: requireBillingActor,
    getConfig: getBillingConfig,
    assertAccess: assertBillingAccess,
    submitRefund: submitRefundRequest,
  },
): (request: Request) => Promise<Response> {
  return async function refundHandler(request) {
    try {
      const billingUser = await dependencies.requireActor();
      const config = dependencies.getConfig();
      dependencies.assertAccess(billingUser, config);
      const input = await parseRefundBody(request);
      const refund = await dependencies.submitRefund({
        userId: billingUser.id,
        ...input,
      });
      return Response.json({ refund }, { status: 202 });
    } catch (error) {
      return errorResponse(error, "退款申请暂时无法提交，请稍后重试。");
    }
  };
}

const INVOICE_BODY_KEYS = new Set([
  "orderId",
  "titleType",
  "invoiceTitle",
  "taxIdentifier",
  "deliveryEmail",
]);
const TAX_IDENTIFIER_PATTERN = /^[A-Z0-9]{15,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function parseInvoiceBody(
  request: Request,
): Promise<Omit<SubmitInvoiceInput, "userId">> {
  const values = await bodyRecord(request, INVOICE_BODY_KEYS);
  const orderId =
    typeof values.orderId === "string" ? values.orderId.trim() : "";
  const titleType = values.titleType;
  const invoiceTitle =
    typeof values.invoiceTitle === "string"
      ? values.invoiceTitle.trim()
      : "";
  const deliveryEmail =
    typeof values.deliveryEmail === "string"
      ? values.deliveryEmail.trim().toLowerCase()
      : "";
  const rawTaxIdentifier =
    typeof values.taxIdentifier === "string"
      ? values.taxIdentifier.trim().toUpperCase()
      : null;
  if (
    !orderId ||
    orderId.length > 128 ||
    (titleType !== "PERSONAL" && titleType !== "ORGANIZATION") ||
    invoiceTitle.length < 2 ||
    invoiceTitle.length > 120 ||
    deliveryEmail.length > 254 ||
    !EMAIL_PATTERN.test(deliveryEmail)
  ) {
    throw invalidBody("请检查发票抬头、类型和接收邮箱。");
  }
  if (
    (titleType === "ORGANIZATION" &&
      (!rawTaxIdentifier ||
        !TAX_IDENTIFIER_PATTERN.test(rawTaxIdentifier))) ||
    (titleType === "PERSONAL" && rawTaxIdentifier !== null)
  ) {
    throw invalidBody("单位发票需填写 15–20 位有效税号。");
  }
  return {
    orderId,
    titleType,
    invoiceTitle,
    taxIdentifier:
      titleType === "ORGANIZATION" ? rawTaxIdentifier : null,
    deliveryEmail,
  };
}

export type InvoicePostHandlerDependencies = {
  requireActor: () => Promise<BillingActor>;
  getConfig: () => BillingConfig;
  assertAccess: (user: BillingUser, config: BillingConfig) => void;
  submitInvoice: (input: SubmitInvoiceInput) => Promise<InvoiceRequest>;
};

export function createInvoicePostHandler(
  dependencies: InvoicePostHandlerDependencies = {
    requireActor: requireBillingActor,
    getConfig: getBillingConfig,
    assertAccess: assertBillingAccess,
    submitInvoice: submitInvoiceRequest,
  },
): (request: Request) => Promise<Response> {
  return async function invoiceHandler(request) {
    try {
      const billingUser = await dependencies.requireActor();
      const config = dependencies.getConfig();
      dependencies.assertAccess(billingUser, config);
      const input = await parseInvoiceBody(request);
      const invoice = await dependencies.submitInvoice({
        userId: billingUser.id,
        ...input,
      });
      return Response.json({ invoice }, { status: 202 });
    } catch (error) {
      return errorResponse(error, "发票申请暂时无法提交，请稍后重试。");
    }
  };
}

export function billingFeatureEnabled(): boolean {
  try {
    return getBillingConfig().featureEnabled;
  } catch {
    return false;
  }
}

export type BillingAvailability = {
  available: boolean;
  paymentMode: PaymentMode | null;
  mockConfirmationAllowed: boolean;
  agreementVersion: string | null;
};
