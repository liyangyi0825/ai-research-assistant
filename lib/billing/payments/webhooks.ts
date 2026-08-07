import { createHash } from "node:crypto";

import { getSupabaseAdminClient } from "../../supabase";
import {
  assertBillingAccess,
  requireBillingActor,
  type BillingActor,
  type BillingUser,
} from "../auth";
import { getBillingConfig, type BillingConfig, type PaymentMode } from "../config";
import type { Json } from "../database.types";
import { BillingError } from "../errors";
import type { BillingProvider } from "../repositories";
import {
  billingSecurityLogger,
  type BillingSecurityLogger,
  warnBillingSecurity,
} from "../security-logger";
import { MockPaymentProvider } from "./mock";
import type { PaymentProvider } from "./provider";
import { getPaymentProvider } from "./registry";
import {
  createPaymentServiceRepository,
  paymentRequestIdempotencyKey,
  type PaymentServiceAdminClient,
  type PaymentServiceRepository,
} from "./service";

export type WebhookEventStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED";

export type WebhookPayloadSummary = {
  payload_hash: string;
  event_type?: "PAYMENT.PAID";
};

export type WebhookEventInsert = {
  provider: BillingProvider;
  providerEventId: string;
  orderNumber: string | null;
  providerTransactionId: string | null;
  requestIdempotencyKey: string | null;
  amountMinor: number | null;
  currency: "CNY" | null;
  paidAt: string | null;
  signatureValid: boolean;
  status: "RECEIVED" | "FAILED";
  payloadSummary: WebhookPayloadSummary;
  errorCode: string | null;
};

export type WebhookEventRecord = Omit<WebhookEventInsert, "status"> & {
  id: string;
  orderId: string | null;
  userId: string | null;
  status: WebhookEventStatus;
};

export type WebhookSettlementArgs = {
  p_order_number: string;
  p_provider: BillingProvider;
  p_provider_transaction_id: string;
  p_provider_event_id: string;
  p_request_idempotency_key: string;
  p_amount_minor: number;
  p_currency: "CNY";
  p_paid_at: string;
  p_response_summary: Json;
};

export type WebhookSettlementResult = {
  status:
    | "PROCESSED"
    | "ALREADY_PROCESSED"
    | "ALREADY_FAILED"
    | "IN_PROGRESS";
  eventStatus: WebhookEventStatus;
  orderId: string | null;
  errorCode?: string | null;
};

export type PaymentWebhookResult = WebhookSettlementResult & {
  eventId: string;
};

export type WebhookRepository = {
  persistEvent(input: WebhookEventInsert): Promise<WebhookEventRecord>;
  markEventFailed(
    provider: BillingProvider,
    providerEventId: string,
    errorCode: string,
  ): Promise<WebhookEventRecord>;
  settlePaidOrder(
    args: WebhookSettlementArgs,
  ): Promise<WebhookSettlementResult>;
};

type DatabaseError = { message: string; code?: string };
type DatabaseResult = { data: unknown; error: DatabaseError | null };
type WebhookDatabaseQuery = PromiseLike<DatabaseResult> & {
  select(columns: string): WebhookDatabaseQuery;
  insert(values: Record<string, unknown>): WebhookDatabaseQuery;
  update(values: Record<string, unknown>): WebhookDatabaseQuery;
  eq(column: string, value: unknown): WebhookDatabaseQuery;
  maybeSingle(): WebhookDatabaseQuery;
  single(): WebhookDatabaseQuery;
};

export type WebhookAdminClient = {
  from(table: string): WebhookDatabaseQuery;
  rpc(name: string, args: Record<string, unknown>): Promise<DatabaseResult>;
};

export type ProcessPaymentWebhookDependencies = {
  repository?: WebhookRepository;
  getConfig?: () => BillingConfig;
  getProvider?: (
    mode: PaymentMode,
    config: BillingConfig,
  ) => PaymentProvider;
  logger?: BillingSecurityLogger;
};

const WEBHOOK_COLUMNS = [
  "id",
  "order_id",
  "user_id",
  "order_number",
  "provider",
  "provider_event_id",
  "provider_transaction_id",
  "request_idempotency_key",
  "amount_minor",
  "currency",
  "paid_at",
  "signature_valid",
  "status",
  "payload_summary",
  "error_code",
].join(", ");

