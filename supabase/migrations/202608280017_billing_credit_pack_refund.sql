BEGIN;

ALTER FUNCTION public.billing_claim_approved_refund(UUID, UUID, TIMESTAMPTZ)
  RENAME TO billing_claim_approved_refund_v12;
ALTER FUNCTION public.billing_complete_refund(UUID, UUID, TEXT, TEXT, BIGINT, TEXT, JSONB)
  RENAME TO billing_complete_refund_v12;
ALTER FUNCTION public.billing_fail_refund_claim(UUID, UUID, TEXT)
  RENAME TO billing_fail_refund_claim_v12;

REVOKE ALL ON FUNCTION public.billing_claim_approved_refund_v12(UUID, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.billing_complete_refund_v12(UUID, UUID, TEXT, TEXT, BIGINT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.billing_fail_refund_claim_v12(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

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
  v_account public.billing_credit_accounts%ROWTYPE;
  v_purchase public.billing_credit_ledger%ROWTYPE;
  v_reserve public.billing_credit_ledger%ROWTYPE;
  v_credit_grant BIGINT;
  v_count BIGINT;
  v_claimed_at TIMESTAMPTZ := clock_timestamp();
  v_idempotency_key TEXT;
BEGIN
  IF p_request_id IS NULL OR p_claim_token IS NULL OR p_claimed_at IS NULL THEN
    RAISE EXCEPTION 'invalid refund claim' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_claimed_at < clock_timestamp() - interval '5 minutes'
     OR p_claimed_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid refund claim time' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing-refund:' || p_request_id::TEXT, 0));
  SELECT * INTO v_request FROM public.billing_refund_requests
    WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'approved refund request not found'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT * INTO v_order FROM public.billing_orders
    WHERE id = v_request.order_id FOR UPDATE;
  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM v_request.user_id THEN
    RAISE EXCEPTION 'refund order contract mismatch'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_order.snapshot_product_type <> 'CREDIT_PACK' THEN
    RETURN public.billing_claim_approved_refund_v12(p_request_id, p_claim_token, p_claimed_at);
  END IF;

  v_credit_grant := v_order.snapshot_credit_grant;
  IF v_order.status <> 'REFUNDING'
     OR v_order.refund_status <> 'REQUESTED'
     OR v_request.requested_amount_minor IS DISTINCT FROM v_order.amount_minor
     OR v_request.currency IS DISTINCT FROM v_order.currency
     OR v_credit_grant IS NULL OR v_credit_grant <= 0 THEN
    RAISE EXCEPTION 'refund order contract mismatch'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  v_idempotency_key := 'billing-refund:' || p_request_id::TEXT;
  SELECT * INTO v_refund FROM public.billing_refunds
    WHERE refund_request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF NOT v_refund.execution_managed THEN
      RAISE EXCEPTION 'legacy refund is not execution managed'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF v_refund.status = 'SUCCEEDED' THEN
      SELECT * INTO v_payment FROM public.billing_payments WHERE id = v_refund.payment_id FOR UPDATE;
      IF v_order.status <> 'REFUNDED' OR v_order.refund_status <> 'FULL'
         OR v_payment.status <> 'REFUNDED' THEN
        RAISE EXCEPTION 'refund replay contract mismatch' USING ERRCODE = 'data_exception';
      END IF;
      RETURN jsonb_build_object(
        'status', 'SUCCEEDED', 'provider_refund_id', v_refund.provider_refund_id,
        'provider_transaction_id', v_payment.provider_transaction_id,
        'refunded_amount_minor', v_refund.refunded_amount_minor, 'currency', v_refund.currency
      );
    END IF;
    IF v_refund.status = 'FAILED' THEN
      RETURN jsonb_build_object('status', 'FAILED');
    END IF;
    IF v_refund.status = 'PENDING'
       AND v_refund.claim_token IS DISTINCT FROM p_claim_token
       AND v_refund.claim_expires_at > v_claimed_at THEN
      RETURN jsonb_build_object('status', 'IN_PROGRESS');
    END IF;
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_payments
    WHERE order_id = v_order.id AND user_id = v_order.user_id
      AND provider = v_order.provider AND status = 'PAID';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'paid refund payment not found'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT * INTO v_payment FROM public.billing_payments
    WHERE order_id = v_order.id AND user_id = v_order.user_id
      AND provider = v_order.provider AND status = 'PAID' FOR UPDATE;
  IF v_payment.amount_minor IS DISTINCT FROM v_order.amount_minor
     OR v_payment.currency IS DISTINCT FROM v_order.currency
     OR NULLIF(btrim(v_payment.provider_transaction_id), '') IS NULL THEN
    RAISE EXCEPTION 'refund payment contract mismatch' USING ERRCODE = 'data_exception';
  END IF;

  SELECT count(*) INTO v_count FROM public.billing_credit_ledger
    WHERE user_id = v_order.user_id AND entry_type = 'PURCHASE'
      AND reference_type = 'ORDER' AND reference_id = v_order.id::TEXT
      AND delta_available = v_credit_grant AND delta_reserved = 0;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'credit pack refund requires manual review' USING ERRCODE = 'P2102';
  END IF;
  SELECT * INTO v_purchase FROM public.billing_credit_ledger
    WHERE user_id = v_order.user_id AND entry_type = 'PURCHASE'
      AND reference_type = 'ORDER' AND reference_id = v_order.id::TEXT
      AND delta_available = v_credit_grant AND delta_reserved = 0 FOR UPDATE;
  SELECT * INTO v_account FROM public.billing_credit_accounts
    WHERE id = v_purchase.account_id AND user_id = v_order.user_id AND currency = 'CREDITS' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit pack refund requires manual review' USING ERRCODE = 'P2102';
  END IF;

  SELECT * INTO v_reserve FROM public.billing_credit_ledger
    WHERE idempotency_key = 'refund:' || p_request_id::TEXT || ':reserve';
  IF NOT FOUND THEN
    IF v_account.reserved_balance <> 0 OR v_account.available_balance < v_credit_grant THEN
      RAISE EXCEPTION 'credit pack refund requires manual review' USING ERRCODE = 'P2102';
    END IF;
    UPDATE public.billing_credit_accounts
      SET available_balance = available_balance - v_credit_grant,
          reserved_balance = reserved_balance + v_credit_grant,
          version = version + 1, updated_at = clock_timestamp()
      WHERE id = v_account.id AND reserved_balance = 0
        AND available_balance >= v_credit_grant RETURNING * INTO v_account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'credit pack refund requires manual review' USING ERRCODE = 'P2102';
    END IF;
    INSERT INTO public.billing_credit_ledger (
      account_id, user_id, entry_type, delta_available, delta_reserved,
      available_after, reserved_after, idempotency_key, reference_type, reference_id, metadata
    ) VALUES (
      v_account.id, v_order.user_id, 'RESERVE', -v_credit_grant, v_credit_grant,
      v_account.available_balance, v_account.reserved_balance,
      'refund:' || p_request_id::TEXT || ':reserve', 'REFUND_REQUEST', p_request_id::TEXT,
      jsonb_build_object('order_id', v_order.id, 'credit_grant', v_credit_grant)
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  ELSIF v_reserve.account_id IS DISTINCT FROM v_account.id
     OR v_reserve.delta_available IS DISTINCT FROM -v_credit_grant
     OR v_reserve.delta_reserved IS DISTINCT FROM v_credit_grant
     OR v_account.reserved_balance < v_credit_grant THEN
    RAISE EXCEPTION 'refund credit hold mismatch' USING ERRCODE = 'data_exception';
  END IF;

  IF v_refund.id IS NULL THEN
    INSERT INTO public.billing_refunds (
      refund_request_id, order_id, payment_id, user_id, provider, execution_managed,
      status, refunded_amount_minor, currency, idempotency_key,
      claim_token, claim_expires_at, last_error_code
    ) VALUES (
      p_request_id, v_order.id, v_payment.id, v_order.user_id, v_order.provider, TRUE,
      'PENDING', v_order.amount_minor, v_order.currency, v_idempotency_key,
      p_claim_token, v_claimed_at + interval '5 minutes', NULL
    ) RETURNING * INTO v_refund;
  ELSE
    UPDATE public.billing_refunds SET status = 'PENDING', provider_refund_id = NULL,
      response_summary = '{}'::JSONB, completed_at = NULL, claim_token = p_claim_token,
      claim_expires_at = v_claimed_at + interval '5 minutes', last_error_code = NULL,
      updated_at = clock_timestamp()
      WHERE id = v_refund.id RETURNING * INTO v_refund;
  END IF;

  RETURN jsonb_build_object(
    'status', 'CLAIMED', 'refund_id', v_refund.id, 'request_id', v_request.id,
    'order_id', v_order.id, 'payment_id', v_payment.id, 'provider', v_order.provider,
    'provider_transaction_id', v_payment.provider_transaction_id,
    'amount_minor', v_order.amount_minor, 'currency', v_order.currency,
    'idempotency_key', v_idempotency_key
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_complete_refund(
  p_refund_id UUID, p_claim_token UUID, p_provider_refund_id TEXT,
  p_provider_transaction_id TEXT, p_refunded_amount_minor BIGINT,
  p_currency TEXT, p_response_summary JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_refund public.billing_refunds%ROWTYPE;
  v_request public.billing_refund_requests%ROWTYPE;
  v_order public.billing_orders%ROWTYPE;
  v_payment public.billing_payments%ROWTYPE;
  v_account public.billing_credit_accounts%ROWTYPE;
  v_reserve public.billing_credit_ledger%ROWTYPE;
  v_credit_grant BIGINT;
  v_completed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v_refund FROM public.billing_refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_order FROM public.billing_orders WHERE id = v_refund.order_id FOR UPDATE;
  IF v_order.snapshot_product_type <> 'CREDIT_PACK' THEN
    RETURN public.billing_complete_refund_v12(
      p_refund_id, p_claim_token, p_provider_refund_id, p_provider_transaction_id,
      p_refunded_amount_minor, p_currency, p_response_summary
    );
  END IF;
  SELECT * INTO v_request FROM public.billing_refund_requests WHERE id = v_refund.refund_request_id FOR UPDATE;
  SELECT * INTO v_payment FROM public.billing_payments WHERE id = v_refund.payment_id FOR UPDATE;
  IF v_refund.status = 'SUCCEEDED' THEN
    RETURN jsonb_build_object(
      'status', 'SUCCEEDED', 'provider_refund_id', v_refund.provider_refund_id,
      'provider_transaction_id', v_payment.provider_transaction_id,
      'refunded_amount_minor', v_refund.refunded_amount_minor, 'currency', v_refund.currency
    );
  END IF;
  IF v_refund.status <> 'PENDING' OR v_refund.claim_token IS DISTINCT FROM p_claim_token
     OR v_request.status <> 'APPROVED' OR v_order.status <> 'REFUNDING'
     OR v_order.refund_status <> 'REQUESTED' OR v_payment.status <> 'PAID'
     OR p_provider_transaction_id IS DISTINCT FROM v_payment.provider_transaction_id
     OR p_refunded_amount_minor IS DISTINCT FROM v_order.amount_minor
     OR p_currency IS DISTINCT FROM v_order.currency
     OR NULLIF(btrim(p_provider_refund_id), '') IS NULL THEN
    RAISE EXCEPTION 'refund completion contract mismatch' USING ERRCODE = 'data_exception';
  END IF;
  v_credit_grant := v_order.snapshot_credit_grant;
  SELECT * INTO v_reserve FROM public.billing_credit_ledger
    WHERE idempotency_key = 'refund:' || v_request.id::TEXT || ':reserve' FOR UPDATE;
  SELECT * INTO v_account FROM public.billing_credit_accounts
    WHERE id = v_reserve.account_id AND user_id = v_order.user_id FOR UPDATE;
  IF v_reserve.id IS NULL OR v_account.id IS NULL OR v_account.reserved_balance < v_credit_grant THEN
    RAISE EXCEPTION 'refund credit hold mismatch' USING ERRCODE = 'data_exception';
  END IF;
  UPDATE public.billing_credit_accounts
    SET reserved_balance = reserved_balance - v_credit_grant,
        version = version + 1, updated_at = v_completed_at
    WHERE id = v_account.id AND reserved_balance >= v_credit_grant RETURNING * INTO v_account;
  INSERT INTO public.billing_credit_ledger (
    account_id, user_id, entry_type, delta_available, delta_reserved,
    available_after, reserved_after, idempotency_key, reference_type, reference_id, metadata
  ) VALUES (
    v_account.id, v_order.user_id, 'CONSUME', 0, -v_credit_grant,
    v_account.available_balance, v_account.reserved_balance,
    'refund:' || v_request.id::TEXT || ':consume', 'REFUND_REQUEST', v_request.id::TEXT,
    jsonb_build_object('order_id', v_order.id, 'provider_refund_id', btrim(p_provider_refund_id))
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  UPDATE public.billing_refunds SET provider_refund_id = btrim(p_provider_refund_id),
    status = 'SUCCEEDED', response_summary = p_response_summary, completed_at = v_completed_at,
    claim_token = NULL, claim_expires_at = NULL, last_error_code = NULL, updated_at = v_completed_at
    WHERE id = v_refund.id;
  UPDATE public.billing_payments SET status = 'REFUNDED', updated_at = v_completed_at
    WHERE id = v_payment.id AND status = 'PAID';
  UPDATE public.billing_orders SET status = 'REFUNDED', refund_status = 'FULL', updated_at = v_completed_at
    WHERE id = v_order.id AND status = 'REFUNDING' AND refund_status = 'REQUESTED';
  RETURN jsonb_build_object(
    'status', 'SUCCEEDED', 'provider_refund_id', btrim(p_provider_refund_id),
    'provider_transaction_id', v_payment.provider_transaction_id,
    'refunded_amount_minor', v_refund.refunded_amount_minor, 'currency', v_refund.currency
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_fail_refund_claim(
  p_refund_id UUID, p_claim_token UUID, p_error_code TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_refund public.billing_refunds%ROWTYPE;
  v_request public.billing_refund_requests%ROWTYPE;
  v_order public.billing_orders%ROWTYPE;
  v_account public.billing_credit_accounts%ROWTYPE;
  v_reserve public.billing_credit_ledger%ROWTYPE;
  v_credit_grant BIGINT;
BEGIN
  SELECT * INTO v_refund FROM public.billing_refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_order FROM public.billing_orders WHERE id = v_refund.order_id FOR UPDATE;
  IF v_order.snapshot_product_type <> 'CREDIT_PACK' THEN
    RETURN public.billing_fail_refund_claim_v12(p_refund_id, p_claim_token, p_error_code);
  END IF;
  IF v_refund.status = 'SUCCEEDED' THEN RETURN jsonb_build_object('status', 'SUCCEEDED'); END IF;
  IF v_refund.status <> 'PENDING' OR v_refund.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'refund claim cannot be failed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT * INTO v_request FROM public.billing_refund_requests WHERE id = v_refund.refund_request_id FOR UPDATE;
  v_credit_grant := v_order.snapshot_credit_grant;
  SELECT * INTO v_reserve FROM public.billing_credit_ledger
    WHERE idempotency_key = 'refund:' || v_request.id::TEXT || ':reserve' FOR UPDATE;
  IF v_reserve.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.billing_credit_ledger
    WHERE idempotency_key IN (
      'refund:' || v_request.id::TEXT || ':consume',
      'refund:' || v_request.id::TEXT || ':release'
    )
  ) THEN
    SELECT * INTO v_account FROM public.billing_credit_accounts
      WHERE id = v_reserve.account_id AND user_id = v_order.user_id FOR UPDATE;
    UPDATE public.billing_credit_accounts
      SET available_balance = available_balance + v_credit_grant,
          reserved_balance = reserved_balance - v_credit_grant,
          version = version + 1, updated_at = clock_timestamp()
      WHERE id = v_account.id AND reserved_balance >= v_credit_grant RETURNING * INTO v_account;
    IF NOT FOUND THEN RAISE EXCEPTION 'refund credit hold mismatch' USING ERRCODE = 'data_exception'; END IF;
    INSERT INTO public.billing_credit_ledger (
      account_id, user_id, entry_type, delta_available, delta_reserved,
      available_after, reserved_after, idempotency_key, reference_type, reference_id, metadata
    ) VALUES (
      v_account.id, v_order.user_id, 'RELEASE', v_credit_grant, -v_credit_grant,
      v_account.available_balance, v_account.reserved_balance,
      'refund:' || v_request.id::TEXT || ':release', 'REFUND_REQUEST', v_request.id::TEXT,
      jsonb_build_object('order_id', v_order.id, 'error_code', left(btrim(p_error_code), 120))
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
  UPDATE public.billing_refunds SET status = 'FAILED', claim_token = NULL,
    claim_expires_at = NULL, last_error_code = left(btrim(p_error_code), 120),
    updated_at = clock_timestamp() WHERE id = p_refund_id;
  RETURN jsonb_build_object('status', 'RELEASED');
END;
$$;

REVOKE ALL ON FUNCTION public.billing_claim_approved_refund(UUID, UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_complete_refund(UUID, UUID, TEXT, TEXT, BIGINT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_fail_refund_claim(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_approved_refund(UUID, UUID, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_complete_refund(UUID, UUID, TEXT, TEXT, BIGINT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_fail_refund_claim(UUID, UUID, TEXT) TO service_role;

COMMIT;
