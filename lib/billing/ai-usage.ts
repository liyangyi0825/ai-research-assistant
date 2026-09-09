import { randomUUID } from "node:crypto";

import type { UsageActionType } from "../limits";
import { checkUsageLimit, insertUsageRecord } from "../supabase";
import { requireBillingUser, type BillingUser } from "./auth";
import { getBillingConfig, type BillingConfig } from "./config";
import { BillingError } from "./errors";
import {
  FeatureUsageCostService,
  type ResolvedFeatureUsageCost,
} from "./feature-usage-costs";
import {
  ResearchUsageService,
  type ResearchUsageInput,
  type ResearchUsageRunOptions,
} from "./research-usage";
import {
  UsageQuotaService,
  type ContinuationClaimResult,
  type ContinuationRootInput,
  type ContinuationSettlementInput,
  type ContinuationStageInput,
  type ContinuationStageProvision,
} from "./usage-quota";

export type AiTokenUsage = {
  tokensInput: number;
  tokensOutput: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
};

export type AiUsageContext = {
  readonly userId: string | null;
  setTokenUsage(input: AiTokenUsage): void;
  markFailed(error: unknown): void;
};

type LegacyUsageResult = {
  allowed: boolean;
  used: number;
  limit: number;
  userId: string | null;
};

type LegacyUsageRecord = AiTokenUsage & {
  userId: string;
  actionType: UsageActionType;
};

type ResearchUsageRunner = {
  run<T>(
    input: ResearchUsageInput,
    task: () => T | Promise<T>,
    options?: ResearchUsageRunOptions,
  ): Promise<T>;
};

type AiUsageContinuationLifecycle = {
  provision(input: ContinuationRootInput): Promise<unknown>;
  claim(input: ContinuationStageInput): Promise<ContinuationClaimResult>;
  complete(input: ContinuationSettlementInput): Promise<unknown>;
  release(input: ContinuationSettlementInput): Promise<unknown>;
};

export type AiUsageRunnerDependencies = {
  getConfig: () => BillingConfig;
  requireUser: () => Promise<BillingUser>;
  checkLegacy: (feature: UsageActionType) => Promise<LegacyUsageResult>;
  insertLegacy: (usage: LegacyUsageRecord) => Promise<unknown>;
  research: ResearchUsageRunner;
  continuations: AiUsageContinuationLifecycle;
  randomUUID: () => string;
  resolveCost?: (
    userId: string,
    featureKey: UsageActionType,
  ) => Promise<ResolvedFeatureUsageCost>;
};

export type AiUsageRunner = (
  request: Request,
  feature: UsageActionType,
  legacyLimitResponse: (usage: { used: number; limit: number }) => Response,
  task: (context: AiUsageContext) => Promise<Response>,
  options?: AiUsageOptions,
) => Promise<Response>;

export type AiUsageOptions = {
  operationKey?: string;
  continuation?: {
    stageKey: string;
    requestHash: string;
  };
  continuationStages?: readonly ContinuationStageProvision[];
};

const usageQuota = new UsageQuotaService();
const featureUsageCosts = new FeatureUsageCostService();
const defaultDependencies: AiUsageRunnerDependencies = {
  getConfig: getBillingConfig,
  requireUser: requireBillingUser,
  checkLegacy: checkUsageLimit,
  insertLegacy: insertUsageRecord,
  research: new ResearchUsageService(),
  continuations: {
    provision(input) {
      return usageQuota.provision(input);
    },
    claim(input) {
      return usageQuota.claim(input);
    },
    complete(input) {
      return usageQuota.complete(input);
    },
    release(input) {
      return usageQuota.releaseContinuation(input);
    },
  },
  randomUUID,
  resolveCost(userId, featureKey) {
    return featureUsageCosts.resolve(userId, featureKey);
  },
};

const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SAFE_OPERATION_KEY = /^[a-z0-9][a-z0-9._:-]{2,63}$/;

