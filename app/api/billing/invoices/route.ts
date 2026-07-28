import { createInvoicePostHandler } from "@/lib/billing/user-pages";

const handlePost = createInvoicePostHandler();

export async function POST(request: Request): Promise<Response> {
  return handlePost(request);
}
