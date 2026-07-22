import { BillingError } from "../errors";
import type { PaymentProvider } from "./provider";
import type {
  CreatePaymentInput,
  PaymentReferenceInput,
  PaymentResult,
  PaymentWebhookEvent,
  PaymentWebhookInput,
  RefundPaymentInput,
  RefundResult,
} from "./types";

export class WechatPayProvider implements PaymentProvider {
  constructor(private readonly configured: boolean) {}

  async createPayment(_input: CreatePaymentInput): Promise<PaymentResult> {
    void _input;
    return this.unavailable();
  }

  async queryPayment(_input: PaymentReferenceInput): Promise<PaymentResult> {
    void _input;
    return this.unavailable();
  }

  async closePayment(_input: PaymentReferenceInput): Promise<PaymentResult> {
    void _input;
    return this.unavailable();
  }

  async refundPayment(_input: RefundPaymentInput): Promise<RefundResult> {
    void _input;
    return this.unavailable();
  }

  async verifyWebhook(_input: PaymentWebhookInput): Promise<boolean> {
    void _input;
    return this.unavailable();
  }

  async parseWebhook(_input: PaymentWebhookInput): Promise<PaymentWebhookEvent> {
    void _input;
    return this.unavailable();
  }

  private unavailable(): never {
    if (!this.configured) {
      throw new BillingError(
        "PROVIDER_NOT_CONFIGURED",
        "WeChat Pay is not configured.",
        503,
      );
    }

    throw new BillingError(
      "NOT_IMPLEMENTED",
      "WeChat Pay is configured but not implemented.",
      501,
    );
  }
}
