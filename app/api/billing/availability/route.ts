import { createBillingAvailabilityGetHandler } from "@/lib/billing/user-pages";

const handleGet = createBillingAvailabilityGetHandler();

export async function GET(): Promise<Response> {
  return handleGet();
}