function storageError(): BillingError {
  return new BillingError(
    "BILLING_STORAGE_UNAVAILABLE",
    "Billing data is temporarily unavailable.",
    503,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  return value as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw storageError();
  return value;
}

function requiredString(value: unknown): string {
  const result = nullableString(value);
  if (!result?.trim()) throw storageError();
  return result;
}

function nullableAmount(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageError();
  }
  return value;
}

function payloadSummary(value: unknown): WebhookPayloadSummary {
  const summary = record(value);
  const hash = requiredString(summary.payload_hash);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw storageError();
  if (
    summary.event_type !== undefined &&
    summary.event_type !== "PAYMENT.PAID"
  ) {
    throw storageError();
  }
  return {
    payload_hash: hash,
    ...(summary.event_type === "PAYMENT.PAID"
      ? { event_type: "PAYMENT.PAID" as const }
      : {}),
  };
}

function mapWebhookEvent(value: unknown): WebhookEventRecord {
  const row = record(value);
  if (
    row.provider !== "MOCK" &&
    row.provider !== "WECHAT" &&
    row.provider !== "ALIPAY"
  ) {
    throw storageError();
  }
  if (
    row.status !== "RECEIVED" &&
    row.status !== "PROCESSING" &&
    row.status !== "PROCESSED" &&
    row.status !== "FAILED"
  ) {
    throw storageError();
  }
  if (typeof row.signature_valid !== "boolean") throw storageError();
  if (row.currency !== null && row.currency !== "CNY") throw storageError();

  return {
    id: requiredString(row.id),
    orderId: nullableString(row.order_id),
    userId: nullableString(row.user_id),
    orderNumber: nullableString(row.order_number),
    provider: row.provider,
    providerEventId: requiredString(row.provider_event_id),
    providerTransactionId: nullableString(row.provider_transaction_id),
    requestIdempotencyKey: nullableString(row.request_idempotency_key),
    amountMinor: nullableAmount(row.amount_minor),
    currency: row.currency,
    paidAt: nullableString(row.paid_at),
    signatureValid: row.signature_valid,
    status: row.status,
    payloadSummary: payloadSummary(row.payload_summary),
    errorCode: nullableString(row.error_code),
  };
}

function insertValues(input: WebhookEventInsert): Record<string, unknown> {
  return {
    provider: input.provider,
    provider_event_id: input.providerEventId,
    order_number: input.orderNumber,
    provider_transaction_id: input.providerTransactionId,
    request_idempotency_key: input.requestIdempotencyKey,
    amount_minor: input.amountMinor,
    currency: input.currency,
    paid_at: input.paidAt,
    signature_valid: input.signatureValid,
    status: input.status,
    payload_summary: input.payloadSummary,
    error_code: input.errorCode,
  };
}

function safeDatabaseError(error: DatabaseError): BillingError {
  const message = error.message.toLowerCase();
  const mapping: Array<[string, string, string, number]> = [
    ["webhook replay payload mismatch", "WEBHOOK_REPLAY_CONFLICT", "Webhook replay data does not match the original event.", 409],
    ["billing order not found", "ORDER_NUMBER_MISMATCH", "The callback order does not match a payable order.", 400],
    ["payment provider mismatch", "PAYMENT_PROVIDER_MISMATCH", "The callback payment provider does not match the order.", 400],
    ["payment amount mismatch", "PAYMENT_AMOUNT_MISMATCH", "The callback amount does not match the order.", 400],
    ["payment currency mismatch", "PAYMENT_CURRENCY_MISMATCH", "The callback currency does not match the order.", 400],
    ["order is not pending", "ORDER_NOT_PAYABLE", "The billing order is not payable.", 409],
    ["order expired before payment", "ORDER_EXPIRED", "The callback was paid after the order expired.", 409],
  ];
  const found = mapping.find(([needle]) => message.includes(needle));
  return found
    ? new BillingError(found[1], found[2], found[3])
    : storageError();
}

