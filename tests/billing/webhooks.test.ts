import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { POST as mockConfirmPOST } from "../../app/api/billing/payments/mock/confirm/route";
import { POST as webhookPOST } from "../../app/api/billing/webhooks/[provider]/route";
import type { BillingUser } from "../../lib/billing/auth";
import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import { createBillingSecurityLogger } from "../../lib/billing/security-logger";
import { MockPaymentProvider } from "../../lib/billing/payments/mock";
import type {
  PaymentOrderSnapshot,
  PaymentServiceRepository,
} from "../../lib/billing/payments/service";
import {
  confirmMockOrderPayment,
  createMockConfirmPostHandler,
  createPaymentWebhookPostHandler,
  processPaymentWebhook,
  type WebhookEventInsert,
  type WebhookEventRecord,
  type WebhookRepository,
  type WebhookSettlementArgs,
  type WebhookSettlementResult,
} from "../../lib/billing/payments/webhooks";

const now = new Date("2026-07-22T03:00:00.000Z");
const secret = "webhook-test-secret";
const config: BillingConfig = {
  featureEnabled: true,
  paymentMode: "mock",
  testUserIds: ["user-1"],
  legal: { operatorName: "", operatorCreditCode: "", contactEmail: "" },
  wechatConfigured: false,
  alipayConfigured: false,
  isProduction: false,
};

type SettlementOrder = {
  id: string;
  orderNumber: string;
  provider: "MOCK";
  status: "PENDING" | "PAID";
  amountMinor: number;
  currency: "CNY";
  expiresAt: string;
};

function settlementOrder(
  overrides: Partial<SettlementOrder> = {},
): SettlementOrder {
  return {
    id: "order-id-1",
    orderNumber: "BILL-00000000000000000000000000000001",
    provider: "MOCK",
    status: "PENDING",
    amountMinor: 1_990,
    currency: "CNY",
    expiresAt: "2026-07-22T03:30:00.000Z",
    ...overrides,
  };
}

function cloneEvent(event: WebhookEventRecord): WebhookEventRecord {
  return { ...event, payloadSummary: { ...event.payloadSummary } };
}

class MemoryWebhookRepository implements WebhookRepository {
  readonly events = new Map<string, WebhookEventRecord>();
  readonly operations: string[] = [];
  settlementCalls = 0;
  grants = 0;
  simulateProcessedRace = false;
  simulateProcessingRace = false;

  constructor(readonly order = settlementOrder()) {}

  async persistEvent(input: WebhookEventInsert): Promise<WebhookEventRecord> {
    this.operations.push(`persist:${input.status}`);
    const key = `${input.provider}:${input.providerEventId}`;
    const existing = this.events.get(key);
    if (existing) return cloneEvent(existing);
    const stored: WebhookEventRecord = {
      id: `event-row-${this.events.size + 1}`,
      orderId: null,
      userId: null,
      ...input,
    };
    this.events.set(key, stored);
    return cloneEvent(stored);
  }

  async markEventFailed(
    provider: WebhookEventRecord["provider"],
    providerEventId: string,
    errorCode: string,
  ): Promise<WebhookEventRecord> {
    this.operations.push(`fail:${errorCode}`);
    const key = `${provider}:${providerEventId}`;
    const event = this.events.get(key);
    if (!event) throw new Error("missing webhook event");
    if (this.simulateProcessedRace) {
      event.status = "PROCESSED";
      event.orderId = this.order.id;
      return cloneEvent(event);
    }
    if (this.simulateProcessingRace) {
      event.status = "PROCESSING";
      return cloneEvent(event);
    }
    if (event.status === "RECEIVED") {
      event.status = "FAILED";
      event.errorCode = errorCode;
    }
    return cloneEvent(event);
  }

  async markEventRetryable(
    provider: WebhookEventRecord["provider"],
    providerEventId: string,
    errorCode: string,
  ): Promise<WebhookEventRecord> {
    this.operations.push(`retryable:${errorCode}`);
    const event = this.events.get(`${provider}:${providerEventId}`);
    if (!event) throw new Error("missing webhook event");
    if (this.simulateProcessedRace) {
      event.status = "PROCESSED";
      event.orderId = this.order.id;
      return cloneEvent(event);
    }
    if (this.simulateProcessingRace) {
      event.status = "PROCESSING";
      return cloneEvent(event);
    }
    if (event.status === "RECEIVED" || event.status === "RETRYABLE") {
      event.status = "RETRYABLE";
      event.errorCode = errorCode;
    }
    return cloneEvent(event);
  }

