export type PaymentMode = "mock" | "wechat" | "alipay";

export type BillingConfig = {
  featureEnabled: boolean;
  paymentMode: PaymentMode;
  testUserIds: string[];
  realPaymentPublicEnabled: boolean;
  legal: {
    operatorName: string;
    operatorCreditCode: string;
    contactEmail: string;
  };
  wechatConfigured: boolean;
  alipayConfigured: boolean;
  isProduction: boolean;
};

export type PaymentRuntimeContext = {
  userId?: string;
  isAdmin?: boolean;
};
