import { readFileSync } from "node:fs";
import type { Json } from "../../../lib/billing/database.types";

// Read the deployment catalog itself so a missing seed also fails the rendered UI test.
export function subscriptionDisplayCatalog(): Map<string, Json> {
  const sql = readFileSync(new URL(
    "../../../supabase/migrations/202609100019_monthly_semester_catalog.sql",
    import.meta.url,
  ), "utf8");
  const block = sql.match(/WITH desired_display_metadata[\s\S]*?UPDATE public\.billing_products/);
  return new Map([...((block?.[0] ?? "").matchAll(/\('(PRO_MONTHLY|PRO_SEMESTER)',\s*'([^']+)'::JSONB\)/g))]
    .map((match) => [match[1], JSON.parse(match[2]) as Json]));
}
