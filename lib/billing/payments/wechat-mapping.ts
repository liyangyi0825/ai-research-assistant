import { BillingError } from "../errors";
import type { PaymentWebhookEvent } from "./types";

const MAX_EVENT_ID_LENGTH = 128;
const MAX_TRANSACTION_ID_LENGTH = 64;
const MAX_ORDER_NUMBER_LENGTH = 64;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function invalidWebhook(): BillingError {
  return new BillingError(
    "INVALID_WEBHOOK",
    "The WeChat Pay webhook payload is invalid.",
    400,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !ASCII_CONTROL_PATTERN.test(value)
  );
}

function hasValidOptionalStringFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) => !(field in value) || typeof value[field] === "string",
  );
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function normalizedRfc3339(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const timezone = match[8];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (timezone !== "Z") {
    const offsetHour = Number(timezone.slice(1, 3));
    const offsetMinute = Number(timezone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function validOptionalPayer(value: Record<string, unknown>): boolean {
  if (!("payer" in value)) return true;
  if (!isRecord(value.payer)) return false;
  return (
    !("openid" in value.payer) ||
    isSafeIdentifier(value.payer.openid, 128)
  );
}

function validOptionalAmountFields(amount: Record<string, unknown>): boolean {
  if (
    "payer_total" in amount &&
    (!Number.isSafeInteger(amount.payer_total) ||
      (amount.payer_total as number) < 0)
  ) {
    return false;
  }
  if (
    "payer_currency" in amount &&
    amount.payer_currency !== "CNY"
  ) {
    return false;
  }
  return true;
}

export function parseWechatPaidNotification(input: {
  decryptedResource: string;
  expectedMchId: string;
  expectedAppId: string;
  eventId: string;
  eventType: string;
}): PaymentWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.decryptedResource);
  } catch {
    throw invalidWebhook();
  }
  if (!isRecord(parsed)) throw invalidWebhook();

  const amount = parsed.amount;
  const occurredAt = normalizedRfc3339(parsed.success_time);
  if (
    !isSafeIdentifier(input.eventId, MAX_EVENT_ID_LENGTH) ||
    input.eventType !== "TRANSACTION.SUCCESS" ||
    parsed.trade_state !== "SUCCESS" ||
    parsed.mchid !== input.expectedMchId ||
    parsed.appid !== input.expectedAppId ||
    !isSafeIdentifier(parsed.transaction_id, MAX_TRANSACTION_ID_LENGTH) ||
    !isSafeIdentifier(parsed.out_trade_no, MAX_ORDER_NUMBER_LENGTH) ||
    !isRecord(amount) ||
    typeof amount.total !== "number" ||
    !Number.isSafeInteger(amount.total) ||
    amount.total <= 0 ||
    amount.currency !== "CNY" ||
    !validOptionalAmountFields(amount) ||
    occurredAt === null ||
    !hasValidOptionalStringFields(parsed, [
      "trade_type",
      "trade_state_desc",
      "bank_type",
      "attach",
    ]) ||
    !validOptionalPayer(parsed)
  ) {
    throw invalidWebhook();
  }

  return {
    eventId: input.eventId,
    eventType: "PAYMENT.PAID",
    providerTransactionId: parsed.transaction_id,
    orderNumber: parsed.out_trade_no,
    amountMinor: amount.total,
    currency: "CNY",
    occurredAt,
  };
}
