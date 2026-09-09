import {
  createOrderPaymentGetHandler,
  createOrderPaymentPostHandler,
} from "@/lib/billing/payments/service";

const handlePost = createOrderPaymentPostHandler();
const handleGet = createOrderPaymentGetHandler();

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleGet(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handlePost(request, context);
}