  async prepareEventForSettlement(
    provider: WebhookEventRecord["provider"],
    providerEventId: string,
  ): Promise<WebhookEventRecord> {
    const event = this.events.get(`${provider}:${providerEventId}`);
    if (!event) throw new Error("missing webhook event");
    if (event.status === "RETRYABLE") {
      event.status = "RECEIVED";
      event.errorCode = null;
    }
    return cloneEvent(event);
  }

  async settlePaidOrder(
    args: WebhookSettlementArgs,
  ): Promise<WebhookSettlementResult> {
    this.operations.push("settle");
    this.settlementCalls += 1;
    const key = `${args.p_provider}:${args.p_provider_event_id}`;
    const event = this.events.get(key);
    if (!event) throw new Error("webhook event must be persisted");
    if (event.status === "PROCESSED") {
      return {
        status: "ALREADY_PROCESSED",
        eventStatus: "PROCESSED",
        orderId: this.order.id,
      };
    }
    if (event.status === "FAILED") {
      return {
        status: "ALREADY_FAILED",
        eventStatus: "FAILED",
        orderId: event.orderId,
        errorCode: event.errorCode,
      };
    }
    if (this.order.orderNumber !== args.p_order_number) {
      throw new BillingError("ORDER_NUMBER_MISMATCH", "Order mismatch.", 400);
    }
    if (this.order.provider !== args.p_provider) {
      throw new BillingError("PAYMENT_PROVIDER_MISMATCH", "Provider mismatch.", 400);
    }
    if (this.order.amountMinor !== args.p_amount_minor) {
      throw new BillingError("PAYMENT_AMOUNT_MISMATCH", "Amount mismatch.", 400);
    }
    if (this.order.currency !== args.p_currency) {
      throw new BillingError("PAYMENT_CURRENCY_MISMATCH", "Currency mismatch.", 400);
    }
    if (this.order.status !== "PENDING") {
      throw new BillingError("ORDER_NOT_PAYABLE", "Order is not pending.", 409);
    }
    if (Date.parse(this.order.expiresAt) <= Date.parse(args.p_paid_at)) {
      throw new BillingError("ORDER_EXPIRED", "Order expired.", 409);
    }
    event.status = "PROCESSED";
    event.orderId = this.order.id;
    this.order.status = "PAID";
    this.grants += 1;
    return {
      status: "PROCESSED",
      eventStatus: "PROCESSED",
      orderId: this.order.id,
    };
  }
}

function mockProvider() {
  return new MockPaymentProvider({ secret, now: () => now });
}

function eventBody(
  overrides: Partial<{
    eventId: string;
    providerTransactionId: string;
    orderNumber: string;
    amountMinor: number;
    currency: string;
    occurredAt: string;
  }> = {},
) {
  return JSON.stringify({
    eventId: "mock-event-1",
    eventType: "PAYMENT.PAID",
    providerTransactionId: "mock-tx-1",
    orderNumber: settlementOrder().orderNumber,
    amountMinor: 1_990,
    currency: "CNY",
    occurredAt: now.toISOString(),
    ...overrides,
  });
}

function signed(rawBody: string) {
  return {
    "x-mock-signature": `sha256=${createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex")}`,
  };
}

function webhookDependencies(
  repository: WebhookRepository,
  provider = mockProvider(),
) {
  return {
    repository,
    getConfig: () => config,
    getProvider: () => provider,
  };
}

function expectBillingError(error: unknown, code: string, status: number) {
  return (
    error instanceof BillingError && error.code === code && error.status === status
  );
}

test("payment callback route modules expose POST handlers", () => {
  assert.equal(typeof mockConfirmPOST, "function");
  assert.equal(typeof webhookPOST, "function");
});

test("a valid callback is persisted as RECEIVED before the exact nine-argument settlement RPC", async () => {
  const repository = new MemoryWebhookRepository();
  const settlementCalls: WebhookSettlementArgs[] = [];
  const originalSettle = repository.settlePaidOrder.bind(repository);
  repository.settlePaidOrder = async (args) => {
    settlementCalls.push(args);
    return originalSettle(args);
  };
  const rawBody = eventBody();

  const result = await processPaymentWebhook(
    "mock",
    rawBody,
    signed(rawBody),
    webhookDependencies(repository),
  );

  assert.deepEqual(repository.operations, ["persist:RECEIVED", "settle"]);
  assert.equal(result.status, "PROCESSED");
  assert.equal(repository.grants, 1);
  const settlementArgs = settlementCalls[0];
  assert.deepEqual(Object.keys(settlementArgs).sort(), [
    "p_amount_minor",
    "p_currency",
    "p_order_number",
    "p_paid_at",
    "p_provider",
    "p_provider_event_id",
    "p_provider_transaction_id",
    "p_request_idempotency_key",
    "p_response_summary",
  ]);
  assert.equal(
    settlementArgs.p_request_idempotency_key,
    `billing-payment:MOCK:${settlementOrder().orderNumber}`,
  );
  const stored = repository.events.get("MOCK:mock-event-1");
  assert.equal(stored?.signatureValid, true);
  assert.deepEqual(Object.keys(stored?.payloadSummary ?? {}).sort(), [
    "event_type",
    "payload_hash",
  ]);
  assert.equal(JSON.stringify(stored).includes(rawBody), false);
});

