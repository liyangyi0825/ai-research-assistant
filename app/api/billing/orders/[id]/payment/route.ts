import { createOrderPaymentPostHandler } from "@/lib/billing/payments/service";

const handlePost = createOrderPaymentPostHandler();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handlePost(request, context);
}
