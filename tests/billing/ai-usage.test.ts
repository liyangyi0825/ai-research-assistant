import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { BillingConfig } from "../../lib/billing/config";
import { BillingError } from "../../lib/billing/errors";
import {
  createAiUsageRunner,
  type AiUsageRunnerDependencies,
} from "../../lib/billing/ai-usage";
import {
  ResearchUsageService,
  type ResearchEntitlementAuthorizer,
  type ResearchUsageInput,
  type ResearchUsageReservationService,
} from "../../lib/billing/research-usage";
import type {
  UsageReservationInput,
  UsageRpcResult,
} from "../../lib/billing/usage-quota";

test("the centralized AI usage adapter exposes one route integration surface", async () => {
  let contents = "";
  try {
    contents = await readFile(
      path.join(process.cwd(), "lib/billing/ai-usage.ts"),
      "utf8",
    );
  } catch {
    assert.fail("lib/billing/ai-usage.ts must exist");
  }

  assert.match(contents, /export type AiUsageContext/);
  assert.match(contents, /export function createAiUsageRunner/);
  assert.match(contents, /export const withAiUsage/);
});

const disabledConfig: BillingConfig = {
  featureEnabled: false,
  paymentMode: "mock",
  testUserIds: [],
  legal: { operatorName: "", operatorCreditCode: "", contactEmail: "" },
  wechatConfigured: false,
  alipayConfigured: false,
  isProduction: false,
};

