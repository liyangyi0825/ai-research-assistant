-- Atomic billing operations. These functions are callable only by service_role.

CREATE OR REPLACE FUNCTION public.billing_settle_paid_order(
  p_order_number TEXT,
  p_provider TEXT,
  p_provider_transaction_id TEXT,
  p_provider_event_id TEXT,
  p_request_idempotency_key TEXT,
  p_amount_minor BIGINT,
  p_currency TEXT,
  p_paid_at TIMESTAMPTZ,
  p_response_summary JSONB DEFAULT '{}'::JSONB,
  p_payload_summary JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.billing_orders%ROWTYPE;
  v_existing_event public.billing_webhook_events%ROWTYPE;
  v_event_id UUID;
  v_subscription_id UUID;
  v_entitlement_end TIMESTAMPTZ;
  v_credit_grant BIGINT := 0;
  v_account public.billing_credit_accounts%ROWTYPE;
BEGIN
  IF NULLIF(btrim(p_order_number), '') IS NULL
    OR NULLIF(btrim(p_provider_transaction_id), '') IS NULL
    OR NULLIF(btrim(p_provider_event_id), '') IS NULL
    OR NULLIF(btrim(p_request_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'payment identifiers are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF upper(p_provider) NOT IN ('MOCK', 'WECHAT', 'ALIPAY') THEN
    RAISE EXCEPTION 'unsupported payment provider'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_amount_minor < 0 OR p_paid_at IS NULL THEN
    RAISE EXCEPTION 'invalid payment amount or paid time'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT *
  INTO v_existing_event
  FROM public.billing_webhook_events
  WHERE provider = upper(p_provider)
    AND provider_event_id = p_provider_event_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_event.order_number <> p_order_number THEN
      RAISE EXCEPTION 'webhook replay payload mismatch'
        USING ERRCODE = 'data_exception';
    END IF;

    SELECT *
    INTO v_order
    FROM public.billing_orders
    WHERE id = v_existing_event.order_id
    FOR UPDATE;

    IF NOT FOUND
      OR v_order.order_number <> p_order_number
      OR v_order.provider <> upper(p_provider)
      OR v_order.amount_minor <> p_amount_minor
      OR v_order.currency <> upper(p_currency)
      OR v_order.expires_at <= p_paid_at
      OR NOT EXISTS (
        SELECT 1
        FROM public.billing_payments
        WHERE order_id = v_order.id
          AND provider = upper(p_provider)
          AND provider_transaction_id = p_provider_transaction_id
          AND amount_minor = p_amount_minor
          AND currency = upper(p_currency)
          AND status = 'PAID'
      ) THEN
      RAISE EXCEPTION 'webhook replay payload mismatch'
        USING ERRCODE = 'data_exception';
    END IF;

    RETURN jsonb_build_object(
      'status', 'ALREADY_PROCESSED',
      'event_status', v_existing_event.status,
      'order_id', v_existing_event.order_id
    );
  END IF;

  INSERT INTO public.billing_webhook_events (
    order_number,
    provider,
    provider_event_id,
    signature_valid,
    status,
    payload_summary
  )
  VALUES (
    p_order_number,
    upper(p_provider),
    p_provider_event_id,
    TRUE,
    'PROCESSING',
    COALESCE(p_payload_summary, '{}'::JSONB)
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT *
    INTO v_existing_event
    FROM public.billing_webhook_events
    WHERE provider = upper(p_provider)
      AND provider_event_id = p_provider_event_id;

    IF v_existing_event.order_number <> p_order_number THEN
      RAISE EXCEPTION 'webhook replay payload mismatch'
        USING ERRCODE = 'data_exception';
    END IF;

    SELECT *
    INTO v_order
    FROM public.billing_orders
    WHERE id = v_existing_event.order_id
    FOR UPDATE;

    IF NOT FOUND
      OR v_order.order_number <> p_order_number
      OR v_order.provider <> upper(p_provider)
      OR v_order.amount_minor <> p_amount_minor
      OR v_order.currency <> upper(p_currency)
      OR v_order.expires_at <= p_paid_at
      OR NOT EXISTS (
        SELECT 1
        FROM public.billing_payments
        WHERE order_id = v_order.id
          AND provider = upper(p_provider)
          AND provider_transaction_id = p_provider_transaction_id
          AND amount_minor = p_amount_minor
          AND currency = upper(p_currency)
          AND status = 'PAID'
      ) THEN
      RAISE EXCEPTION 'webhook replay payload mismatch'
        USING ERRCODE = 'data_exception';
    END IF;

    RETURN jsonb_build_object(
      'status', 'ALREADY_PROCESSED',
      'event_status', v_existing_event.status,
      'order_id', v_existing_event.order_id
    );
  END IF;

  SELECT *
  INTO v_order
  FROM public.billing_orders
  WHERE order_number = p_order_number
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing order not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_order.order_number <> p_order_number THEN
    RAISE EXCEPTION 'order number mismatch'
      USING ERRCODE = 'data_exception';
  END IF;

  IF v_order.provider <> upper(p_provider) THEN
    RAISE EXCEPTION 'payment provider mismatch'
      USING ERRCODE = 'data_exception';
  END IF;

  IF v_order.amount_minor <> p_amount_minor THEN
    RAISE EXCEPTION 'payment amount mismatch'
      USING ERRCODE = 'data_exception';
  END IF;

  IF v_order.currency <> upper(p_currency) THEN
    RAISE EXCEPTION 'payment currency mismatch'
      USING ERRCODE = 'data_exception';
  END IF;

  IF v_order.status <> 'PENDING' THEN
    RAISE EXCEPTION 'order is not pending'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_order.expires_at <= p_paid_at THEN
    RAISE EXCEPTION 'order expired before payment'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.billing_webhook_events
  SET order_id = v_order.id,
      user_id = v_order.user_id,
      updated_at = now()
  WHERE id = v_event_id;

  INSERT INTO public.billing_payments (
    order_id,
    user_id,
    provider,
    provider_transaction_id,
    status,
    amount_minor,
    currency,
    request_idempotency_key,
    response_summary,
    paid_at
  )
  VALUES (
    v_order.id,
    v_order.user_id,
    upper(p_provider),
    p_provider_transaction_id,
    'PAID',
    p_amount_minor,
    upper(p_currency),
    p_request_idempotency_key,
    COALESCE(p_response_summary, '{}'::JSONB),
    p_paid_at
  );

  IF v_order.snapshot_product_type = 'SUBSCRIPTION' THEN
    v_entitlement_end := p_paid_at
      + make_interval(days => v_order.snapshot_duration_days);

    INSERT INTO public.billing_subscriptions (
      user_id,
      plan_id,
      source_order_id,
      status,
      starts_at,
      ends_at,
      auto_renew
    )
    VALUES (
      v_order.user_id,
      v_order.snapshot_plan_id,
      v_order.id,
      'ACTIVE',
      p_paid_at,
      v_entitlement_end,
      FALSE
    )
    ON CONFLICT (source_order_id) DO NOTHING
    RETURNING id INTO v_subscription_id;

    IF v_subscription_id IS NULL THEN
      RAISE EXCEPTION 'order subscription was already granted'
        USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.billing_user_entitlements (
      user_id,
      plan_entitlement_id,
      feature_key,
      source_type,
      source_order_id,
      entitlement_value,
      valid_from,
      valid_until
    )
    SELECT
      v_order.user_id,
      entitlement.id,
      entitlement.feature_key,
      'PLAN',
      v_order.id,
      jsonb_build_object(
        'periodic_limit', entitlement.periodic_limit,
        'configuration', entitlement.configuration
      ),
      p_paid_at,
      v_entitlement_end
    FROM public.billing_plan_entitlements AS entitlement
    WHERE entitlement.plan_id = v_order.snapshot_plan_id
      AND entitlement.entitlement_version = v_order.snapshot_entitlement_version
    ON CONFLICT (user_id, feature_key, source_order_id) DO NOTHING;

    SELECT COALESCE(sum(entitlement.credit_grant), 0)
    INTO v_credit_grant
    FROM public.billing_plan_entitlements AS entitlement
    WHERE entitlement.plan_id = v_order.snapshot_plan_id
      AND entitlement.entitlement_version = v_order.snapshot_entitlement_version;
  ELSE
    v_credit_grant := v_order.snapshot_credit_grant;
  END IF;

  IF v_credit_grant > 0 THEN
    INSERT INTO public.billing_credit_accounts (user_id, currency)
    VALUES (v_order.user_id, 'CREDITS')
    ON CONFLICT (user_id, currency) DO NOTHING;

    SELECT *
    INTO v_account
    FROM public.billing_credit_accounts
    WHERE user_id = v_order.user_id
      AND currency = 'CREDITS'
    FOR UPDATE;

    UPDATE public.billing_credit_accounts
    SET available_balance = available_balance + v_credit_grant,
        version = version + 1,
        updated_at = now()
    WHERE id = v_account.id
    RETURNING * INTO v_account;

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
    )
    VALUES (
      v_account.id,
      v_order.user_id,
      CASE
        WHEN v_order.snapshot_product_type = 'CREDIT_PACK' THEN 'PURCHASE'
        ELSE 'GRANT'
      END,
      v_credit_grant,
      0,
      v_account.available_balance,
      v_account.reserved_balance,
      'settlement:' || p_provider_event_id || ':credit',
      'ORDER',
      v_order.id::TEXT,
      jsonb_build_object('provider', upper(p_provider))
    );
  END IF;

  UPDATE public.billing_orders
  SET status = 'PAID',
      paid_at = p_paid_at,
      updated_at = now()
  WHERE id = v_order.id;

  UPDATE public.billing_webhook_events
  SET status = 'PROCESSED',
      processed_at = now(),
      updated_at = now()
  WHERE id = v_event_id;

  RETURN jsonb_build_object(
    'status', 'PROCESSED',
    'order_id', v_order.id,
    'event_id', v_event_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_reserve_usage(
  p_user_id UUID,
  p_task_idempotency_key TEXT,
  p_feature_key TEXT,
  p_quota_units BIGINT DEFAULT 0,
  p_credit_amount BIGINT DEFAULT 0,
  p_currency TEXT DEFAULT 'CREDITS'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_record public.billing_usage_records%ROWTYPE;
  v_quota public.billing_usage_quotas%ROWTYPE;
  v_account public.billing_credit_accounts%ROWTYPE;
BEGIN
  IF NULLIF(btrim(p_task_idempotency_key), '') IS NULL
    OR NULLIF(btrim(p_feature_key), '') IS NULL THEN
    RAISE EXCEPTION 'task idempotency key and feature are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_quota_units < 0 OR p_credit_amount < 0
    OR (p_quota_units = 0 AND p_credit_amount = 0) THEN
    RAISE EXCEPTION 'usage reservation must be positive'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF upper(p_currency) <> 'CREDITS' THEN
    RAISE EXCEPTION 'unsupported credit currency'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_task_idempotency_key, 0));

  SELECT *
  INTO v_record
  FROM public.billing_usage_records
  WHERE task_idempotency_key = p_task_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_record.user_id <> p_user_id
      OR v_record.feature_key <> p_feature_key
      OR v_record.quota_units <> p_quota_units
      OR v_record.credit_amount <> p_credit_amount THEN
      RAISE EXCEPTION 'task idempotency key payload mismatch'
        USING ERRCODE = 'data_exception';
    END IF;

    RETURN jsonb_build_object(
      'status', v_record.status,
      'usage_record_id', v_record.id,
      'idempotent', TRUE
    );
  END IF;

  IF p_quota_units > 0 THEN
    SELECT *
    INTO v_quota
    FROM public.billing_usage_quotas
    WHERE user_id = p_user_id
      AND feature_key = p_feature_key
      AND period_start <= now()
      AND period_end > now()
    ORDER BY period_end
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'active usage quota not found'
        USING ERRCODE = 'insufficient_resources';
    END IF;

    UPDATE public.billing_usage_quotas
    SET reserved_units = reserved_units + p_quota_units,
        updated_at = now()
    WHERE id = v_quota.id
      AND reserved_units + used_units + p_quota_units <= quota_limit
    RETURNING * INTO v_quota;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'usage quota exceeded'
        USING ERRCODE = 'insufficient_resources';
    END IF;
  END IF;

  IF p_credit_amount > 0 THEN
    SELECT *
    INTO v_account
    FROM public.billing_credit_accounts
    WHERE user_id = p_user_id
      AND currency = upper(p_currency)
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit account not found'
        USING ERRCODE = 'insufficient_resources';
    END IF;

    UPDATE public.billing_credit_accounts
    SET available_balance = available_balance - p_credit_amount,
        reserved_balance = reserved_balance + p_credit_amount,
        version = version + 1,
        updated_at = now()
    WHERE id = v_account.id
      AND available_balance >= p_credit_amount
    RETURNING * INTO v_account;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'insufficient credit balance'
        USING ERRCODE = 'insufficient_resources';
    END IF;
  END IF;

  INSERT INTO public.billing_usage_records (
    user_id,
    quota_id,
    credit_account_id,
    task_idempotency_key,
    feature_key,
    status,
    quota_units,
    credit_amount,
    currency
  )
  VALUES (
    p_user_id,
    v_quota.id,
    v_account.id,
    p_task_idempotency_key,
    p_feature_key,
    'RESERVED',
    p_quota_units,
    p_credit_amount,
    upper(p_currency)
  )
  RETURNING * INTO v_record;

  IF p_credit_amount > 0 THEN
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
      reference_id
    )
    VALUES (
      v_account.id,
      p_user_id,
      'RESERVE',
      -p_credit_amount,
      p_credit_amount,
      v_account.available_balance,
      v_account.reserved_balance,
      'usage:' || p_task_idempotency_key || ':reserve',
      'USAGE_RECORD',
      v_record.id::TEXT
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'RESERVED',
    'usage_record_id', v_record.id,
    'idempotent', FALSE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_finalize_usage(
  p_user_id UUID,
  p_task_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_record public.billing_usage_records%ROWTYPE;
  v_quota public.billing_usage_quotas%ROWTYPE;
  v_account public.billing_credit_accounts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_task_idempotency_key, 0));

  SELECT *
  INTO v_record
  FROM public.billing_usage_records
  WHERE task_idempotency_key = p_task_idempotency_key
  FOR UPDATE;

  IF NOT FOUND OR v_record.user_id <> p_user_id THEN
    RAISE EXCEPTION 'usage reservation not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_record.status = 'FINALIZED' THEN
    RETURN jsonb_build_object(
      'status', 'FINALIZED',
      'usage_record_id', v_record.id,
      'idempotent', TRUE
    );
  END IF;

  IF v_record.status <> 'RESERVED' THEN
    RAISE EXCEPTION 'usage reservation cannot be finalized'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_record.quota_units > 0 THEN
    UPDATE public.billing_usage_quotas
    SET reserved_units = reserved_units - v_record.quota_units,
        used_units = used_units + v_record.quota_units,
        updated_at = now()
    WHERE id = v_record.quota_id
      AND reserved_units >= v_record.quota_units
    RETURNING * INTO v_quota;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'quota reservation invariant violated'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_record.credit_amount > 0 THEN
    UPDATE public.billing_credit_accounts
    SET reserved_balance = reserved_balance - v_record.credit_amount,
        version = version + 1,
        updated_at = now()
    WHERE id = v_record.credit_account_id
      AND reserved_balance >= v_record.credit_amount
    RETURNING * INTO v_account;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit reservation invariant violated'
        USING ERRCODE = 'check_violation';
    END IF;

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
      reference_id
    )
    VALUES (
      v_account.id,
      p_user_id,
      'CONSUME',
      0,
      -v_record.credit_amount,
      v_account.available_balance,
      v_account.reserved_balance,
      'usage:' || p_task_idempotency_key || ':finalize',
      'USAGE_RECORD',
      v_record.id::TEXT
    );
  END IF;

  UPDATE public.billing_usage_records
  SET status = 'FINALIZED',
      finalized_at = now(),
      updated_at = now()
  WHERE id = v_record.id
  RETURNING * INTO v_record;

  RETURN jsonb_build_object(
    'status', 'FINALIZED',
    'usage_record_id', v_record.id,
    'idempotent', FALSE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_release_usage(
  p_user_id UUID,
  p_task_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_record public.billing_usage_records%ROWTYPE;
  v_quota public.billing_usage_quotas%ROWTYPE;
  v_account public.billing_credit_accounts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_task_idempotency_key, 0));

  SELECT *
  INTO v_record
  FROM public.billing_usage_records
  WHERE task_idempotency_key = p_task_idempotency_key
  FOR UPDATE;

  IF NOT FOUND OR v_record.user_id <> p_user_id THEN
    RAISE EXCEPTION 'usage reservation not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_record.status = 'RELEASED' THEN
    RETURN jsonb_build_object(
      'status', 'RELEASED',
      'usage_record_id', v_record.id,
      'idempotent', TRUE
    );
  END IF;

  IF v_record.status <> 'RESERVED' THEN
    RAISE EXCEPTION 'usage reservation cannot be released'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_record.quota_units > 0 THEN
    UPDATE public.billing_usage_quotas
    SET reserved_units = reserved_units - v_record.quota_units,
        updated_at = now()
    WHERE id = v_record.quota_id
      AND reserved_units >= v_record.quota_units
    RETURNING * INTO v_quota;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'quota reservation invariant violated'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_record.credit_amount > 0 THEN
    UPDATE public.billing_credit_accounts
    SET available_balance = available_balance + v_record.credit_amount,
        reserved_balance = reserved_balance - v_record.credit_amount,
        version = version + 1,
        updated_at = now()
    WHERE id = v_record.credit_account_id
      AND reserved_balance >= v_record.credit_amount
    RETURNING * INTO v_account;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit reservation invariant violated'
        USING ERRCODE = 'check_violation';
    END IF;

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
      reference_id
    )
    VALUES (
      v_account.id,
      p_user_id,
      'RELEASE',
      v_record.credit_amount,
      -v_record.credit_amount,
      v_account.available_balance,
      v_account.reserved_balance,
      'usage:' || p_task_idempotency_key || ':release',
      'USAGE_RECORD',
      v_record.id::TEXT
    );
  END IF;

  UPDATE public.billing_usage_records
  SET status = 'RELEASED',
      released_at = now(),
      updated_at = now()
  WHERE id = v_record.id
  RETURNING * INTO v_record;

  RETURN jsonb_build_object(
    'status', 'RELEASED',
    'usage_record_id', v_record.id,
    'idempotent', FALSE
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_adjust_credit(
  p_user_id UUID,
  p_amount BIGINT,
  p_reason TEXT,
  p_idempotency_key TEXT,
  p_admin_user_id UUID,
  p_currency TEXT DEFAULT 'CREDITS'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.billing_credit_ledger%ROWTYPE;
  v_account public.billing_credit_accounts%ROWTYPE;
  v_before BIGINT;
  v_ledger_id UUID;
  v_audit_id UUID;
BEGIN
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'credit adjustment must be non-zero'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NULLIF(btrim(p_reason), '') IS NULL
    OR NULLIF(btrim(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'adjustment reason and idempotency key are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF upper(p_currency) <> 'CREDITS' THEN
    RAISE EXCEPTION 'unsupported credit currency'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.billing_admins
    WHERE user_id = p_admin_user_id
      AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'active billing administrator required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  SELECT *
  INTO v_existing
  FROM public.billing_credit_ledger
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.user_id <> p_user_id
      OR v_existing.entry_type <> 'ADJUSTMENT'
      OR v_existing.delta_available <> p_amount THEN
      RAISE EXCEPTION 'adjustment idempotency key payload mismatch'
        USING ERRCODE = 'data_exception';
    END IF;

    RETURN jsonb_build_object(
      'status', 'ALREADY_APPLIED',
      'ledger_id', v_existing.id,
      'available_balance', v_existing.available_after
    );
  END IF;

  IF p_amount > 0 THEN
    INSERT INTO public.billing_credit_accounts (user_id, currency)
    VALUES (p_user_id, upper(p_currency))
    ON CONFLICT (user_id, currency) DO NOTHING;
  END IF;

  SELECT *
  INTO v_account
  FROM public.billing_credit_accounts
  WHERE user_id = p_user_id
    AND currency = upper(p_currency)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit account not found'
      USING ERRCODE = 'insufficient_resources';
  END IF;

  v_before := v_account.available_balance;

  UPDATE public.billing_credit_accounts
  SET available_balance = available_balance + p_amount,
      version = version + 1,
      updated_at = now()
  WHERE id = v_account.id
    AND available_balance + p_amount >= 0
  RETURNING * INTO v_account;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit adjustment would make balance negative'
      USING ERRCODE = 'insufficient_resources';
  END IF;

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
  )
  VALUES (
    v_account.id,
    p_user_id,
    'ADJUSTMENT',
    p_amount,
    0,
    v_account.available_balance,
    v_account.reserved_balance,
    p_idempotency_key,
    'ADMIN',
    p_admin_user_id::TEXT,
    jsonb_build_object('reason', btrim(p_reason))
  )
  RETURNING id INTO v_ledger_id;

  INSERT INTO public.billing_admin_audit_logs (
    actor_user_id,
    target_user_id,
    action,
    target_type,
    target_id,
    reason,
    before_value,
    after_value
  )
  VALUES (
    p_admin_user_id,
    p_user_id,
    'ADJUST_CREDIT',
    'CREDIT_ACCOUNT',
    v_account.id::TEXT,
    btrim(p_reason),
    jsonb_build_object('available_balance', v_before),
    jsonb_build_object('available_balance', v_account.available_balance)
  )
  RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'status', 'APPLIED',
    'ledger_id', v_ledger_id,
    'audit_id', v_audit_id,
    'available_balance', v_account.available_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_settle_paid_order(
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_settle_paid_order(
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, JSONB, JSONB
) TO service_role;

REVOKE ALL ON FUNCTION public.billing_reserve_usage(
  UUID, TEXT, TEXT, BIGINT, BIGINT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_reserve_usage(
  UUID, TEXT, TEXT, BIGINT, BIGINT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.billing_finalize_usage(UUID, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_finalize_usage(UUID, TEXT)
TO service_role;

REVOKE ALL ON FUNCTION public.billing_release_usage(UUID, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_release_usage(UUID, TEXT)
TO service_role;

REVOKE ALL ON FUNCTION public.billing_adjust_credit(
  UUID, BIGINT, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_adjust_credit(
  UUID, BIGINT, TEXT, TEXT, UUID, TEXT
) TO service_role;
