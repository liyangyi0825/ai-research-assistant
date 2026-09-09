BEGIN;

CREATE OR REPLACE FUNCTION public.billing_assert_semester_plan(p_plan_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_plan public.billing_plans%ROWTYPE;
  v_free UUID;
  v_monthly UUID;
  v_free_count INTEGER;
  v_monthly_count INTEGER;
  v_semester_count INTEGER;
  v_approved_features TEXT[] := ARRAY[
    'summarize', 'chat', 'translate', 'ppt_generate', 'concept_explore',
    'keyword_gen', 'bibtex_export', 'extract_refs', 'profile_summarize',
    'literature_review', 'latex_export', 'data_clean', 'polish'
  ];
BEGIN
  LOCK TABLE public.billing_plans, public.billing_products,
    public.billing_plan_entitlements IN SHARE ROW EXCLUSIVE MODE;

  SELECT * INTO v_plan
  FROM public.billing_plans
  WHERE id = p_plan_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_plan.code <> 'PRO_SEMESTER'
    OR v_plan.name <> 'Pro Semester'
    OR v_plan.billing_period <> 'SEMESTER' THEN
    RAISE EXCEPTION 'FAST_LAUNCH_PLAN_MISMATCH'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_free
  FROM public.billing_plans
  WHERE code = 'FREE' AND name = 'Free'
    AND billing_period = 'FREE' AND is_active = FALSE
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAST_LAUNCH_FREE_PLAN_MISSING'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_monthly
  FROM public.billing_plans
  WHERE code = 'PRO' AND name = 'Pro'
    AND billing_period = 'MONTHLY' AND is_active = FALSE
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAST_LAUNCH_MONTHLY_BASELINE_MISSING'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
  FROM public.billing_plan_entitlements
  WHERE plan_id IN (v_free, v_monthly, p_plan_id)
  ORDER BY plan_id, feature_key, entitlement_version
  FOR UPDATE;

  SELECT count(*) INTO v_free_count
  FROM public.billing_plan_entitlements
  WHERE plan_id = v_free AND entitlement_version = 'free-v1';
  SELECT count(*) INTO v_monthly_count
  FROM public.billing_plan_entitlements
  WHERE plan_id = v_monthly AND entitlement_version = 'pro-v1';
  SELECT count(*) INTO v_semester_count
  FROM public.billing_plan_entitlements
  WHERE plan_id = p_plan_id AND entitlement_version = 'pro-semester-v1';

  IF v_free_count <> 13
    OR v_monthly_count <> 13
    OR v_semester_count <> 13
    OR EXISTS (
      SELECT 1
      FROM public.billing_plan_entitlements AS entitlement
      WHERE (entitlement.plan_id = v_free
          AND entitlement.entitlement_version <> 'free-v1')
        OR (entitlement.plan_id = v_monthly
          AND entitlement.entitlement_version <> 'pro-v1')
        OR (entitlement.plan_id = p_plan_id
          AND entitlement.entitlement_version <> 'pro-semester-v1')
    )
    OR EXISTS (
      SELECT 1
      FROM public.billing_plan_entitlements AS entitlement
      WHERE entitlement.plan_id IN (v_free, v_monthly, p_plan_id)
        AND (entitlement.periodic_limit IS NULL
          OR entitlement.feature_key <> ALL(v_approved_features))
    )
    OR EXISTS (
      SELECT 1
      FROM public.billing_plan_entitlements AS monthly
      FULL JOIN public.billing_plan_entitlements AS semester
        ON semester.plan_id = p_plan_id
        AND semester.entitlement_version = 'pro-semester-v1'
        AND semester.feature_key = monthly.feature_key
      WHERE monthly.plan_id = v_monthly
        AND monthly.entitlement_version = 'pro-v1'
        AND (semester.id IS NULL
          OR semester.periodic_limit IS DISTINCT FROM monthly.periodic_limit * 5
          OR semester.credit_grant IS DISTINCT FROM monthly.credit_grant
          OR semester.configuration IS DISTINCT FROM monthly.configuration)
    )
    OR EXISTS (
      SELECT 1
      FROM public.billing_plan_entitlements AS semester
      LEFT JOIN public.billing_plan_entitlements AS monthly
        ON monthly.plan_id = v_monthly
        AND monthly.entitlement_version = 'pro-v1'
        AND monthly.feature_key = semester.feature_key
      WHERE semester.plan_id = p_plan_id
        AND semester.entitlement_version = 'pro-semester-v1'
        AND monthly.id IS NULL
    ) THEN
    RAISE EXCEPTION 'FAST_LAUNCH_ENTITLEMENT_MISMATCH'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.billing_assert_semester_plan(UUID)
FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