test("invalid signatures never trust business fields and persist only a rejected payload hash", async () => {
  const repository = new MemoryWebhookRepository();
  const rawBody = `${eventBody({ orderNumber: "attacker-order", amountMinor: 1 }).slice(0, -1)},"email":"student@example.com","taxIdentifier":"tax-id"}`;
  const logs: string[] = [];

  await assert.rejects(
    () =>
      processPaymentWebhook(
        "mock",
        rawBody,
        {
          "x-mock-signature": "sha256=" + "0".repeat(64),
          authorization: "Bearer secret-header",
        },
        {
          ...webhookDependencies(repository),
          logger: createBillingSecurityLogger((line) => logs.push(line)),
        },
      ),
    (error: unknown) =>
      expectBillingError(error, "INVALID_WEBHOOK_SIGNATURE", 401),
  );

  const hash = createHash("sha256").update(rawBody).digest("hex");
  const stored = repository.events.get(`MOCK:rejected:${hash}`);
  assert.equal(stored?.status, "FAILED");
  assert.equal(stored?.signatureValid, false);
  assert.equal(stored?.orderNumber, null);
  assert.equal(stored?.providerTransactionId, null);
  assert.equal(stored?.amountMinor, null);
  assert.equal(stored?.currency, null);
  assert.deepEqual(stored?.payloadSummary, { payload_hash: hash });
  assert.equal(logs.length, 1);
  assert.deepEqual(
    JSON.parse(logs[0].slice("billing_security_event ".length)),
    {
      eventCode: "WEBHOOK_SIGNATURE_REJECTED",
      provider: "MOCK",
      providerEventId: `rejected:${hash}`,
      errorCode: "INVALID_WEBHOOK_SIGNATURE",
      status: "FAILED",
    },
  );
  const auditText = JSON.stringify({ stored, logs });
  assert.equal(auditText.includes(rawBody), false);
  assert.equal(auditText.includes("secret-header"), false);
  assert.equal(auditText.includes("student@example.com"), false);
  assert.equal(auditText.includes("tax-id"), false);
  assert.equal(repository.settlementCalls, 0);
});

test("a verifier-classified invalid signature is also retained as a hash-only audit", async () => {
  const repository = new MemoryWebhookRepository();
  const provider = mockProvider();
  provider.verifyWebhook = async () => {
    throw new BillingError(
      "INVALID_WEBHOOK_SIGNATURE",
      "Malformed signature header.",
      401,
    );
  };
  const rawBody = eventBody();

  await assert.rejects(
    () =>
      processPaymentWebhook(
        "mock",
        rawBody,
        {},
        webhookDependencies(repository, provider),
      ),
    (error: unknown) =>
      expectBillingError(error, "INVALID_WEBHOOK_SIGNATURE", 401),
  );

  const hash = createHash("sha256").update(rawBody).digest("hex");
  const stored = repository.events.get(`MOCK:rejected:${hash}`);
  assert.equal(stored?.status, "FAILED");
  assert.equal(stored?.signatureValid, false);
  assert.equal(stored?.orderNumber, null);
});

test("a signed but malformed callback is retained as a hash-only FAILED audit", async () => {
  const repository = new MemoryWebhookRepository();
  const rawBody = "not-json";

  await assert.rejects(
    () =>
      processPaymentWebhook(
        "mock",
        rawBody,
        signed(rawBody),
        webhookDependencies(repository),
      ),
    (error: unknown) => expectBillingError(error, "INVALID_WEBHOOK", 400),
  );

  const hash = createHash("sha256").update(rawBody).digest("hex");
  const stored = repository.events.get(`MOCK:rejected:${hash}`);
  assert.equal(stored?.signatureValid, true);
  assert.equal(stored?.status, "FAILED");
  assert.equal(stored?.orderNumber, null);
  assert.deepEqual(stored?.payloadSummary, { payload_hash: hash });
});

