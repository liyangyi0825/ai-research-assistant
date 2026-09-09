import type {
  CreatePaymentInput,
  PaymentReferenceInput,
  PaymentResult,
  PaymentWebhookEvent,
  PaymentWebhookInput,
  RefundPaymentInput,
  RefundResult,
} from "./types";

export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<PaymentResult>;
  queryPayment(input: PaymentReferenceInput): Promise<PaymentResult>;
  closePayment(input: PaymentReferenceInput): Promise<PaymentResult>;
  refundPayment(input: RefundPaymentInput): Promise<RefundResult>;
  verifyWebhook(input: PaymentWebhookInput): Promise<boolean>;
  parseWebhook(input: PaymentWebhookInput): Promise<PaymentWebhookEvent>;
}
