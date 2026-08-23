BEGIN;

ALTER TABLE public.billing_payment_intents
  DROP CONSTRAINT IF EXISTS billing_payment_intents_check;

ALTER TABLE public.billing_payment_intents
  ADD COLUMN merchant_order_number TEXT;

UPDATE public.billing_payment_intents AS intent
SET merchant_order_number = CASE
  WHEN intent.provider = 'WECHAT'
    THEN 'WX' || left(replace(intent.id::TEXT, '-', ''), 30)
  ELSE billing_order.order_number
END
FROM public.billing_orders AS billing_order
WHERE billing_order.id = intent.order_id
  AND intent.merchant_order_number IS NULL;

-- Task 5 temporarily stored out_trade_no in the transaction-id slot. It is a
-- merchant reference, not a verified WeChat transaction identity.
UPDATE public.billing_payment_intents
SET provider_transaction_id = NULL
WHERE provider = 'WECHAT'
  AND payment_status = 'PENDING';

ALTER TABLE public.billing_payment_intents
  ALTER COLUMN merchant_order_number SET NOT NULL;

ALTER TABLE public.billing_payment_intents
  ADD CONSTRAINT billing_payment_intents_merchant_order_unique
    UNIQUE (provider, merchant_order_number);

ALTER TABLE public.billing_payment_intents
  ADD CONSTRAINT billing_payment_intents_lifecycle_check CHECK (
    NULLIF(btrim(merchant_order_number), '') IS NOT NULL
    AND (
      (provider = 'WECHAT'
        AND merchant_order_number ~ '^[A-Za-z0-9_|*-]{6,32}$')
      OR (provider <> 'WECHAT'
        AND merchant_order_number ~ '^[A-Za-z0-9_|*-]{1,64}$')
    )
    AND (
      (status = 'CREATING'
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
        AND provider_transaction_id IS NULL
        AND payment_token IS NULL
        AND payment_status IS NULL
        AND last_error_code IS NULL)
      OR
      (status = 'CREATED'
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND last_error_code IS NULL
        AND (
          (payment_status = 'PENDING'
            AND payment_token IS NOT NULL
            AND paid_at IS NULL)
          OR
          (payment_status = 'PAID'
            AND provider_transaction_id IS NOT NULL
            AND paid_at IS NOT NULL)
          OR
          (payment_status IN ('FAILED', 'CLOSED')
            AND provider_transaction_id IS NOT NULL
            AND payment_token IS NULL
            AND paid_at IS NULL)
        ))
      OR
      (status = 'FAILED'
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND provider_transaction_id IS NULL
        AND payment_token IS NULL
        AND payment_status IS NULL
        AND NULLIF(btrim(last_error_code), '') IS NOT NULL)
    )
  );

CREATE OR REPLACE FUNCTION public.billing_guard_refund_execution_management()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.execution_managed IS NOT TRUE THEN
    RAISE EXCEPTION 'new refunds must be execution managed'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.execution_managed IS DISTINCT FROM OLD.execution_managed THEN
    RAISE EXCEPTION 'refund execution management is immutable'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.execution_managed
     AND OLD.status = 'FAILED'
     AND NEW.status = 'PENDING' THEN
    IF OLD.last_error_code = 'REFUND_PROVIDER_CONTRACT_MISMATCH' THEN
      RAISE EXCEPTION 'refund requires manual review' USING ERRCODE = 'P2102';
    ELSIF OLD.last_error_code IN (
      'REFUND_PROVIDER_REJECTED',
      'REFUND_PROVIDER_REFUND_PRECHECK_FAILED'
    ) THEN
      RAISE EXCEPTION 'refund failure is permanent' USING ERRCODE = 'P2101';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION public.billing_claim_payment_intent(UUID, UUID, TEXT, TEXT, UUID);