test("a signed parse rejection writes one allowlisted security event", async () => {
  const repository = new MemoryWebhookRepository();
  const logs: string[] = [];
  const rawBody = "not-json-with-email=student@example.com";

  await assert.rejects(
    () =>
      processPaymentWebhook("mock", rawBody, signed(rawBody), {
        ...webhookDependencies(repository),
        logger: createBillingSecurityLogger((line) => logs.push(line)),
      }),
    (error: unknown) => expectBillingError(error, "INVALID_WEBHOOK", 400),
  );

  const hash = createHash("sha256").update(rawBody).digest("hex");
  assert.equal(logs.length, 1);
  assert.deepEqual(
    JSON.parse(logs[0].slice("billing_security_event ".length)),
    {
      eventCode: "WEBHOOK_PARSE_REJECTED",
      provider: "MOCK",
      providerEventId: `rejected:${hash}`,
      errorCode: "WEBHOOK_PARSE_REJECTED",
      status: "FAILED",
    },
  );
  assert.equal(logs[0].includes(rawBody), false);
  assert.equal(logs[0].includes("student@example.com"), false);
});

test("a verified settlement failure writes one safe security event", async () => {
  const repository = new MemoryWebhookRepository();
  const logs: string[] = [];
  const rawBody = `${eventBody().slice(0, -1)},"email":"student@example.com"}`;
  repository.settlePaidOrder = async () => {
    throw new Error("database password=do-not-log");
  };

  await assert.rejects(
    () =>
      processPaymentWebhook("mock", rawBody, signed(rawBody), {
        ...webhookDependencies(repository),
        logger: createBillingSecurityLogger((line) => logs.push(line)),
      }),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );

  assert.equal(logs.length, 1);
  assert.deepEqual(
    JSON.parse(logs[0].slice("billing_security_event ".length)),
    {
      eventCode: "WEBHOOK_SETTLEMENT_FAILED",
      provider: "MOCK",
      orderNumber: settlementOrder().orderNumber,
      providerEventId: "mock-event-1",
      errorCode: "WEBHOOK_SETTLEMENT_FAILED",
      status: "RETRYABLE",
    },
  );
  assert.equal(logs[0].includes(rawBody), false);
  assert.equal(logs[0].includes("student@example.com"), false);
  assert.equal(logs[0].includes("database password=do-not-log"), false);
});

test("a transient settlement failure becomes retryable and the identical callback grants once after recovery", async () => {
  const repository = new MemoryWebhookRepository();
  const rawBody = eventBody();
  const originalSettle = repository.settlePaidOrder.bind(repository);
  let settlementAttempts = 0;
  let retryableMarks = 0;
  const retryableRepository = repository as unknown as MemoryWebhookRepository & {
    markEventRetryable: WebhookRepository["markEventFailed"];
    prepareEventForSettlement: WebhookRepository["markEventFailed"];
  };
  retryableRepository.markEventRetryable = async (provider, providerEventId, errorCode) => {
    retryableMarks += 1;
    const event = repository.events.get(`${provider}:${providerEventId}`);
    assert.ok(event);
    (event as unknown as { status: string }).status = "RETRYABLE";
    event.errorCode = errorCode;
    return structuredClone(event);
  };
  retryableRepository.prepareEventForSettlement = async (provider, providerEventId) => {
    const event = repository.events.get(`${provider}:${providerEventId}`);
    assert.ok(event);
    (event as unknown as { status: string }).status = "RECEIVED";
    event.errorCode = null;
    return structuredClone(event);
  };
  repository.settlePaidOrder = async (args) => {
    settlementAttempts += 1;
    if (settlementAttempts === 1) {
      throw new BillingError(
        "BILLING_STORAGE_UNAVAILABLE",
        "Billing data is temporarily unavailable.",
        503,
      );
    }
    return originalSettle(args);
  };

  await assert.rejects(
    processPaymentWebhook("mock", rawBody, signed(rawBody), webhookDependencies(retryableRepository)),
    (error: unknown) => expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );
  assert.equal(retryableMarks, 1);
  assert.equal((repository.events.get("MOCK:mock-event-1") as unknown as { status: string }).status, "RETRYABLE");
  assert.equal(repository.grants, 0);

  const recovered = await processPaymentWebhook(
    "mock",
    rawBody,
    signed(rawBody),
    webhookDependencies(retryableRepository),
  );
  assert.equal(recovered.status, "PROCESSED");
  assert.equal(settlementAttempts, 2);
  assert.equal(repository.grants, 1);

  const changed = eventBody({ amountMinor: 2_000 });
  await assert.rejects(
    processPaymentWebhook("mock", changed, signed(changed), webhookDependencies(retryableRepository)),
    (error: unknown) => expectBillingError(error, "WEBHOOK_REPLAY_CONFLICT", 409),
  );
  assert.equal(repository.grants, 1);
});

