import { randomUUID } from "node:crypto";

import type { UsageActionType } from "../limits";
import { checkUsageLimit, insertUsageRecord } from "../supabase";
import { requireBillingUser, type BillingUser } from "./auth";
import { getBillingConfig, type BillingConfig } from "./config";
import { BillingError } from "./errors";
import {
  ResearchUsageService,
  type ResearchUsageInput,
} from "./research-usage";

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
  skipLegacyUsage(): void;
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
  run<T>(input: ResearchUsageInput, task: () => T | Promise<T>): Promise<T>;
};

export type AiUsageRunnerDependencies = {
  getConfig: () => BillingConfig;
  requireUser: () => Promise<BillingUser>;
  checkLegacy: (feature: UsageActionType) => Promise<LegacyUsageResult>;
  insertLegacy: (usage: LegacyUsageRecord) => Promise<unknown>;
  research: ResearchUsageRunner;
  randomUUID: () => string;
};

export type AiUsageRunner = (
  request: Request,
  feature: UsageActionType,
  legacyLimitResponse: (usage: { used: number; limit: number }) => Response,
  task: (context: AiUsageContext) => Promise<Response>,
  options?: AiUsageOptions,
) => Promise<Response>;

export type AiUsageOptions = {
  legacyUnmetered?: boolean;
};

const defaultDependencies: AiUsageRunnerDependencies = {
  getConfig: getBillingConfig,
  requireUser: requireBillingUser,
  checkLegacy: checkUsageLimit,
  insertLegacy: insertUsageRecord,
  research: new ResearchUsageService(),
  randomUUID,
};

const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function taskKey(request: Request, feature: UsageActionType, createId: () => string) {
  const clientKey = request.headers.get("Idempotency-Key");
  if (clientKey !== null && !SAFE_IDEMPOTENCY_KEY.test(clientKey)) {
    throw new BillingError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 8-128 safe ASCII characters.",
      400,
    );
  }
  return `ai:${feature}:${clientKey ?? createId()}`;
}

function researchInput(
  request: Request,
  feature: UsageActionType,
  userId: string,
  createId: () => string,
): ResearchUsageInput {
  return {
    userId,
    taskKey: taskKey(request, feature, createId),
    featureKey: feature,
    quotaUnits: 1,
    creditAmount: 0,
  };
}

function usageContext(userId: string | null): {
  context: AiUsageContext;
  tokens: () => Required<AiTokenUsage>;
  failure: () => unknown;
  recordsLegacyUsage: () => boolean;
} {
  let current: Required<AiTokenUsage> = {
    tokensInput: 0,
    tokensOutput: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let taskFailure: unknown;
  let recordLegacyUsage = true;
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
      skipLegacyUsage() {
        recordLegacyUsage = false;
      },
    },
    tokens: () => current,
    failure: () => taskFailure,
    recordsLegacyUsage: () => recordLegacyUsage,
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

function guardStreamingResponse(
  response: Response,
  failure: () => unknown,
): Response {
  if (!isStreamingResponse(response) || !response.body) return response;

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        const error = failure();
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

async function runLegacy(
  dependencies: AiUsageRunnerDependencies,
  feature: UsageActionType,
  legacyLimitResponse: (usage: { used: number; limit: number }) => Response,
  task: (context: AiUsageContext) => Promise<Response>,
): Promise<Response> {
  const legacy = await dependencies.checkLegacy(feature);
  if (!legacy.allowed) {
    return legacyLimitResponse(legacy);
  }

  const usage = usageContext(legacy.userId);
  const response = await task(usage.context);
  const record = async () => {
    if (!legacy.userId) return;
    await dependencies.insertLegacy({
      userId: legacy.userId,
      actionType: feature,
      ...usage.tokens(),
    });
  };
  if (
    response.ok &&
    usage.recordsLegacyUsage() &&
    isStreamingResponse(response)
  ) {
    return settleLegacyStream(response, usage.failure, record);
  }
  if (
    response.ok &&
    legacy.userId &&
    usage.recordsLegacyUsage() &&
    usage.failure() === undefined
  ) {
    await record();
  }
  return response;
}

export function createAiUsageRunner(
  dependencies: AiUsageRunnerDependencies = defaultDependencies,
): AiUsageRunner {
  return async (request, feature, legacyLimitResponse, task, options) => {
    try {
      const config = dependencies.getConfig();
      if (!config.featureEnabled) {
        if (options?.legacyUnmetered) {
          return await task(usageContext(null).context);
        }
        return await runLegacy(
          dependencies,
          feature,
          legacyLimitResponse,
          task,
        );
      }

      const user = await dependencies.requireUser();
      const usage = usageContext(user.id);
      const result = await dependencies.research.run<
        Response | { response: Response }
      >(
        researchInput(request, feature, user.id, dependencies.randomUUID),
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
