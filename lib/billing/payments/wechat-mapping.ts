import { BillingError } from "../errors";
import type { PaymentResult, PaymentStatus, PaymentWebhookEvent } from "./types";
import { parseStrictWechatJson } from "./wechat-json";

const MAX_EVENT_ID_LENGTH = 128;
const MAX_TRANSACTION_ID_LENGTH = 64;
const MAX_ORDER_NUMBER_LENGTH = 64;
const UNICODE_CATEGORY_C_PATTERN = /\p{C}/u;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function invalidWebhook(): BillingError {
  return new BillingError(
    "INVALID_WEBHOOK",
    "The WeChat Pay webhook payload is invalid.",
    400,
  );
}

function invalidResponse(): BillingError {
  return new BillingError(
    "PAYMENT_PROVIDER_INVALID_RESPONSE",
    "WeChat Pay returned an invalid response.",
    502,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    [...value].length > 0 &&
    [...value].length <= maximumLength &&
    Buffer.byteLength(value, "utf8") <= maximumLength * 4 &&
    value === value.trim() &&
    !UNICODE_CATEGORY_C_PATTERN.test(value)
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

function nativeStatus(value: unknown): PaymentStatus | null {
  switch (value) {
    case "SUCCESS":
      return "PAID";
    case "NOTPAY":
    case "USERPAYING":
      return "PENDING";
    case "CLOSED":
      return "CLOSED";
    case "PAYERROR":
      return "FAILED";
    case "REFUND":
      return "REFUNDED";
    default:
      return null;
  }
}

function validNativeCreateResponse(value: unknown): value is {
  code_url: string;
} {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.code_url === "string" &&
    value.code_url.length > 0 &&
    value.code_url === value.code_url.trim() &&
    value.code_url.length <= 2_048 &&
    !UNICODE_CATEGORY_C_PATTERN.test(value.code_url)
  );
}

export function parseWechatNativeCreateResponse(value: unknown): {
  paymentToken: string;
} {
  if (!validNativeCreateResponse(value)) throw invalidResponse();
  return { paymentToken: value.code_url };
}

export function parseWechatNativeTransaction(input: {
  response: unknown;
  expectedMchId: string;
  expectedAppId: string;
  orderNumber: string;
  providerTransactionId: string | null;
  expectedAmountMinor?: number;
  expectedCurrency?: "CNY";
  expectedExpiresAt?: string;
  paymentToken: string;
}): PaymentResult {
  if (!isRecord(input.response)) throw invalidResponse();
  const response = input.response;
  const amount = response.amount;
  const status = nativeStatus(response.trade_state);
  const expiresAt = normalizedRfc3339(response.time_expire);
  const expectedExpiresAt =
    input.expectedExpiresAt === undefined
      ? undefined
      : normalizedRfc3339(input.expectedExpiresAt);
  const paidAt =
    status === "PAID" ? normalizedRfc3339(response.success_time) : null;

  if (
    response.appid !== input.expectedAppId ||
    response.mchid !== input.expectedMchId ||
    response.out_trade_no !== input.orderNumber ||
    response.trade_type !== "NATIVE" ||
    !isSafeIdentifier(response.transaction_id, MAX_TRANSACTION_ID_LENGTH) ||
    (input.providerTransactionId !== null &&
      response.transaction_id !== input.providerTransactionId) ||
    status === null ||
    !isRecord(amount) ||
    typeof amount.total !== "number" ||
    !Number.isSafeInteger(amount.total) ||
    amount.total <= 0 ||
    amount.currency !== "CNY" ||
    !validOptionalAmountFields(amount) ||
    (input.expectedAmountMinor !== undefined &&
      amount.total !== input.expectedAmountMinor) ||
    (input.expectedCurrency !== undefined && amount.currency !== input.expectedCurrency) ||
    expiresAt === null ||
    (expectedExpiresAt !== undefined &&
      (expectedExpiresAt === null || expiresAt !== expectedExpiresAt)) ||
    paidAt === null && status === "PAID" ||
    !hasValidOptionalStringFields(response, [
      "trade_state_desc",
      "bank_type",
      "attach",
    ]) ||
    !validOptionalPayer(response) ||
    typeof input.paymentToken !== "string" ||
    input.paymentToken.length === 0
  ) {
    throw invalidResponse();
  }

  return {
    providerTransactionId: response.transaction_id,
    orderNumber: response.out_trade_no,
    status,
    amountMinor: amount.total,
    currency: "CNY",
    paymentToken: input.paymentToken,
    expiresAt,
    paidAt,
  };
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
    parsed = parseStrictWechatJson(input.decryptedResource);
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