function operationKey(
  feature: UsageActionType,
  options: AiUsageOptions | undefined,
): string {
  const value = options?.operationKey ?? feature;
  if (!SAFE_OPERATION_KEY.test(value)) {
    throw new BillingError(
      "INVALID_AI_OPERATION",
      "The AI operation key is invalid.",
      400,
    );
  }
  return value;
}

function taskKey(
  request: Request,
  operation: string,
  userId: string,
  createId: () => string,
  requireClientKey = false,
) {
  const clientKey = request.headers.get("Idempotency-Key");
  if (clientKey === null && requireClientKey) {
    throw new BillingError(
      "MISSING_CONTINUATION_KEY",
      "Idempotency-Key is required for continuation requests.",
      400,
    );
  }
  if (clientKey !== null && !SAFE_IDEMPOTENCY_KEY.test(clientKey)) {
    throw new BillingError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 8-128 safe ASCII characters.",
      400,
    );
  }
  return `ai:${userId}:${operation}:${clientKey ?? createId()}`;
}

function researchInput(
  request: Request,
  feature: UsageActionType,
  operation: string,
  userId: string,
  createId: () => string,
  requireClientKey = false,
  cost: ResolvedFeatureUsageCost = {
    quotaUnits: 1,
    creditAmount: 0,
    accessMode: "ENTITLEMENT",
  },
): ResearchUsageInput {
  return {
    userId,
    taskKey: taskKey(
      request,
      operation,
      userId,
      createId,
      requireClientKey,
    ),
    featureKey: feature,
    quotaUnits: cost.quotaUnits,
    creditAmount: cost.creditAmount,
  };
}

function usageContext(userId: string | null): {
  context: AiUsageContext;
  tokens: () => Required<AiTokenUsage>;
  failure: () => unknown;
} {
  let current: Required<AiTokenUsage> = {
    tokensInput: 0,
    tokensOutput: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let taskFailure: unknown;
  return {
    context: {
      userId,
      setTokenUsage(input) {
        current = {
          tokensInput: input.tokensInput,
          tokensOutput: input.tokensOutput,
          cacheCreationTokens: input.cacheCreationTokens ?? 0,
          cacheReadTokens: input.cacheReadTokens ?? 0,
        };
      },
      markFailed(error) {
        taskFailure = error;
      },
    },
    tokens: () => current,
    failure: () => taskFailure,
  };
}

function isStreamingResponse(response: Response): boolean {
  return response.headers
    .get("content-type")
    ?.toLowerCase()
    .startsWith("text/event-stream") === true;
}

function taskFailure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new BillingError(
        "RESEARCH_TASK_FAILED",
        "The research stream failed before completion.",
        502,
      );
}

function copyResponse(response: Response, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function providerStreamFailure(): BillingError {
  return new BillingError(
    "RESEARCH_PROVIDER_STREAM_FAILED",
    "The AI provider reported a stream failure.",
    502,
  );
}

function hasProviderErrorEvent(line: string): boolean {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!normalized.startsWith("data:")) return false;

  const raw = normalized.slice(5).trim();
  if (!raw || raw === "[DONE]") return false;

  try {
    const event = JSON.parse(raw) as unknown;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return false;
    }
    const record = event as Record<string, unknown>;
    return record.type === "error" || record.error != null;
  } catch {
    return false;
  }
}

