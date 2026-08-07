import type { BillingProvider } from "./repositories";

export type BillingSecurityEventCode =
  | "WEBHOOK_SIGNATURE_REJECTED"
  | "WEBHOOK_PARSE_REJECTED"
  | "WEBHOOK_SETTLEMENT_FAILED"
  | "PAYMENT_CREATE_FAILED"
  | "PAYMENT_INTENT_PERSIST_FAILED";

export type BillingSecurityLogEvent = {
  eventCode: BillingSecurityEventCode;
  provider?: BillingProvider;
  orderNumber?: string;
  providerEventId?: string;
  errorCode?: string;
  status?: string;
};

export type BillingSecurityLogger = {
  warn(event: BillingSecurityLogEvent): void;
};

export type BillingSecurityLogSink = (line: string) => void;

const EVENT_CODES = new Set<BillingSecurityEventCode>([
  "WEBHOOK_SIGNATURE_REJECTED",
  "WEBHOOK_PARSE_REJECTED",
  "WEBHOOK_SETTLEMENT_FAILED",
  "PAYMENT_CREATE_FAILED",
  "PAYMENT_INTENT_PERSIST_FAILED",
]);

const MAX_VALUE_LENGTH = 160;

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .slice(0, MAX_VALUE_LENGTH);
  return normalized || undefined;
}

function safeProvider(value: unknown): BillingProvider | undefined {
  return value === "MOCK" || value === "WECHAT" || value === "ALIPAY"
    ? value
    : undefined;
}

export function createBillingSecurityLogger(
  sink: BillingSecurityLogSink,
): BillingSecurityLogger {
  return {
    warn(event) {
      try {
        if (!EVENT_CODES.has(event.eventCode)) return;

        const output: BillingSecurityLogEvent = { eventCode: event.eventCode };
        const provider = safeProvider(event.provider);
        const orderNumber = safeText(event.orderNumber);
        const providerEventId = safeText(event.providerEventId);
        const errorCode = safeText(event.errorCode);
        const status = safeText(event.status);

        if (provider) output.provider = provider;
        if (orderNumber) output.orderNumber = orderNumber;
        if (providerEventId) output.providerEventId = providerEventId;
        if (errorCode) output.errorCode = errorCode;
        if (status) output.status = status;

        sink(`billing_security_event ${JSON.stringify(output)}`);
      } catch {
        // Billing behavior must not depend on logging availability.
      }
    },
  };
}

export function warnBillingSecurity(
  logger: BillingSecurityLogger,
  event: BillingSecurityLogEvent,
): void {
  try {
    logger.warn(event);
  } catch {
    // An injected logger must not change billing behavior.
  }
}

export const billingSecurityLogger = createBillingSecurityLogger((line) => {
  process.stderr.write(`${line}\n`);
});