test("a settlement failure logs FAILED when failure marking observes a PROCESSING race", async () => {
  const repository = new MemoryWebhookRepository();
  repository.simulateProcessingRace = true;
  repository.settlePaidOrder = async () => {
    throw new Error("database password=do-not-log");
  };
  const logs: string[] = [];
  const rawBody = eventBody();

  await assert.rejects(
    () =>
      processPaymentWebhook("mock", rawBody, signed(rawBody), {
        ...webhookDependencies(repository),
        logger: createBillingSecurityLogger((line) => logs.push(line)),
      }),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );

  assert.equal(repository.events.get("MOCK:mock-event-1")?.status, "PROCESSING");
  assert.equal(logs.length, 1);
  assert.equal(
    JSON.parse(logs[0].slice("billing_security_event ".length)).status,
    "FAILED",
  );
});

test("webhook failures preserve safe errors when the security log sink throws", async () => {
  const throwingLogger = createBillingSecurityLogger(() => {
    throw new Error("log sink unavailable");
  });

  const invalidSignatureRepository = new MemoryWebhookRepository();
  const invalidSignatureBody = eventBody();
  await assert.rejects(
    () =>
      processPaymentWebhook("mock", invalidSignatureBody, {}, {
        ...webhookDependencies(invalidSignatureRepository),
        logger: throwingLogger,
      }),
    (error: unknown) =>
      expectBillingError(error, "INVALID_WEBHOOK_SIGNATURE", 401),
  );

  const parseRepository = new MemoryWebhookRepository();
  const malformedBody = "not-json";
  await assert.rejects(
    () =>
      processPaymentWebhook("mock", malformedBody, signed(malformedBody), {
        ...webhookDependencies(parseRepository),
        logger: throwingLogger,
      }),
    (error: unknown) => expectBillingError(error, "INVALID_WEBHOOK", 400),
  );

  const settlementRepository = new MemoryWebhookRepository();
  settlementRepository.settlePaidOrder = async () => {
    throw new Error("database password=do-not-log");
  };
  const settlementBody = eventBody();
  await assert.rejects(
    () =>
      processPaymentWebhook("mock", settlementBody, signed(settlementBody), {
        ...webhookDependencies(settlementRepository),
        logger: throwingLogger,
      }),
    (error: unknown) =>
      expectBillingError(error, "BILLING_STORAGE_UNAVAILABLE", 503),
  );
});

test("webhook logs use fixed error codes instead of dependency BillingError codes", async () => {
  const maliciousCode = "provider-secret\u0085not-for-log";
  const parseLogs: string[] = [];
  const parseRepository = new MemoryWebhookRepository();
  const parseProvider = mockProvider();
  parseProvider.parseWebhook = async () => {
    throw new BillingError(maliciousCode, "Provider parse failure.", 400);
  };
  const rawBody = eventBody();

  await assert.rejects(
    () =>
      processPaymentWebhook("mock", rawBody, signed(rawBody), {
        ...webhookDependencies(parseRepository, parseProvider),
        logger: createBillingSecurityLogger((line) => parseLogs.push(line)),
      }),
    (error: unknown) => expectBillingError(error, maliciousCode, 400),
  );
  assert.equal(parseLogs.length, 1);
  const parseRecord = parseLogs[0];
  assert.equal(parseRecord.includes(maliciousCode), false);
  assert.deepEqual(
    JSON.parse(parseRecord.slice("billing_security_event ".length)).errorCode,
    "WEBHOOK_PARSE_REJECTED",
  );

  const settlementLogs: string[] = [];
  const settlementRepository = new MemoryWebhookRepository();
  settlementRepository.settlePaidOrder = async () => {
    throw new BillingError(maliciousCode, "Provider settlement failure.", 400);
  };
  await assert.rejects(
    () =>
      processPaymentWebhook("mock", rawBody, signed(rawBody), {
        ...webhookDependencies(settlementRepository),
        logger: createBillingSecurityLogger((line) => settlementLogs.push(line)),
      }),
    (error: unknown) => expectBillingError(error, maliciousCode, 400),
  );
  assert.equal(settlementLogs.length, 1);
  const settlementRecord = settlementLogs[0];
  assert.equal(settlementRecord.includes(maliciousCode), false);
  assert.deepEqual(
    JSON.parse(settlementRecord.slice("billing_security_event ".length)).errorCode,
    "WEBHOOK_SETTLEMENT_FAILED",
  );
});

