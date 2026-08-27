import { randomBytes } from "node:crypto";

import {
  assertBillingAccess,
  requireBillingActor,
  requireBillingUser,
  type BillingActor,
  type BillingUser,
} from "./auth";
import {
  BILLING_AGREEMENT_VERSION,
  getBillingConfig,
  type BillingConfig,
  type PaymentMode,
} from "./config";
import { BillingError } from "./errors";
import { consumeOrderRateLimit } from "./rate-limit";
import {
  billingRepository,
  type BillingOrder,
  type BillingProvider,
  type BillingRepository,
} from "./repositories";

export const ORDER_EXPIRATION_MS = 30 * 60 * 1_000;

export type CreateOrderInput = {
  userId: string;
  productId: string;
  provider: "mock" | "wechat" | "alipay";
  acceptedAgreementVersion: string;
};

export type CreateOrderDependencies = {
  repository?: BillingRepository;
  now?: () => Date;
  createOrderNumber?: () => string;
  paymentMode?: PaymentMode;
};

function createOrderNumber(): string {
  return `BILL${randomBytes(14).toString("hex").toUpperCase()}`;
}

function normalizeProvider(value: unknown): BillingProvider {
  if (value === "mock" || value === "wechat" || value === "alipay") {
    return value.toUpperCase() as BillingProvider;
  }

  throw new BillingError(
    "INVALID_PROVIDER",
    "Payment provider must be mock, wechat, or alipay.",
    400,
  );
}

function requiredAgreementVersion(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BillingError(
      "AGREEMENT_REQUIRED",
      "A non-empty accepted agreement version is required.",
      400,
    );
  }

  const version = value.trim();
  if (version !== BILLING_AGREEMENT_VERSION) {
    throw new BillingError(
      "AGREEMENT_VERSION_MISMATCH",
      "The accepted billing agreement version is not current.",
      400,
    );
  }

  return version;
}

function assertProviderMatchesPaymentMode(
  provider: CreateOrderInput["provider"],
  paymentMode: PaymentMode,
): void {
  if (provider !== paymentMode) {
    throw new BillingError(
      "PAYMENT_PROVIDER_MISMATCH",
      "Requested payment provider does not match the server payment mode.",
      400,
    );
  }
}

function requiredFeatureKey(value: string): string {
  const featureKey = value.trim();

  if (!featureKey) {
    throw new BillingError(
      "BILLING_STORAGE_UNAVAILABLE",
      "Billing data is temporarily unavailable.",
      503,
    );
  }

  return featureKey;
}

function storageFailure(error: unknown): never {
  if (error instanceof BillingError) {
    throw error;
  }

  throw new BillingError(
    "BILLING_STORAGE_UNAVAILABLE",
    "Billing data is temporarily unavailable.",
    503,
  );
}

export async function createOrder(
  input: CreateOrderInput,
  dependencies: CreateOrderDependencies = {},
): Promise<BillingOrder> {
  const repository = dependencies.repository ?? billingRepository;
  const clock = dependencies.now ?? (() => new Date());
  const numberFactory = dependencies.createOrderNumber ?? createOrderNumber;
  const provider = normalizeProvider(input.provider);
  const paymentMode =
    dependencies.paymentMode ?? getBillingConfig().paymentMode;
  assertProviderMatchesPaymentMode(input.provider, paymentMode);
  const acceptedAgreementVersion = requiredAgreementVersion(
    input.acceptedAgreementVersion,
  );
  let product;

  try {
    product = await repository.findActiveProduct(input.productId);
  } catch (error) {
    storageFailure(error);
  }

  if (!product?.isActive) {
    throw new BillingError(
      "PRODUCT_NOT_AVAILABLE",
      "The selected billing product is not available.",
      404,
    );
  }

  const createdAt = clock();

  try {
    return await repository.insertOrder({
      orderNumber: numberFactory(),
      userId: input.userId,
      productId: product.id,
      provider,
      amountMinor: product.priceMinor,
      currency: product.currency,
      snapshotProductName: product.name,
      snapshotProductType: product.productType,
      snapshotPlanId: product.planId,
      snapshotDurationDays: product.durationDays,
      snapshotCreditGrant: product.creditGrant,
      snapshotEntitlementVersion: product.entitlementVersion,
      snapshotEntitlements: product.entitlements.map((entitlement) => ({
        feature_key: requiredFeatureKey(entitlement.featureKey),
        entitlement_version: entitlement.entitlementVersion,
        periodic_limit: entitlement.periodicLimit,
        credit_grant: entitlement.creditGrant,
        configuration: structuredClone(entitlement.configuration),
      })),
      snapshotDetails: {
        sku: product.sku,
        displayMetadata: structuredClone(product.displayMetadata),
      },
      acceptedAgreementVersion,
      expiresAt: new Date(
        createdAt.getTime() + ORDER_EXPIRATION_MS,
      ).toISOString(),
    });
  } catch (error) {
    storageFailure(error);
  }
}

