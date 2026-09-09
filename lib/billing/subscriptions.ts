import { getSupabaseAdminClient } from "../supabase";
import { BillingError } from "./errors";

export type Subscription = {
  id: string;
  userId: string;
  planId: string;
  sourceOrderId: string;
  status: "ACTIVE";
  startsAt: string;
  endsAt: string;
};

export type SubscriptionRepository = {
  findCurrentSubscription(userId: string): Promise<Subscription | null>;
};

type SubscriptionDatabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

export type SubscriptionDatabaseQuery =
  PromiseLike<SubscriptionDatabaseResult> & {
    select(columns: string): SubscriptionDatabaseQuery;
    eq(column: string, value: unknown): SubscriptionDatabaseQuery;
    lte(column: string, value: unknown): SubscriptionDatabaseQuery;
    gt(column: string, value: unknown): SubscriptionDatabaseQuery;
    order(
      column: string,
      options?: { ascending?: boolean },
    ): SubscriptionDatabaseQuery;
    limit(count: number): SubscriptionDatabaseQuery;
    maybeSingle(): SubscriptionDatabaseQuery;
  };

export type SubscriptionDatabaseClient = {
  from(table: string): SubscriptionDatabaseQuery;
};

const SUBSCRIPTION_COLUMNS = [
  "id",
  "user_id",
  "plan_id",
  "source_order_id",
  "status",
  "starts_at",
  "ends_at",
].join(", ");

function storageError(): BillingError {
  return new BillingError(
    "BILLING_STORAGE_UNAVAILABLE",
    "Billing data is temporarily unavailable.",
    503,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw storageError();
  return value;
}

function timestamp(value: unknown): string {
  const result = requiredString(value);
  if (!Number.isFinite(Date.parse(result))) throw storageError();
  return result;
}

function mapSubscription(value: unknown): Subscription {
  const row = record(value);
  if (row.status !== "ACTIVE") throw storageError();
  const startsAt = timestamp(row.starts_at);
  const endsAt = timestamp(row.ends_at);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw storageError();

  return {
    id: requiredString(row.id),
    userId: requiredString(row.user_id),
    planId: requiredString(row.plan_id),
    sourceOrderId: requiredString(row.source_order_id),
    status: "ACTIVE",
    startsAt,
    endsAt,
  };
}

export function createSubscriptionRepository(
  client: SubscriptionDatabaseClient,
): SubscriptionRepository {
  return {
    async findCurrentSubscription(userId) {
      try {
        const result = await client
          .from("billing_subscriptions")
          .select(SUBSCRIPTION_COLUMNS)
          .eq("user_id", userId)
          .eq("status", "ACTIVE")
          .lte("starts_at", "now")
          .gt("ends_at", "now")
          .order("ends_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (result.error) throw storageError();
        return result.data === null ? null : mapSubscription(result.data);
      } catch (error) {
        if (error instanceof BillingError) throw error;
        throw storageError();
      }
    },
  };
}

function defaultRepository(): SubscriptionRepository {
  const database = getSupabaseAdminClient();
  if (!database) throw storageError();
  return createSubscriptionRepository(
    database as unknown as SubscriptionDatabaseClient,
  );
}

const supabaseSubscriptionRepository: SubscriptionRepository = {
  findCurrentSubscription(userId) {
    return defaultRepository().findCurrentSubscription(userId);
  },
};

export class SubscriptionService {
  constructor(
    private readonly repository: SubscriptionRepository =
      supabaseSubscriptionRepository,
  ) {}

  async getCurrentSubscription(userId: string): Promise<Subscription | null> {
    try {
      const subscription = await this.repository.findCurrentSubscription(userId);
      if (subscription && subscription.userId !== userId) throw storageError();
      return subscription;
    } catch (error) {
      if (error instanceof BillingError) throw error;
      throw storageError();
    }
  }

  async requireActiveSubscription(userId: string): Promise<Subscription> {
    const subscription = await this.getCurrentSubscription(userId);
    if (!subscription) {
      throw new BillingError(
        "SUBSCRIPTION_REQUIRED",
        "An active subscription is required.",
        403,
      );
    }
    return subscription;
  }
}
