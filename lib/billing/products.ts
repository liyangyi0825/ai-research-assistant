import type { Json } from "./database.types";
import { BillingError } from "./errors";
import {
  billingRepository,
  type BillingProduct,
  type BillingProductType,
  type BillingRepository,
} from "./repositories";

export type PublicBillingProduct = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  productType: BillingProductType;
  priceMinor: number;
  currency: "CNY";
  durationDays: number | null;
  creditGrant: number;
  displayMetadata: Json;
};

function publicProduct(product: BillingProduct): PublicBillingProduct {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    productType: product.productType,
    priceMinor: product.priceMinor,
    currency: product.currency,
    durationDays: product.durationDays,
    creditGrant: product.creditGrant,
    displayMetadata: structuredClone(product.displayMetadata),
  };
}

export async function listPublicProducts(
  repository: BillingRepository = billingRepository,
): Promise<PublicBillingProduct[]> {
  try {
    const products = await repository.listActiveProducts();
    return products.filter((product) => product.isActive).map(publicProduct);
  } catch (error) {
    if (error instanceof BillingError) {
      throw error;
    }

    throw new BillingError(
      "BILLING_STORAGE_UNAVAILABLE",
      "Billing data is temporarily unavailable.",
      503,
    );
  }
}

export type ListPublicProductsHandlerDependencies = {
  listProducts: () => Promise<PublicBillingProduct[]>;
};

function errorResponse(error: unknown): Response {
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

export function createListPublicProductsHandler(
  dependencies: ListPublicProductsHandlerDependencies = {
    listProducts: listPublicProducts,
  },
): () => Promise<Response> {
  return async function listProductsHandler() {
    try {
      const products = await dependencies.listProducts();
      return Response.json({ products });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
