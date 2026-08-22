import assert from "node:assert/strict";
import { mock } from "node:test";

type ActorMode = "UNAUTHENTICATED" | "ORDINARY";

let actorMode: ActorMode = "UNAUTHENTICATED";
let adminLookupCalls = 0;
let businessRepositoryAccesses = 0;

const authClient = {
  auth: {
    async getUser() {
      if (actorMode === "UNAUTHENTICATED") {
        return { data: { user: null }, error: null };
      }

      return {
        data: {
          user: {
            id: "ordinary-user",
            email: "ordinary@example.test",
          },
        },
        error: null,
      };
    },
  },
};

const adminClient = {
  from(table: string) {
    if (table !== "billing_admins") {
      businessRepositoryAccesses += 1;
      throw new Error(`unexpected business repository access: ${table}`);
    }

    const query = {
      select() {
        return query;
      },
      eq() {
        return query;
      },
      async maybeSingle() {
        adminLookupCalls += 1;
        return { data: null, error: null };
      },
    };
    return query;
  },
};

mock.module(new URL("../../lib/supabase.ts", import.meta.url).href, {
  namedExports: {
    getSupabaseAdminClient: () => adminClient,
    getSupabaseAuthClient: async () => authClient,
  },
});

process.env.ADMIN_EMAIL = "admin@example.test";

const reconciliationRoute = await import(
  "../../app/api/admin/billing/reconciliation/route"
);
const refundRoute = await import("../../app/api/admin/billing/refunds/route");

assert.deepEqual(Object.keys(reconciliationRoute).sort(), ["GET"]);
assert.deepEqual(Object.keys(refundRoute).sort(), ["GET", "PATCH"]);

async function invokeRoutes() {
  return Promise.all([
    reconciliationRoute.GET(
      new Request("http://localhost/api/admin/billing/reconciliation"),
    ),
    refundRoute.GET(new Request("http://localhost/api/admin/billing/refunds")),
    refundRoute.PATCH(
      new Request("http://localhost/api/admin/billing/refunds", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "refund-auth-probe",
          action: "REVIEW",
          decision: "REJECTED",
          reason: "authorization probe",
          idempotencyKey: "refund-auth-probe-review",
        }),
      }),
    ),
  ]);
}

const statuses: number[] = [];
const errorCodes: string[] = [];
for (const mode of ["UNAUTHENTICATED", "ORDINARY"] as const) {
  actorMode = mode;
  for (const response of await invokeRoutes()) {
    const body = await response.json() as { error: { code: string } };
    statuses.push(response.status);
    errorCodes.push(body.error.code);
  }
}

process.stdout.write(JSON.stringify({
  statuses,
  errorCodes,
  adminLookupCalls,
  businessRepositoryAccesses,
}));
