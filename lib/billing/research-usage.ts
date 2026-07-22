import { EntitlementService } from "./entitlements";
import { BillingError } from "./errors";
import {
  UsageQuotaService,
  normalizeUsageReservation,
  type UsageReservationInput,
  type UsageRpcResult,
} from "./usage-quota";

export type ResearchUsageInput = UsageReservationInput;

export type ResearchEntitlementAuthorizer = {
  requireEntitlement(userId: string, featureKey: string): Promise<unknown>;
};

export type ResearchUsageReservationService = {
  reserve(input: UsageReservationInput): Promise<UsageRpcResult>;
  finalize(userId: string, taskKey: string): Promise<UsageRpcResult>;
  release(userId: string, taskKey: string): Promise<UsageRpcResult>;
};

export type ResearchTaskFailure = {
  readonly researchUsageOutcome: "FAILED";
  readonly error: unknown;
};

export function researchTaskFailed(error: unknown): ResearchTaskFailure {
  return { researchUsageOutcome: "FAILED", error };
}

type ResearchUsageDependencies = {
  entitlements?: ResearchEntitlementAuthorizer;
  usage?: ResearchUsageReservationService;
};

function isTaskFailure(value: unknown): value is ResearchTaskFailure {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).researchUsageOutcome === "FAILED"
  );
}

function taskFailureReason(value: ResearchTaskFailure): unknown {
  return value.error instanceof Error
    ? value.error
    : new BillingError(
        "RESEARCH_TASK_FAILED",
        "The research task failed before completion.",
        502,
      );
}

function replayError(status: UsageRpcResult["status"]): BillingError {
  if (status === "RESERVED") {
    return new BillingError(
      "RESEARCH_TASK_IN_PROGRESS",
      "This research task is already in progress.",
      409,
    );
  }
  if (status === "FINALIZED") {
    return new BillingError(
      "RESEARCH_TASK_ALREADY_COMPLETED",
      "This research task has already completed.",
      409,
    );
  }
  return new BillingError(
    "RESEARCH_TASK_ALREADY_FAILED",
    "This research task was already released after a failure.",
    409,
  );
}

async function releaseThenThrow(
  usage: ResearchUsageReservationService,
  input: ResearchUsageInput,
  error: unknown,
): Promise<never> {
  await usage.release(input.userId, input.taskKey);
  throw error;
}

function settleStream<T>(
  source: ReadableStream<T>,
  finalize: () => Promise<void>,
  release: () => Promise<void>,
): ReadableStream<T> {
  const reader = source.getReader();
  let settled = false;

  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (!settled) {
            settled = true;
            await finalize();
          }
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (!settled) {
          settled = true;
          try {
            await release();
          } catch (releaseError) {
            controller.error(releaseError);
            return;
          }
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        if (!settled) {
          settled = true;
          await release();
        }
      }
    },
  });
}

export class ResearchUsageService {
  private readonly entitlements: ResearchEntitlementAuthorizer;
  private readonly usage: ResearchUsageReservationService;

  constructor(dependencies: ResearchUsageDependencies = {}) {
    this.entitlements = dependencies.entitlements ?? new EntitlementService();
    this.usage = dependencies.usage ?? new UsageQuotaService();
  }

  async run<T>(
    rawInput: ResearchUsageInput,
    task: () => T | Promise<T | ResearchTaskFailure>,
  ): Promise<T> {
    const input = normalizeUsageReservation(rawInput);
    await this.entitlements.requireEntitlement(input.userId, input.featureKey);
    const reservation = await this.usage.reserve(input);
    if (reservation.idempotent || reservation.status !== "RESERVED") {
      throw replayError(reservation.status);
    }

    let result: T | ResearchTaskFailure;
    try {
      result = await task();
    } catch (error) {
      return releaseThenThrow(this.usage, input, error);
    }

    if (isTaskFailure(result)) {
      return releaseThenThrow(this.usage, input, taskFailureReason(result));
    }

    if (result instanceof Response) {
      if (!result.ok) {
        await this.usage.release(input.userId, input.taskKey);
        return result as T;
      }
      if (result.body) {
        const body = settleStream(
          result.body,
          async () => {
            await this.usage.finalize(input.userId, input.taskKey);
          },
          async () => {
            await this.usage.release(input.userId, input.taskKey);
          },
        );
        return new Response(body, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers,
        }) as T;
      }
    }

    if (result instanceof ReadableStream) {
      return settleStream(
        result,
        async () => {
          await this.usage.finalize(input.userId, input.taskKey);
        },
        async () => {
          await this.usage.release(input.userId, input.taskKey);
        },
      ) as T;
    }

    await this.usage.finalize(input.userId, input.taskKey);
    return result;
  }
}
