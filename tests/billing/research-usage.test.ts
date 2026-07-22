import assert from "node:assert/strict";
import test from "node:test";

import { BillingError } from "../../lib/billing/errors";
import {
  ResearchUsageService,
  researchTaskFailed,
  type ResearchEntitlementAuthorizer,
  type ResearchUsageInput,
  type ResearchUsageReservationService,
} from "../../lib/billing/research-usage";
import type {
  UsageReservationInput,
  UsageRpcResult,
} from "../../lib/billing/usage-quota";

class InMemoryEntitlements implements ResearchEntitlementAuthorizer {
  readonly events: string[];
  fail = false;

  constructor(events: string[]) {
    this.events = events;
  }

  async requireEntitlement(userId: string, featureKey: string): Promise<void> {
    this.events.push(`entitlement:${userId}:${featureKey}`);
    if (this.fail) {
      throw new BillingError(
        "ENTITLEMENT_REQUIRED",
        "This research feature is not included in the current entitlement.",
        403,
      );
    }
  }
}

class InMemoryUsage implements ResearchUsageReservationService {
  readonly events: string[];
  reserveResult: UsageRpcResult = {
    status: "RESERVED",
    usageRecordId: "usage-1",
    idempotent: false,
  };

  constructor(events: string[]) {
    this.events = events;
  }

  async reserve(input: UsageReservationInput): Promise<UsageRpcResult> {
    this.events.push(`reserve:${JSON.stringify(input)}`);
    return this.reserveResult;
  }

  async finalize(userId: string, taskKey: string): Promise<UsageRpcResult> {
    this.events.push(`finalize:${userId}:${taskKey}`);
    return {
      status: "FINALIZED",
      usageRecordId: "usage-1",
      idempotent: false,
    };
  }

  async release(userId: string, taskKey: string): Promise<UsageRpcResult> {
    this.events.push(`release:${userId}:${taskKey}`);
    return {
      status: "RELEASED",
      usageRecordId: "usage-1",
      idempotent: false,
    };
  }
}

function input(overrides: Partial<ResearchUsageInput> = {}): ResearchUsageInput {
  return {
    userId: "user-1",
    featureKey: "deep_research",
    taskKey: "research:user-1:request-1",
    quotaUnits: 1,
    creditAmount: 25,
    ...overrides,
  };
}

test("ResearchUsageService checks entitlement, atomically reserves, runs, then finalizes", async () => {
  const events: string[] = [];
  const entitlements = new InMemoryEntitlements(events);
  const usage = new InMemoryUsage(events);
  const research = new ResearchUsageService({ entitlements, usage });

  const result = await research.run(input(), async () => {
    events.push("task");
    return "answer";
  });

  assert.equal(result, "answer");
  assert.deepEqual(events, [
    "entitlement:user-1:deep_research",
    `reserve:${JSON.stringify({
      userId: "user-1",
      taskKey: "research:user-1:request-1",
      featureKey: "deep_research",
      quotaUnits: 1,
      creditAmount: 25,
    })}`,
    "task",
    "finalize:user-1:research:user-1:request-1",
  ]);
});

test("ResearchUsageService releases reservations for synchronous throws and async rejection", async () => {
  for (const task of [
    () => {
      throw new Error("sync failed");
    },
    async () => {
      throw new Error("async failed");
    },
  ]) {
    const events: string[] = [];
    const research = new ResearchUsageService({
      entitlements: new InMemoryEntitlements(events),
      usage: new InMemoryUsage(events),
    });

    await assert.rejects(research.run(input(), task), /failed/);
    assert.equal(
      events.at(-1),
      "release:user-1:research:user-1:request-1",
    );
    assert.equal(events.some((event) => event.startsWith("finalize:")), false);
  }
});

test("ResearchUsageService releases an explicitly failed task outcome", async () => {
  const events: string[] = [];
  const research = new ResearchUsageService({
    entitlements: new InMemoryEntitlements(events),
    usage: new InMemoryUsage(events),
  });

  await assert.rejects(
    research.run(input(), async () => researchTaskFailed(new Error("stream failed"))),
    /stream failed/,
  );
  assert.equal(events.at(-1), "release:user-1:research:user-1:request-1");
});

test("ResearchUsageService finalizes only after a response stream closes", async () => {
  const events: string[] = [];
  const research = new ResearchUsageService({
    entitlements: new InMemoryEntitlements(events),
    usage: new InMemoryUsage(events),
  });
  const encoder = new TextEncoder();

  const response = await research.run(input(), async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("done"));
          controller.close();
        },
      }),
    ),
  );

  assert.equal(events.some((event) => event.startsWith("finalize:")), false);
  assert.equal(await response.text(), "done");
  assert.equal(
    events.at(-1),
    "finalize:user-1:research:user-1:request-1",
  );
});

test("ResearchUsageService releases when a response stream errors", async () => {
  const events: string[] = [];
  const research = new ResearchUsageService({
    entitlements: new InMemoryEntitlements(events),
    usage: new InMemoryUsage(events),
  });

  const response = await research.run(input(), async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("stream exploded"));
        },
      }),
    ),
  );

  await assert.rejects(response.text(), /stream exploded/);
  assert.equal(events.at(-1), "release:user-1:research:user-1:request-1");
});

test("ResearchUsageService does not execute the task for an idempotent reservation replay", async () => {
  const events: string[] = [];
  const usage = new InMemoryUsage(events);
  usage.reserveResult = {
    status: "RESERVED",
    usageRecordId: "usage-1",
    idempotent: true,
  };
  const research = new ResearchUsageService({
    entitlements: new InMemoryEntitlements(events),
    usage,
  });

  await assert.rejects(
    research.run(input(), async () => {
      events.push("task");
      return "duplicate";
    }),
    (error) =>
      error instanceof BillingError &&
      error.code === "RESEARCH_TASK_IN_PROGRESS" &&
      error.status === 409,
  );
  assert.equal(events.includes("task"), false);
});

test("ResearchUsageService does not reserve when entitlement validation fails", async () => {
  const events: string[] = [];
  const entitlements = new InMemoryEntitlements(events);
  entitlements.fail = true;
  const research = new ResearchUsageService({
    entitlements,
    usage: new InMemoryUsage(events),
  });

  await assert.rejects(
    research.run(input(), async () => "not allowed"),
    (error) =>
      error instanceof BillingError && error.code === "ENTITLEMENT_REQUIRED",
  );
  assert.equal(events.some((event) => event.startsWith("reserve:")), false);
});
