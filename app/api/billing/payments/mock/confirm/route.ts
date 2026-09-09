import { createMockConfirmPostHandler } from "@/lib/billing/payments/webhooks";

const handlePost = createMockConfirmPostHandler();

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
