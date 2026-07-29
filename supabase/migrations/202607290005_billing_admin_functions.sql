-- Forward-only billing administration functions. Run only on a local or isolated test database.
ALTER TABLE public.billing_subscriptions
  ALTER COLUMN source_order_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.billing_require_write_admin(p_admin_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.billing_admins
    WHERE user_id = p_admin_user_id AND role = 'BILLING_ADMIN' AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'active billing write administrator required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_admin_grant_subscription(
  p_admin_user_id UUID, p_user_id UUID, p_plan_id UUID, p_duration_days INTEGER,
  p_reason TEXT, p_idempotency_key TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_audit UUID; v_subscription UUID; v_existing public.billing_admin_audit_logs%ROWTYPE;
  v_request_hash TEXT; v_start TIMESTAMPTZ := now(); v_end TIMESTAMPTZ;
BEGIN
  PERFORM public.billing_require_write_admin(p_admin_user_id);
  IF p_duration_days <= 0 OR p_duration_days > 3660 OR NULLIF(btrim(p_reason), '') IS NULL
     OR NULLIF(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid subscription grant' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'actor',p_admin_user_id,'user',p_user_id,'plan',p_plan_id,'days',p_duration_days,
    'reason',btrim(p_reason))::TEXT,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-sub:' || p_idempotency_key, 0));
  SELECT * INTO v_existing
  FROM public.billing_admin_audit_logs
  WHERE action='GRANT_SUBSCRIPTION' AND after_value->>'idempotency_key'=p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.after_value->>'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='data_exception';
    END IF;
    RETURN jsonb_build_object('status','ALREADY_APPLIED','audit_id',v_existing.id,
      'resource_id',v_existing.after_value->>'subscription_id');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.billing_plans WHERE id=p_plan_id AND is_active) THEN
    RAISE EXCEPTION 'active plan not found' USING ERRCODE = 'no_data_found';
  END IF;
  v_end := v_start + make_interval(days => p_duration_days);
  INSERT INTO public.billing_subscriptions(user_id,plan_id,status,starts_at,ends_at,auto_renew)
  VALUES(p_user_id,p_plan_id,'ACTIVE',v_start,v_end,FALSE) RETURNING id INTO v_subscription;
  INSERT INTO public.billing_user_entitlements(
    user_id,plan_entitlement_id,feature_key,source_type,entitlement_value,valid_from,valid_until
  )
  SELECT p_user_id,e.id,e.feature_key,'ADMIN',e.configuration,v_start,v_end
  FROM public.billing_plan_entitlements e WHERE e.plan_id=p_plan_id;
  INSERT INTO public.billing_usage_quotas(
    user_id,subscription_id,feature_key,period_start,period_end,quota_limit
  )
  SELECT p_user_id,v_subscription,e.feature_key,v_start,v_end,e.periodic_limit
  FROM public.billing_plan_entitlements e
  WHERE e.plan_id=p_plan_id AND e.periodic_limit IS NOT NULL;
  INSERT INTO public.billing_admin_audit_logs(
    actor_user_id,target_user_id,action,target_type,target_id,reason,before_value,after_value
  ) VALUES(p_admin_user_id,p_user_id,'GRANT_SUBSCRIPTION','SUBSCRIPTION',v_subscription::TEXT,btrim(p_reason),
    NULL,jsonb_build_object('subscription_id',v_subscription,'plan_id',p_plan_id,
      'ends_at',v_end,'idempotency_key',p_idempotency_key,'request_hash',v_request_hash)) RETURNING id INTO v_audit;
  RETURN jsonb_build_object('status','APPLIED','audit_id',v_audit,'resource_id',v_subscription);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_admin_review_refund(
  p_admin_user_id UUID, p_request_id UUID, p_decision TEXT,
  p_reason TEXT, p_idempotency_key TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_request public.billing_refund_requests%ROWTYPE; v_order public.billing_orders%ROWTYPE;
  v_audit UUID; v_existing public.billing_admin_audit_logs%ROWTYPE; v_request_hash TEXT; v_updated INTEGER;
BEGIN
  PERFORM public.billing_require_write_admin(p_admin_user_id);
  IF p_decision NOT IN ('APPROVED','REJECTED') OR NULLIF(btrim(p_reason),'') IS NULL
     OR NULLIF(btrim(p_idempotency_key),'') IS NULL THEN
    RAISE EXCEPTION 'invalid refund review' USING ERRCODE='invalid_parameter_value';
  END IF;
  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'actor',p_admin_user_id,'request',p_request_id,'decision',p_decision,
    'reason',btrim(p_reason))::TEXT,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-refund:'||p_idempotency_key,0));
  SELECT * INTO v_existing FROM public.billing_admin_audit_logs
    WHERE action='REVIEW_REFUND' AND after_value->>'idempotency_key'=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.after_value->>'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='data_exception';
    END IF;
    RETURN jsonb_build_object('status','ALREADY_APPLIED','audit_id',v_existing.id,'resource_id',v_existing.target_id);
  END IF;
  SELECT * INTO v_request FROM public.billing_refund_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund request not found' USING ERRCODE='no_data_found'; END IF;
  IF v_request.status <> 'PENDING' THEN RAISE EXCEPTION 'refund already reviewed' USING ERRCODE='object_not_in_prerequisite_state'; END IF;
  SELECT * INTO v_order FROM public.billing_orders WHERE id=v_request.order_id FOR UPDATE;
  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM v_request.user_id
    OR v_order.status <> 'PAID'
    OR v_order.amount_minor IS DISTINCT FROM v_request.requested_amount_minor
    OR v_order.currency IS DISTINCT FROM v_request.currency THEN
    RAISE EXCEPTION 'refund order contract mismatch' USING ERRCODE='object_not_in_prerequisite_state';
  END IF;
  UPDATE public.billing_refund_requests SET status=p_decision,reviewed_by=p_admin_user_id,
    review_note=btrim(p_reason),reviewed_at=now(),updated_at=now() WHERE id=p_request_id;
  UPDATE public.billing_orders SET refund_status=CASE WHEN p_decision='APPROVED' THEN 'REQUESTED' ELSE refund_status END,
    status=CASE WHEN p_decision='APPROVED' THEN 'REFUNDING' ELSE status END,updated_at=now()
    WHERE id=v_request.order_id AND status='PAID';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'refund order transition failed' USING ERRCODE='object_not_in_prerequisite_state'; END IF;
  INSERT INTO public.billing_admin_audit_logs(actor_user_id,target_user_id,action,target_type,target_id,reason,before_value,after_value)
  VALUES(p_admin_user_id,v_request.user_id,'REVIEW_REFUND','REFUND_REQUEST',p_request_id::TEXT,btrim(p_reason),
    jsonb_build_object('status',v_request.status),jsonb_build_object('status',p_decision,'idempotency_key',p_idempotency_key,'request_hash',v_request_hash))
  RETURNING id INTO v_audit;
  RETURN jsonb_build_object('status','APPLIED','audit_id',v_audit,'resource_id',p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_admin_review_invoice(
  p_admin_user_id UUID, p_request_id UUID, p_decision TEXT,
  p_reason TEXT, p_idempotency_key TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_request public.billing_invoice_requests%ROWTYPE; v_order public.billing_orders%ROWTYPE;
  v_audit UUID; v_existing public.billing_admin_audit_logs%ROWTYPE; v_request_hash TEXT;
BEGIN
  PERFORM public.billing_require_write_admin(p_admin_user_id);
  IF p_decision NOT IN ('ISSUED','REJECTED') OR NULLIF(btrim(p_reason),'') IS NULL
     OR NULLIF(btrim(p_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'invalid invoice review'; END IF;
  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'actor',p_admin_user_id,'request',p_request_id,'decision',p_decision,
    'reason',btrim(p_reason))::TEXT,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-invoice:'||p_idempotency_key,0));
  SELECT * INTO v_existing FROM public.billing_admin_audit_logs
    WHERE action='REVIEW_INVOICE' AND after_value->>'idempotency_key'=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.after_value->>'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='data_exception';
    END IF;
    RETURN jsonb_build_object('status','ALREADY_APPLIED','audit_id',v_existing.id,'resource_id',v_existing.target_id);
  END IF;
  SELECT * INTO v_request FROM public.billing_invoice_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'PENDING' THEN RAISE EXCEPTION 'invoice request unavailable'; END IF;
  SELECT * INTO v_order FROM public.billing_orders WHERE id=v_request.order_id FOR UPDATE;
  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM v_request.user_id
    OR v_order.status NOT IN ('PAID','REFUNDING','REFUNDED')
    OR v_order.amount_minor IS DISTINCT FROM v_request.amount_minor
    OR v_order.currency IS DISTINCT FROM v_request.currency THEN
    RAISE EXCEPTION 'invoice order contract mismatch' USING ERRCODE='object_not_in_prerequisite_state';
  END IF;
  UPDATE public.billing_invoice_requests SET status=p_decision,
    issued_at=CASE WHEN p_decision='ISSUED' THEN now() ELSE NULL END,updated_at=now() WHERE id=p_request_id;
  INSERT INTO public.billing_admin_audit_logs(actor_user_id,target_user_id,action,target_type,target_id,reason,before_value,after_value)
  VALUES(p_admin_user_id,v_request.user_id,'REVIEW_INVOICE','INVOICE_REQUEST',p_request_id::TEXT,btrim(p_reason),
    jsonb_build_object('status',v_request.status),jsonb_build_object('status',p_decision,'idempotency_key',p_idempotency_key,'request_hash',v_request_hash))
  RETURNING id INTO v_audit;
  RETURN jsonb_build_object('status','APPLIED','audit_id',v_audit,'resource_id',p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_admin_upsert_plan(
  p_admin_user_id UUID, p_plan_id UUID, p_code TEXT, p_name TEXT, p_description TEXT,
  p_billing_period TEXT, p_is_active BOOLEAN, p_reason TEXT, p_idempotency_key TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_id UUID; v_audit UUID; v_before JSONB; v_existing public.billing_admin_audit_logs%ROWTYPE;
  v_request_hash TEXT;
BEGIN
  PERFORM public.billing_require_write_admin(p_admin_user_id);
  IF NULLIF(btrim(p_reason),'') IS NULL OR NULLIF(btrim(p_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'reason required'; END IF;
  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'actor',p_admin_user_id,'plan',p_plan_id,'code',btrim(p_code),'name',btrim(p_name),
    'description',p_description,'period',p_billing_period,'active',p_is_active,
    'reason',btrim(p_reason))::TEXT,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-plan:'||p_idempotency_key,0));
  SELECT * INTO v_existing FROM public.billing_admin_audit_logs
    WHERE action='UPSERT_PLAN' AND after_value->>'idempotency_key'=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.after_value->>'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='data_exception';
    END IF;
    RETURN jsonb_build_object('status','ALREADY_APPLIED','audit_id',v_existing.id,'resource_id',v_existing.target_id);
  END IF;
  SELECT to_jsonb(p) INTO v_before FROM public.billing_plans p WHERE id=p_plan_id FOR UPDATE;
  INSERT INTO public.billing_plans(id,code,name,description,billing_period,is_active)
  VALUES(COALESCE(p_plan_id,extensions.gen_random_uuid()),btrim(p_code),btrim(p_name),p_description,p_billing_period,p_is_active)
  ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,description=EXCLUDED.description,
    billing_period=EXCLUDED.billing_period,is_active=EXCLUDED.is_active,updated_at=now() RETURNING id INTO v_id;
  INSERT INTO public.billing_admin_audit_logs(actor_user_id,action,target_type,target_id,reason,before_value,after_value)
  VALUES(p_admin_user_id,'UPSERT_PLAN','PLAN',v_id::TEXT,btrim(p_reason),v_before,
    jsonb_build_object('plan_id',v_id,'idempotency_key',p_idempotency_key,'request_hash',v_request_hash)) RETURNING id INTO v_audit;
  RETURN jsonb_build_object('status','APPLIED','audit_id',v_audit,'resource_id',v_id);
END; $$;

CREATE OR REPLACE FUNCTION public.billing_admin_upsert_product(
  p_admin_user_id UUID, p_product_id UUID, p_plan_id UUID, p_sku TEXT, p_name TEXT,
  p_description TEXT, p_product_type TEXT, p_price_minor BIGINT, p_currency TEXT,
  p_duration_days INTEGER, p_credit_grant BIGINT, p_entitlement_version TEXT,
  p_is_active BOOLEAN, p_reason TEXT, p_idempotency_key TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_id UUID; v_audit UUID; v_before JSONB; v_existing public.billing_admin_audit_logs%ROWTYPE;
  v_request_hash TEXT;
BEGIN
  PERFORM public.billing_require_write_admin(p_admin_user_id);
  IF p_price_minor < 0 OR p_currency <> 'CNY' OR NULLIF(btrim(p_reason),'') IS NULL
    OR NULLIF(btrim(p_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'invalid product'; END IF;
  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'actor',p_admin_user_id,'product',p_product_id,'plan',p_plan_id,'sku',btrim(p_sku),
    'name',btrim(p_name),'description',p_description,'type',p_product_type,
    'price',p_price_minor,'currency',p_currency,'days',p_duration_days,'credits',p_credit_grant,
    'version',p_entitlement_version,'active',p_is_active,'reason',btrim(p_reason))::TEXT,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-product:'||p_idempotency_key,0));
  SELECT * INTO v_existing FROM public.billing_admin_audit_logs
    WHERE action='UPSERT_PRODUCT' AND after_value->>'idempotency_key'=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.after_value->>'request_hash' IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='data_exception';
    END IF;
    RETURN jsonb_build_object('status','ALREADY_APPLIED','audit_id',v_existing.id,'resource_id',v_existing.target_id);
  END IF;
  SELECT to_jsonb(p) INTO v_before FROM public.billing_products p WHERE id=p_product_id FOR UPDATE;
  INSERT INTO public.billing_products(id,plan_id,sku,name,description,product_type,price_minor,currency,
    duration_days,credit_grant,entitlement_version,is_active)
  VALUES(COALESCE(p_product_id,extensions.gen_random_uuid()),p_plan_id,btrim(p_sku),btrim(p_name),p_description,
    p_product_type,p_price_minor,p_currency,p_duration_days,p_credit_grant,p_entitlement_version,p_is_active)
  ON CONFLICT(id) DO UPDATE SET plan_id=EXCLUDED.plan_id,sku=EXCLUDED.sku,name=EXCLUDED.name,
    description=EXCLUDED.description,product_type=EXCLUDED.product_type,price_minor=EXCLUDED.price_minor,
    currency=EXCLUDED.currency,duration_days=EXCLUDED.duration_days,credit_grant=EXCLUDED.credit_grant,
    entitlement_version=EXCLUDED.entitlement_version,is_active=EXCLUDED.is_active,updated_at=now()
  RETURNING id INTO v_id;
  INSERT INTO public.billing_admin_audit_logs(actor_user_id,action,target_type,target_id,reason,before_value,after_value)
  VALUES(p_admin_user_id,'UPSERT_PRODUCT','PRODUCT',v_id::TEXT,btrim(p_reason),v_before,
    jsonb_build_object('product_id',v_id,'idempotency_key',p_idempotency_key,'request_hash',v_request_hash)) RETURNING id INTO v_audit;
  RETURN jsonb_build_object('status','APPLIED','audit_id',v_audit,'resource_id',v_id);
END; $$;

REVOKE ALL ON FUNCTION public.billing_require_write_admin(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_admin_grant_subscription(UUID,UUID,UUID,INTEGER,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_admin_review_refund(UUID,UUID,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_admin_review_invoice(UUID,UUID,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_admin_upsert_plan(UUID,UUID,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_admin_upsert_product(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,INTEGER,BIGINT,TEXT,BOOLEAN,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_require_write_admin(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_admin_grant_subscription(UUID,UUID,UUID,INTEGER,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_admin_review_refund(UUID,UUID,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_admin_review_invoice(UUID,UUID,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_admin_upsert_plan(UUID,UUID,TEXT,TEXT,TEXT,TEXT,BOOLEAN,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_admin_upsert_product(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,INTEGER,BIGINT,TEXT,BOOLEAN,TEXT,TEXT) TO service_role;
