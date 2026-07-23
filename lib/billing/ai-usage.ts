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
import { UsageQuotaService } from "./usage-quota";

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
  run<T>(input: ResearchUsageInput, task: () => T | Promise<T>): Promise<T>;
};

type AiUsageContinuationVerifier = {
  assertFinalized(
    userId: string,
    taskKey: string,
    featureKey: string,
  ): Promise<unknown>;
};

export type AiUsageRunnerDependencies = {
  getConfig: () => BillingConfig;
  requireUser: () => Promise<BillingUser>;
  checkLegacy: (feature: UsageActionType) => Promise<LegacyUsageResult>;
  insertLegacy: (usage: LegacyUsageRecord) => Promise<unknown>;
  research: ResearchUsageRunner;
  continuations: AiUsageContinuationVerifier;
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
  continuation?: boolean;
};

const defaultDependencies: AiUsageRunnerDependencies = {
  getConfig: getBillingConfig,
  requireUser: requireBillingUser,
  checkLegacy: checkUsageLimit,
  insertLegacy: insertUsageRecord,
  research: new ResearchUsageService(),
  continuations: new UsageQuotaService(),
  randomUUID,
};

const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function taskKey(
  request: Request,
  feature: UsageActionType,
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
  return `ai:${userId}:${feature}:${clientKey ?? createId()}`;
}

function researchInput(
  request: Request,
  feature: UsageActionType,
  userId: string,
  createId: () => string,
  requireClientKey = false,
): ResearchUsageInput {
  return {
    userId,
    taskKey: taskKey(
      request,
      feature,
      userId,
      createId,
      requireClientKey,
    ),
    featureKey: feature,
    quotaUnits: 1,
    creditAmount: 0,
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
    isStreamingResponse(response)
  ) {
    return settleLegacyStream(
      guardStreamingResponse(response, usage.failure),
      usage.failure,
      record,
    );
  }
  if (
    response.ok &&
    legacy.userId &&
    usage.failure() === undefined
  ) {
    await record();
  }
  return response;
}

async function runContinuation(
  userId: string | null,
  task: (context: AiUsageContext) => Promise<Response>,
): Promise<Response> {
  const usage = usageContext(userId);
  const response = await task(usage.context);
  const failure = usage.failure();
  if (!isStreamingResponse(response) && response.ok && failure !== undefined) {
    throw taskFailure(failure);
  }
  return guardStreamingResponse(response, usage.failure);
}

export function createAiUsageRunner(
  dependencies: AiUsageRunnerDependencies = defaultDependencies,
): AiUsageRunner {
  return async (request, feature, legacyLimitResponse, task, options) => {
    try {
      const config = dependencies.getConfig();
      if (!config.featureEnabled) {
        if (options?.continuation) {
          taskKey(
            request,
            feature,
            "legacy",
            dependencies.randomUUID,
            true,
          );
          return await runContinuation(null, task);
        }
        return await runLegacy(
          dependencies,
          feature,
          legacyLimitResponse,
          task,
        );
      }

      const user = await dependencies.requireUser();
      const input = researchInput(
        request,
        feature,
        user.id,
        dependencies.randomUUID,
        options?.continuation === true,
      );
      if (options?.continuation) {
        await dependencies.continuations.assertFinalized(
          user.id,
          input.taskKey,
          feature,
        );
        return await runContinuation(user.id, task);
      }
      const usage = usageContext(user.id);
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
