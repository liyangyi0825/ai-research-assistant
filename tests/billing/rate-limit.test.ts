import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeOrderRateLimit,
  ORDER_RATE_LIMIT_MAX_REQUESTS,
  ORDER_RATE_LIMIT_WINDOW_MS,
  type OrderRateLimitRepository,
} from "../../lib/billing/rate-limit";
import { BillingError } from "../../lib/billing/errors";

class InMemoryOrderRateLimitRepository implements OrderRateLimitRepository {
  private readonly requests: Array<{ userId: string; occurredAt: number }> = [];

  async consume({
    userId,
    now,
    limit,
    windowMs,
  }: {
    userId: string;
    action: "CREATE_ORDER";
    now: Date;
    limit: number;
    windowMs: number;
  }): Promise<boolean> {
    const earliestAllowed = now.getTime() - windowMs;
    const used = this.requests.filter(
      (request) =>
        request.userId === userId && request.occurredAt > earliestAllowed,
    ).length;

    if (used >= limit) {
      return false;
    }

    this.requests.push({ userId, occurredAt: now.getTime() });
    return true;
  }
}

test("consumeOrderRateLimit rejects the request beyond the per-user sliding window", async () => {
  const repository = new InMemoryOrderRateLimitRepository();
  const now = new Date("2026-07-22T00:00:00.000Z");

  for (let request = 0; request < ORDER_RATE_LIMIT_MAX_REQUESTS; request += 1) {
    await consumeOrderRateLimit("user-1", now, repository);
  }

  await assert.rejects(
    () => consumeOrderRateLimit("user-1", now, repository),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "ORDER_RATE_LIMITED" &&
      error.status === 429,
  );
});

test("consumeOrderRateLimit permits a user again after the sliding window expires", async () => {
  const repository = new InMemoryOrderRateLimitRepository();
  const now = new Date("2026-07-22T00:00:00.000Z");

  for (let request = 0; request < ORDER_RATE_LIMIT_MAX_REQUESTS; request += 1) {
    await consumeOrderRateLimit("user-1", now, repository);
  }

  await assert.doesNotReject(() =>
    consumeOrderRateLimit(
      "user-1",
      new Date(now.getTime() + ORDER_RATE_LIMIT_WINDOW_MS + 1),
      repository,
    ),
  );
});

test("consumeOrderRateLimit fails closed when persistent storage is unavailable", async () => {
  const repository: OrderRateLimitRepository = {
    consume: async () => {
      throw new Error("database unavailable");
    },
  };

  await assert.rejects(
    () => consumeOrderRateLimit("user-1", new Date(), repository),
    (error: unknown) =>
      error instanceof BillingError &&
      error.code === "ORDER_RATE_LIMIT_UNAVAILABLE" &&
      error.status === 503,
  );
});