function guardStreamingResponse(
  response: Response,
  failure: () => unknown,
): Response {
  if (!isStreamingResponse(response) || !response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let detectedFailure: BillingError | undefined;
  const inspect = (value: Uint8Array | undefined, done = false) => {
    buffer += value
      ? decoder.decode(value, { stream: !done })
      : decoder.decode();
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    if (!detectedFailure && lines.some(hasProviderErrorEvent)) {
      detectedFailure = providerStreamFailure();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (!next.done) {
          inspect(next.value);
          controller.enqueue(next.value);
          return;
        }
        inspect(undefined, true);
        const explicitFailure = failure();
        const error =
          explicitFailure !== undefined ? explicitFailure : detectedFailure;
        if (error !== undefined) {
          controller.error(taskFailure(error));
          return;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return copyResponse(response, body);
}

function settleLegacyStream(
  response: Response,
  failure: () => unknown,
  finalize: () => Promise<void>,
): Response {
  if (!isStreamingResponse(response) || !response.body) return response;

  const reader = response.body.getReader();
  let settled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        if (settled) return;
        settled = true;
        const error = failure();
        if (error !== undefined) {
          controller.error(taskFailure(error));
          return;
        }
        await finalize();
        controller.close();
      } catch (error) {
        settled = true;
        controller.error(error);
      }
    },
    async cancel(reason) {
      settled = true;
      await reader.cancel(reason);
    },
  });
  return copyResponse(response, body);
}

function settleContinuationStream(
  response: Response,
  complete: () => Promise<void>,
  release: () => Promise<void>,
): Response {
  if (!isStreamingResponse(response) || !response.body) return response;

  const reader = response.body.getReader();
  let settled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        if (!settled) {
          settled = true;
          await complete();
        }
        controller.close();
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
  return copyResponse(response, body);
}

function continuationStageInput(
  userId: string,
  rootTaskKey: string,
  feature: UsageActionType,
  operation: string,
  continuation: NonNullable<AiUsageOptions["continuation"]>,
): ContinuationStageInput {
  return {
    userId,
    taskKey: rootTaskKey,
    featureKey: feature,
    operationKey: operation,
    stageKey: continuation.stageKey,
    requestHash: continuation.requestHash,
  };
}

async function runClaimedContinuation(
  dependencies: AiUsageRunnerDependencies,
  input: ContinuationStageInput,
  task: (context: AiUsageContext) => Promise<Response>,
): Promise<Response> {
  const claim = await dependencies.continuations.claim(input);
  if (claim.status === "COMPLETED") {
    throw new BillingError(
      "USAGE_CONTINUATION_REPLAY",
      "This continuation stage has already completed.",
      409,
    );
  }
  if (claim.idempotent || claim.claimToken === null) {
    throw new BillingError(
      "USAGE_CONTINUATION_IN_PROGRESS",
      "This continuation stage is already in progress.",
      409,
    );
  }

  const settlement: ContinuationSettlementInput = {
    ...input,
    claimToken: claim.claimToken,
  };
  const complete = async () => {
    await dependencies.continuations.complete(settlement);
  };
  const release = async () => {
    await dependencies.continuations.release(settlement);
  };
  const usage = usageContext(input.userId);
  let response: Response;
  try {
    response = await task(usage.context);
  } catch (error) {
    await release();
    throw error;
  }

  if (!response.ok) {
    await release();
    return response;
  }

  const guarded = guardStreamingResponse(response, usage.failure);
  if (isStreamingResponse(guarded)) {
    return settleContinuationStream(guarded, complete, release);
  }
  const failure = usage.failure();
  if (failure !== undefined) {
    await release();
    throw taskFailure(failure);
  }
  await complete();
  return guarded;
}