test("an identical callback is idempotent while a reused event ID with different payload is rejected", async () => {
  const repository = new MemoryWebhookRepository();
  const rawBody = eventBody();

  const first = await processPaymentWebhook(
    "mock",
    rawBody,
    signed(rawBody),
    webhookDependencies(repository),
  );
  const repeated = await processPaymentWebhook(
    "mock",
    rawBody,
    signed(rawBody),
    webhookDependencies(repository),
  );

  assert.equal(first.status, "PROCESSED");
  assert.equal(repeated.status, "ALREADY_PROCESSED");
  assert.equal(repository.grants, 1);

  const changed = eventBody({ amountMinor: 2_000 });
  await assert.rejects(
    () =>
      processPaymentWebhook(
        "mock",
        changed,
        signed(changed),
        webhookDependencies(repository),
      ),
    (error: unknown) =>
      expectBillingError(error, "WEBHOOK_REPLAY_CONFLICT", 409),
  );
  assert.equal(repository.grants, 1);
  assert.equal(repository.events.get("MOCK:mock-event-1")?.status, "PROCESSED");
});

test("amount, order, state, and expiration failures remain audited without settlement", async () => {
  for (const [rawBody, repository, code] of [
    [eventBody({ amountMinor: 1 }), new MemoryWebhookRepository(), "PAYMENT_AMOUNT_MISMATCH"],
    [eventBody({ orderNumber: "missing-order" }), new MemoryWebhookRepository(), "ORDER_NUMBER_MISMATCH"],
    [eventBody(), new MemoryWebhookRepository(settlementOrder({ status: "PAID" })), "ORDER_NOT_PAYABLE"],
    [
      eventBody({ occurredAt: "2026-07-22T03:30:00.000Z" }),
      new MemoryWebhookRepository(),
      "ORDER_EXPIRED",
    ],
  ] as const) {
    await assert.rejects(
      () =>
        processPaymentWebhook(
          "mock",
          rawBody,
          signed(rawBody),
          webhookDependencies(repository),
        ),
      (error: unknown) => error instanceof BillingError && error.code === code,
    );
    const stored = repository.events.get("MOCK:mock-event-1");
    assert.equal(stored?.status, "FAILED");
    assert.equal(stored?.errorCode, code);
    assert.equal(repository.grants, 0);
  }

  const invalidCurrency = eventBody({ currency: "USD" });
  const currencyRepository = new MemoryWebhookRepository();
  await assert.rejects(
    () =>
      processPaymentWebhook(
        "mock",
        invalidCurrency,
        signed(invalidCurrency),
        webhookDependencies(currencyRepository),
      ),
    (error: unknown) => expectBillingError(error, "INVALID_WEBHOOK", 400),
  );
  const rejected = [...currencyRepository.events.values()][0];
  assert.equal(rejected.status, "FAILED");
  assert.equal(rejected.currency, null);
});

test("a conditional FAILED update never overwrites a concurrently PROCESSED event", async () => {
  const repository = new MemoryWebhookRepository();
  repository.simulateProcessedRace = true;
  const rawBody = eventBody({ amountMinor: 1 });

  const result = await processPaymentWebhook(
    "mock",
    rawBody,
    signed(rawBody),
    webhookDependencies(repository),
  );

  assert.equal(result.status, "ALREADY_PROCESSED");
  assert.equal(repository.events.get("MOCK:mock-event-1")?.status, "PROCESSED");
});

