import { createOrderPostHandler } from "@/lib/billing/orders";

const handlePost = createOrderPostHandler();

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
