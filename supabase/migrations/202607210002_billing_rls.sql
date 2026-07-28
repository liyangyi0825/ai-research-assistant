-- Billing tables default to deny. Client roles receive read-only grants backed by RLS.
ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_user_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_usage_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_usage_continuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoice_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.billing_plans FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_products FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_plan_entitlements FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_orders FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_payment_intents FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_payments FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_subscriptions FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_user_entitlements FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_usage_quotas FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_usage_records FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_usage_continuations FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_credit_accounts FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_credit_ledger FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_webhook_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_refund_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_refunds FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_invoice_requests FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_admins FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_admin_audit_logs FROM anon, authenticated;
REVOKE ALL ON TABLE public.billing_rate_limits FROM anon, authenticated;

GRANT SELECT ON TABLE
  public.billing_plans,
  public.billing_products,
  public.billing_plan_entitlements
TO anon, authenticated;

GRANT SELECT ON TABLE
  public.billing_orders,
  public.billing_payments,
  public.billing_subscriptions,
  public.billing_user_entitlements,
  public.billing_usage_quotas,
  public.billing_usage_records,
  public.billing_credit_accounts,
  public.billing_credit_ledger,
  public.billing_refund_requests,
  public.billing_refunds,
  public.billing_invoice_requests
TO authenticated;

GRANT ALL ON TABLE
  public.billing_plans,
  public.billing_products,
  public.billing_plan_entitlements,
  public.billing_orders,
  public.billing_payment_intents,
  public.billing_payments,
  public.billing_subscriptions,
  public.billing_user_entitlements,
  public.billing_usage_quotas,
  public.billing_usage_records,
  public.billing_usage_continuations,
  public.billing_credit_accounts,
  public.billing_credit_ledger,
  public.billing_webhook_events,
  public.billing_refund_requests,
  public.billing_refunds,
  public.billing_invoice_requests,
  public.billing_admins,
  public.billing_admin_audit_logs,
  public.billing_rate_limits
TO service_role;

CREATE POLICY billing_plans_select_active
ON public.billing_plans
FOR SELECT
TO anon, authenticated
USING (is_active = TRUE);

CREATE POLICY billing_products_select_active
ON public.billing_products
FOR SELECT
TO anon, authenticated
USING (is_active = TRUE);

CREATE POLICY billing_plan_entitlements_select_active
ON public.billing_plan_entitlements
FOR SELECT
TO anon, authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.billing_plans
    WHERE billing_plans.id = billing_plan_entitlements.plan_id
      AND billing_plans.is_active = TRUE
  )
);

CREATE POLICY billing_orders_select_own
ON public.billing_orders
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_payments_select_own
ON public.billing_payments
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_subscriptions_select_own
ON public.billing_subscriptions
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_user_entitlements_select_own
ON public.billing_user_entitlements
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_usage_quotas_select_own
ON public.billing_usage_quotas
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_usage_records_select_own
ON public.billing_usage_records
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_credit_accounts_select_own
ON public.billing_credit_accounts
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_credit_ledger_select_own
ON public.billing_credit_ledger
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_refund_requests_select_own
ON public.billing_refund_requests
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_refunds_select_own
ON public.billing_refunds
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY billing_invoice_requests_select_own
ON public.billing_invoice_requests
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);