test("the webhook route preserves exact bytes and rejects providers outside server mode before reading", async () => {
  const rawBody = '{ "spaced": true }\n';
  let capturedBody = "";
  let capturedHeaders: Readonly<Record<string, string | undefined>> = {};
  const handler = createPaymentWebhookPostHandler({
    getConfig: () => config,
    processWebhook: async (_provider, body, headers) => {
      capturedBody = body;
      capturedHeaders = headers;
      return {
        status: "PROCESSED",
        eventStatus: "PROCESSED",
        eventId: "event-1",
        orderId: "order-1",
      };
    },
  });
  const response = await handler(
    new Request("http://localhost/api/billing/webhooks/mock", {
      method: "POST",
      headers: { "x-mock-signature": "safe-for-test" },
      body: rawBody,
    }),
    { params: Promise.resolve({ provider: "mock" }) },
  );

  assert.equal(response.status, 200);
  assert.equal(capturedBody, rawBody);
  assert.equal(capturedHeaders["x-mock-signature"], "safe-for-test");

  const mismatchedRequest = new Request(
    "http://localhost/api/billing/webhooks/alipay",
    {
      method: "POST",
      body: "{}",
    },
  );
  let mismatchedBodyRead = false;
  mismatchedRequest.text = async () => {
    mismatchedBodyRead = true;
    throw new Error("mismatched provider body must not be read");
  };
  const rejected = await handler(
    mismatchedRequest,
    { params: Promise.resolve({ provider: "alipay" }) },
  );
  assert.equal(rejected.status, 400);
  assert.equal(mismatchedBodyRead, false);
});

test("the webhook route continues verified settlement while new billing sales are disabled", async () => {
  let settlementAttempts = 0;
  const handler = createPaymentWebhookPostHandler({
    getConfig: () => ({ ...config, featureEnabled: false }),
    processWebhook: async (_provider, rawBody) => {
      assert.equal(rawBody, "settle-this-paid-callback");
      settlementAttempts += 1;
      return {
        status: "PROCESSED",
        eventStatus: "PROCESSED",
        eventId: "event-1",
        orderId: "order-1",
      };
    },
  });
  const request = new Request("http://localhost/api/billing/webhooks/mock", {
    method: "POST",
    body: "settle-this-paid-callback",
  });

  const response = await handler(request, {
    params: Promise.resolve({ provider: "mock" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    webhook: {
      status: "PROCESSED",
      eventStatus: "PROCESSED",
      eventId: "event-1",
      orderId: "order-1",
    },
  });
  assert.equal(settlementAttempts, 1);
});

test("webhook processing settles a verified paid callback while new billing sales are disabled", async () => {
  const repository = new MemoryWebhookRepository();
  const rawBody = eventBody();

  const result = await processPaymentWebhook("mock", rawBody, signed(rawBody), {
    repository,
    getConfig: () => ({ ...config, featureEnabled: false }),
    getProvider: () => mockProvider(),
  });

  assert.equal(result.status, "PROCESSED");
  assert.deepEqual(repository.operations, ["persist:RECEIVED", "settle"]);
  assert.equal(repository.settlementCalls, 1);
});

test("the webhook route rejects a declared body over 64 KiB before reading", async () => {
  let processed = 0;
  const handler = createPaymentWebhookPostHandler({
    getConfig: () => config,
    processWebhook: async () => {
      processed += 1;
      throw new Error("must not process an oversized webhook");
    },
  });
  const request = new Request("http://localhost/api/billing/webhooks/mock", {
    method: "POST",
    headers: { "content-length": "65537" },
    body: "not-read",
  });
  let bodyRead = false;
  request.text = async () => {
    bodyRead = true;
    throw new Error("oversized body must not be read");
  };

  const response = await handler(request, {
    params: Promise.resolve({ provider: "mock" }),
  });

  assert.equal(response.status, 413);
  assert.equal(bodyRead, false);
  assert.equal(processed, 0);
});

test("the webhook route streams and cancels bodies whose real size exceeds 64 KiB", async () => {
  for (const declaredLength of [undefined, "1"] as const) {
    let cancelled = false;
    let processed = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000).fill(97));
        controller.enqueue(new Uint8Array(30_000).fill(98));
        controller.close();
      },
    });
    const headers = new Headers();
    if (declaredLength) headers.set("content-length", declaredLength);
    const request = new Request(
      "http://localhost/api/billing/webhooks/mock",
      {
        method: "POST",
        headers,
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    const requestBody = request.body;
    assert.ok(requestBody);
    const getReader = requestBody.getReader.bind(requestBody);
    (requestBody as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }).getReader = () => {
      const reader = getReader();
      const cancel = reader.cancel.bind(reader);
      reader.cancel = async (reason?: unknown) => {
        cancelled = true;
        return cancel(reason);
      };
      return reader;
    };
    const handler = createPaymentWebhookPostHandler({
      getConfig: () => config,
      processWebhook: async () => {
        processed += 1;
        throw new Error("must not process an oversized webhook");
      },
    });

    const response = await handler(request, {
      params: Promise.resolve({ provider: "mock" }),
    });

    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
    assert.equal(processed, 0);
  }
});

