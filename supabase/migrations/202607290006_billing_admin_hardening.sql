-- Forward-only hardening for installations that already applied 003 and 005.
-- The legacy implementation already validates the complete idempotency payload
-- (actor, user, amount, currency, reason and ledger result). This wrapper narrows
-- the writer role without rewriting migration history.
ALTER FUNCTION public.billing_adjust_credit(UUID, BIGINT, TEXT, TEXT, UUID, TEXT)
  RENAME TO billing_adjust_credit_legacy;

REVOKE ALL ON FUNCTION public.billing_adjust_credit_legacy(UUID, BIGINT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_adjust_credit_legacy(UUID, BIGINT, TEXT, TEXT, UUID, TEXT)
  TO service_role;

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
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.billing_admins
    WHERE user_id = p_admin_user_id
      AND role = 'BILLING_ADMIN'
      AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'active billing write administrator required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN public.billing_adjust_credit_legacy(
    p_user_id, p_amount, p_reason, p_idempotency_key, p_admin_user_id, p_currency
  );
EXCEPTION
  WHEN data_exception THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'data_exception';
END;
$$;

REVOKE ALL ON FUNCTION public.billing_adjust_credit(UUID, BIGINT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_adjust_credit(UUID, BIGINT, TEXT, TEXT, UUID, TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.billing_reject_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'billing administrator audit logs are immutable'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS billing_admin_audit_logs_immutable
  ON public.billing_admin_audit_logs;
CREATE TRIGGER billing_admin_audit_logs_immutable
BEFORE UPDATE OR DELETE ON public.billing_admin_audit_logs
FOR EACH ROW EXECUTE FUNCTION public.billing_reject_audit_log_mutation();

REVOKE ALL ON FUNCTION public.billing_reject_audit_log_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
