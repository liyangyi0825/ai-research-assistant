-- Billing catalog configuration. All plans and products remain hidden until
-- an explicit operational activation decision is made.

-- The original schema allowed FREE, MONTHLY, and YEARLY only. Replacing its
-- named constraint is a forward-only upgrade that preserves every prior value
-- and explicitly adds the semester billing period.
ALTER TABLE public.billing_plans
  DROP CONSTRAINT IF EXISTS billing_plans_billing_period_check;

ALTER TABLE public.billing_plans
  ADD CONSTRAINT billing_plans_billing_period_check
  CHECK (billing_period IN ('FREE', 'MONTHLY', 'YEARLY', 'SEMESTER'));

INSERT INTO public.billing_plans (
  code,
  name,
  billing_period,
  is_active
)
VALUES
  ('FREE', 'Free', 'FREE', false),
  ('PRO', 'Pro', 'MONTHLY', false),
  ('PRO_SEMESTER', 'Pro Semester', 'SEMESTER', false)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  billing_period = EXCLUDED.billing_period,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-- Each plan entitlement is a database-owned periodic quota. The version is
-- part of the uniqueness key so purchases retain a stable entitlement snapshot.
WITH desired_entitlements (
  plan_code,
  feature_key,
  entitlement_version,
  periodic_limit
) AS (
  VALUES
    ('FREE', 'summarize', 'free-v1', 5),
    ('FREE', 'chat', 'free-v1', 30),
    ('FREE', 'translate', 'free-v1', 3),
    ('FREE', 'ppt_generate', 'free-v1', 3),
    ('FREE', 'concept_explore', 'free-v1', 10),
    ('FREE', 'keyword_gen', 'free-v1', 20),
    ('FREE', 'bibtex_export', 'free-v1', 30),
    ('FREE', 'extract_refs', 'free-v1', 10),
    ('FREE', 'profile_summarize', 'free-v1', 5),
    ('FREE', 'literature_review', 'free-v1', 3),
    ('FREE', 'latex_export', 'free-v1', 5),
    ('FREE', 'data_clean', 'free-v1', 10),
    ('FREE', 'polish', 'free-v1', 10),
    ('PRO', 'summarize', 'pro-v1', 100),
    ('PRO', 'chat', 'pro-v1', 1000),
    ('PRO', 'translate', 'pro-v1', 30),
    ('PRO', 'ppt_generate', 'pro-v1', 30),
    ('PRO', 'concept_explore', 'pro-v1', 100),
    ('PRO', 'keyword_gen', 'pro-v1', 200),
    ('PRO', 'bibtex_export', 'pro-v1', 1000),
    ('PRO', 'extract_refs', 'pro-v1', 100),
    ('PRO', 'profile_summarize', 'pro-v1', 100),
    ('PRO', 'literature_review', 'pro-v1', 30),
    ('PRO', 'latex_export', 'pro-v1', 100),
    ('PRO', 'data_clean', 'pro-v1', 100),
    ('PRO', 'polish', 'pro-v1', 100),
    ('PRO_SEMESTER', 'summarize', 'pro-semester-v1', 500),
    ('PRO_SEMESTER', 'chat', 'pro-semester-v1', 5000),
    ('PRO_SEMESTER', 'translate', 'pro-semester-v1', 150),
    ('PRO_SEMESTER', 'ppt_generate', 'pro-semester-v1', 150),
    ('PRO_SEMESTER', 'concept_explore', 'pro-semester-v1', 500),
    ('PRO_SEMESTER', 'keyword_gen', 'pro-semester-v1', 1000),
    ('PRO_SEMESTER', 'bibtex_export', 'pro-semester-v1', 5000),
    ('PRO_SEMESTER', 'extract_refs', 'pro-semester-v1', 500),
    ('PRO_SEMESTER', 'profile_summarize', 'pro-semester-v1', 500),
    ('PRO_SEMESTER', 'literature_review', 'pro-semester-v1', 150),
    ('PRO_SEMESTER', 'latex_export', 'pro-semester-v1', 500),
    ('PRO_SEMESTER', 'data_clean', 'pro-semester-v1', 500),
    ('PRO_SEMESTER', 'polish', 'pro-semester-v1', 500)
)
INSERT INTO public.billing_plan_entitlements (
  plan_id,
  feature_key,
  entitlement_version,
  periodic_limit,
  credit_grant,
  configuration
)
SELECT
  plans.id,
  desired.feature_key,
  desired.entitlement_version,
  desired.periodic_limit,
  0,
  '{}'::JSONB
FROM desired_entitlements AS desired
JOIN public.billing_plans AS plans ON plans.code = desired.plan_code
ON CONFLICT (plan_id, feature_key, entitlement_version) DO UPDATE
SET
  periodic_limit = EXCLUDED.periodic_limit,
  credit_grant = EXCLUDED.credit_grant,
  configuration = EXCLUDED.configuration,
  updated_at = now();

WITH desired_products (
  sku,
  name,
  product_type,
  plan_code,
  price_minor,
  currency,
  duration_days,
  credit_grant,
  entitlement_version,
  is_active
) AS (
  VALUES
    ('PRO_MONTHLY', 'Pro Monthly', 'SUBSCRIPTION', 'PRO', 1990, 'CNY', 30, 0, 'pro-v1', false),
    ('PRO_SEMESTER', 'Pro Semester', 'SUBSCRIPTION', 'PRO_SEMESTER', 7900, 'CNY', 150, 0, 'pro-semester-v1', false),
    ('CREDIT_PACK_100', 'Credit Pack 100', 'CREDIT_PACK', NULL, 990, 'CNY', NULL, 100, 'credit-v1', false)
)
INSERT INTO public.billing_products (
  plan_id,
  sku,
  name,
  product_type,
  price_minor,
  currency,
  duration_days,
  credit_grant,
  entitlement_version,
  is_active
)
SELECT
  plans.id,
  desired.sku,
  desired.name,
  desired.product_type,
  desired.price_minor,
  desired.currency,
  desired.duration_days,
  desired.credit_grant,
  desired.entitlement_version,
  desired.is_active
FROM desired_products AS desired
LEFT JOIN public.billing_plans AS plans ON plans.code = desired.plan_code
ON CONFLICT (sku) DO UPDATE
SET
  plan_id = EXCLUDED.plan_id,
  name = EXCLUDED.name,
  product_type = EXCLUDED.product_type,
  price_minor = EXCLUDED.price_minor,
  currency = EXCLUDED.currency,
  duration_days = EXCLUDED.duration_days,
  credit_grant = EXCLUDED.credit_grant,
  entitlement_version = EXCLUDED.entitlement_version,
  is_active = EXCLUDED.is_active,
  updated_at = now();
