import { getSupabaseAdminClient } from "../supabase";
import { requireBillingAdmin, type BillingAdmin } from "./auth";
import { BillingError } from "./errors";
import { getBillingConfig, type BillingConfig } from "./config";

export type AdminMutationResult = {
  status: "APPLIED" | "ALREADY_APPLIED";
  auditId: string;
  resourceId: string;
};

export type BillingAdminRepository = {
  getOverview(): Promise<unknown>;
  listOrders(): Promise<unknown>;
  getUser(userId: string): Promise<unknown>;
  listRefunds(): Promise<unknown[]>;
  listInvoices(): Promise<unknown[]>;
  listWebhookEvents(): Promise<unknown[]>;
  listCatalog(): Promise<{ plans: unknown[]; products: unknown[] }>;
  adjustCredit(input: {
    adminUserId: string;
    userId: string;
    amount: bigint;
    reason: string;
    idempotencyKey: string;
  }): Promise<AdminMutationResult>;
  grantSubscription(input: {
    adminUserId: string;
    userId: string;
    planId: string;
    durationDays: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<AdminMutationResult>;
  reviewRefund(input: {
    adminUserId: string;
    requestId: string;
    decision: "APPROVED" | "REJECTED";
    reason: string;
    idempotencyKey: string;
  }): Promise<AdminMutationResult>;
  reviewInvoice(input: {
    adminUserId: string;
    requestId: string;
    decision: "ISSUED" | "REJECTED";
    reason: string;
    idempotencyKey: string;
  }): Promise<AdminMutationResult>;
  upsertPlan(input: Record<string, unknown>): Promise<AdminMutationResult>;
  upsertProduct(input: Record<string, unknown>): Promise<AdminMutationResult>;
};

type Query = PromiseLike<{ data: unknown; error: { message: string } | null }> & {
  select(columns: string, options?: Record<string, unknown>): Query;
  eq(column: string, value: unknown): Query;
  order(column: string, options?: { ascending?: boolean }): Query;
  limit(count: number): Query;
  maybeSingle(): Query;
};

type Client = {
  from(table: string): Query;
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
};

type StorageDiagnostic = {
  operation: string;
  code: string;
  message: string;
};

type StorageDiagnosticReporter = (diagnostic: StorageDiagnostic) => void;

function sanitizeStorageMessage(value: unknown): string {
  const message = typeof value === "string" ? value : "Unknown storage error";
  return message
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: [REDACTED]")
    .replace(/apikey\s*=\s*\S+/gi, "apikey=[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .slice(0, 300);
}

const reportStorageDiagnostic: StorageDiagnosticReporter = (diagnostic) => {
  console.error("[billing-admin-storage]", diagnostic);
};

function storageError(): BillingError {
  return new BillingError(
    "BILLING_ADMIN_STORAGE_UNAVAILABLE",
    "Billing administration is temporarily unavailable.",
    503,
  );
}

function required(value: string, code = "INVALID_ADMIN_INPUT"): string {
  const normalized = value.trim();
  if (!normalized) throw new BillingError(code, "A non-empty value is required.", 400);
  return normalized;
}

function assertWriter(admin: BillingAdmin): void {
  if (admin.role !== "BILLING_ADMIN") {
    throw new BillingError(
      "BILLING_ADMIN_WRITE_REQUIRED",
      "Billing reviewer access is read-only.",
      403,
    );
  }
}

function reason(value: string): string {
  return required(value, "ADMIN_REASON_REQUIRED");
}

function optionalString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function optionalUuid(value: unknown): string | null {
  const normalized = optionalString(value);
  if (normalized && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new BillingError("INVALID_ADMIN_INPUT", "Identifier must be a UUID.", 400);
  }
  return normalized;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw storageError();
  }
  return value as Record<string, unknown>[];
}

function payloadHash(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hash = (value as Record<string, unknown>).payload_hash;
  return typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash) ? hash : null;
}

function maskTaxIdentifier(value: unknown): string | null {
  const identifier = optionalString(value);
  if (!identifier) return null;
  if (identifier.length <= 8) return "****";
  return `${identifier.slice(0, 4)}${"*".repeat(identifier.length - 8)}${identifier.slice(-4)}`;
}

function maskDeliveryEmail(value: unknown): string | null {
  const email = optionalString(value);
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local.length === 1
    ? "***"
    : local.length === 2
      ? `${local[0]}***`
    : `${local[0]}${"*".repeat(Math.max(1, local.length - 2))}${local.at(-1)}`;
  return `${maskedLocal}@${domain}`;
}

function mapInvoiceRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    user_id: row.user_id,
    order_id: row.order_id,
    invoice_title: row.invoice_title,
    tax_identifier: maskTaxIdentifier(row.tax_identifier),
    amount_minor: row.amount_minor,
    currency: row.currency,
    delivery_email: maskDeliveryEmail(row.delivery_email),
    status: row.status,
    created_at: row.created_at,
  };
}

function mapWebhookEventRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    provider: row.provider,
    provider_event_id: row.provider_event_id,
    order_id: row.order_id,
    payload_hash: payloadHash(row.payload_summary),
    status: row.status,
    error_code: row.error_code,
    created_at: row.created_at,
    processed_at: row.processed_at,
  };
}

function parseMutation(data: unknown): AdminMutationResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw storageError();
  const row = data as Record<string, unknown>;
  const status = row.status;
  const auditId = row.audit_id;
  const resourceId =
    row.resource_id ?? row.ledger_id ?? row.subscription_id ?? row.refund_id ??
    row.invoice_request_id ?? row.plan_id ?? row.product_id;
  if (
    (status !== "APPLIED" && status !== "ALREADY_APPLIED") ||
    typeof auditId !== "string" ||
    typeof resourceId !== "string"
  ) throw storageError();
  return { status, auditId, resourceId };
}

async function result(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown> {
  const response = await query;
  if (response.error) throw storageError();
  return response.data;
}

export function createBillingAdminRepository(
  client: Client,
  reportDiagnostic: StorageDiagnosticReporter = reportStorageDiagnostic,
): BillingAdminRepository {
  async function rpc(name: string, args: Record<string, unknown>) {
    const response = await client.rpc(name, args);
    if (response.error) {
      reportDiagnostic({
        operation: name,
        code: response.error.code ?? "UNKNOWN",
        message: sanitizeStorageMessage(response.error.message),
      });
      throw storageError();
    }
    return parseMutation(response.data);
  }
  return {
    async getOverview() {
      const [orders, refunds, invoices, audits] = await Promise.all([
        result(client.from("billing_orders").select("id", { count: "exact" }).eq("status", "PENDING")),
        result(client.from("billing_refund_requests").select("id", { count: "exact" }).eq("status", "PENDING")),
        result(client.from("billing_invoice_requests").select("id", { count: "exact" }).eq("status", "PENDING")),
        result(client.from("billing_admin_audit_logs").select("id, actor_user_id, action, target_type, target_id, reason, created_at").order("created_at", { ascending: false }).limit(20)),
      ]);
      return { pendingOrders: orders, pendingRefunds: refunds, pendingInvoices: invoices, recentAuditLogs: audits };
    },
    async listOrders() {
      const [orders, payments] = await Promise.all([
        result(client.from("billing_orders").select("id, order_number, user_id, snapshot_product_name, amount_minor, currency, provider, status, refund_status, created_at, paid_at").order("created_at", { ascending: false }).limit(100)),
        result(client.from("billing_payments").select("id, order_id, user_id, provider, provider_transaction_id, status, amount_minor, currency, paid_at, created_at").order("created_at", { ascending: false }).limit(100)),
      ]);
      return { orders, payments };
    },
    async getUser(userId) {
      const [credit, subscriptions, entitlements, quotas] = await Promise.all([
        result(client.from("billing_credit_accounts").select("user_id, available_balance, reserved_balance").eq("user_id", userId).maybeSingle()),
        result(client.from("billing_subscriptions").select("id, plan_id, status, starts_at, ends_at, auto_renew").eq("user_id", userId).order("ends_at", { ascending: false }).limit(20)),
        result(client.from("billing_user_entitlements").select("id, feature_key, source_type, entitlement_value, valid_from, valid_until").eq("user_id", userId).order("created_at", { ascending: false }).limit(100)),
        result(client.from("billing_usage_quotas").select("id, feature_key, period_start, period_end, quota_limit, reserved_units, used_units").eq("user_id", userId).order("period_end", { ascending: false }).limit(100)),
      ]);
      return { userId, credit, subscriptions, entitlements, quotas };
    },
    async listRefunds() {
      return (await result(client.from("billing_refund_requests").select("id, user_id, order_id, requested_amount_minor, currency, reason, status, created_at").order("created_at", { ascending: false }).limit(100))) as unknown[];
    },
    async listInvoices() {
      const data = await result(client.from("billing_invoice_requests").select("id, user_id, order_id, invoice_title, tax_identifier, amount_minor, currency, delivery_email, status, created_at").order("created_at", { ascending: false }).limit(100));
      return rows(data).map(mapInvoiceRow);
    },
    async listWebhookEvents() {
      const data = await result(client.from("billing_webhook_events").select("id, provider, provider_event_id, order_id, payload_summary, status, error_code, created_at, processed_at").order("created_at", { ascending: false }).limit(100));
      return rows(data).map(mapWebhookEventRow);
    },
    async listCatalog() {
      const [plans, products] = await Promise.all([
        result(client.from("billing_plans").select("id, code, name, description, is_active, created_at").order("created_at")),
        result(client.from("billing_products").select("id, plan_id, sku, name, product_type, price_minor, currency, duration_days, credit_grant, is_active, created_at").order("created_at")),
      ]);
      return { plans: plans as unknown[], products: products as unknown[] };
    },
    adjustCredit: (input) => rpc("billing_adjust_credit", {
      p_user_id: input.userId, p_amount: input.amount.toString(), p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey, p_admin_user_id: input.adminUserId,
    }),
    grantSubscription: (input) => rpc("billing_admin_grant_subscription", {
      p_admin_user_id: input.adminUserId, p_user_id: input.userId, p_plan_id: input.planId,
      p_duration_days: input.durationDays, p_reason: input.reason, p_idempotency_key: input.idempotencyKey,
    }),
    reviewRefund: (input) => rpc("billing_admin_review_refund", {
      p_admin_user_id: input.adminUserId, p_request_id: input.requestId,
      p_decision: input.decision, p_reason: input.reason, p_idempotency_key: input.idempotencyKey,
    }),
    reviewInvoice: (input) => rpc("billing_admin_review_invoice", {
      p_admin_user_id: input.adminUserId, p_request_id: input.requestId,
      p_decision: input.decision, p_reason: input.reason, p_idempotency_key: input.idempotencyKey,
    }),
    upsertPlan: (input) => rpc("billing_admin_upsert_plan", input),
    upsertProduct: (input) => rpc("billing_admin_upsert_product", input),
  };
}

export function getBillingAdminRepository(): BillingAdminRepository {
  const client = getSupabaseAdminClient();
  if (!client) throw storageError();
  return createBillingAdminRepository(client as unknown as Client);
}

export async function adjustUserCredit(admin: BillingAdmin, input: {
  userId: string; amount: bigint | number; reason: string; idempotencyKey: string;
}, repository = getBillingAdminRepository()): Promise<AdminMutationResult> {
  assertWriter(admin);
  if (typeof input.amount === "number" && !Number.isSafeInteger(input.amount)) {
    throw new BillingError("INVALID_ADMIN_INPUT", "Amount must be a safe integer.", 400);
  }
  const amount = typeof input.amount === "bigint" ? input.amount : BigInt(input.amount);
  if (amount === BigInt(0)) throw new BillingError("INVALID_ADMIN_INPUT", "Amount must be non-zero.", 400);
  return repository.adjustCredit({
    adminUserId: admin.id, userId: required(input.userId), amount,
    reason: reason(input.reason), idempotencyKey: required(input.idempotencyKey),
  });
}

export async function grantUserSubscription(admin: BillingAdmin, input: {
  userId: string; planId: string; durationDays: number; reason: string; idempotencyKey: string;
}, repository = getBillingAdminRepository()): Promise<AdminMutationResult> {
  assertWriter(admin);
  if (!Number.isSafeInteger(input.durationDays) || input.durationDays <= 0 || input.durationDays > 3660) {
    throw new BillingError("INVALID_ADMIN_INPUT", "Duration must be a positive whole number.", 400);
  }
  return repository.grantSubscription({
    adminUserId: admin.id, userId: required(input.userId), planId: required(input.planId),
    durationDays: input.durationDays, reason: reason(input.reason),
    idempotencyKey: required(input.idempotencyKey),
  });
}

export async function reviewRefundRequest(admin: BillingAdmin, input: {
  requestId: string; decision: "APPROVED" | "REJECTED"; reason: string; idempotencyKey: string;
}, repository = getBillingAdminRepository()): Promise<AdminMutationResult> {
  assertWriter(admin);
  return repository.reviewRefund({
    adminUserId: admin.id, requestId: required(input.requestId), decision: input.decision,
    reason: reason(input.reason), idempotencyKey: required(input.idempotencyKey),
  });
}

export async function reviewInvoiceRequest(admin: BillingAdmin, input: {
  requestId: string; decision: "ISSUED" | "REJECTED"; reason: string; idempotencyKey: string;
}, repository = getBillingAdminRepository()): Promise<AdminMutationResult> {
  assertWriter(admin);
  return repository.reviewInvoice({
    adminUserId: admin.id, requestId: required(input.requestId), decision: input.decision,
    reason: reason(input.reason), idempotencyKey: required(input.idempotencyKey),
  });
}

export async function upsertBillingPlan(admin: BillingAdmin, input: Record<string, unknown>,
  repository = getBillingAdminRepository(), config?: BillingConfig): Promise<AdminMutationResult> {
  assertWriter(admin);
  if (!["FREE", "MONTHLY", "YEARLY", "SEMESTER"].includes(String(input.billingPeriod)) ||
      typeof input.isActive !== "boolean") {
    throw new BillingError("INVALID_ADMIN_INPUT", "Invalid plan configuration.", 400);
  }
  if (input.isActive) {
    if (!(config ?? getBillingConfig()).featureEnabled) {
      throw new BillingError("BILLING_FEATURE_DISABLED", "Billing must be enabled before a plan can be activated.", 409);
    }
    const approvedPlans = {
      PRO: { name: "Pro", billingPeriod: "MONTHLY" },
      PRO_SEMESTER: { name: "Pro Semester", billingPeriod: "SEMESTER" },
    } as const;
    const approved = approvedPlans[input.code as keyof typeof approvedPlans];
    if (!approved || input.name !== approved.name || input.billingPeriod !== approved.billingPeriod) {
      throw new BillingError("PLAN_ACTIVATION_NOT_APPROVED", "This plan is not approved for the fast-launch catalog.", 409);
    }
  }
  return repository.upsertPlan({
    p_admin_user_id: admin.id,
    p_plan_id: optionalUuid(input.planId),
    p_code: required(String(input.code ?? "")),
    p_name: required(String(input.name ?? "")),
    p_description: input.description == null ? null : String(input.description),
    p_billing_period: input.billingPeriod,
    p_is_active: input.isActive,
    p_reason: reason(String(input.reason ?? "")),
    p_idempotency_key: required(String(input.idempotencyKey ?? "")),
  });
}

const FAST_LAUNCH_PRODUCTS = {
  PRO_MONTHLY: {
    name: "Pro Monthly",
    productType: "SUBSCRIPTION",
    priceMinor: 1_990,
    durationDays: 30,
    creditGrant: 0,
    entitlementVersion: "pro-v1",
    requiresPlanId: true,
  },
  PRO_SEMESTER: {
    name: "Pro Semester",
    productType: "SUBSCRIPTION",
    priceMinor: 7_900,
    durationDays: 150,
    creditGrant: 0,
    entitlementVersion: "pro-semester-v1",
    requiresPlanId: true,
  },
  CREDIT_PACK_100: {
    name: "Credit Pack 100",
    productType: "CREDIT_PACK",
    priceMinor: 990,
    durationDays: null,
    creditGrant: 100,
    entitlementVersion: "credit-v1",
    requiresPlanId: false,
  },
} as const;

function assertFastLaunchActivation(
  input: Record<string, unknown>,
  config: BillingConfig,
): void {
  if (!config.featureEnabled) {
    throw new BillingError(
      "BILLING_FEATURE_DISABLED",
      "Billing must be enabled before a product can be activated.",
      409,
    );
  }

  const sku = String(input.sku ?? "");
  const approved = FAST_LAUNCH_PRODUCTS[sku as keyof typeof FAST_LAUNCH_PRODUCTS];
  if (!approved) {
    throw new BillingError(
      "PRODUCT_ACTIVATION_NOT_APPROVED",
      "This product is not approved for the fast-launch catalog.",
      409,
    );
  }

  if (
    input.productType !== approved.productType ||
    input.name !== approved.name ||
    input.priceMinor !== approved.priceMinor ||
    (input.durationDays ?? null) !== approved.durationDays ||
    input.creditGrant !== approved.creditGrant ||
    input.entitlementVersion !== approved.entitlementVersion ||
    (approved.requiresPlanId
      ? !optionalString(input.planId)
      : optionalString(input.planId) !== null)
  ) {
    throw new BillingError(
      "PRODUCT_ACTIVATION_CONFIG_MISMATCH",
      "The product configuration does not match the approved fast-launch catalog.",
      409,
    );
  }
}

export async function upsertBillingProduct(admin: BillingAdmin, input: Record<string, unknown>,
  repository = getBillingAdminRepository(), config?: BillingConfig): Promise<AdminMutationResult> {
  assertWriter(admin);
  if (!Number.isSafeInteger(input.priceMinor) || Number(input.priceMinor) < 0) {
    throw new BillingError("INVALID_ADMIN_INPUT", "Price must be a non-negative integer.", 400);
  }
  if (
    !["SUBSCRIPTION", "CREDIT_PACK"].includes(String(input.productType)) ||
    typeof input.isActive !== "boolean" ||
    !Number.isSafeInteger(input.creditGrant) ||
    Number(input.creditGrant) < 0 ||
    (input.durationDays !== null && input.durationDays !== undefined &&
      (!Number.isSafeInteger(input.durationDays) || Number(input.durationDays) <= 0))
  ) {
    throw new BillingError("INVALID_ADMIN_INPUT", "Invalid product configuration.", 400);
  }
  if (input.isActive) {
    assertFastLaunchActivation(input, config ?? getBillingConfig());
  }
  return repository.upsertProduct({
    p_admin_user_id: admin.id,
    p_product_id: optionalUuid(input.productId),
    p_plan_id: optionalUuid(input.planId),
    p_sku: required(String(input.sku ?? "")),
    p_name: required(String(input.name ?? "")),
    p_description: input.description == null ? null : String(input.description),
    p_product_type: input.productType,
    p_price_minor: String(input.priceMinor),
    p_currency: "CNY",
    p_duration_days: input.durationDays ?? null,
    p_credit_grant: input.creditGrant,
    p_entitlement_version: required(String(input.entitlementVersion ?? "")),
    p_is_active: input.isActive,
    p_reason: reason(String(input.reason ?? "")),
    p_idempotency_key: required(String(input.idempotencyKey ?? "")),
  });
}

export function createAdminBillingHandler<T>(dependencies: {
  requireAdmin?: () => Promise<BillingAdmin>;
  operation: (admin: BillingAdmin, request: Request) => Promise<T>;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const admin = await (dependencies.requireAdmin ?? requireBillingAdmin)();
      return Response.json(await dependencies.operation(admin, request));
    } catch (error) {
      const safe = error instanceof BillingError ? error : storageError();
      return Response.json(
        { error: { code: safe.code, message: safe.message } },
        { status: safe.status },
      );
    }
  };
}
