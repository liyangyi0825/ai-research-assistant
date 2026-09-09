BEGIN;

ALTER TABLE public.billing_payment_intents
  DROP CONSTRAINT IF EXISTS billing_payment_intents_lifecycle_check;

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
          (payment_status = 'FAILED'
            AND provider_transaction_id IS NOT NULL
            AND payment_token IS NULL
            AND paid_at IS NULL)
          OR
          (payment_status = 'CLOSED'
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

CREATE OR REPLACE FUNCTION public.billing_bind_verified_payment_query(
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
    OR (p_payment_status = 'PAID'
      AND NULLIF(btrim(p_provider_transaction_id), '') IS NULL)
    OR (p_provider_transaction_id IS NOT NULL AND (
      NULLIF(btrim(p_provider_transaction_id), '') IS NULL
      OR char_length(p_provider_transaction_id) > 64
      OR octet_length(p_provider_transaction_id) > 256
    ))
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

REVOKE ALL ON FUNCTION public.billing_bind_verified_payment_query(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_bind_verified_payment_query(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) TO service_role;

COMMIT;
