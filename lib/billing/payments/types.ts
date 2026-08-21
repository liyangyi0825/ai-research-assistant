export type PaymentCurrency = "CNY";

export type PaymentStatus =
  | "PENDING"
  | "PAID"
  | "REQUIRES_NEW_PAYMENT"
  | "FAILED"
  | "CLOSED"
  | "REFUNDED";

export type CreatePaymentInput = {
  orderNumber: string;
  description: string;
  amountMinor: number;
  currency: PaymentCurrency;
  expiresAt: string;
  idempotencyKey: string;
};

export type PaymentReferenceInput = {
  orderNumber: string;
  providerTransactionId: string | null;
  amountMinor?: number;
  currency?: PaymentCurrency;
  expiresAt?: string;
  paymentToken?: string | null;
};

export type PaymentResult = {
  providerTransactionId: string | null;
  orderNumber: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: PaymentCurrency;
  paymentToken: string | null;
  expiresAt: string;
  paidAt: string | null;
};

export type RefundPaymentInput = {
  providerTransactionId: string;
  amountMinor: number;
  currency: PaymentCurrency;
  idempotencyKey: string;
};

export type RefundResult = {
  providerRefundId: string;
  providerTransactionId: string;
  status: "SUCCEEDED";
  refundedAmountMinor: number;
  currency: PaymentCurrency;
};

export type PaymentWebhookInput = {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
};

export type PaymentWebhookEvent = {
  eventId: string;
  eventType: "PAYMENT.PAID";
  providerTransactionId: string;
  orderNumber: string;
  amountMinor: number;
  currency: PaymentCurrency;
  occurredAt: string;
};