export async function getUserOrder(
  userId: string,
  orderId: string,
  repository: BillingRepository = billingRepository,
): Promise<BillingOrder> {
  let order: BillingOrder | null;

  try {
    order = await repository.findUserOrder(userId, orderId);
  } catch (error) {
    storageFailure(error);
  }

  if (!order || order.userId !== userId) {
    throw new BillingError(
      "ORDER_NOT_FOUND",
      "The billing order was not found.",
      404,
    );
  }

  return order;
}

export type CreateOrderPostHandlerDependencies = {
  requireActor: () => Promise<BillingActor>;
  getConfig: () => BillingConfig;
  assertAccess: (user: BillingUser, config: BillingConfig) => void;
  consumeRateLimit: (userId: string) => Promise<void>;
  createOrder: (
    input: CreateOrderInput,
    dependencies: Pick<CreateOrderDependencies, "paymentMode">,
  ) => Promise<BillingOrder>;
};

export type GetUserOrderHandlerDependencies = {
  requireUser: () => Promise<BillingUser>;
  getOrder: (userId: string, orderId: string) => Promise<BillingOrder>;
};

type OrderRouteContext = {
  params: Promise<{ id: string }>;
};

const CREATE_ORDER_BODY_KEYS = new Set([
  "productId",
  "provider",
  "acceptedAgreementVersion",
]);

function billingErrorResponse(error: unknown): Response {
  const billingError =
    error instanceof BillingError
      ? error
      : new BillingError(
          "INTERNAL_BILLING_ERROR",
          "Billing request failed.",
          500,
        );

  return Response.json(
    {
      error: {
        code: billingError.code,
        message: billingError.message,
      },
    },
    { status: billingError.status },
  );
}

function invalidOrderBody(): BillingError {
  return new BillingError(
    "INVALID_ORDER_BODY",
    "Order body contains unsupported or invalid fields.",
    400,
  );
}

async function parseCreateOrderBody(request: Request): Promise<{
  productId: string;
  provider: CreateOrderInput["provider"];
  acceptedAgreementVersion: string;
}> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw invalidOrderBody();
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidOrderBody();
  }

  const values = body as Record<string, unknown>;
  if (Object.keys(values).some((key) => !CREATE_ORDER_BODY_KEYS.has(key))) {
    throw invalidOrderBody();
  }

  if (
    typeof values.productId !== "string" ||
    !values.productId.trim() ||
    (values.provider !== "mock" &&
      values.provider !== "wechat" &&
      values.provider !== "alipay") ||
    typeof values.acceptedAgreementVersion !== "string" ||
    !values.acceptedAgreementVersion.trim()
  ) {
    throw invalidOrderBody();
  }

  return {
    productId: values.productId.trim(),
    provider: values.provider,
    acceptedAgreementVersion: requiredAgreementVersion(
      values.acceptedAgreementVersion,
    ),
  };
}

export function createOrderPostHandler(
  dependencies: CreateOrderPostHandlerDependencies = {
    requireActor: requireBillingActor,
    getConfig: getBillingConfig,
    assertAccess: assertBillingAccess,
    consumeRateLimit: consumeOrderRateLimit,
    createOrder,
  },
): (request: Request) => Promise<Response> {
  return async function postOrderHandler(request: Request) {
    try {
      const user = await dependencies.requireActor();
      const config = dependencies.getConfig();
      dependencies.assertAccess(user, config);
      await dependencies.consumeRateLimit(user.id);
      const body = await parseCreateOrderBody(request);
      assertProviderMatchesPaymentMode(body.provider, config.paymentMode);
      const order = await dependencies.createOrder(
        {
          userId: user.id,
          ...body,
        },
        {
          paymentMode: config.paymentMode,
        },
      );

      return Response.json({ order }, { status: 201 });
    } catch (error) {
      return billingErrorResponse(error);
    }
  };
}

export function createGetUserOrderHandler(
  dependencies: GetUserOrderHandlerDependencies = {
    requireUser: requireBillingUser,
    getOrder: getUserOrder,
  },
): (request: Request, context: OrderRouteContext) => Promise<Response> {
  return async function getOrderHandler(
    _request: Request,
    context: OrderRouteContext,
  ) {
    try {
      const user = await dependencies.requireUser();
      const { id } = await context.params;
      const order = await dependencies.getOrder(user.id, id);
      return Response.json({ order });
    } catch (error) {
      return billingErrorResponse(error);
    }
  };
}
