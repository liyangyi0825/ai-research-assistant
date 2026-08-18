BEGIN;

ALTER TABLE public.billing_refunds
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT;

ALTER TABLE public.billing_refunds
  DROP CONSTRAINT IF EXISTS billing_refunds_claim_state_check;
ALTER TABLE public.billing_refunds
  ADD CONSTRAINT billing_refunds_claim_state_check CHECK (
    (
      status = 'PENDING'
      AND completed_at IS NULL
      AND (
        (claim_token IS NULL AND claim_expires_at IS NULL)
        OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
      )
    )
    OR (
      status = 'FAILED'
      AND claim_token IS NULL
      AND claim_expires_at IS NULL
      AND completed_at IS NULL
      AND NULLIF(btrim(last_error_code), '') IS NOT NULL
    )
    OR (
      status = 'SUCCEEDED'
      AND claim_token IS NULL
      AND claim_expires_at IS NULL
      AND last_error_code IS NULL
      AND NULLIF(btrim(provider_refund_id), '') IS NOT NULL
      AND completed_at IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS billing_refunds_claim_expiry_idx
  ON public.billing_refunds (claim_expires_at)
  WHERE ((status = 'PENDING'::TEXT) AND (claim_token IS NOT NULL));

CREATE OR REPLACE FUNCTION public.billing_assert_refund_reversible(
  p_order_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.billing_orders%ROWTYPE;
  v_subscription public.billing_subscriptions%ROWTYPE;
  v_credit_ledger public.billing_credit_ledger%ROWTYPE;
  v_credit_account public.billing_credit_accounts%ROWTYPE;
  v_subscription_count BIGINT;
  v_expected_entitlement_count BIGINT := 0;
  v_actual_entitlement_count BIGINT := 0;
  v_expected_quota_count BIGINT := 0;
  v_actual_quota_count BIGINT := 0;
  v_credit_ledger_count BIGINT := 0;
  v_credit_grant BIGINT := 0;
BEGIN
  SELECT * INTO v_order
  FROM public.billing_orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_order.status <> 'REFUNDING'
     OR v_order.refund_status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'refund benefits are not reversible'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_order.snapshot_product_type = 'SUBSCRIPTION' THEN
    SELECT count(*) INTO v_subscription_count
    FROM public.billing_subscriptions
    WHERE source_order_id = v_order.id
      AND user_id = v_order.user_id
      AND plan_id = v_order.snapshot_plan_id
      AND status = 'ACTIVE';
    IF v_subscription_count <> 1 THEN
      RAISE EXCEPTION 'refund subscription state mismatch'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT * INTO v_subscription
    FROM public.billing_subscriptions
    WHERE source_order_id = v_order.id
      AND user_id = v_order.user_id
      AND plan_id = v_order.snapshot_plan_id
      AND status = 'ACTIVE'
    FOR UPDATE;

    v_expected_entitlement_count := jsonb_array_length(v_order.snapshot_entitlements);
    SELECT count(*) INTO v_actual_entitlement_count
    FROM public.billing_user_entitlements
    WHERE source_order_id = v_order.id
      AND user_id = v_order.user_id
      AND source_type = 'PLAN';
    IF v_actual_entitlement_count <> v_expected_entitlement_count OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_order.snapshot_entitlements) AS snapshot(value)
      LEFT JOIN public.billing_user_entitlements AS entitlement
        ON entitlement.source_order_id = v_order.id
       AND entitlement.user_id = v_order.user_id
       AND entitlement.source_type = 'PLAN'
       AND entitlement.feature_key = snapshot.value ->> 'feature_key'
      WHERE entitlement.id IS NULL
         OR entitlement.entitlement_value IS DISTINCT FROM (snapshot.value - 'credit_grant')
         OR entitlement.valid_from IS DISTINCT FROM v_subscription.starts_at
         OR entitlement.valid_until IS DISTINCT FROM v_subscription.ends_at
    ) THEN
      RAISE EXCEPTION 'refund entitlement state mismatch'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT count(*) INTO v_expected_quota_count
    FROM jsonb_array_elements(v_order.snapshot_entitlements) AS snapshot(value)
    WHERE snapshot.value -> 'periodic_limit' <> 'null'::JSONB;
    SELECT count(*) INTO v_actual_quota_count
    FROM public.billing_usage_quotas
    WHERE subscription_id = v_subscription.id
      AND user_id = v_order.user_id;
    IF v_actual_quota_count <> v_expected_quota_count OR EXISTS (
      SELECT 1
      FROM public.billing_usage_quotas AS quota
      LEFT JOIN LATERAL (
        SELECT snapshot.value
        FROM jsonb_array_elements(v_order.snapshot_entitlements) AS snapshot(value)
        WHERE snapshot.value ->> 'feature_key' = quota.feature_key
          AND snapshot.value -> 'periodic_limit' <> 'null'::JSONB
      ) AS expected ON TRUE
      WHERE quota.subscription_id = v_subscription.id
        AND (
          quota.user_id IS DISTINCT FROM v_order.user_id
          OR expected.value IS NULL
          OR quota.quota_limit IS DISTINCT FROM (expected.value ->> 'periodic_limit')::BIGINT
          OR quota.period_start IS DISTINCT FROM v_subscription.starts_at
          OR quota.period_end IS DISTINCT FROM v_subscription.ends_at
          OR quota.reserved_units <> 0
          OR quota.used_units <> 0
        )
    ) THEN
      RAISE EXCEPTION 'refund quota state mismatch'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.billing_usage_records AS usage
      JOIN public.billing_usage_quotas AS quota ON quota.id = usage.quota_id
      WHERE quota.subscription_id = v_subscription.id
        AND quota.user_id = v_order.user_id
        AND usage.user_id = v_order.user_id
        AND usage.status IN ('RESERVED', 'FINALIZED')
    ) THEN
      RAISE EXCEPTION 'refund subscription has usage'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT COALESCE(sum(COALESCE((snapshot.value ->> 'credit_grant')::BIGINT, 0)), 0)
      INTO v_credit_grant
    FROM jsonb_array_elements(v_order.snapshot_entitlements) AS snapshot(value);
  ELSE
    SELECT count(*) INTO v_subscription_count
    FROM public.billing_subscriptions
    WHERE source_order_id = v_order.id;
    SELECT count(*) INTO v_actual_entitlement_count
    FROM public.billing_user_entitlements
    WHERE source_order_id = v_order.id
      AND source_type = 'PLAN';
    IF v_subscription_count <> 0 OR v_actual_entitlement_count <> 0 THEN
      RAISE EXCEPTION 'refund credit pack state mismatch'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    v_credit_grant := v_order.snapshot_credit_grant;
  END IF;

  SELECT count(*) INTO v_credit_ledger_count
  FROM public.billing_credit_ledger
  WHERE user_id = v_order.user_id
    AND reference_type = 'ORDER'
    AND reference_id = v_order.id::TEXT;
  IF (v_credit_grant = 0 AND v_credit_ledger_count <> 0)
     OR (v_credit_grant > 0 AND v_credit_ledger_count <> 1) THEN
    RAISE EXCEPTION 'refund credit settlement mismatch'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_credit_grant > 0 THEN
    SELECT * INTO v_credit_ledger
    FROM public.billing_credit_ledger
    WHERE user_id = v_order.user_id
      AND reference_type = 'ORDER'
      AND reference_id = v_order.id::TEXT
    FOR UPDATE;
    IF v_credit_ledger.entry_type IS DISTINCT FROM CASE
         WHEN v_order.snapshot_product_type = 'CREDIT_PACK' THEN 'PURCHASE'
         ELSE 'GRANT'
       END
       OR v_credit_ledger.delta_available IS DISTINCT FROM v_credit_grant
       OR v_credit_ledger.delta_reserved IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'refund credit grant mismatch'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT * INTO v_credit_account
    FROM public.billing_credit_accounts
    WHERE id = v_credit_ledger.account_id
      AND user_id = v_order.user_id
      AND currency = 'CREDITS'
    FOR UPDATE;
    IF NOT FOUND
       OR v_credit_account.available_balance < v_credit_grant
       OR v_credit_account.reserved_balance <> 0 THEN
      RAISE EXCEPTION 'refund credits are no longer reversible'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'subscription_id', v_subscription.id,
    'credit_account_id', v_credit_account.id,
    'credit_grant', v_credit_grant
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_guard_refunding_quota_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.reserved_units > OLD.reserved_units OR NEW.used_units > OLD.used_units)
     AND EXISTS (
       SELECT 1
       FROM public.billing_subscriptions AS subscription
       JOIN public.billing_orders AS billing_order
         ON billing_order.id = subscription.source_order_id
       JOIN public.billing_refund_requests AS refund_request
         ON refund_request.order_id = billing_order.id
        AND refund_request.status = 'APPROVED'
       WHERE subscription.id = NEW.subscription_id
         AND billing_order.status = 'REFUNDING'
         AND billing_order.refund_status = 'REQUESTED'
     ) THEN
    RAISE EXCEPTION 'refund benefits are locked'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS billing_block_refunding_quota_usage
  ON public.billing_usage_quotas;
