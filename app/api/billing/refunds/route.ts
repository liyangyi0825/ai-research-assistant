import { createRefundPostHandler } from "@/lib/billing/user-pages";

const handlePost = createRefundPostHandler();

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