function dependencies(
  overrides: Partial<AiUsageRunnerDependencies> = {},
): AiUsageRunnerDependencies {
  return {
    getConfig: () => disabledConfig,
    requireUser: async () => ({
      id: "server-user",
      email: "student@example.com",
      isAdmin: false,
    }),
    checkLegacy: async () => ({
      allowed: true,
      used: 1,
      limit: 30,
      userId: "legacy-user",
    }),
    insertLegacy: async () => undefined,
    research: {
      async run<T>(input: ResearchUsageInput, task: () => T | Promise<T>) {
        void input;
        return task();
      },
    },
    continuations: {
      async assertFinalized() {
        throw new Error("continuation verification was not expected");
      },
    },
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

function request(idempotencyKey?: string): Request {
  const headers = new Headers();
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return new Request("http://localhost/api/chat", { method: "POST", headers });
}

test("billing disabled keeps the legacy limit and usage-record path centralized", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(
    dependencies({
      requireUser: async () => {
        events.push("unexpected-auth");
        throw new Error("new billing auth must stay disabled");
      },
      checkLegacy: async (feature) => {
        events.push(`legacy-check:${feature}`);
        return { allowed: true, used: 2, limit: 30, userId: "legacy-user" };
      },
      insertLegacy: async (usage) => {
        events.push(`legacy-record:${JSON.stringify(usage)}`);
      },
      research: {
        async run() {
          events.push("unexpected-research");
          throw new Error("atomic billing must stay disabled");
        },
      },
    }),
  );

  const response = await runner(
    request(),
    "chat",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async (usage) => {
      events.push(`task:${usage.userId}`);
      usage.setTokenUsage({ tokensInput: 10, tokensOutput: 5 });
      return Response.json({ answer: "ok" });
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(events, [
    "legacy-check:chat",
    "task:legacy-user",
    `legacy-record:${JSON.stringify({
      userId: "legacy-user",
      actionType: "chat",
      tokensInput: 10,
      tokensOutput: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    })}`,
  ]);
});

test("legacy denial preserves each route's existing quota response and skips work", async () => {
  let taskRan = false;
  const runner = createAiUsageRunner(
    dependencies({
      checkLegacy: async () => ({
        allowed: false,
        used: 30,
        limit: 30,
        userId: "legacy-user",
      }),
    }),
  );

  const response = await runner(
    request(),
    "chat",
    ({ used, limit }) =>
      Response.json({ error: `本月次数已用完（${used}/${limit}）` }, { status: 429 }),
    async () => {
      taskRan = true;
      return Response.json({ answer: "unexpected" });
    },
  );

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "本月次数已用完（30/30）" });
  assert.equal(taskRan, false);
});

test("billing-disabled continuations require a root key and skip legacy checks and records", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(
    dependencies({
      checkLegacy: async () => {
        events.push("legacy-check");
        throw new Error("continuations must preserve the old unchecked path");
      },
      insertLegacy: async () => {
        events.push("legacy-record");
      },
    }),
  );

  const response = await runner(
    request("operation-root"),
    "ppt_generate",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async (usage) => {
      events.push(`task:${usage.userId}`);
      return Response.json({ continuation: "ok" });
    },
    { continuation: true },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(events, ["task:null"]);

  const missingKeyResponse = await runner(
    request(),
    "ppt_generate",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async () => Response.json({ continuation: "unexpected" }),
    { continuation: true },
  );

  assert.equal(missingKeyResponse.status, 400);
  assert.deepEqual(await missingKeyResponse.json(), {
    error: "Idempotency-Key is required for continuation requests.",
  });
  assert.deepEqual(events, ["task:null"]);
});

test("billing enabled authenticates on the server and reserves the centralized feature tuple", async () => {
  const events: string[] = [];
  let receivedInput: ResearchUsageInput | null = null;
  const runner = createAiUsageRunner(
    dependencies({
      getConfig: () => ({ ...disabledConfig, featureEnabled: true }),
      requireUser: async () => {
        events.push("auth");
        return { id: "server-user", email: null, isAdmin: false };
      },
      checkLegacy: async () => {
        throw new Error("legacy checks must not run when billing is enabled");
      },
      insertLegacy: async () => {
        throw new Error("legacy records must not run when billing is enabled");
      },
      research: {
        async run<T>(input: ResearchUsageInput, task: () => T | Promise<T>) {
          receivedInput = input;
          events.push("research");
          return task();
        },
      },
    }),
  );

  const response = await runner(
    request("retry-key_123"),
    "chat",
    () => Response.json({ error: "legacy limit" }, { status: 429 }),
    async (usage) => {
      events.push(`task:${usage.userId}`);
      usage.setTokenUsage({ tokensInput: 99, tokensOutput: 42 });
      return Response.json({ answer: "ok" });
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(events, ["auth", "research", "task:server-user"]);
  assert.deepEqual(receivedInput, {
    userId: "server-user",
    taskKey: "ai:server-user:chat:retry-key_123",
    featureKey: "chat",
    quotaUnits: 1,
    creditAmount: 0,
  });
});

test("task keys namespace the same client key by authenticated user", async () => {
  const taskKeys: string[] = [];
  const userIds = ["user-a", "user-b"];
  const runner = createAiUsageRunner(
    dependencies({
      getConfig: () => ({ ...disabledConfig, featureEnabled: true }),
      requireUser: async () => ({
        id: userIds.shift() ?? "unexpected-user",
        email: null,
        isAdmin: false,
      }),
      research: {
        async run<T>(input: ResearchUsageInput, task: () => T | Promise<T>) {
          taskKeys.push(input.taskKey);
          return task();
        },
      },
    }),
  );

  for (let index = 0; index < 2; index += 1) {
    await runner(
      request("shared-client-key"),
      "chat",
      () => Response.json({ error: "limit" }, { status: 429 }),
      async () => Response.json({ answer: "ok" }),
    );
  }

  assert.deepEqual(taskKeys, [
    "ai:user-a:chat:shared-client-key",
    "ai:user-b:chat:shared-client-key",
  ]);
});

test("billing-enabled continuations execute only after server-side finalized-root proof", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(
    dependencies({
      getConfig: () => ({ ...disabledConfig, featureEnabled: true }),
      requireUser: async () => {
        events.push("auth");
        return { id: "server-user", email: null, isAdmin: false };
      },
      research: {
        async run() {
          events.push("unexpected-reservation");
          throw new Error("continuations must not reserve again");
        },
      },
      continuations: {
        async assertFinalized(userId, taskKey, featureKey) {
          events.push(
            `verify:${userId}:${taskKey}:${featureKey}`,
          );
        },
      },
    }),
  );

  const response = await runner(
    request("concept-operation"),
    "concept_explore",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async (usage) => {
      events.push(`task:${usage.userId}`);
      return Response.json({ continuation: "ok" });
    },
    { continuation: true },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { continuation: "ok" });
  assert.deepEqual(events, [
    "auth",
    "verify:server-user:ai:server-user:concept_explore:concept-operation:concept_explore",
    "task:server-user",
  ]);
});

test("a continuation with no finalized root is rejected before task execution", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(
    dependencies({
      getConfig: () => ({ ...disabledConfig, featureEnabled: true }),
      continuations: {
        async assertFinalized() {
          events.push("verify");
          throw new BillingError(
            "INVALID_USAGE_CONTINUATION",
            "This continuation does not match a completed research task.",
            409,
          );
        },
      },
      research: {
        async run() {
          events.push("unexpected-reservation");
          throw new Error("continuations must not reserve");
        },
      },
    }),
  );

  const response = await runner(
    request("unknown-operation"),
    "concept_explore",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async () => {
      events.push("unexpected-task");
      return Response.json({ continuation: "unexpected" });
    },
    { continuation: true },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "This continuation does not match a completed research task.",
  });
  assert.deepEqual(events, ["verify"]);
});

test("missing task keys use an unpredictable server UUID", async () => {
  let receivedInput: ResearchUsageInput | null = null;
  const runner = createAiUsageRunner(
    dependencies({
      getConfig: () => ({ ...disabledConfig, featureEnabled: true }),
      research: {
        async run<T>(input: ResearchUsageInput, task: () => T | Promise<T>) {
          receivedInput = input;
          return task();
        },
      },
    }),
  );

  await runner(
    request(),
    "chat",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async () => Response.json({ answer: "ok" }),
  );

  assert.equal(
    (receivedInput as ResearchUsageInput | null)?.taskKey,
    "ai:server-user:chat:00000000-0000-4000-8000-000000000001",
  );
});

