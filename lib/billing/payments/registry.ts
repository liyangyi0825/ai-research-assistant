import { getServerWechatPayConfig } from "../config";
import type { BillingConfig, PaymentMode } from "../config-types";
import { BillingError } from "../errors";
import { AlipayProvider } from "./alipay";
import { MockPaymentProvider } from "./mock";
import type { PaymentProvider } from "./provider";
import { WechatPayProvider } from "./wechat";
import {
  WechatHttpClient,
  type WechatFetch,
} from "./wechat-transport";

const mockPaymentProvider = new MockPaymentProvider();

export type PaymentProviderRegistryDependencies = {
  wechatFetch?: WechatFetch;
  now?: () => Date;
  nonce?: () => string;
};

export function getPaymentProvider(
  mode: "mock",
  config: BillingConfig,
  dependencies?: PaymentProviderRegistryDependencies,
): MockPaymentProvider;
export function getPaymentProvider(
  mode: "wechat",
  config: BillingConfig,
  dependencies?: PaymentProviderRegistryDependencies,
): WechatPayProvider;
export function getPaymentProvider(
  mode: "alipay",
  config: BillingConfig,
  dependencies?: PaymentProviderRegistryDependencies,
): AlipayProvider;
export function getPaymentProvider(
  mode: PaymentMode,
  config: BillingConfig,
  dependencies?: PaymentProviderRegistryDependencies,
): PaymentProvider;
export function getPaymentProvider(
  mode: PaymentMode,
  config: BillingConfig,
  dependencies: PaymentProviderRegistryDependencies = {},
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
      const wechat = getServerWechatPayConfig(config);
      if (wechat === null) {
        throw new BillingError(
          "PROVIDER_NOT_CONFIGURED",
          "WeChat Pay is not configured.",
          503,
        );
      }
      const httpClient = new WechatHttpClient({
        config: wechat,
        fetchImpl: dependencies.wechatFetch,
        now: dependencies.now,
        nonce: dependencies.nonce,
      });
      return new WechatPayProvider({
        config: wechat,
        httpClient,
        now: dependencies.now,
      });
    }
    case "alipay":
      return new AlipayProvider(config.alipayConfigured);
  }
}
