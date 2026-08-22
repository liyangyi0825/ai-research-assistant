import { createReconciliationGetHandler } from "./server";

export async function GET(request: Request) {
  return createReconciliationGetHandler()(request);
}