test("unsafe client idempotency keys fail before reservation or task execution", async () => {
  for (const invalidKey of ["short", "contains spaces", "a".repeat(129), "../unsafe!"]) {
    const events: string[] = [];
    const runner = createAiUsageRunner(
      dependencies({
        getConfig: () => ({ ...disabledConfig, featureEnabled: true }),
        research: {
          async run<T>(_input: ResearchUsageInput, task: () => T | Promise<T>) {
            events.push("research");
            return task();
          },
        },
      }),
    );

    const response = await runner(
      request(invalidKey),
      "chat",
      () => Response.json({ error: "limit" }, { status: 429 }),
      async () => {
        events.push("task");
        return Response.json({ answer: "unexpected" });
      },
    );

    assert.equal(response.status, 400, invalidKey);
    assert.deepEqual(await response.json(), {
      error: "Idempotency-Key must be 8-128 safe ASCII characters.",
    });
    assert.deepEqual(events, []);
  }
});

class StreamEntitlements implements ResearchEntitlementAuthorizer {
  constructor(private readonly events: string[]) {}

  async requireEntitlement(): Promise<void> {
    this.events.push("entitlement");
  }
}

class StreamReservations implements ResearchUsageReservationService {
  constructor(private readonly events: string[]) {}

  async reserve(_input: UsageReservationInput): Promise<UsageRpcResult> {
    void _input;
    this.events.push("reserve");
    return { status: "RESERVED", usageRecordId: "usage-1", idempotent: false };
  }

  async finalize(): Promise<UsageRpcResult> {
    this.events.push("finalize");
    return { status: "FINALIZED", usageRecordId: "usage-1", idempotent: false };
  }

  async release(): Promise<UsageRpcResult> {
    this.events.push("release");
    return { status: "RELEASED", usageRecordId: "usage-1", idempotent: false };
  }
}

function enabledStreamDependencies(events: string[]): AiUsageRunnerDependencies {
  return dependencies({
    getConfig: () => ({ ...disabledConfig, featureEnabled: true }),
    research: new ResearchUsageService({
      entitlements: new StreamEntitlements(events),
      usage: new StreamReservations(events),
    }),
  });
}

test("successful streams finalize only after the response body closes", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(enabledStreamDependencies(events));
  const encoder = new TextEncoder();

  const response = await runner(
    request(),
    "chat",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: ok\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );

  assert.deepEqual(events, ["entitlement", "reserve"]);
  assert.equal(await response.text(), "data: ok\n\n");
  assert.deepEqual(events, ["entitlement", "reserve", "finalize"]);
});

test("successful non-stream responses finalize before the route returns", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(enabledStreamDependencies(events));

  const response = await runner(
    request(),
    "chat",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async () => Response.json({ answer: "ok" }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(events, ["entitlement", "reserve", "finalize"]);
  assert.deepEqual(await response.json(), { answer: "ok" });
});

test("a stream-marked serialization failure is delivered then releases the reservation", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(enabledStreamDependencies(events));
  const encoder = new TextEncoder();

  const response = await runner(
    request(),
    "chat",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async (usage) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            usage.markFailed(new Error("AI output serialization failed"));
            controller.enqueue(encoder.encode('data: {"error":"格式异常"}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );

  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: {"error":"格式异常"}\n\n');
  await assert.rejects(reader.read(), /serialization failed/);
  assert.deepEqual(events, ["entitlement", "reserve", "release"]);
});

test("a cross-chunk SSE provider error event is delivered then releases the reservation", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(enabledStreamDependencies(events));
  const encoder = new TextEncoder();

  const response = await runner(
    request(),
    "chat",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"err'));
            controller.enqueue(
              encoder.encode('or","error":{"message":"provider failed"}}\n\n'),
            );
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );

  const reader = response.body!.getReader();
  const first = await reader.read();
  const second = await reader.read();
  assert.equal(
    new TextDecoder().decode(first.value) + new TextDecoder().decode(second.value),
    'data: {"type":"error","error":{"message":"provider failed"}}\n\n',
  );
  await assert.rejects(reader.read(), /AI provider reported a stream failure/);
  assert.deepEqual(events, ["entitlement", "reserve", "release"]);
});

test("cancelling a billed response stream releases instead of finalizing", async () => {
  const events: string[] = [];
  const runner = createAiUsageRunner(enabledStreamDependencies(events));
  const encoder = new TextEncoder();

  const response = await runner(
    request(),
    "chat",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(encoder.encode("data: partial\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );

  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
  assert.deepEqual(events, ["entitlement", "reserve", "release"]);
});

test("legacy streaming records usage only after a clean close", async () => {
  const events: string[] = [];
  const encoder = new TextEncoder();
  const runner = createAiUsageRunner(
    dependencies({
      insertLegacy: async () => {
        events.push("legacy-record");
      },
    }),
  );

  const response = await runner(
    request(),
    "chat",
    () => Response.json({ error: "limit" }, { status: 429 }),
    async (usage) => {
      usage.setTokenUsage({ tokensInput: 3, tokensOutput: 2 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("done"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );

  assert.deepEqual(events, []);
  assert.equal(await response.text(), "done");
  assert.deepEqual(events, ["legacy-record"]);
});