CREATE TRIGGER billing_block_refunding_quota_usage
BEFORE UPDATE OF reserved_units, used_units ON public.billing_usage_quotas
FOR EACH ROW EXECUTE FUNCTION public.billing_guard_refunding_quota_usage();

CREATE OR REPLACE FUNCTION public.billing_claim_approved_refund(
  p_request_id UUID,
  p_claim_token UUID,
  p_claimed_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request public.billing_refund_requests%ROWTYPE;
  v_order public.billing_orders%ROWTYPE;
  v_payment public.billing_payments%ROWTYPE;
  v_refund public.billing_refunds%ROWTYPE;
  v_payment_count BIGINT;
  v_idempotency_key TEXT;
  v_refund_exists BOOLEAN := FALSE;
  v_claimed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_request_id IS NULL OR p_claim_token IS NULL OR p_claimed_at IS NULL THEN
    RAISE EXCEPTION 'invalid refund claim' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_claimed_at < clock_timestamp() - interval '5 minutes'
     OR p_claimed_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid refund claim time' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing-refund:' || p_request_id::TEXT, 0));

  SELECT * INTO v_request
  FROM public.billing_refund_requests
  WHERE id = p_request_id
  FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'approved refund request not found'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT * INTO v_order
  FROM public.billing_orders
  WHERE id = v_request.order_id
  FOR UPDATE;
  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM v_request.user_id THEN
    RAISE EXCEPTION 'refund order contract mismatch'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  v_idempotency_key := 'billing-refund:' || p_request_id::TEXT;
  SELECT * INTO v_refund
  FROM public.billing_refunds
  WHERE refund_request_id = p_request_id
  FOR UPDATE;
  v_refund_exists := FOUND;

  IF v_refund_exists AND v_refund.status = 'SUCCEEDED' THEN
    SELECT * INTO v_payment
    FROM public.billing_payments
    WHERE id = v_refund.payment_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_refund.order_id IS DISTINCT FROM v_order.id
       OR v_refund.user_id IS DISTINCT FROM v_order.user_id
       OR v_refund.provider IS DISTINCT FROM v_order.provider
       OR v_refund.refunded_amount_minor IS DISTINCT FROM v_order.amount_minor
       OR v_refund.currency IS DISTINCT FROM v_order.currency
       OR v_refund.idempotency_key IS DISTINCT FROM v_idempotency_key
       OR v_order.status <> 'REFUNDED'
       OR v_order.refund_status <> 'FULL'
       OR v_payment.order_id IS DISTINCT FROM v_order.id
       OR v_payment.user_id IS DISTINCT FROM v_order.user_id
       OR v_payment.provider IS DISTINCT FROM v_order.provider
       OR v_payment.status <> 'REFUNDED'
       OR v_payment.amount_minor IS DISTINCT FROM v_order.amount_minor
       OR v_payment.currency IS DISTINCT FROM v_order.currency THEN
      RAISE EXCEPTION 'refund replay contract mismatch' USING ERRCODE = 'data_exception';
    END IF;
    RETURN jsonb_build_object(
      'status', 'SUCCEEDED',
      'provider_refund_id', v_refund.provider_refund_id,
      'provider_transaction_id', v_payment.provider_transaction_id,
      'refunded_amount_minor', v_refund.refunded_amount_minor,
      'currency', v_refund.currency
    );
  END IF;

  IF v_order.status <> 'REFUNDING'
     OR v_order.refund_status <> 'REQUESTED'
     OR v_request.requested_amount_minor IS DISTINCT FROM v_order.amount_minor
     OR v_request.currency IS DISTINCT FROM v_order.currency THEN
    RAISE EXCEPTION 'refund order contract mismatch'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT count(*) INTO v_payment_count
  FROM public.billing_payments
  WHERE order_id = v_order.id
    AND user_id = v_order.user_id
    AND provider = v_order.provider
    AND status = 'PAID';
  IF v_payment_count <> 1 THEN
    RAISE EXCEPTION 'paid refund payment not found'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT * INTO v_payment
  FROM public.billing_payments
  WHERE order_id = v_order.id
    AND user_id = v_order.user_id
    AND provider = v_order.provider
    AND status = 'PAID'
  FOR UPDATE;
  IF v_payment.amount_minor IS DISTINCT FROM v_order.amount_minor
     OR v_payment.currency IS DISTINCT FROM v_order.currency
     OR NULLIF(btrim(v_payment.provider_transaction_id), '') IS NULL THEN
    RAISE EXCEPTION 'refund payment contract mismatch'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_refund_exists
     AND v_refund.status = 'PENDING'
     AND v_refund.claim_token IS DISTINCT FROM p_claim_token
     AND v_refund.claim_expires_at > v_claimed_at THEN
    RETURN jsonb_build_object('status', 'IN_PROGRESS');
  END IF;

  PERFORM public.billing_assert_refund_reversible(v_order.id);

  IF NOT v_refund_exists THEN
    INSERT INTO public.billing_refunds (
      refund_request_id,
      order_id,
      payment_id,
      user_id,
      provider,
      status,
      refunded_amount_minor,
      currency,
      idempotency_key,
      claim_token,
      claim_expires_at,
      last_error_code
    ) VALUES (
      p_request_id,
      v_order.id,
      v_payment.id,
      v_order.user_id,
      v_order.provider,
      'PENDING',
      v_order.amount_minor,
      v_order.currency,
      v_idempotency_key,
      p_claim_token,
      v_claimed_at + interval '5 minutes',
      NULL
    )
    RETURNING * INTO v_refund;
  ELSE
    IF v_refund.order_id IS DISTINCT FROM v_order.id
       OR v_refund.payment_id IS DISTINCT FROM v_payment.id
       OR v_refund.user_id IS DISTINCT FROM v_order.user_id
       OR v_refund.provider IS DISTINCT FROM v_order.provider
       OR v_refund.refunded_amount_minor IS DISTINCT FROM v_order.amount_minor
       OR v_refund.currency IS DISTINCT FROM v_order.currency
       OR v_refund.idempotency_key IS DISTINCT FROM v_idempotency_key THEN
      RAISE EXCEPTION 'refund replay contract mismatch' USING ERRCODE = 'data_exception';
    END IF;
    UPDATE public.billing_refunds
    SET status = 'PENDING',
        provider_refund_id = NULL,
        response_summary = '{}'::JSONB,
        completed_at = NULL,
        claim_token = p_claim_token,
        claim_expires_at = v_claimed_at + interval '5 minutes',
        last_error_code = NULL,
        updated_at = clock_timestamp()
    WHERE id = v_refund.id
    RETURNING * INTO v_refund;
  END IF;

  RETURN jsonb_build_object(
    'status', 'CLAIMED',
    'refund_id', v_refund.id,
    'request_id', v_request.id,
    'order_id', v_order.id,
    'payment_id', v_payment.id,
    'provider', v_order.provider,
    'provider_transaction_id', v_payment.provider_transaction_id,
    'amount_minor', v_order.amount_minor,
    'currency', v_order.currency,
    'idempotency_key', v_idempotency_key
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_complete_refund(
  p_refund_id UUID,
  p_claim_token UUID,
  p_provider_refund_id TEXT,
  p_provider_transaction_id TEXT,
  p_refunded_amount_minor BIGINT,
  p_currency TEXT,
  p_response_summary JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_refund public.billing_refunds%ROWTYPE;
  v_request public.billing_refund_requests%ROWTYPE;
  v_order public.billing_orders%ROWTYPE;
  v_payment public.billing_payments%ROWTYPE;
  v_credit_account public.billing_credit_accounts%ROWTYPE;
  v_benefits JSONB;
  v_subscription_id UUID;
  v_credit_account_id UUID;
  v_credit_grant BIGINT;
  v_completed_at TIMESTAMPTZ;
BEGIN
  IF p_refund_id IS NULL
     OR p_claim_token IS NULL
     OR NULLIF(btrim(p_provider_refund_id), '') IS NULL
     OR NULLIF(btrim(p_provider_transaction_id), '') IS NULL
     OR p_refunded_amount_minor IS NULL
     OR p_refunded_amount_minor <= 0
     OR p_currency <> 'CNY'
     OR p_response_summary IS NULL
     OR jsonb_typeof(p_response_summary) <> 'object' THEN
    RAISE EXCEPTION 'invalid refund completion' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_refund
  FROM public.billing_refunds
  WHERE id = p_refund_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_request
  FROM public.billing_refund_requests
  WHERE id = v_refund.refund_request_id
  FOR UPDATE;
  SELECT * INTO v_order
  FROM public.billing_orders
  WHERE id = v_refund.order_id
  FOR UPDATE;
  SELECT * INTO v_payment
  FROM public.billing_payments
  WHERE id = v_refund.payment_id
  FOR UPDATE;

  IF v_request.id IS NULL
     OR v_order.id IS NULL
     OR v_payment.id IS NULL
     OR v_request.status <> 'APPROVED'
     OR v_request.order_id IS DISTINCT FROM v_order.id
     OR v_request.user_id IS DISTINCT FROM v_order.user_id
     OR v_refund.order_id IS DISTINCT FROM v_order.id
     OR v_refund.payment_id IS DISTINCT FROM v_payment.id
     OR v_refund.user_id IS DISTINCT FROM v_order.user_id
     OR v_refund.provider IS DISTINCT FROM v_order.provider
     OR v_payment.order_id IS DISTINCT FROM v_order.id
     OR v_payment.user_id IS DISTINCT FROM v_order.user_id
     OR v_payment.provider IS DISTINCT FROM v_order.provider
     OR v_request.requested_amount_minor IS DISTINCT FROM v_order.amount_minor
     OR v_refund.refunded_amount_minor IS DISTINCT FROM v_order.amount_minor
     OR v_payment.amount_minor IS DISTINCT FROM v_order.amount_minor
     OR v_request.currency IS DISTINCT FROM v_order.currency
     OR v_refund.currency IS DISTINCT FROM v_order.currency
     OR v_payment.currency IS DISTINCT FROM v_order.currency THEN
    RAISE EXCEPTION 'refund completion contract mismatch' USING ERRCODE = 'data_exception';
  END IF;

  IF p_provider_transaction_id IS DISTINCT FROM v_payment.provider_transaction_id
     OR p_refunded_amount_minor IS DISTINCT FROM v_refund.refunded_amount_minor
     OR p_currency IS DISTINCT FROM v_refund.currency THEN
    RAISE EXCEPTION 'provider refund result mismatch' USING ERRCODE = 'data_exception';
  END IF;

  IF v_refund.status = 'SUCCEEDED' THEN
    IF v_refund.provider_refund_id IS DISTINCT FROM btrim(p_provider_refund_id)
       OR v_order.status <> 'REFUNDED'
       OR v_order.refund_status <> 'FULL'
       OR v_payment.status <> 'REFUNDED' THEN
      RAISE EXCEPTION 'refund completion replay mismatch' USING ERRCODE = 'data_exception';
    END IF;
    RETURN jsonb_build_object(
      'status', 'SUCCEEDED',
      'provider_refund_id', v_refund.provider_refund_id,
      'provider_transaction_id', v_payment.provider_transaction_id,
      'refunded_amount_minor', v_refund.refunded_amount_minor,
      'currency', v_refund.currency
    );
  END IF;

  IF v_refund.status <> 'PENDING'
     OR v_refund.claim_token IS DISTINCT FROM p_claim_token
     OR v_order.status <> 'REFUNDING'
     OR v_order.refund_status <> 'REQUESTED'
     OR v_payment.status <> 'PAID' THEN
    RAISE EXCEPTION 'refund claim is not completable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  v_benefits := public.billing_assert_refund_reversible(v_order.id);
  v_subscription_id := NULLIF(v_benefits ->> 'subscription_id', '')::UUID;
  v_credit_account_id := NULLIF(v_benefits ->> 'credit_account_id', '')::UUID;
  v_credit_grant := COALESCE((v_benefits ->> 'credit_grant')::BIGINT, 0);
  v_completed_at := clock_timestamp();

  IF v_subscription_id IS NOT NULL THEN
    UPDATE public.billing_subscriptions
    SET status = 'CANCELLED',
        ends_at = greatest(v_completed_at, starts_at + interval '1 microsecond'),
        updated_at = v_completed_at
    WHERE id = v_subscription_id
      AND source_order_id = v_order.id
      AND user_id = v_order.user_id
      AND status = 'ACTIVE';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refund subscription transition failed'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    UPDATE public.billing_user_entitlements
    SET valid_until = greatest(v_completed_at, valid_from + interval '1 microsecond'),
        updated_at = v_completed_at
    WHERE source_order_id = v_order.id
      AND user_id = v_order.user_id
      AND source_type = 'PLAN';

    UPDATE public.billing_usage_quotas
    SET quota_limit = 0,
        period_end = greatest(v_completed_at, period_start + interval '1 microsecond'),
        updated_at = v_completed_at
    WHERE subscription_id = v_subscription_id
      AND user_id = v_order.user_id
      AND reserved_units = 0
      AND used_units = 0;
  END IF;

  IF v_credit_grant > 0 THEN
    SELECT * INTO v_credit_account
    FROM public.billing_credit_accounts
    WHERE id = v_credit_account_id
      AND user_id = v_order.user_id
      AND currency = 'CREDITS'
    FOR UPDATE;
    IF NOT FOUND
       OR v_credit_account.available_balance < v_credit_grant
       OR v_credit_account.reserved_balance <> 0 THEN
      RAISE EXCEPTION 'refund credits are no longer reversible'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    UPDATE public.billing_credit_accounts
    SET available_balance = available_balance - v_credit_grant,
        version = version + 1,
        updated_at = v_completed_at
    WHERE id = v_credit_account.id
    RETURNING * INTO v_credit_account;

    INSERT INTO public.billing_credit_ledger (
      account_id,
      user_id,
      entry_type,
      delta_available,
      delta_reserved,
      available_after,
      reserved_after,
      idempotency_key,
      reference_type,
      reference_id,
      metadata
    ) VALUES (
      v_credit_account.id,
      v_order.user_id,
      'ADJUSTMENT',
      -v_credit_grant,
      0,
      v_credit_account.available_balance,
      v_credit_account.reserved_balance,
      'refund:' || v_request.id::TEXT || ':credit-reversal',
      'REFUND',
      v_refund.id::TEXT,
      jsonb_build_object('order_id', v_order.id, 'refund_request_id', v_request.id)
    );
  END IF;

  UPDATE public.billing_refunds
  SET provider_refund_id = btrim(p_provider_refund_id),
      status = 'SUCCEEDED',
      response_summary = p_response_summary,
      completed_at = v_completed_at,
      claim_token = NULL,
      claim_expires_at = NULL,
      last_error_code = NULL,
      updated_at = v_completed_at
  WHERE id = v_refund.id;

  UPDATE public.billing_payments
  SET status = 'REFUNDED',
      updated_at = v_completed_at
  WHERE id = v_payment.id AND status = 'PAID';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund payment transition failed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.billing_orders
  SET status = 'REFUNDED',
      refund_status = 'FULL',
      updated_at = v_completed_at
  WHERE id = v_order.id AND status = 'REFUNDING' AND refund_status = 'REQUESTED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund order transition failed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN jsonb_build_object(
    'status', 'SUCCEEDED',
    'provider_refund_id', btrim(p_provider_refund_id),
    'provider_transaction_id', v_payment.provider_transaction_id,
    'refunded_amount_minor', v_refund.refunded_amount_minor,
    'currency', v_refund.currency
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_fail_refund_claim(
  p_refund_id UUID,
  p_claim_token UUID,
  p_error_code TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_refund public.billing_refunds%ROWTYPE;
BEGIN
  IF p_refund_id IS NULL
     OR p_claim_token IS NULL
     OR NULLIF(btrim(p_error_code), '') IS NULL THEN
    RAISE EXCEPTION 'invalid refund failure' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_refund
  FROM public.billing_refunds
  WHERE id = p_refund_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_refund.status = 'SUCCEEDED' THEN
    RETURN jsonb_build_object('status', 'SUCCEEDED');
  END IF;
  IF v_refund.status <> 'PENDING'
     OR v_refund.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'refund claim cannot be failed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE public.billing_refunds
  SET status = 'FAILED',
      claim_token = NULL,
      claim_expires_at = NULL,
      last_error_code = left(btrim(p_error_code), 120),
      updated_at = clock_timestamp()
  WHERE id = p_refund_id;
  RETURN jsonb_build_object('status', 'RELEASED');
END;
$$;

REVOKE ALL ON FUNCTION public.billing_claim_approved_refund(UUID, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_complete_refund(UUID, UUID, TEXT, TEXT, BIGINT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_fail_refund_claim(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_assert_refund_reversible(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.billing_guard_refunding_quota_usage()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.billing_claim_approved_refund(UUID, UUID, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_complete_refund(UUID, UUID, TEXT, TEXT, BIGINT, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_fail_refund_claim(UUID, UUID, TEXT)
  TO service_role;

COMMIT;
