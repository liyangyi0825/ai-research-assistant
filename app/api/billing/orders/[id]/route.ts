import { createGetUserOrderHandler } from "@/lib/billing/orders";

const handleGet = createGetUserOrderHandler();

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleGet(request, context);
}
