BEGIN;

LOCK TABLE public.billing_plans, public.billing_products, public.billing_plan_entitlements IN SHARE ROW EXCLUSIVE MODE;
UPDATE public.billing_products SET is_active=false WHERE sku NOT IN ('PRO_MONTHLY','PRO_SEMESTER','CREDIT_PACK_100');
UPDATE public.billing_plans SET is_active=false WHERE code NOT IN ('PRO','PRO_SEMESTER');

INSERT INTO public.billing_plans (
  code,
  name,
  billing_period,
  is_active
)
VALUES
  ('PRO', 'Pro', 'MONTHLY', true),
  ('PRO_SEMESTER', 'Pro Semester', 'SEMESTER', true)
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
    ('PRO_MONTHLY', 'Pro Monthly', 'SUBSCRIPTION', 'PRO', 1990, 'CNY', 30, 0, 'pro-v1', true),
    ('PRO_SEMESTER', 'Pro Semester', 'SUBSCRIPTION', 'PRO_SEMESTER', 7900, 'CNY', 150, 0, 'pro-semester-v1', true),
    ('CREDIT_PACK_100', 'Credit Pack 100', 'CREDIT_PACK', NULL, 990, 'CNY', NULL, 100, 'credit-v1', true)
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
    AND billing_period = 'MONTHLY'
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

