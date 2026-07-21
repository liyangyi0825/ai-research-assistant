import { getSupabaseAdminClient } from "../supabase";
import { BillingError } from "./errors";

export const ORDER_RATE_LIMIT_MAX_REQUESTS = 5;
export const ORDER_RATE_LIMIT_WINDOW_MS = 60_000;

type ConsumeOrderRateLimitInput = {
  userId: string;
  action: "CREATE_ORDER";
  now: Date;
  limit: number;
  windowMs: number;
};

export type OrderRateLimitRepository = {
  consume(input: ConsumeOrderRateLimitInput): Promise<boolean>;
};

const supabaseOrderRateLimitRepository: OrderRateLimitRepository = {
  async consume({ userId, action, now, limit, windowMs }) {
    const database = getSupabaseAdminClient();

    if (!database) {
      throw new Error("Billing rate-limit storage is unavailable.");
    }

    const cutoff = new Date(now.getTime() - windowMs).toISOString();
    const { data, error } = await database
      .from("billing_rate_limits")
      .select("request_count")
      .eq("user_id", userId)
      .eq("action", action)
      .gt("window_started_at", cutoff);

    if (error) {
      throw error;
    }

    const used = data.reduce(
      (count, record) => count + Number(record.request_count),
      0,
    );

    if (used >= limit) {
      return false;
    }

    const { error: insertError } = await database
      .from("billing_rate_limits")
      .insert({
        user_id: userId,
        action,
        window_started_at: now.toISOString(),
        request_count: 1,
      });

    if (insertError) {
      throw insertError;
    }

    return true;
  },
};

export async function consumeOrderRateLimit(
  userId: string,
  now: Date = new Date(),
  repository: OrderRateLimitRepository = supabaseOrderRateLimitRepository,
): Promise<void> {
  try {
    const allowed = await repository.consume({
      userId,
      action: "CREATE_ORDER",
      now,
      limit: ORDER_RATE_LIMIT_MAX_REQUESTS,
      windowMs: ORDER_RATE_LIMIT_WINDOW_MS,
    });

    if (!allowed) {
      throw new BillingError(
        "ORDER_RATE_LIMITED",
        "Too many order creation requests. Please try again later.",
        429,
      );
    }
  } catch (error) {
    if (error instanceof BillingError) {
      throw error;
    }

    throw new BillingError(
      "ORDER_RATE_LIMIT_UNAVAILABLE",
      "Order creation is temporarily unavailable.",
      503,
    );
  }
}
