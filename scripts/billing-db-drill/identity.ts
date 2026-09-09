export const BILLING_SOURCE_PROJECT_REF = "fqnpzsecalhrsqhpdaxs";
export const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export interface TargetIdentityInput {
  sourceRef: string;
  restoreRef: string;
  approvedRestoreRef: string;
  productionRefs: readonly string[];
}

export interface AuthorizedTargets {
  sourceRef: typeof BILLING_SOURCE_PROJECT_REF;
  restoreRef: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function assertProjectRef(ref: string): void {
  if (!PROJECT_REF_PATTERN.test(ref)) {
    fail("INVALID_PROJECT_REF");
  }
}

export function assertAuthorizedTargets(input: TargetIdentityInput): AuthorizedTargets {
  if (input.sourceRef !== BILLING_SOURCE_PROJECT_REF) {
    fail("SOURCE_PROJECT_REF_MISMATCH");
  }

  assertProjectRef(input.sourceRef);
  assertProjectRef(input.restoreRef);
  if (input.restoreRef === input.sourceRef) {
    fail("SOURCE_AND_RESTORE_MUST_DIFFER");
  }
  if (input.restoreRef !== input.approvedRestoreRef) {
    fail("RESTORE_PROJECT_NOT_APPROVED");
  }
  assertProjectRef(input.approvedRestoreRef);
  for (const productionRef of input.productionRefs) {
    assertProjectRef(productionRef);
  }
  if (input.productionRefs.includes(input.sourceRef)) {
    fail("SOURCE_PROJECT_IS_PRODUCTION");
  }
  if (input.productionRefs.includes(input.restoreRef)) {
    fail("RESTORE_PROJECT_IS_PRODUCTION");
  }

  return { sourceRef: BILLING_SOURCE_PROJECT_REF, restoreRef: input.restoreRef };
}

export function assertDatabaseUrlMatchesRef(rawUrl: string, expectedRef: string): URL {
  assertProjectRef(expectedRef);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    fail("DATABASE_URL_INVALID");
  }

  if (url.protocol !== "postgresql:") {
    fail("DATABASE_URL_PROTOCOL_INVALID");
  }

  const directHost = `db.${expectedRef}.supabase.co`;
  const poolerUsername = `postgres.${expectedRef}`;
  const isDirectHost = url.hostname === directHost;
  const isPooler = url.hostname.endsWith(".pooler.supabase.com") && url.username === poolerUsername;
  if (!isDirectHost && !isPooler) {
    fail("DATABASE_URL_PROJECT_MISMATCH");
  }

  return url;
}