CREATE OR REPLACE FUNCTION public.billing_admin_upsert_plan(
  p_admin_user_id UUID, p_plan_id UUID, p_code TEXT, p_name TEXT, p_description TEXT,
  p_billing_period TEXT, p_is_active BOOLEAN, p_reason TEXT, p_idempotency_key TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_id UUID; v_audit UUID; v_before JSONB; v_existing public.billing_admin_audit_logs%ROWTYPE; v_request_hash TEXT;
BEGIN
  PERFORM public.billing_require_write_admin(p_admin_user_id);
  LOCK TABLE public.billing_plans, public.billing_products, public.billing_plan_entitlements IN SHARE ROW EXCLUSIVE MODE;
  IF NULLIF(btrim(p_reason),'') IS NULL OR NULLIF(btrim(p_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'reason required'; END IF;
  IF p_is_active THEN
    IF p_plan_id IS NULL OR NOT (
      (btrim(p_code)='PRO' AND btrim(p_name)='Pro' AND p_billing_period='MONTHLY')
      OR (btrim(p_code)='PRO_SEMESTER' AND btrim(p_name)='Pro Semester' AND p_billing_period='SEMESTER')
    ) THEN
      RAISE EXCEPTION 'PLAN_ACTIVATION_NOT_APPROVED' USING ERRCODE='check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fast-launch-plan:'||p_plan_id::TEXT,0));
    IF btrim(p_code)='PRO_SEMESTER' THEN
      PERFORM public.billing_assert_semester_plan(p_plan_id);
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.billing_plans WHERE id=p_plan_id AND code='PRO' AND name='Pro' AND billing_period='MONTHLY') THEN
        RAISE EXCEPTION 'FAST_LAUNCH_PLAN_MISMATCH' USING ERRCODE='check_violation';
      END IF;
      PERFORM public.billing_assert_semester_plan((SELECT id FROM public.billing_plans WHERE code='PRO_SEMESTER'));
    END IF;
  END IF;
  v_request_hash := encode(extensions.digest(jsonb_build_object('actor',p_admin_user_id,'plan',p_plan_id,'code',btrim(p_code),'name',btrim(p_name),'description',p_description,'period',p_billing_period,'active',p_is_active,'reason',btrim(p_reason))::TEXT,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-plan:'||p_idempotency_key,0));
  SELECT * INTO v_existing FROM public.billing_admin_audit_logs WHERE action='UPSERT_PLAN' AND after_value->>'idempotency_key'=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.after_value->>'request_hash' IS DISTINCT FROM v_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='data_exception'; END IF;
    RETURN jsonb_build_object('status','ALREADY_APPLIED','audit_id',v_existing.id,'resource_id',v_existing.target_id);
  END IF;
  SELECT to_jsonb(p) INTO v_before FROM public.billing_plans p WHERE id=p_plan_id FOR UPDATE;
  IF v_before IS NOT NULL AND v_before->>'code' IS DISTINCT FROM btrim(p_code) THEN
    RAISE EXCEPTION 'PLAN_IDENTITY_MUTATION' USING ERRCODE='check_violation';
  END IF;
  IF v_before IS NOT NULL AND EXISTS (SELECT 1 FROM public.billing_products WHERE plan_id=p_plan_id AND is_active)
    AND (NOT p_is_active OR NOT (
      (btrim(p_code)='PRO' AND btrim(p_name)='Pro' AND p_billing_period='MONTHLY')
      OR (btrim(p_code)='PRO_SEMESTER' AND btrim(p_name)='Pro Semester' AND p_billing_period='SEMESTER')
    )) THEN
    RAISE EXCEPTION 'PLAN_IN_USE' USING ERRCODE='check_violation';
  END IF;
  INSERT INTO public.billing_plans(id,code,name,description,billing_period,is_active)
  VALUES(COALESCE(p_plan_id,extensions.gen_random_uuid()),btrim(p_code),btrim(p_name),p_description,p_billing_period,p_is_active)
  ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,description=EXCLUDED.description,billing_period=EXCLUDED.billing_period,is_active=EXCLUDED.is_active,updated_at=now() RETURNING id INTO v_id;
  INSERT INTO public.billing_admin_audit_logs(actor_user_id,action,target_type,target_id,reason,before_value,after_value)
  VALUES(p_admin_user_id,'UPSERT_PLAN','PLAN',v_id::TEXT,btrim(p_reason),v_before,jsonb_build_object('plan_id',v_id,'idempotency_key',p_idempotency_key,'request_hash',v_request_hash)) RETURNING id INTO v_audit;
  RETURN jsonb_build_object('status','APPLIED','audit_id',v_audit,'resource_id',v_id);
END; $$;

CREATE OR REPLACE FUNCTION public.billing_admin_upsert_product(
  p_admin_user_id UUID, p_product_id UUID, p_plan_id UUID, p_sku TEXT, p_name TEXT,
  p_description TEXT, p_product_type TEXT, p_price_minor BIGINT, p_currency TEXT,
  p_duration_days INTEGER, p_credit_grant BIGINT, p_entitlement_version TEXT,
  p_is_active BOOLEAN, p_reason TEXT, p_idempotency_key TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_id UUID; v_audit UUID; v_before JSONB; v_existing public.billing_admin_audit_logs%ROWTYPE; v_request_hash TEXT;
BEGIN
  PERFORM public.billing_require_write_admin(p_admin_user_id);
  LOCK TABLE public.billing_plans, public.billing_products, public.billing_plan_entitlements IN SHARE ROW EXCLUSIVE MODE;
  IF p_price_minor < 0 OR p_currency <> 'CNY' OR NULLIF(btrim(p_reason),'') IS NULL OR NULLIF(btrim(p_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'invalid product'; END IF;
  IF p_is_active THEN
    IF btrim(p_sku)='PRO_MONTHLY' THEN
      IF p_plan_id IS NULL OR btrim(p_name) IS DISTINCT FROM 'Pro Monthly' OR p_product_type IS DISTINCT FROM 'SUBSCRIPTION' OR p_price_minor IS DISTINCT FROM 1990 OR p_currency IS DISTINCT FROM 'CNY' OR p_duration_days IS DISTINCT FROM 30 OR p_credit_grant IS DISTINCT FROM 0 OR p_entitlement_version IS DISTINCT FROM 'pro-v1' THEN
        RAISE EXCEPTION 'PRODUCT_ACTIVATION_CONFIG_MISMATCH' USING ERRCODE='check_violation';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('fast-launch-plan:'||p_plan_id::TEXT,0));
      IF NOT EXISTS (SELECT 1 FROM public.billing_plans WHERE id=p_plan_id AND code='PRO' AND name='Pro' AND billing_period='MONTHLY' AND is_active) THEN
        RAISE EXCEPTION 'FAST_LAUNCH_PLAN_INACTIVE' USING ERRCODE='check_violation';
      END IF;
      PERFORM public.billing_assert_semester_plan((SELECT id FROM public.billing_plans WHERE code='PRO_SEMESTER'));
    ELSIF btrim(p_sku)='PRO_SEMESTER' THEN
      IF p_plan_id IS NULL OR btrim(p_name)<>'Pro Semester' OR p_product_type<>'SUBSCRIPTION' OR p_price_minor<>7900 OR p_currency<>'CNY' OR p_duration_days<>150 OR p_credit_grant<>0 OR p_entitlement_version<>'pro-semester-v1' THEN
        RAISE EXCEPTION 'PRODUCT_ACTIVATION_CONFIG_MISMATCH' USING ERRCODE='check_violation';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('fast-launch-plan:'||p_plan_id::TEXT,0));
      PERFORM public.billing_assert_semester_plan(p_plan_id);
      IF NOT EXISTS (SELECT 1 FROM public.billing_plans v_plan WHERE v_plan.id=p_plan_id AND v_plan.is_active) THEN
        RAISE EXCEPTION 'FAST_LAUNCH_PLAN_INACTIVE' USING ERRCODE='check_violation';
      END IF;
    ELSIF btrim(p_sku)='CREDIT_PACK_100' THEN
      IF p_plan_id IS NOT NULL OR btrim(p_name)<>'Credit Pack 100' OR p_product_type<>'CREDIT_PACK' OR p_price_minor<>990 OR p_currency<>'CNY' OR p_duration_days IS NOT NULL OR p_credit_grant<>100 OR p_entitlement_version<>'credit-v1' THEN
        RAISE EXCEPTION 'PRODUCT_ACTIVATION_CONFIG_MISMATCH' USING ERRCODE='check_violation';
      END IF;
    ELSE RAISE EXCEPTION 'PRODUCT_ACTIVATION_NOT_APPROVED' USING ERRCODE='check_violation'; END IF;
  END IF;
  v_request_hash := encode(extensions.digest(jsonb_build_object('actor',p_admin_user_id,'product',p_product_id,'plan',p_plan_id,'sku',btrim(p_sku),'name',btrim(p_name),'description',p_description,'type',p_product_type,'price',p_price_minor,'currency',p_currency,'days',p_duration_days,'credits',p_credit_grant,'version',p_entitlement_version,'active',p_is_active,'reason',btrim(p_reason))::TEXT,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-product:'||p_idempotency_key,0));
  SELECT * INTO v_existing FROM public.billing_admin_audit_logs WHERE action='UPSERT_PRODUCT' AND after_value->>'idempotency_key'=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.after_value->>'request_hash' IS DISTINCT FROM v_request_hash THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='data_exception'; END IF;
    RETURN jsonb_build_object('status','ALREADY_APPLIED','audit_id',v_existing.id,'resource_id',v_existing.target_id);
  END IF;
  SELECT to_jsonb(p) INTO v_before FROM public.billing_products p WHERE id=p_product_id FOR UPDATE;
  IF v_before IS NOT NULL AND v_before->>'sku' IS DISTINCT FROM btrim(p_sku) THEN
    RAISE EXCEPTION 'PRODUCT_IDENTITY_MUTATION' USING ERRCODE='check_violation';
  END IF;
  INSERT INTO public.billing_products(id,plan_id,sku,name,description,product_type,price_minor,currency,duration_days,credit_grant,entitlement_version,is_active)
  VALUES(COALESCE(p_product_id,extensions.gen_random_uuid()),p_plan_id,btrim(p_sku),btrim(p_name),p_description,p_product_type,p_price_minor,p_currency,p_duration_days,p_credit_grant,p_entitlement_version,p_is_active)
  ON CONFLICT(id) DO UPDATE SET plan_id=EXCLUDED.plan_id,sku=EXCLUDED.sku,name=EXCLUDED.name,description=EXCLUDED.description,product_type=EXCLUDED.product_type,price_minor=EXCLUDED.price_minor,currency=EXCLUDED.currency,duration_days=EXCLUDED.duration_days,credit_grant=EXCLUDED.credit_grant,entitlement_version=EXCLUDED.entitlement_version,is_active=EXCLUDED.is_active,updated_at=now() RETURNING id INTO v_id;
  INSERT INTO public.billing_admin_audit_logs(actor_user_id,action,target_type,target_id,reason,before_value,after_value)
  VALUES(p_admin_user_id,'UPSERT_PRODUCT','PRODUCT',v_id::TEXT,btrim(p_reason),v_before,jsonb_build_object('product_id',v_id,'idempotency_key',p_idempotency_key,'request_hash',v_request_hash)) RETURNING id INTO v_audit;
  RETURN jsonb_build_object('status','APPLIED','audit_id',v_audit,'resource_id',v_id);
END; $$;

REVOKE ALL ON FUNCTION public.billing_assert_semester_plan(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_admin_upsert_plan(UUID,UUID,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_admin_upsert_product(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,INTEGER,BIGINT,TEXT,BOOLEAN,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_admin_upsert_plan(UUID,UUID,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_admin_upsert_product(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,INTEGER,BIGINT,TEXT,BOOLEAN,TEXT,TEXT) TO service_role;


-- One transaction-scoped user lock covers direct order inserts and the
-- subscription INSERT inside the existing atomic settlement RPC. Its validated
-- terminal replay branches return before this INSERT, so they stay idempotent.
CREATE OR REPLACE FUNCTION public.billing_assert_subscription_available(p_user_id UUID, p_order_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing-subscription:' || p_user_id::TEXT, 0));
  IF EXISTS (
    SELECT 1 FROM public.billing_subscriptions
    WHERE user_id = p_user_id AND status = 'ACTIVE' AND ends_at > clock_timestamp()
  ) OR EXISTS (
    SELECT 1 FROM public.billing_orders
    WHERE user_id = p_user_id AND snapshot_product_type = 'SUBSCRIPTION'
      AND status = 'PENDING' AND expires_at > clock_timestamp()
      AND id IS DISTINCT FROM p_order_id
  ) THEN
    RAISE EXCEPTION 'ACTIVE_SUBSCRIPTION_EXISTS' USING ERRCODE = 'P2201';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_guard_subscription_order()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.snapshot_product_type = 'SUBSCRIPTION' THEN
    PERFORM public.billing_assert_subscription_available(NEW.user_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_guard_subscription_activation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.billing_assert_subscription_available(NEW.user_id, NEW.source_order_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS billing_subscription_order_gate ON public.billing_orders;
CREATE TRIGGER billing_subscription_order_gate BEFORE INSERT ON public.billing_orders
FOR EACH ROW EXECUTE FUNCTION public.billing_guard_subscription_order();
DROP TRIGGER IF EXISTS billing_subscription_activation_gate ON public.billing_subscriptions;
CREATE TRIGGER billing_subscription_activation_gate BEFORE INSERT ON public.billing_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.billing_guard_subscription_activation();

REVOKE ALL ON FUNCTION public.billing_assert_subscription_available(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.billing_guard_subscription_order() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.billing_guard_subscription_activation() FROM PUBLIC, anon, authenticated, service_role;

-- Validate the final catalog before committing any activation.
SELECT public.billing_assert_semester_plan(id) FROM public.billing_plans WHERE code='PRO_SEMESTER';
COMMIT;
