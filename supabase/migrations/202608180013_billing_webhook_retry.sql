BEGIN;

ALTER TABLE public.billing_webhook_events
  ADD COLUMN retry_after TIMESTAMPTZ,
  ADD COLUMN retry_count BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.billing_webhook_events
  DROP CONSTRAINT IF EXISTS billing_webhook_events_status_check,
  DROP CONSTRAINT IF EXISTS billing_webhook_events_check,
  DROP CONSTRAINT IF EXISTS billing_webhook_events_check1;

ALTER TABLE public.billing_webhook_events
  ADD CONSTRAINT billing_webhook_events_status_check
    CHECK (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'RETRYABLE', 'FAILED'));
ALTER TABLE public.billing_webhook_events
  ADD CONSTRAINT billing_webhook_events_error_code_check
    CHECK (status NOT IN ('FAILED', 'RETRYABLE') OR NULLIF(btrim(error_code), '') IS NOT NULL);
ALTER TABLE public.billing_webhook_events
  ADD CONSTRAINT billing_webhook_events_payload_state_check CHECK (
    (status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'RETRYABLE')
      AND signature_valid IS TRUE
      AND order_number IS NOT NULL
      AND provider_transaction_id IS NOT NULL
      AND request_idempotency_key IS NOT NULL
      AND amount_minor IS NOT NULL
      AND currency IS NOT NULL
      AND paid_at IS NOT NULL)
    OR (status = 'FAILED' AND (
      (signature_valid IS TRUE
        AND order_number IS NOT NULL
        AND provider_transaction_id IS NOT NULL
        AND request_idempotency_key IS NOT NULL
        AND amount_minor IS NOT NULL
        AND currency IS NOT NULL
        AND paid_at IS NOT NULL)
      OR (order_number IS NULL
        AND provider_transaction_id IS NULL
        AND request_idempotency_key IS NULL
        AND amount_minor IS NULL
        AND currency IS NULL
        AND paid_at IS NULL)))
  );

CREATE OR REPLACE FUNCTION public.billing_validate_webhook_event_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.id, NEW.order_number, NEW.provider, NEW.provider_event_id,
    NEW.provider_transaction_id, NEW.request_idempotency_key,
    NEW.amount_minor, NEW.currency, NEW.paid_at, NEW.signature_valid,
    NEW.payload_summary, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.order_number, OLD.provider, OLD.provider_event_id,
    OLD.provider_transaction_id, OLD.request_idempotency_key,
    OLD.amount_minor, OLD.currency, OLD.paid_at, OLD.signature_valid,
    OLD.payload_summary, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'billing webhook event payload is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'RECEIVED' AND NEW.status IN ('PROCESSING', 'RETRYABLE', 'FAILED'))
    OR (OLD.status = 'RETRYABLE' AND NEW.status IN ('RECEIVED', 'FAILED'))
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('PROCESSED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid billing webhook event status transition'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW.retry_count < OLD.retry_count
    OR NEW.retry_count > OLD.retry_count + 1
    OR (NEW.retry_count = OLD.retry_count + 1 AND NEW.status <> 'RETRYABLE')
    OR (NEW.retry_count = OLD.retry_count AND OLD.status <> 'RETRYABLE' AND NEW.status = 'RETRYABLE') THEN
    RAISE EXCEPTION 'invalid billing webhook event retry count'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE public.billing_webhook_events
  ADD CONSTRAINT billing_webhook_events_retry_state_check CHECK (
    retry_count BETWEEN 0 AND 8
    AND ((status = 'RETRYABLE' AND retry_after IS NOT NULL)
      OR (status <> 'RETRYABLE' AND retry_after IS NULL))
  );

CREATE OR REPLACE FUNCTION public.billing_mark_webhook_retryable(
  p_provider TEXT,
  p_provider_event_id TEXT,
  p_error_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.billing_webhook_events%ROWTYPE;
BEGIN
  IF p_provider NOT IN ('MOCK', 'WECHAT', 'ALIPAY')
    OR NULLIF(btrim(p_provider_event_id), '') IS NULL
    OR p_error_code NOT IN ('BILLING_STORAGE_UNAVAILABLE', 'BILLING_SERIALIZATION_RETRY', 'BILLING_DATABASE_TIMEOUT', 'BILLING_CONNECTION_UNAVAILABLE') THEN
    RAISE EXCEPTION 'invalid webhook retry request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_event
  FROM public.billing_webhook_events
  WHERE provider = p_provider AND provider_event_id = p_provider_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook event not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_event.status IN ('RECEIVED', 'RETRYABLE') THEN
    IF v_event.retry_count >= 8 THEN
      UPDATE public.billing_webhook_events
      SET status = 'FAILED', error_code = 'WEBHOOK_RETRY_EXHAUSTED', retry_after = NULL, updated_at = clock_timestamp()
      WHERE id = v_event.id RETURNING * INTO v_event;
    ELSE
      UPDATE public.billing_webhook_events
      SET status = 'RETRYABLE', error_code = p_error_code,
          retry_count = retry_count + 1,
          retry_after = clock_timestamp() + make_interval(secs => LEAST(60, power(2, retry_count)::INTEGER)),
          updated_at = clock_timestamp()
      WHERE id = v_event.id RETURNING * INTO v_event;
    END IF;
  END IF;
  RETURN to_jsonb(v_event);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_prepare_webhook_settlement(
  p_provider TEXT,
  p_provider_event_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.billing_webhook_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event
  FROM public.billing_webhook_events
  WHERE provider = p_provider AND provider_event_id = p_provider_event_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'webhook event not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_event.status = 'RETRYABLE' AND v_event.retry_after <= clock_timestamp() THEN
    UPDATE public.billing_webhook_events
    SET status = 'RECEIVED', error_code = NULL, retry_after = NULL, updated_at = clock_timestamp()
    WHERE id = v_event.id RETURNING * INTO v_event;
  END IF;
  RETURN to_jsonb(v_event);
END;
$$;

REVOKE ALL ON FUNCTION public.billing_mark_webhook_retryable(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_prepare_webhook_settlement(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_mark_webhook_retryable(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_prepare_webhook_settlement(TEXT, TEXT) TO service_role;

COMMIT;
