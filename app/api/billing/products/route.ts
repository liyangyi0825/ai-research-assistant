import { createListPublicProductsHandler } from "@/lib/billing/products";

const handleGet = createListPublicProductsHandler();

export async function GET(): Promise<Response> {
  return handleGet();
}