CREATE FUNCTION public.billing_claim_payment_intent(
  p_user_id UUID,
  p_order_id UUID,
  p_provider TEXT,
  p_merchant_order_number TEXT,
  p_request_idempotency_key TEXT,
  p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.billing_orders%ROWTYPE;
  v_intent public.billing_payment_intents%ROWTYPE;
  v_now TIMESTAMPTZ;
BEGIN
  IF p_user_id IS NULL
    OR p_order_id IS NULL
    OR p_claim_token IS NULL
    OR NOT (
      (upper(p_provider) = 'WECHAT'
        AND p_merchant_order_number ~ '^[A-Za-z0-9_|*-]{6,32}$')
      OR (upper(p_provider) IN ('MOCK', 'ALIPAY')
        AND p_merchant_order_number ~ '^[A-Za-z0-9_|*-]{1,64}$')
    )
    OR NULLIF(btrim(p_request_idempotency_key), '') IS NULL
    OR upper(p_provider) NOT IN ('MOCK', 'WECHAT', 'ALIPAY') THEN
    RAISE EXCEPTION 'invalid payment intent claim'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_order
  FROM public.billing_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'billing order not found' USING ERRCODE = 'no_data_found';
  END IF;

  v_now := clock_timestamp();
  IF v_order.provider IS DISTINCT FROM upper(p_provider)
    OR v_order.status IS DISTINCT FROM 'PENDING'
    OR v_order.expires_at <= v_now THEN
    RAISE EXCEPTION 'billing order cannot create a payment'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.billing_payment_intents (
    order_id, user_id, provider, merchant_order_number,
    request_idempotency_key, status, claim_token, claim_expires_at,
    amount_minor, currency, expires_at
  ) VALUES (
    v_order.id, v_order.user_id, v_order.provider, p_merchant_order_number,
    p_request_idempotency_key, 'CREATING', p_claim_token,
    v_now + interval '30 seconds', v_order.amount_minor,
    v_order.currency, v_order.expires_at
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_intent
  FROM public.billing_payment_intents
  WHERE order_id = v_order.id
  FOR UPDATE;
  v_now := clock_timestamp();

  IF NOT FOUND
    OR v_intent.user_id IS DISTINCT FROM p_user_id
    OR v_intent.provider IS DISTINCT FROM upper(p_provider)
    OR v_intent.amount_minor IS DISTINCT FROM v_order.amount_minor
    OR v_intent.currency IS DISTINCT FROM v_order.currency
    OR v_intent.expires_at IS DISTINCT FROM v_order.expires_at THEN
    RAISE EXCEPTION 'payment intent replay payload mismatch'
      USING ERRCODE = 'data_exception';
  END IF;

  IF v_intent.status = 'CREATED'
    AND v_intent.payment_status NOT IN ('FAILED', 'CLOSED') THEN
    RETURN jsonb_build_object(
      'status', 'REUSE',
      'intent_id', v_intent.id,
      'merchant_order_number', v_intent.merchant_order_number,
      'request_idempotency_key', v_intent.request_idempotency_key,
      'provider_transaction_id', v_intent.provider_transaction_id,
      'payment_token', v_intent.payment_token,
      'payment_status', v_intent.payment_status,
      'amount_minor', v_intent.amount_minor,
      'currency', v_intent.currency,
      'expires_at', v_intent.expires_at,
      'paid_at', v_intent.paid_at
    );
  END IF;

  IF v_intent.status = 'CREATING'
    AND v_intent.claim_expires_at > v_now
    AND v_intent.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'status', 'IN_PROGRESS',
      'intent_id', v_intent.id,
      'claim_expires_at', v_intent.claim_expires_at
    );
  END IF;

  IF v_intent.status IN ('FAILED', 'CREATING')
    OR (v_intent.status = 'CREATED'
      AND v_intent.payment_status IN ('FAILED', 'CLOSED')) THEN
    UPDATE public.billing_payment_intents
    SET status = 'CREATING',
        claim_token = p_claim_token,
        claim_expires_at = v_now + interval '30 seconds',
        merchant_order_number = CASE
          WHEN status = 'CREATED'
            OR last_error_code = 'PAYMENT_REQUIRES_NEW_PAYMENT'
          THEN p_merchant_order_number
          ELSE v_intent.merchant_order_number
        END,
        request_idempotency_key = CASE
          WHEN status = 'CREATED'
            OR last_error_code = 'PAYMENT_REQUIRES_NEW_PAYMENT'
          THEN p_request_idempotency_key
          ELSE v_intent.request_idempotency_key
        END,
        provider_transaction_id = NULL,
        payment_token = NULL,
        payment_status = NULL,
        paid_at = NULL,
        last_error_code = NULL,
        attempt_count = CASE
          WHEN claim_token IS DISTINCT FROM p_claim_token THEN attempt_count + 1
          ELSE attempt_count
        END,
        updated_at = now()
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
  END IF;

  RETURN jsonb_build_object(
    'status', 'CLAIMED',
    'intent_id', v_intent.id,
    'merchant_order_number', v_intent.merchant_order_number,
    'request_idempotency_key', v_intent.request_idempotency_key,
    'claim_expires_at', v_intent.claim_expires_at
  );
END;
$$;

DROP FUNCTION public.billing_complete_payment_intent(
  UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
);

CREATE FUNCTION public.billing_complete_payment_intent(
  p_intent_id UUID,
  p_claim_token UUID,
  p_merchant_order_number TEXT,
  p_provider_transaction_id TEXT,
  p_payment_token TEXT,
  p_payment_status TEXT,
  p_expires_at TIMESTAMPTZ,
  p_paid_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_intent public.billing_payment_intents%ROWTYPE;
BEGIN
  IF p_intent_id IS NULL
    OR p_claim_token IS NULL
    OR p_merchant_order_number !~ '^[A-Za-z0-9_|*-]{1,64}$'
    OR (p_provider_transaction_id IS NOT NULL
      AND NULLIF(btrim(p_provider_transaction_id), '') IS NULL)
    OR (p_payment_token IS NOT NULL
      AND NULLIF(btrim(p_payment_token), '') IS NULL)
    OR p_payment_status NOT IN ('PENDING', 'PAID', 'FAILED', 'CLOSED')
    OR p_expires_at IS NULL
    OR NOT (
      (p_payment_status = 'PENDING'
        AND p_payment_token IS NOT NULL
        AND p_paid_at IS NULL)
      OR (p_payment_status = 'PAID'
        AND p_provider_transaction_id IS NOT NULL
        AND p_paid_at IS NOT NULL)
      OR (p_payment_status IN ('FAILED', 'CLOSED')
        AND p_provider_transaction_id IS NOT NULL
        AND p_payment_token IS NULL
        AND p_paid_at IS NULL)
    ) THEN
    RAISE EXCEPTION 'invalid completed payment intent'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_intent
  FROM public.billing_payment_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment intent not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_intent.provider = 'WECHAT'
    AND p_merchant_order_number !~ '^[A-Za-z0-9_|*-]{6,32}$' THEN
    RAISE EXCEPTION 'invalid completed payment intent'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_intent.expires_at IS DISTINCT FROM p_expires_at THEN
    RAISE EXCEPTION 'payment intent expiration mismatch'
      USING ERRCODE = 'data_exception';
  END IF;
  IF v_intent.merchant_order_number IS DISTINCT FROM p_merchant_order_number
    OR (v_intent.provider = 'WECHAT'
      AND p_payment_status = 'PENDING'
      AND p_provider_transaction_id IS NOT NULL) THEN
    RAISE EXCEPTION 'payment intent merchant reference mismatch'
      USING ERRCODE = 'data_exception';
  END IF;

  IF v_intent.status = 'CREATED' THEN
    IF v_intent.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id
      OR v_intent.payment_token IS DISTINCT FROM p_payment_token
      OR v_intent.payment_status IS DISTINCT FROM p_payment_status
      OR v_intent.paid_at IS DISTINCT FROM p_paid_at THEN
      RAISE EXCEPTION 'payment intent completion mismatch'
        USING ERRCODE = 'data_exception';
    END IF;
  ELSIF v_intent.status IS DISTINCT FROM 'CREATING'
    OR v_intent.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'payment intent claim was lost'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  ELSE
    UPDATE public.billing_payment_intents
    SET status = 'CREATED',
        claim_token = NULL,
        claim_expires_at = NULL,
        provider_transaction_id = p_provider_transaction_id,
        payment_token = p_payment_token,
        payment_status = p_payment_status,
        paid_at = p_paid_at,
        last_error_code = NULL,
        updated_at = now()
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
  END IF;

  RETURN jsonb_build_object(
    'status', 'CREATED',
    'intent_id', v_intent.id,
    'merchant_order_number', v_intent.merchant_order_number,
    'request_idempotency_key', v_intent.request_idempotency_key,
    'provider_transaction_id', v_intent.provider_transaction_id,
    'payment_token', v_intent.payment_token,
    'payment_status', v_intent.payment_status,
    'amount_minor', v_intent.amount_minor,
    'currency', v_intent.currency,
    'expires_at', v_intent.expires_at,
    'paid_at', v_intent.paid_at
  );
END;
$$;

CREATE FUNCTION public.billing_bind_verified_payment_query(
  p_user_id UUID,
  p_order_id UUID,
  p_provider TEXT,
  p_merchant_order_number TEXT,
  p_provider_transaction_id TEXT,
  p_payment_status TEXT,
  p_amount_minor BIGINT,
  p_currency TEXT,
  p_expires_at TIMESTAMPTZ,
  p_paid_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.billing_orders%ROWTYPE;
  v_intent public.billing_payment_intents%ROWTYPE;
  v_query_event public.billing_webhook_events%ROWTYPE;
  v_query_event_id TEXT;
  v_query_summary JSONB;
  v_settlement JSONB;
BEGIN
  IF p_user_id IS NULL
    OR p_order_id IS NULL
    OR upper(p_provider) NOT IN ('MOCK', 'WECHAT', 'ALIPAY')
    OR NOT (
      (upper(p_provider) = 'WECHAT'
        AND p_merchant_order_number ~ '^[A-Za-z0-9_|*-]{6,32}$')
      OR (upper(p_provider) IN ('MOCK', 'ALIPAY')
        AND p_merchant_order_number ~ '^[A-Za-z0-9_|*-]{1,64}$')
    )
    OR NULLIF(btrim(p_provider_transaction_id), '') IS NULL
    OR char_length(p_provider_transaction_id) > 64
    OR octet_length(p_provider_transaction_id) > 256
    OR p_payment_status NOT IN ('PENDING', 'PAID', 'FAILED', 'CLOSED')
    OR p_amount_minor IS NULL
    OR p_amount_minor <= 0
    OR upper(p_currency) IS DISTINCT FROM 'CNY'
    OR p_expires_at IS NULL
    OR NOT (
      (p_payment_status = 'PENDING' AND p_paid_at IS NULL)
      OR (p_payment_status = 'PAID'
        AND p_paid_at IS NOT NULL
        AND p_paid_at < p_expires_at)
      OR (p_payment_status IN ('FAILED', 'CLOSED') AND p_paid_at IS NULL)
    ) THEN
    RAISE EXCEPTION 'invalid verified payment query'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_order
  FROM public.billing_orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'billing order not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_intent
  FROM public.billing_payment_intents
  WHERE order_id = v_order.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment intent not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_order.provider IS DISTINCT FROM upper(p_provider)
    OR v_intent.order_id IS DISTINCT FROM v_order.id
    OR v_intent.user_id IS DISTINCT FROM p_user_id
    OR v_intent.provider IS DISTINCT FROM upper(p_provider)
    OR v_intent.merchant_order_number IS DISTINCT FROM p_merchant_order_number
    OR v_intent.amount_minor IS DISTINCT FROM p_amount_minor
    OR v_intent.amount_minor IS DISTINCT FROM v_order.amount_minor
    OR v_intent.currency IS DISTINCT FROM upper(p_currency)
    OR v_intent.currency IS DISTINCT FROM v_order.currency
    OR v_intent.expires_at IS DISTINCT FROM p_expires_at
    OR v_intent.expires_at IS DISTINCT FROM v_order.expires_at THEN
    RAISE EXCEPTION 'verified payment query payload mismatch'
      USING ERRCODE = 'data_exception';
  END IF;
  IF v_intent.status IS DISTINCT FROM 'CREATED'
    OR (v_order.status IS DISTINCT FROM 'PENDING'
      AND NOT (v_order.status = 'PAID' AND p_payment_status = 'PAID'))
    OR (v_intent.provider_transaction_id IS NOT NULL
      AND v_intent.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id)
    OR (v_intent.payment_status = 'PAID' AND (
      p_payment_status IS DISTINCT FROM 'PAID'
      OR v_intent.paid_at IS DISTINCT FROM p_paid_at
    ))
    OR (v_intent.payment_status IN ('FAILED', 'CLOSED') AND (
      v_intent.payment_status IS DISTINCT FROM p_payment_status
      OR v_intent.paid_at IS DISTINCT FROM p_paid_at
    ))
    OR (p_payment_status = 'PENDING' AND v_intent.payment_token IS NULL) THEN
    RAISE EXCEPTION 'verified payment query state mismatch'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF p_payment_status = 'PAID' THEN
    IF v_order.status = 'PAID' THEN
      IF v_intent.payment_status IS DISTINCT FROM 'PAID'
        OR v_intent.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id
        OR v_intent.paid_at IS DISTINCT FROM p_paid_at
        OR NOT EXISTS (
          SELECT 1
          FROM public.billing_payments
          WHERE order_id = v_order.id
            AND user_id = v_order.user_id
            AND provider = upper(p_provider)
            AND provider_transaction_id = p_provider_transaction_id
            AND request_idempotency_key = v_intent.request_idempotency_key
            AND status = 'PAID'
            AND amount_minor = p_amount_minor
            AND currency = upper(p_currency)
            AND paid_at = p_paid_at
        ) THEN
        RAISE EXCEPTION 'verified payment query settlement mismatch'
          USING ERRCODE = 'data_exception';
      END IF;
    ELSE
      v_query_event_id := 'QUERY:' || p_provider_transaction_id;
      v_query_summary := jsonb_build_object(
        'payload_hash',
        md5('merchant-query:' || p_provider_transaction_id)
          || md5('merchant-query-2:' || p_provider_transaction_id),
        'event_type', 'PAYMENT.PAID',
        'source', 'merchant-query'
      );
      INSERT INTO public.billing_webhook_events (
        provider, provider_event_id, order_number, provider_transaction_id,
        request_idempotency_key, amount_minor, currency, paid_at,
        signature_valid, status, payload_summary
      ) VALUES (
        upper(p_provider), v_query_event_id, p_merchant_order_number,
        p_provider_transaction_id, v_intent.request_idempotency_key,
        p_amount_minor, upper(p_currency), p_paid_at, TRUE, 'RECEIVED',
        v_query_summary
      )
      ON CONFLICT (provider, provider_event_id) DO NOTHING;

      SELECT * INTO v_query_event
      FROM public.billing_webhook_events
      WHERE provider = upper(p_provider)
        AND provider_event_id = v_query_event_id
      FOR UPDATE;
      IF NOT FOUND
        OR v_query_event.order_number IS DISTINCT FROM p_merchant_order_number
        OR v_query_event.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id
        OR v_query_event.request_idempotency_key IS DISTINCT FROM v_intent.request_idempotency_key
        OR v_query_event.amount_minor IS DISTINCT FROM p_amount_minor
        OR v_query_event.currency IS DISTINCT FROM upper(p_currency)
        OR v_query_event.paid_at IS DISTINCT FROM p_paid_at
        OR v_query_event.signature_valid IS NOT TRUE
        OR v_query_event.payload_summary IS DISTINCT FROM v_query_summary THEN
        RAISE EXCEPTION 'verified payment query event mismatch'
          USING ERRCODE = 'data_exception';
      END IF;

      SELECT public.billing_settle_paid_order(
        p_merchant_order_number,
        upper(p_provider),
        p_provider_transaction_id,
        v_query_event_id,
        v_intent.request_idempotency_key,
        p_amount_minor,
        upper(p_currency),
        p_paid_at,
        jsonb_build_object('source', 'merchant-query')
      ) INTO v_settlement;
      IF v_settlement ->> 'status' NOT IN ('PROCESSED', 'ALREADY_PROCESSED') THEN
        RAISE EXCEPTION 'verified payment query settlement did not complete'
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      SELECT * INTO v_intent
      FROM public.billing_payment_intents
      WHERE order_id = v_order.id;
    END IF;
  ELSE
    UPDATE public.billing_payment_intents
    SET provider_transaction_id = p_provider_transaction_id,
        payment_token = CASE
          WHEN p_payment_status = 'PENDING' THEN v_intent.payment_token
          ELSE NULL
        END,
        payment_status = p_payment_status,
        paid_at = p_paid_at,
        updated_at = now()
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
  END IF;

  RETURN jsonb_build_object(
    'status', 'CREATED',
    'intent_id', v_intent.id,
    'merchant_order_number', v_intent.merchant_order_number,
    'request_idempotency_key', v_intent.request_idempotency_key,
    'provider_transaction_id', v_intent.provider_transaction_id,
    'payment_token', v_intent.payment_token,
    'payment_status', v_intent.payment_status,
    'amount_minor', v_intent.amount_minor,
    'currency', v_intent.currency,
    'expires_at', v_intent.expires_at,
    'paid_at', v_intent.paid_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_claim_mock_payment_confirmation(
  p_user_id UUID,
  p_order_id UUID,
  p_provider_transaction_id TEXT,
  p_paid_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_intent public.billing_payment_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent
  FROM public.billing_payment_intents
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_intent.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'payment intent not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_intent.status IS DISTINCT FROM 'CREATED'
    OR v_intent.provider IS DISTINCT FROM 'MOCK'
    OR v_intent.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id
    OR v_intent.expires_at <= p_paid_at THEN
    RAISE EXCEPTION 'mock payment cannot be confirmed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_intent.payment_status = 'PENDING' THEN
    UPDATE public.billing_payment_intents
    SET payment_status = 'PAID', paid_at = p_paid_at, updated_at = now()
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
  ELSIF v_intent.payment_status IS DISTINCT FROM 'PAID' THEN
    RAISE EXCEPTION 'mock payment is not pending'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN jsonb_build_object(
    'status', 'PAID',
    'intent_id', v_intent.id,
    'merchant_order_number', v_intent.merchant_order_number,
    'request_idempotency_key', v_intent.request_idempotency_key,
    'provider_transaction_id', v_intent.provider_transaction_id,
    'payment_token', v_intent.payment_token,
    'payment_status', v_intent.payment_status,
    'amount_minor', v_intent.amount_minor,
    'currency', v_intent.currency,
    'expires_at', v_intent.expires_at,
    'paid_at', v_intent.paid_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_settle_paid_order(
  p_order_number TEXT,
  p_provider TEXT,
  p_provider_transaction_id TEXT,
  p_provider_event_id TEXT,
  p_request_idempotency_key TEXT,
  p_amount_minor BIGINT,
  p_currency TEXT,
  p_paid_at TIMESTAMPTZ,
  p_response_summary JSONB DEFAULT '{}'::JSONB
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
  v_subscription public.billing_subscriptions%ROWTYPE;
  v_entitlement_end TIMESTAMPTZ;
  v_credit_grant BIGINT := 0;
  v_account public.billing_credit_accounts%ROWTYPE;
  v_intent public.billing_payment_intents%ROWTYPE;
  v_intent_order_id UUID;
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
  IF p_amount_minor IS NULL OR p_currency IS NULL OR p_paid_at IS NULL
    OR p_amount_minor < 0 THEN
    RAISE EXCEPTION 'invalid payment amount or paid time'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_existing_event
  FROM public.billing_webhook_events
  WHERE provider = upper(p_provider)
    AND provider_event_id = p_provider_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook event must be persisted before settlement'
      USING ERRCODE = 'no_data_found';
  END IF;
  v_event_id := v_existing_event.id;

  IF v_existing_event.order_number IS DISTINCT FROM p_order_number
    OR v_existing_event.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id
    OR v_existing_event.request_idempotency_key IS DISTINCT FROM p_request_idempotency_key
    OR v_existing_event.amount_minor IS DISTINCT FROM p_amount_minor
    OR v_existing_event.currency IS DISTINCT FROM upper(p_currency)
    OR v_existing_event.paid_at IS DISTINCT FROM p_paid_at THEN
    RAISE EXCEPTION 'webhook replay payload mismatch'
      USING ERRCODE = 'data_exception';
  END IF;
  IF v_existing_event.signature_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'webhook signature is not valid'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_existing_event.status = 'PROCESSED' THEN
    SELECT order_id INTO v_intent_order_id
    FROM public.billing_payment_intents
    WHERE provider = upper(p_provider)
      AND merchant_order_number = p_order_number;
    IF FOUND THEN
      SELECT * INTO v_order
      FROM public.billing_orders
      WHERE id = v_intent_order_id
      FOR UPDATE;
      SELECT * INTO v_intent
      FROM public.billing_payment_intents
      WHERE provider = upper(p_provider)
        AND merchant_order_number = p_order_number
      FOR UPDATE;
    ELSE
      -- Pre-intent processed events remain replayable, but never enter the
      -- mutable settlement path below.
      SELECT * INTO v_order
      FROM public.billing_orders
      WHERE id = v_existing_event.order_id
        AND order_number = p_order_number
      FOR UPDATE;
    END IF;
    IF v_order.id IS NULL
      OR v_order.provider IS DISTINCT FROM upper(p_provider)
      OR v_order.amount_minor IS DISTINCT FROM p_amount_minor
      OR v_order.currency IS DISTINCT FROM upper(p_currency)
      OR v_order.expires_at <= p_paid_at
      OR (v_intent.id IS NOT NULL AND (
        v_intent.order_id IS DISTINCT FROM v_order.id
        OR v_intent.user_id IS DISTINCT FROM v_order.user_id
        OR v_intent.provider IS DISTINCT FROM upper(p_provider)
        OR v_intent.merchant_order_number IS DISTINCT FROM p_order_number
        OR v_intent.amount_minor IS DISTINCT FROM p_amount_minor
        OR v_intent.currency IS DISTINCT FROM upper(p_currency)
        OR v_intent.expires_at IS DISTINCT FROM v_order.expires_at
        OR v_intent.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id
        OR v_intent.request_idempotency_key IS DISTINCT FROM p_request_idempotency_key
      ))
      OR NOT EXISTS (
        SELECT 1 FROM public.billing_payments
        WHERE order_id IS NOT DISTINCT FROM v_order.id
          AND provider IS NOT DISTINCT FROM upper(p_provider)
          AND provider_transaction_id IS NOT DISTINCT FROM p_provider_transaction_id
          AND request_idempotency_key IS NOT DISTINCT FROM p_request_idempotency_key
          AND amount_minor IS NOT DISTINCT FROM p_amount_minor
          AND currency IS NOT DISTINCT FROM upper(p_currency)
          AND paid_at IS NOT DISTINCT FROM p_paid_at
          AND status IS NOT DISTINCT FROM 'PAID'
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

  IF v_existing_event.status = 'FAILED' THEN
    RETURN jsonb_build_object(
      'status', 'ALREADY_FAILED',
      'event_status', v_existing_event.status,
      'error_code', v_existing_event.error_code,
      'order_id', v_existing_event.order_id
    );
  END IF;
  IF v_existing_event.status = 'RECEIVED' THEN
    UPDATE public.billing_webhook_events
    SET status = 'PROCESSING', error_code = NULL, updated_at = now()
    WHERE id = v_event_id;
  ELSE
    RETURN jsonb_build_object(
      'status', 'IN_PROGRESS',
      'event_status', v_existing_event.status,
      'order_id', v_existing_event.order_id
    );
  END IF;

  SELECT order_id INTO v_intent_order_id
  FROM public.billing_payment_intents
  WHERE provider = upper(p_provider)
    AND merchant_order_number = p_order_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment intent payload mismatch'
      USING ERRCODE = 'data_exception';
  END IF;

  SELECT * INTO v_order
  FROM public.billing_orders
  WHERE id = v_intent_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing order not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_intent
  FROM public.billing_payment_intents
  WHERE provider = upper(p_provider)
    AND merchant_order_number = p_order_number
  FOR UPDATE;
  IF NOT FOUND
    OR v_intent.order_id IS DISTINCT FROM v_order.id
    OR v_intent.user_id IS DISTINCT FROM v_order.user_id
    OR v_intent.status IS DISTINCT FROM 'CREATED'
    OR v_intent.request_idempotency_key IS DISTINCT FROM p_request_idempotency_key
    OR v_intent.amount_minor IS DISTINCT FROM p_amount_minor
    OR v_intent.currency IS DISTINCT FROM upper(p_currency)
    OR v_intent.expires_at <= p_paid_at
    OR (v_intent.provider_transaction_id IS NOT NULL
      AND v_intent.provider_transaction_id IS DISTINCT FROM p_provider_transaction_id)
    OR v_intent.payment_status NOT IN ('PENDING', 'PAID')
    OR (v_intent.payment_status = 'PAID'
      AND v_intent.paid_at IS DISTINCT FROM p_paid_at) THEN
    RAISE EXCEPTION 'payment intent payload mismatch'
      USING ERRCODE = 'data_exception';
  END IF;

  IF v_order.provider IS DISTINCT FROM upper(p_provider)
    OR v_order.amount_minor IS DISTINCT FROM p_amount_minor
    OR v_order.currency IS DISTINCT FROM upper(p_currency) THEN
    RAISE EXCEPTION 'payment order payload mismatch'
      USING ERRCODE = 'data_exception';
  END IF;
  IF v_order.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'order is not pending'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_order.expires_at <= p_paid_at THEN
    RAISE EXCEPTION 'order expired before payment'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.billing_payment_intents
  SET provider_transaction_id = p_provider_transaction_id,
      payment_token = NULL,
      payment_status = 'PAID',
      paid_at = p_paid_at,
      updated_at = now()
  WHERE id = v_intent.id;

  UPDATE public.billing_webhook_events
  SET order_id = v_order.id, user_id = v_order.user_id, updated_at = now()
  WHERE id = v_event_id;

  INSERT INTO public.billing_payments (
    order_id, user_id, provider, provider_transaction_id, status,
    amount_minor, currency, request_idempotency_key, response_summary, paid_at
  ) VALUES (
    v_order.id, v_order.user_id, upper(p_provider), p_provider_transaction_id,
    'PAID', p_amount_minor, upper(p_currency),
    v_intent.request_idempotency_key, COALESCE(p_response_summary, '{}'::JSONB),
    p_paid_at
  );

  IF v_order.snapshot_product_type = 'SUBSCRIPTION' THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_order.snapshot_entitlements) AS entitlement(value)
      WHERE jsonb_typeof(entitlement.value) <> 'object'
        OR NULLIF(btrim(entitlement.value ->> 'feature_key'), '') IS NULL
        OR NOT (entitlement.value ? 'periodic_limit')
        OR (entitlement.value -> 'periodic_limit' <> 'null'::JSONB AND (
          jsonb_typeof(entitlement.value -> 'periodic_limit') <> 'number'
          OR CASE
            WHEN jsonb_typeof(entitlement.value -> 'periodic_limit') = 'number'
            THEN (entitlement.value ->> 'periodic_limit')::NUMERIC < 0
              OR (entitlement.value ->> 'periodic_limit')::NUMERIC
                <> trunc((entitlement.value ->> 'periodic_limit')::NUMERIC)
            ELSE FALSE
          END
        ))
    ) THEN
      RAISE EXCEPTION 'invalid subscription entitlement snapshot'
        USING ERRCODE = 'data_exception';
    END IF;

    v_entitlement_end := p_paid_at
      + make_interval(days => v_order.snapshot_duration_days);
    INSERT INTO public.billing_subscriptions (
      user_id, plan_id, source_order_id, status, starts_at, ends_at, auto_renew
    ) VALUES (
      v_order.user_id, v_order.snapshot_plan_id, v_order.id, 'ACTIVE',
      p_paid_at, v_entitlement_end, FALSE
    )
    ON CONFLICT (source_order_id) DO NOTHING
    RETURNING * INTO v_subscription;
    IF v_subscription.id IS NULL THEN
      RAISE EXCEPTION 'order subscription was already granted'
        USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.billing_user_entitlements (
      user_id, plan_entitlement_id, feature_key, source_type, source_order_id,
      entitlement_value, valid_from, valid_until
    )
    SELECT v_order.user_id, NULL::UUID,
      entitlement.value ->> 'feature_key', 'PLAN', v_order.id,
      entitlement.value - 'credit_grant', v_subscription.starts_at,
      v_subscription.ends_at
    FROM jsonb_array_elements(v_order.snapshot_entitlements) AS entitlement(value)
    WHERE jsonb_typeof(entitlement.value) = 'object'
      AND NULLIF(entitlement.value ->> 'feature_key', '') IS NOT NULL
    ON CONFLICT (user_id, feature_key, source_order_id) DO NOTHING;

    INSERT INTO public.billing_usage_quotas (
      user_id, subscription_id, feature_key, period_start, period_end, quota_limit
    )
    SELECT v_order.user_id, v_subscription.id,
      entitlement.value ->> 'feature_key', v_subscription.starts_at,
      v_subscription.ends_at,
      (entitlement.value ->> 'periodic_limit')::BIGINT
    FROM jsonb_array_elements(v_order.snapshot_entitlements) AS entitlement(value)
    WHERE entitlement.value -> 'periodic_limit' <> 'null'::JSONB
    ON CONFLICT (subscription_id, feature_key) DO NOTHING;

    SELECT COALESCE(
      sum(COALESCE((entitlement.value ->> 'credit_grant')::BIGINT, 0)), 0
    ) INTO v_credit_grant
    FROM jsonb_array_elements(v_order.snapshot_entitlements) AS entitlement(value)
    WHERE jsonb_typeof(entitlement.value) = 'object';
  ELSE
    v_credit_grant := v_order.snapshot_credit_grant;
  END IF;

  IF v_credit_grant > 0 THEN
    INSERT INTO public.billing_credit_accounts (user_id, currency)
    VALUES (v_order.user_id, 'CREDITS')
    ON CONFLICT (user_id, currency) DO NOTHING;
    SELECT * INTO v_account
    FROM public.billing_credit_accounts
    WHERE user_id = v_order.user_id AND currency = 'CREDITS'
    FOR UPDATE;
    UPDATE public.billing_credit_accounts
    SET available_balance = available_balance + v_credit_grant,
        version = version + 1, updated_at = now()
    WHERE id = v_account.id
    RETURNING * INTO v_account;
    INSERT INTO public.billing_credit_ledger (
      account_id, user_id, entry_type, delta_available, delta_reserved,
      available_after, reserved_after, idempotency_key, reference_type,
      reference_id, metadata
    ) VALUES (
      v_account.id, v_order.user_id,
      CASE WHEN v_order.snapshot_product_type = 'CREDIT_PACK'
        THEN 'PURCHASE' ELSE 'GRANT' END,
      v_credit_grant, 0, v_account.available_balance, v_account.reserved_balance,
      'settlement:' || upper(p_provider) || ':' || p_provider_event_id || ':credit',
      'ORDER', v_order.id::TEXT,
      jsonb_build_object('provider', upper(p_provider))
    );
  END IF;

  UPDATE public.billing_orders
  SET status = 'PAID', paid_at = p_paid_at, updated_at = now()
  WHERE id = v_order.id;
  UPDATE public.billing_webhook_events
  SET status = 'PROCESSED', processed_at = now(), updated_at = now()
  WHERE id = v_event_id;

  RETURN jsonb_build_object(
    'status', 'PROCESSED', 'order_id', v_order.id, 'event_id', v_event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_claim_payment_intent(
  UUID, UUID, TEXT, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_payment_intent(
  UUID, UUID, TEXT, TEXT, TEXT, UUID
) TO service_role;

REVOKE ALL ON FUNCTION public.billing_complete_payment_intent(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_complete_payment_intent(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

REVOKE ALL ON FUNCTION public.billing_bind_verified_payment_query(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_bind_verified_payment_query(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

REVOKE ALL ON FUNCTION public.billing_claim_mock_payment_confirmation(
  UUID, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_claim_mock_payment_confirmation(
  UUID, UUID, TEXT, TIMESTAMPTZ
) TO service_role;

REVOKE ALL ON FUNCTION public.billing_settle_paid_order(
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_settle_paid_order(
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, JSONB
) TO service_role;

COMMIT;
