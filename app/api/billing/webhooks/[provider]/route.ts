import { createPaymentWebhookPostHandler } from "@/lib/billing/payments/webhooks";

const handlePost = createPaymentWebhookPostHandler();

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return handlePost(request, context);
}
