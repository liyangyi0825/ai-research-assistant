-- Forward-only hardening for user refund and invoice requests.

ALTER TABLE public.billing_refund_requests
ADD CONSTRAINT billing_refund_requests_user_order_key
UNIQUE (user_id, order_id);

ALTER TABLE public.billing_invoice_requests
ADD CONSTRAINT billing_invoice_requests_user_order_key
UNIQUE (user_id, order_id);

CREATE OR REPLACE FUNCTION public.billing_request_refund(
  p_user_id UUID,
  p_order_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.billing_orders%ROWTYPE;
  v_request public.billing_refund_requests%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
    OR p_order_id IS NULL
    OR NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'invalid refund request'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT *
  INTO v_order
  FROM public.billing_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'billing order not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT *
  INTO v_request
  FROM public.billing_refund_requests
  WHERE user_id = p_user_id
    AND order_id = p_order_id;

  IF FOUND THEN
    RETURN to_jsonb(v_request);
  END IF;

  IF v_order.status IS DISTINCT FROM 'PAID'
    OR v_order.refund_status NOT IN ('NONE', 'REQUESTED') THEN
    RAISE EXCEPTION 'billing order cannot request refund'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.billing_refund_requests (
    order_id,
    user_id,
    requested_amount_minor,
    currency,
    reason
  )
  VALUES (
    v_order.id,
    v_order.user_id,
    v_order.amount_minor,
    v_order.currency,
    p_reason
  )
  RETURNING * INTO v_request;

  RETURN to_jsonb(v_request);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_request_invoice(
  p_user_id UUID,
  p_order_id UUID,
  p_invoice_title TEXT,
  p_tax_identifier TEXT,
  p_delivery_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.billing_orders%ROWTYPE;
  v_request public.billing_invoice_requests%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
    OR p_order_id IS NULL
    OR NULLIF(btrim(p_invoice_title), '') IS NULL
    OR NULLIF(btrim(p_delivery_email), '') IS NULL THEN
    RAISE EXCEPTION 'invalid invoice request'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT *
  INTO v_order
  FROM public.billing_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'billing order not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT *
  INTO v_request
  FROM public.billing_invoice_requests
  WHERE user_id = p_user_id
    AND order_id = p_order_id;

  IF FOUND THEN
    RETURN to_jsonb(v_request);
  END IF;

  IF v_order.status IS DISTINCT FROM 'PAID'
    OR v_order.refund_status IS NOT DISTINCT FROM 'FULL' THEN
    RAISE EXCEPTION 'billing order cannot request invoice'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  INSERT INTO public.billing_invoice_requests (
    order_id,
    user_id,
    invoice_title,
    tax_identifier,
    amount_minor,
    currency,
    delivery_email
  )
  VALUES (
    v_order.id,
    v_order.user_id,
    btrim(p_invoice_title),
    NULLIF(btrim(p_tax_identifier), ''),
    v_order.amount_minor,
    v_order.currency,
    lower(btrim(p_delivery_email))
  )
  RETURNING * INTO v_request;

  RETURN to_jsonb(v_request);
END;
$$;

REVOKE ALL ON FUNCTION public.billing_request_refund(UUID, UUID, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_request_refund(UUID, UUID, TEXT)
TO service_role;

REVOKE ALL ON FUNCTION public.billing_request_invoice(UUID, UUID, TEXT, TEXT, TEXT)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_request_invoice(UUID, UUID, TEXT, TEXT, TEXT)
TO service_role;
