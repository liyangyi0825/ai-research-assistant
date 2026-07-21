import { getSupabaseAdminClient, getSupabaseAuthClient } from "../supabase";
import {
  assertPaymentRuntimeSafe,
  type BillingConfig,
} from "./config";
import { BillingError } from "./errors";

export type BillingUser = {
  id: string;
  email: string | null;
  isAdmin: boolean;
};

export type BillingAdmin = BillingUser & {
  isAdmin: true;
  role: "BILLING_ADMIN" | "BILLING_REVIEWER";
};

type BillingAdminRecord = {
  role: "BILLING_ADMIN" | "BILLING_REVIEWER";
  isActive: boolean;
};

export type BillingAuthDependencies = {
  getUser: () => Promise<BillingUser | null>;
  findAdmin: (userId: string) => Promise<BillingAdminRecord | null>;
  adminEmail?: string;
};

function normalizeEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

const serverDependencies: BillingAuthDependencies = {
  async getUser() {
    const supabase = await getSupabaseAuthClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email ?? null,
      isAdmin: false,
    };
  },
  async findAdmin(userId) {
    const database = getSupabaseAdminClient();

    if (!database) {
      return null;
    }

    const { data, error } = await database
      .from("billing_admins")
      .select("role, is_active")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw new BillingError(
        "BILLING_ADMIN_LOOKUP_FAILED",
        "Unable to verify billing administrator permissions.",
        503,
      );
    }

    if (!data) {
      return null;
    }

    return {
      role: data.role as BillingAdminRecord["role"],
      isActive: data.is_active,
    };
  },
  get adminEmail() {
    return process.env.ADMIN_EMAIL;
  },
};

export async function requireBillingUser(
  dependencies: BillingAuthDependencies = serverDependencies,
): Promise<BillingUser> {
  const user = await dependencies.getUser();

  if (!user) {
    throw new BillingError(
      "UNAUTHENTICATED",
      "An authenticated billing session is required.",
      401,
    );
  }

  return user;
}

export async function requireBillingAdmin(
  dependencies: BillingAuthDependencies = serverDependencies,
): Promise<BillingAdmin> {
  const user = await requireBillingUser(dependencies);
  const record = await dependencies.findAdmin(user.id);
  const isBootstrapAdmin =
    normalizeEmail(user.email) !== null &&
    normalizeEmail(user.email) === normalizeEmail(dependencies.adminEmail);

  if (!record?.isActive && !isBootstrapAdmin) {
    throw new BillingError(
      "BILLING_ADMIN_REQUIRED",
      "An active billing administrator is required.",
      403,
    );
  }

  return {
    ...user,
    isAdmin: true,
    role: record?.role ?? "BILLING_ADMIN",
  };
}

export function assertBillingAccess(
  user: BillingUser,
  config: BillingConfig,
): void {
  if (!config.featureEnabled) {
    throw new BillingError(
      "BILLING_FEATURE_DISABLED",
      "Billing writes are disabled.",
      403,
    );
  }

  assertPaymentRuntimeSafe(config, {
    userId: user.id,
    isAdmin: user.isAdmin,
  });
}