async function runLegacy(
  dependencies: AiUsageRunnerDependencies,
  request: Request,
  feature: UsageActionType,
  operation: string,
  legacyLimitResponse: (usage: { used: number; limit: number }) => Response,
  task: (context: AiUsageContext) => Promise<Response>,
  options: AiUsageOptions | undefined,
): Promise<Response> {
  const legacy = await dependencies.checkLegacy(feature);
  if (options?.continuation) {
    if (!legacy.userId) {
      throw new BillingError(
        "USAGE_CONTINUATION_AUTH_REQUIRED",
        "A signed-in user is required for continuation requests.",
        401,
      );
    }
    const rootTaskKey = taskKey(
      request,
      operation,
      legacy.userId,
      dependencies.randomUUID,
      true,
    );
    return runClaimedContinuation(
      dependencies,
      continuationStageInput(
        legacy.userId,
        rootTaskKey,
        feature,
        operation,
        options.continuation,
      ),
      task,
    );
  }
  if (!legacy.allowed) {
    return legacyLimitResponse(legacy);
  }

  const stages = options?.continuationStages ?? [];
  if (stages.length > 0 && !legacy.userId) {
    throw new BillingError(
      "USAGE_CONTINUATION_AUTH_REQUIRED",
      "A signed-in user is required to start a multi-stage AI operation.",
      401,
    );
  }
  const rootTaskKey =
    stages.length > 0 && legacy.userId
      ? taskKey(
          request,
          operation,
          legacy.userId,
          dependencies.randomUUID,
          true,
        )
      : undefined;
  const usage = usageContext(legacy.userId);
  const response = await task(usage.context);
  const finalize = async () => {
    if (legacy.userId) {
      await dependencies.insertLegacy({
        userId: legacy.userId,
        actionType: feature,
        ...usage.tokens(),
      });
    }
    if (legacy.userId && rootTaskKey && stages.length > 0) {
      await dependencies.continuations.provision({
        userId: legacy.userId,
        taskKey: rootTaskKey,
        featureKey: feature,
        operationKey: operation,
        stages,
        finalizeUsage: false,
      });
    }
  };
  if (
    response.ok &&
    isStreamingResponse(response)
  ) {
    return settleLegacyStream(
      guardStreamingResponse(response, usage.failure),
      usage.failure,
      finalize,
    );
  }
  if (
    response.ok &&
    legacy.userId &&
    usage.failure() === undefined
  ) {
    await finalize();
  }
  return response;
}

export function createAiUsageRunner(
  dependencies: AiUsageRunnerDependencies = defaultDependencies,
): AiUsageRunner {
  return async (request, feature, legacyLimitResponse, task, options) => {
    try {
      if (options?.continuation && options.continuationStages) {
        throw new BillingError(
          "INVALID_CONTINUATION_POLICY",
          "An AI request cannot be both a root and a continuation stage.",
          400,
        );
      }
      const operation = operationKey(feature, options);
      const config = dependencies.getConfig();
      if (!config.featureEnabled) {
        return await runLegacy(
          dependencies,
          request,
          feature,
          operation,
          legacyLimitResponse,
          task,
          options,
        );
      }

      const user = await dependencies.requireUser();
      const cost = dependencies.resolveCost
        ? await dependencies.resolveCost(user.id, feature)
        : {
            quotaUnits: 1,
            creditAmount: 0,
            accessMode: "ENTITLEMENT" as const,
          };
      const stages = options?.continuationStages ?? [];
      const input = researchInput(
        request,
        feature,
        operation,
        user.id,
        dependencies.randomUUID,
        options?.continuation !== undefined || stages.length > 0,
        cost,
      );
      if (options?.continuation) {
        return await runClaimedContinuation(
          dependencies,
          continuationStageInput(
            user.id,
            input.taskKey,
            feature,
            operation,
            options.continuation,
          ),
          task,
        );
      }
      const usage = usageContext(user.id);
      const settlementOptions: ResearchUsageRunOptions =
        stages.length === 0
          ? { authorization: cost.accessMode }
          : {
              authorization: cost.accessMode,
              finalize: async () => {
                await dependencies.continuations.provision({
                  userId: user.id,
                  taskKey: input.taskKey,
                  featureKey: feature,
                  operationKey: operation,
                  stages,
                  finalizeUsage: true,
                });
              },
            };
      const result = await dependencies.research.run<
        Response | { response: Response }
      >(
        input,
        async () => {
          const response = await task(usage.context);
          const failure = usage.failure();
          if (!isStreamingResponse(response) && response.ok && failure !== undefined) {
            throw taskFailure(failure);
          }
          if (isStreamingResponse(response) || !response.ok) {
            return guardStreamingResponse(response, usage.failure);
          }
          return { response };
        },
        settlementOptions,
      );
      return result instanceof Response ? result : result.response;
    } catch (error) {
      if (error instanceof BillingError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  };
}

export const withAiUsage = createAiUsageRunner();
