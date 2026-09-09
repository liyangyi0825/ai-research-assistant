import assert from "node:assert/strict";
import test from "node:test";

import {
  createBillingSecurityLogger,
  type BillingSecurityLogEvent,
} from "../../lib/billing/security-logger";

test("the billing security logger emits one allowlisted JSON record", () => {
  const lines: string[] = [];
  const logger = createBillingSecurityLogger((line) => lines.push(line));

  logger.warn({
    eventCode: "WEBHOOK_SETTLEMENT_FAILED",
    provider: "MOCK",
    orderNumber: "BILL-00000000000000000000000000000001",
    providerEventId: "mock-event-1",
    errorCode: "BILLING_STORAGE_UNAVAILABLE",
    status: "FAILED",
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^billing_security_event /);
  const payload = JSON.parse(lines[0].slice("billing_security_event ".length));
  assert.deepEqual(payload, {
    eventCode: "WEBHOOK_SETTLEMENT_FAILED",
    provider: "MOCK",
    orderNumber: "BILL-00000000000000000000000000000001",
    providerEventId: "mock-event-1",
    errorCode: "BILLING_STORAGE_UNAVAILABLE",
    status: "FAILED",
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    "errorCode",
    "eventCode",
    "orderNumber",
    "provider",
    "providerEventId",
    "status",
  ]);
});

test("the billing security logger drops undeclared fields and safely normalizes text", () => {
  const lines: string[] = [];
  const logger = createBillingSecurityLogger((line) => lines.push(line));
  const rawBody = '{"email":"student@example.com","taxIdentifier":"tax-id"}';
  const signature = "sha256=private-signature";
  const privateKey = "private-key";
  const token = "provider-token";
  const rawError = new Error("database password=not-for-logs");

  logger.warn({
    eventCode: "PAYMENT_CREATE_FAILED",
    provider: "MOCK",
    orderNumber: `BILL\n\u0085${"x".repeat(200)}`,
    ...( {
      rawBody,
      signature,
      headers: { authorization: token },
      privateKey,
      token,
      email: "student@example.com",
      taxIdentifier: "tax-id",
      error: rawError,
      stack: rawError.stack,
    } as Record<string, unknown>),
  } as BillingSecurityLogEvent);

  assert.equal(lines.length, 1);
  const record = lines[0];
  const payload = JSON.parse(record.slice("billing_security_event ".length));
  assert.equal(payload.orderNumber.includes("\n"), false);
  assert.equal(payload.orderNumber.includes("\u0085"), false);
  assert.equal(payload.orderNumber.length, 160);
  for (const secret of [
    rawBody,
    signature,
    privateKey,
    token,
    "student@example.com",
    "tax-id",
    "database password=not-for-logs",
  ]) {
    assert.equal(record.includes(secret), false);
  }
  assert.deepEqual(Object.keys(payload).sort(), [
    "eventCode",
    "orderNumber",
    "provider",
  ]);
});

test("the billing security logger swallows a throwing sink", () => {
  const logger = createBillingSecurityLogger(() => {
    throw new Error("log sink unavailable");
  });

  assert.doesNotThrow(() => {
    logger.warn({
      eventCode: "PAYMENT_CREATE_FAILED",
      provider: "MOCK",
      errorCode: "PROVIDER_CREATE_FAILED",
      status: "FAILED",
    });
  });
});

const typeOnlyEvent: BillingSecurityLogEvent = {
  eventCode: "WEBHOOK_PARSE_REJECTED",
  provider: "MOCK",
};

void typeOnlyEvent;

type ForbiddenBillingSecurityLogKey =
  | "rawBody"
  | "signature"
  | "headers"
  | "privateKey"
  | "token"
  | "email"
  | "taxIdentifier"
  | "error"
  | "stack";
type AssertNever<T extends never> = T;
type ForbiddenKeysAreExcluded = AssertNever<
  Extract<keyof BillingSecurityLogEvent, ForbiddenBillingSecurityLogKey>
>;

void (null as unknown as ForbiddenKeysAreExcluded);