test("Mock confirmation creates a stable signed callback and settles only through the webhook pipeline", async () => {
  const creatingProvider = mockProvider();
  const payment = await creatingProvider.createPayment({
    orderNumber: settlementOrder().orderNumber,
    amountMinor: 1_990,
    currency: "CNY",
    expiresAt: settlementOrder().expiresAt,
    idempotencyKey: `billing-payment:MOCK:${settlementOrder().orderNumber}`,
  });
  const webhookRepository = new MemoryWebhookRepository();
  const paymentOrder: PaymentOrderSnapshot = {
    id: "order-id-1",
    userId: "user-1",
    orderNumber: settlementOrder().orderNumber,
    provider: "MOCK",
    status: "PENDING",
    amountMinor: 1_990,
    currency: "CNY",
    expiresAt: settlementOrder().expiresAt,
  };
  const result = await confirmMockOrderPayment(
    { id: "user-1", email: "student@example.com", isAdmin: false },
    "order-id-1",
    payment.providerTransactionId,
    {
      paymentRepository: {
        findOwnedOrder: async (userId: string, orderId: string) =>
          userId === "user-1" && orderId === "order-id-1"
            ? paymentOrder
            : null,
        claimMockPaymentConfirmation: async () => ({
          providerTransactionId: payment.providerTransactionId,
          status: "PAID" as const,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          paymentToken: payment.paymentToken,
          expiresAt: payment.expiresAt,
          paidAt: now.toISOString(),
        }),
      } as unknown as PaymentServiceRepository,
      webhookRepository,
      getConfig: () => config,
      getProvider: () => creatingProvider,
      now: () => now,
    },
  );

  assert.equal(result.status, "PROCESSED");
  assert.deepEqual(webhookRepository.operations, ["persist:RECEIVED", "settle"]);
  assert.equal(webhookRepository.grants, 1);
  assert.equal(JSON.stringify(result).includes("signature"), false);
  assert.equal(JSON.stringify(result).includes("rawBody"), false);
});

test("Mock confirm route requires an authenticated admin or allowlisted owner and rejects PAID input", async () => {
  const user: BillingUser = {
    id: "user-1",
    email: "student@example.com",
    isAdmin: false,
  };
  let confirmations = 0;
  const handler = createMockConfirmPostHandler({
    requireActor: async () => user,
    getConfig: () => config,
    assertAccess: () => undefined,
    confirmPayment: async () => {
      confirmations += 1;
      return {
        status: "PROCESSED",
        eventStatus: "PROCESSED",
        eventId: "event-1",
        orderId: "order-id-1",
      };
    },
  });
  const response = await handler(
    new Request("http://localhost/api/billing/payments/mock/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId: "order-id-1",
        providerTransactionId: "mock-tx-1",
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(confirmations, 1);

  const forged = await handler(
    new Request("http://localhost/api/billing/payments/mock/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId: "order-id-1",
        providerTransactionId: "mock-tx-1",
        status: "PAID",
      }),
    }),
  );
  assert.equal(forged.status, 400);
  assert.equal(confirmations, 1);

  const forbidden = createMockConfirmPostHandler({
    requireActor: async () => ({ ...user, id: "not-allowlisted" }),
    getConfig: () => config,
    assertAccess: () => undefined,
    confirmPayment: async () => {
      throw new Error("must not run");
    },
  });
  const denied = await forbidden(
    new Request("http://localhost/api/billing/payments/mock/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId: "order-id-1",
        providerTransactionId: "mock-tx-1",
      }),
    }),
  );
  assert.equal(denied.status, 403);
});

test("Mock confirm route elevates an authenticated database administrator before production access checks", async () => {
  const adminIdentity = {
    id: "admin-user",
    email: "admin@example.com",
    isAdmin: true as const,
    role: "BILLING_ADMIN" as const,
  };
  const events: string[] = [];
  const handler = createMockConfirmPostHandler({
    requireActor: async () => {
      events.push("actor");
      return adminIdentity;
    },
    getConfig: () => ({ ...config, isProduction: true, testUserIds: [] }),
    assertAccess: (user) => {
      assert.equal(user.isAdmin, true);
      events.push("access");
    },
    confirmPayment: async (user) => {
      assert.equal(user.isAdmin, true);
      events.push("confirm");
      return {
        status: "PROCESSED",
        eventStatus: "PROCESSED",
        eventId: "event-1",
        orderId: "order-id-1",
      };
    },
  });

  const response = await handler(
    new Request("http://localhost/api/billing/payments/mock/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId: "order-id-1",
        providerTransactionId: "mock-tx-1",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(events, ["actor", "access", "confirm"]);
});
