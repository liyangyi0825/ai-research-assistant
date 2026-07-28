import { createBillingSummaryGetHandler } from "@/lib/billing/user-pages";

const handleGet = createBillingSummaryGetHandler();

export async function GET(): Promise<Response> {
  return handleGet();
}