function mapSettlement(value: unknown): WebhookSettlementResult {
  const result = record(value);
  if (
    result.status !== "PROCESSED" &&
    result.status !== "ALREADY_PROCESSED" &&
    result.status !== "ALREADY_FAILED" &&
    result.status !== "IN_PROGRESS"
  ) {
    throw storageError();
  }
  const eventStatus =
    result.status === "ALREADY_FAILED"
      ? "FAILED"
      : result.status === "IN_PROGRESS"
        ? "PROCESSING"
        : "PROCESSED";
  return {
    status: result.status,
    eventStatus,
    orderId: nullableString(result.order_id),
    ...(result.status === "ALREADY_FAILED"
      ? { errorCode: nullableString(result.error_code) }
      : {}),
  };
}

export function createWebhookRepository(
  client: WebhookAdminClient,
): WebhookRepository {
  async function findEvent(provider: BillingProvider, providerEventId: string) {
    const result = await client
      .from("billing_webhook_events")
      .select(WEBHOOK_COLUMNS)
      .eq("provider", provider)
      .eq("provider_event_id", providerEventId)
      .maybeSingle();
    if (result.error) throw storageError();
    return result.data === null ? null : mapWebhookEvent(result.data);
  }

  return {
    async persistEvent(input) {
      try {
        const result = await client
          .from("billing_webhook_events")
          .insert(insertValues(input))
          .select(WEBHOOK_COLUMNS)
          .single();
        if (!result.error) return mapWebhookEvent(result.data);
        if (result.error.code !== "23505") throw storageError();
        const existing = await findEvent(input.provider, input.providerEventId);
        if (!existing) throw storageError();
        return existing;
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },

    async markEventFailed(provider, providerEventId, errorCode) {
      try {
        const result = await client
          .from("billing_webhook_events")
          .update({ status: "FAILED", error_code: errorCode })
          .eq("provider", provider)
          .eq("provider_event_id", providerEventId)
          .eq("status", "RECEIVED")
          .select(WEBHOOK_COLUMNS)
          .maybeSingle();
        if (result.error) throw storageError();
        if (result.data !== null) return mapWebhookEvent(result.data);
        const existing = await findEvent(provider, providerEventId);
        if (!existing) throw storageError();
        return existing;
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },

    async settlePaidOrder(args) {
      let result: DatabaseResult;
      try {
        result = await client.rpc("billing_settle_paid_order", args);
      } catch {
        throw storageError();
      }
      if (result.error) throw safeDatabaseError(result.error);
      return mapSettlement(result.data);
    },
  };
}

function defaultRepository(): WebhookRepository {
  const client = getSupabaseAdminClient();
  if (!client) throw storageError();
  return createWebhookRepository(client as unknown as WebhookAdminClient);
}

function providerName(value: PaymentMode): BillingProvider {
  return value.toUpperCase() as BillingProvider;
}

function payloadHash(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

function sameSummary(
  first: WebhookPayloadSummary,
  second: WebhookPayloadSummary,
): boolean {
  return (
    first.payload_hash === second.payload_hash &&
    first.event_type === second.event_type
  );
}

function sameImmutableEvent(
  stored: WebhookEventRecord,
  expected: WebhookEventInsert,
): boolean {
  return (
    stored.provider === expected.provider &&
    stored.providerEventId === expected.providerEventId &&
    stored.orderNumber === expected.orderNumber &&
    stored.providerTransactionId === expected.providerTransactionId &&
    stored.requestIdempotencyKey === expected.requestIdempotencyKey &&
    stored.amountMinor === expected.amountMinor &&
    stored.currency === expected.currency &&
    stored.paidAt === expected.paidAt &&
    stored.signatureValid === expected.signatureValid &&
    sameSummary(stored.payloadSummary, expected.payloadSummary)
  );
}

function replayConflict(): BillingError {
  return new BillingError(
    "WEBHOOK_REPLAY_CONFLICT",
    "Webhook replay data does not match the original event.",
    409,
  );
}

function normalizeError(error: unknown): BillingError {
  return error instanceof BillingError ? error : storageError();
}

async function persistRejectedEvent(
  repository: WebhookRepository,
  provider: BillingProvider,
  hash: string,
  signatureValid: boolean,
  errorCode: string,
): Promise<WebhookEventRecord> {
  const input: WebhookEventInsert = {
    provider,
    providerEventId: `rejected:${hash}`,
    orderNumber: null,
    providerTransactionId: null,
    requestIdempotencyKey: null,
    amountMinor: null,
    currency: null,
    paidAt: null,
    signatureValid,
    status: "FAILED",
    payloadSummary: { payload_hash: hash },
    errorCode,
  };
  const stored = await repository.persistEvent(input);
  if (!sameImmutableEvent(stored, input)) throw replayConflict();
  return stored;
}

export async function processPaymentWebhook(
  providerMode: PaymentMode,
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
  dependencies: ProcessPaymentWebhookDependencies = {},
): Promise<PaymentWebhookResult> {
  const config = (dependencies.getConfig ?? getBillingConfig)();
  if (providerMode !== config.paymentMode) {
    throw new BillingError(
      "PAYMENT_PROVIDER_MISMATCH",
      "Webhook provider does not match the server payment mode.",
      400,
    );
  }
  const providerNameValue = providerName(providerMode);
  const provider = (dependencies.getProvider ?? getPaymentProvider)(
    providerMode,
    config,
  );
  const repository = dependencies.repository ?? defaultRepository();
  const logger = dependencies.logger ?? billingSecurityLogger;
  const hash = payloadHash(rawBody);

  let signatureValid: boolean;
  try {
    signatureValid = await provider.verifyWebhook({ rawBody, headers });
  } catch (cause) {
    const error = normalizeError(cause);
    if (error.code === "INVALID_WEBHOOK_SIGNATURE") {
      const audit = await persistRejectedEvent(
        repository,
        providerNameValue,
        hash,
        false,
        error.code,
      );
      warnBillingSecurity(logger, {
        eventCode: "WEBHOOK_SIGNATURE_REJECTED",
        provider: providerNameValue,
        providerEventId: audit.providerEventId,
        errorCode: error.code,
        status: "FAILED",
      });
    }
    throw error;
  }
  if (!signatureValid) {
    const error = new BillingError(
      "INVALID_WEBHOOK_SIGNATURE",
      "The payment webhook signature is invalid.",
      401,
    );
    const audit = await persistRejectedEvent(
      repository,
      providerNameValue,
      hash,
      false,
      error.code,
    );
    warnBillingSecurity(logger, {
      eventCode: "WEBHOOK_SIGNATURE_REJECTED",
      provider: providerNameValue,
      providerEventId: audit.providerEventId,
      errorCode: error.code,
      status: "FAILED",
    });
    throw error;
  }

  let parsed;
  try {
    parsed = await provider.parseWebhook({ rawBody, headers });
  } catch (cause) {
    const error =
      cause instanceof BillingError
        ? cause
        : new BillingError(
            "INVALID_WEBHOOK",
            "The payment webhook payload is invalid.",
            400,
          );
    const audit = await persistRejectedEvent(
      repository,
      providerNameValue,
      hash,
      true,
      error.code,
    );
    warnBillingSecurity(logger, {
      eventCode: "WEBHOOK_PARSE_REJECTED",
      provider: providerNameValue,
      providerEventId: audit.providerEventId,
      errorCode: "WEBHOOK_PARSE_REJECTED",
      status: "FAILED",
    });
    throw error;
  }

  const requestIdempotencyKey = paymentRequestIdempotencyKey(
    providerNameValue,
    parsed.orderNumber,
  );
  const paidAt = new Date(parsed.occurredAt).toISOString();
  const input: WebhookEventInsert = {
    provider: providerNameValue,
    providerEventId: parsed.eventId,
    orderNumber: parsed.orderNumber,
    providerTransactionId: parsed.providerTransactionId,
    requestIdempotencyKey,
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    paidAt,
    signatureValid: true,
    status: "RECEIVED",
    payloadSummary: {
      payload_hash: hash,
      event_type: parsed.eventType,
    },
    errorCode: null,
  };
  const stored = await repository.persistEvent(input);
  if (!sameImmutableEvent(stored, input)) throw replayConflict();

  if (stored.status === "FAILED") {
    return {
      status: "ALREADY_FAILED",
      eventStatus: "FAILED",
      eventId: parsed.eventId,
      orderId: stored.orderId,
      errorCode: stored.errorCode,
    };
  }

  try {
    const result = await repository.settlePaidOrder({
      p_order_number: parsed.orderNumber,
      p_provider: providerNameValue,
      p_provider_transaction_id: parsed.providerTransactionId,
      p_provider_event_id: parsed.eventId,
      p_request_idempotency_key: requestIdempotencyKey,
      p_amount_minor: parsed.amountMinor,
      p_currency: parsed.currency,
      p_paid_at: paidAt,
      p_response_summary: { event_type: parsed.eventType },
    });
    return { ...result, eventId: parsed.eventId };
  } catch (cause) {
    const error = normalizeError(cause);
    const terminal = await repository.markEventFailed(
      providerNameValue,
      parsed.eventId,
      error.code,
    );
    if (terminal.status === "PROCESSED") {
      return {
        status: "ALREADY_PROCESSED",
        eventStatus: "PROCESSED",
        eventId: parsed.eventId,
        orderId: terminal.orderId,
      };
    }
    warnBillingSecurity(logger, {
      eventCode: "WEBHOOK_SETTLEMENT_FAILED",
      provider: providerNameValue,
      orderNumber: parsed.orderNumber,
      providerEventId: parsed.eventId,
      errorCode: "WEBHOOK_SETTLEMENT_FAILED",
      status: "FAILED",
    });
    throw error;
  }
}

function billingErrorResponse(error: unknown): Response {
  const safe =
    error instanceof BillingError
      ? error
      : new BillingError(
          "INTERNAL_BILLING_ERROR",
          "Billing request failed.",
          500,
        );
  return Response.json(
    { error: { code: safe.code, message: safe.message } },
    { status: safe.status },
  );
}

function headerRecord(headers: Headers): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  headers.forEach((value, key) => {
    values[key.toLowerCase()] = value;
  });
  return values;
}

type WebhookRouteContext = { params: Promise<{ provider: string }> };

export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

function webhookBodyTooLarge(): BillingError {
  return new BillingError(
    "WEBHOOK_BODY_TOO_LARGE",
    "The payment webhook body is too large.",
    413,
  );
}

async function readWebhookBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (/^\d+$/.test(declaredLength ?? "")) {
    if (BigInt(declaredLength!) > BigInt(MAX_WEBHOOK_BODY_BYTES)) {
      throw webhookBodyTooLarge();
    }
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_WEBHOOK_BODY_BYTES) {
        try {
          await reader.cancel("webhook body limit exceeded");
        } catch {
          // Preserve the safe 413 even if the request source rejects cancellation.
        }
        throw webhookBodyTooLarge();
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function createPaymentWebhookPostHandler(
  dependencies: {
    getConfig: () => BillingConfig;
    processWebhook: typeof processPaymentWebhook;
  } = {
    getConfig: getBillingConfig,
    processWebhook: processPaymentWebhook,
  },
) {
  return async function paymentWebhookPost(
    request: Request,
    context: WebhookRouteContext,
  ): Promise<Response> {
    try {
      const { provider } = await context.params;
      const config = dependencies.getConfig();
      if (
        (provider !== "mock" && provider !== "wechat" && provider !== "alipay") ||
        provider !== config.paymentMode
      ) {
        throw new BillingError(
          "PAYMENT_PROVIDER_MISMATCH",
          "Webhook provider does not match the server payment mode.",
          400,
        );
      }
      const rawBody = await readWebhookBody(request);
      const result = await dependencies.processWebhook(
        provider,
        rawBody,
        headerRecord(request.headers),
      );
      return Response.json({ webhook: result });
    } catch (error) {
      return billingErrorResponse(error);
    }
  };
}

export type ConfirmMockOrderPaymentDependencies = {
  paymentRepository?: PaymentServiceRepository;
  webhookRepository?: WebhookRepository;
  getConfig?: () => BillingConfig;
  getProvider?: (mode: "mock", config: BillingConfig) => PaymentProvider;
  now?: () => Date;
};

function assertMockConfirmationAllowed(
  user: BillingUser,
  config: BillingConfig,
): void {
  if (config.paymentMode !== "mock") {
    throw new BillingError(
      "PAYMENT_PROVIDER_MISMATCH",
      "Mock confirmation requires the server mock payment mode.",
      400,
    );
  }
  if (!user.isAdmin && !config.testUserIds.includes(user.id)) {
    throw new BillingError(
      "MOCK_CONFIRM_NOT_ALLOWED",
      "Mock payment confirmation is restricted to administrators and listed test users.",
      403,
    );
  }
}

export async function confirmMockOrderPayment(
  user: BillingUser,
  orderId: string,
  providerTransactionId: string,
  dependencies: ConfirmMockOrderPaymentDependencies = {},
): Promise<PaymentWebhookResult> {
  const config = (dependencies.getConfig ?? getBillingConfig)();
  if (!config.featureEnabled) {
    throw new BillingError(
      "BILLING_FEATURE_DISABLED",
      "Billing writes are disabled.",
      403,
    );
  }
  assertMockConfirmationAllowed(user, config);
  const paymentRepository =
    dependencies.paymentRepository ??
    createPaymentServiceRepository(
      getSupabaseAdminClient() as unknown as PaymentServiceAdminClient,
    );
  let order;
  try {
    order = await paymentRepository.findOwnedOrder(user.id, orderId);
  } catch (error) {
    throw normalizeError(error);
  }
  if (!order) {
    throw new BillingError(
      "ORDER_NOT_FOUND",
      "The billing order was not found.",
      404,
    );
  }
  if (order.provider !== "MOCK") {
    throw new BillingError(
      "PAYMENT_PROVIDER_MISMATCH",
      "The billing order does not use the mock provider.",
      400,
    );
  }
  if (order.status !== "PENDING" && order.status !== "PAID") {
    throw new BillingError(
      "ORDER_NOT_PAYABLE",
      "The billing order cannot be confirmed in its current state.",
      409,
    );
  }

  const provider = (dependencies.getProvider ?? getPaymentProvider)(
    "mock",
    config,
  );
  if (!(provider instanceof MockPaymentProvider)) {
    throw new BillingError(
      "PROVIDER_NOT_CONFIGURED",
      "Mock payment confirmation is not configured.",
      503,
    );
  }
  let storedPayment;
  try {
    storedPayment = await paymentRepository.claimMockPaymentConfirmation({
      userId: user.id,
      orderId: order.id,
      providerTransactionId,
      paidAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    });
  } catch (error) {
    throw normalizeError(error);
  }
  const callback = await provider.createPaidPaymentWebhook({
    orderNumber: order.orderNumber,
    ...storedPayment,
  });
  return processPaymentWebhook("mock", callback.rawBody, callback.headers, {
    repository: dependencies.webhookRepository,
    getConfig: () => config,
    getProvider: () => provider,
  });
}

type MockConfirmHandlerDependencies = {
  requireActor: () => Promise<BillingActor>;
  getConfig: () => BillingConfig;
  assertAccess: (user: BillingUser, config: BillingConfig) => void;
  confirmPayment: (
    user: BillingUser,
    orderId: string,
    providerTransactionId: string,
  ) => Promise<PaymentWebhookResult>;
};

const MOCK_CONFIRM_KEYS = new Set(["orderId", "providerTransactionId"]);

async function parseMockConfirmBody(request: Request) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    value = null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingError(
      "INVALID_MOCK_CONFIRM_BODY",
      "Mock confirmation body is invalid.",
      400,
    );
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !MOCK_CONFIRM_KEYS.has(key)) ||
    typeof body.orderId !== "string" ||
    !body.orderId.trim() ||
    typeof body.providerTransactionId !== "string" ||
    !body.providerTransactionId.trim()
  ) {
    throw new BillingError(
      "INVALID_MOCK_CONFIRM_BODY",
      "Mock confirmation body is invalid.",
      400,
    );
  }
  return {
    orderId: body.orderId.trim(),
    providerTransactionId: body.providerTransactionId.trim(),
  };
}

export function createMockConfirmPostHandler(
  dependencies: MockConfirmHandlerDependencies = {
    requireActor: requireBillingActor,
    getConfig: getBillingConfig,
    assertAccess: assertBillingAccess,
    confirmPayment: confirmMockOrderPayment,
  },
) {
  return async function mockConfirmPost(request: Request): Promise<Response> {
    try {
      const user = await dependencies.requireActor();
      const config = dependencies.getConfig();
      dependencies.assertAccess(user, config);
      assertMockConfirmationAllowed(user, config);
      const body = await parseMockConfirmBody(request);
      const result = await dependencies.confirmPayment(
        user,
        body.orderId,
        body.providerTransactionId,
      );
      return Response.json({ webhook: result });
    } catch (error) {
      return billingErrorResponse(error);
    }
  };
}
