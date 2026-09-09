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

type BillingRateLimitRpcResult = {
  data: { allowed: boolean } | null;
  error: { message: string } | null;
};

export type BillingRateLimitRpcClient = {
  rpc(
    functionName: "billing_consume_order_rate_limit",
    args: {
      p_user_id: string;
      p_now: string;
      p_window_seconds: number;
      p_limit: number;
    },
  ): PromiseLike<BillingRateLimitRpcResult>;
};

export function createOrderRateLimitRepository(
  client: BillingRateLimitRpcClient,
): OrderRateLimitRepository {
  return {
    async consume({ userId, now, limit, windowMs }) {
      const { data, error } = await client.rpc(
        "billing_consume_order_rate_limit",
        {
          p_user_id: userId,
          p_now: now.toISOString(),
          p_window_seconds: windowMs / 1_000,
          p_limit: limit,
        },
      );

      if (error) {
        throw new Error(error.message);
      }

      if (!data || typeof data.allowed !== "boolean") {
        throw new Error("Billing rate-limit RPC returned an invalid response.");
      }

      return data.allowed;
    },
  };
}

const supabaseOrderRateLimitRepository: OrderRateLimitRepository = {
  async consume(input) {
    const database = getSupabaseAdminClient();

    if (!database) {
      throw new Error("Billing rate-limit storage is unavailable.");
    }

    return createOrderRateLimitRepository(database).consume(input);
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
