CREATE TABLE public.billing_feature_usage_costs (
  feature_key TEXT PRIMARY KEY,
  quota_units BIGINT NOT NULL CHECK (quota_units >= 0),
  credit_amount BIGINT NOT NULL CHECK (credit_amount >= 0),
  allow_credit_fallback BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (quota_units > 0 OR credit_amount > 0),
  CHECK (NOT allow_credit_fallback OR credit_amount > 0)
);

ALTER TABLE public.billing_feature_usage_costs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_feature_usage_costs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_feature_usage_costs TO service_role;

INSERT INTO public.billing_feature_usage_costs
  (feature_key, quota_units, credit_amount, allow_credit_fallback)
VALUES
  ('summarize', 1, 10, true),
  ('chat', 1, 5, true),
  ('translate', 1, 25, true),
  ('ppt_generate', 1, 30, true),
  ('concept_explore', 1, 10, true),
  ('keyword_gen', 1, 10, true),
  ('bibtex_export', 1, 1, false),
  ('extract_refs', 1, 5, true),
  ('profile_summarize', 1, 10, true),
  ('literature_review', 1, 25, true),
  ('latex_export', 1, 5, true),
  ('data_clean', 1, 10, true),
  ('polish', 1, 10, true);
