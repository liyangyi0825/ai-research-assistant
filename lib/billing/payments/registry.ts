import type { BillingConfig, PaymentMode } from "../config";
import { BillingError } from "../errors";
import { AlipayProvider } from "./alipay";
import { MockPaymentProvider } from "./mock";
import type { PaymentProvider } from "./provider";
import { WechatPayProvider } from "./wechat";
import { WechatHttpClient } from "./wechat-transport";

const mockPaymentProvider = new MockPaymentProvider();

export function getPaymentProvider(
  mode: "mock",
  config: BillingConfig,
): MockPaymentProvider;
export function getPaymentProvider(
  mode: "wechat",
  config: BillingConfig,
): WechatPayProvider;
export function getPaymentProvider(
  mode: "alipay",
  config: BillingConfig,
): AlipayProvider;
export function getPaymentProvider(
  mode: PaymentMode,
  config: BillingConfig,
): PaymentProvider;
export function getPaymentProvider(
  mode: PaymentMode,
  config: BillingConfig,
): PaymentProvider {
  if (mode !== config.paymentMode) {
    throw new BillingError(
      "PAYMENT_PROVIDER_MISMATCH",
      "Requested payment provider does not match the server payment mode.",
      400,
    );
  }

  switch (config.paymentMode) {
    case "mock":
      return mockPaymentProvider;
    case "wechat": {
      if (config.wechat === null) {
        throw new BillingError(
          "PROVIDER_NOT_CONFIGURED",
          "WeChat Pay is not configured.",
          503,
        );
      }
      const httpClient = new WechatHttpClient({ config: config.wechat });
      return new WechatPayProvider({ config: config.wechat, httpClient });
    }
    case "alipay":
      return new AlipayProvider(config.alipayConfigured);
  }
}
