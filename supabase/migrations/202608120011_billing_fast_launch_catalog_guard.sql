-- Forward-only guard for the approved fast-launch catalog. Signatures remain
-- unchanged so existing service-role callers continue to use the same RPCs.

CREATE OR REPLACE FUNCTION public.billing_assert_semester_plan(p_plan_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_plan public.billing_plans%ROWTYPE; v_free UUID; v_free_count INTEGER; v_pro_count INTEGER;
BEGIN
  LOCK TABLE public.billing_plans, public.billing_products, public.billing_plan_entitlements IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_plan FROM public.billing_plans WHERE id=p_plan_id FOR UPDATE;
  IF NOT FOUND OR v_plan.code <> 'PRO_SEMESTER' OR v_plan.name <> 'Pro Semester'
    OR v_plan.billing_period <> 'SEMESTER' THEN
    RAISE EXCEPTION 'FAST_LAUNCH_PLAN_MISMATCH' USING ERRCODE='check_violation';
  END IF;
  SELECT id INTO v_free FROM public.billing_plans WHERE code='FREE' AND name='Free' AND billing_period='FREE' AND is_active=FALSE FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAST_LAUNCH_FREE_PLAN_MISSING' USING ERRCODE='check_violation'; END IF;

  PERFORM 1 FROM public.billing_plan_entitlements
    WHERE plan_id IN (v_free,p_plan_id) ORDER BY plan_id,feature_key,entitlement_version FOR UPDATE;
  SELECT count(*) INTO v_free_count FROM public.billing_plan_entitlements
    WHERE plan_id=v_free AND entitlement_version='free-v1';
  SELECT count(*) INTO v_pro_count FROM public.billing_plan_entitlements
    WHERE plan_id=p_plan_id AND entitlement_version='pro-semester-v1';
  IF v_free_count <> 13 OR v_pro_count <> 13 OR EXISTS (
    SELECT 1 FROM public.billing_plan_entitlements e
    WHERE (e.plan_id=v_free AND e.entitlement_version<>'free-v1')
       OR (e.plan_id=p_plan_id AND e.entitlement_version<>'pro-semester-v1')
  ) OR EXISTS (
    SELECT 1 FROM public.billing_plan_entitlements e
    WHERE e.plan_id IN (v_free,p_plan_id) AND e.periodic_limit IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.billing_plan_entitlements f
    FULL JOIN public.billing_plan_entitlements s
      ON s.plan_id=p_plan_id AND s.entitlement_version='pro-semester-v1'
      AND s.feature_key=f.feature_key
    WHERE f.plan_id=v_free AND f.entitlement_version='free-v1'
      AND (s.id IS NULL OR s.periodic_limit IS DISTINCT FROM f.periodic_limit * 5
        OR s.credit_grant IS DISTINCT FROM f.credit_grant
        OR s.configuration IS DISTINCT FROM f.configuration)
  ) OR EXISTS (
    SELECT 1 FROM public.billing_plan_entitlements s
    LEFT JOIN public.billing_plan_entitlements f
      ON f.plan_id=v_free AND f.entitlement_version='free-v1' AND f.feature_key=s.feature_key
    WHERE s.plan_id=p_plan_id AND s.entitlement_version='pro-semester-v1' AND f.id IS NULL
  ) THEN
    RAISE EXCEPTION 'FAST_LAUNCH_ENTITLEMENT_MISMATCH' USING ERRCODE='check_violation';
  END IF;
END; $$;

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
    IF p_plan_id IS NULL OR btrim(p_code)<>'PRO_SEMESTER' OR btrim(p_name)<>'Pro Semester' OR p_billing_period<>'SEMESTER' THEN
      RAISE EXCEPTION 'PLAN_ACTIVATION_NOT_APPROVED' USING ERRCODE='check_violation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fast-launch-plan:'||p_plan_id::TEXT,0));
    PERFORM public.billing_assert_semester_plan(p_plan_id);
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
    AND (NOT p_is_active OR btrim(p_code)<>'PRO_SEMESTER' OR btrim(p_name)<>'Pro Semester' OR p_billing_period<>'SEMESTER') THEN
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
    IF btrim(p_sku)='PRO_SEMESTER' THEN
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
