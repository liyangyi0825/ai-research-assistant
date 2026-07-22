-- Billing MVP schema. Monetary columns are integer minor units.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE public.billing_plans (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  billing_period TEXT NOT NULL CHECK (billing_period IN ('FREE', 'MONTHLY', 'YEARLY')),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  display_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.billing_products (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  plan_id UUID REFERENCES public.billing_plans(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  product_type TEXT NOT NULL CHECK (product_type IN ('SUBSCRIPTION', 'CREDIT_PACK')),
  price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  duration_days INTEGER CHECK (duration_days > 0),
  credit_grant BIGINT NOT NULL DEFAULT 0 CHECK (credit_grant >= 0),
  entitlement_version TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  display_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (product_type = 'SUBSCRIPTION' AND plan_id IS NOT NULL AND duration_days IS NOT NULL)
    OR
    (product_type = 'CREDIT_PACK' AND plan_id IS NULL AND credit_grant > 0)
  )
);

CREATE TABLE public.billing_plan_entitlements (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES public.billing_plans(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  entitlement_version TEXT NOT NULL,
  periodic_limit BIGINT CHECK (periodic_limit >= 0),
  credit_grant BIGINT NOT NULL DEFAULT 0 CHECK (credit_grant >= 0),
  configuration JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, feature_key, entitlement_version)
);

CREATE TABLE public.billing_orders (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  order_number TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES public.billing_products(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('MOCK', 'WECHAT', 'ALIPAY')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'CLOSED', 'REFUNDING', 'REFUNDED')
  ),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  snapshot_product_name TEXT NOT NULL,
  snapshot_product_type TEXT NOT NULL CHECK (
    snapshot_product_type IN ('SUBSCRIPTION', 'CREDIT_PACK')
  ),
  snapshot_plan_id UUID REFERENCES public.billing_plans(id) ON DELETE RESTRICT,
  snapshot_duration_days INTEGER CHECK (snapshot_duration_days > 0),
  snapshot_credit_grant BIGINT NOT NULL DEFAULT 0 CHECK (snapshot_credit_grant >= 0),
  snapshot_entitlement_version TEXT NOT NULL,
  snapshot_entitlements JSONB NOT NULL CHECK (
    jsonb_typeof(snapshot_entitlements) = 'array'
  ),
  snapshot_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  accepted_agreement_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  refund_status TEXT NOT NULL DEFAULT 'NONE' CHECK (
    refund_status IN ('NONE', 'REQUESTED', 'PARTIAL', 'FULL')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (
    status NOT IN ('PAID', 'REFUNDING', 'REFUNDED')
    OR paid_at IS NOT NULL
  ),
  CHECK (
    (snapshot_product_type = 'SUBSCRIPTION'
      AND snapshot_plan_id IS NOT NULL
      AND snapshot_duration_days IS NOT NULL)
    OR
    (snapshot_product_type = 'CREDIT_PACK'
      AND snapshot_plan_id IS NULL
      AND snapshot_credit_grant > 0)
  )
);

-- Service-only payment creation state. Provider tokens stay behind the service role;
-- callers receive them only through authenticated server routes.
CREATE TABLE public.billing_payment_intents (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES public.billing_orders(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('MOCK', 'WECHAT', 'ALIPAY')),
  request_idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'CREATING' CHECK (
    status IN ('CREATING', 'CREATED', 'FAILED')
  ),
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  provider_transaction_id TEXT,
  payment_token TEXT,
  payment_status TEXT CHECK (
    payment_status IS NULL OR payment_status IN ('PENDING', 'PAID', 'FAILED', 'CLOSED')
  ),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  last_error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_transaction_id),
  CHECK (
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
      AND provider_transaction_id IS NOT NULL
      AND payment_token IS NOT NULL
      AND payment_status IS NOT NULL
      AND last_error_code IS NULL)
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

CREATE TABLE public.billing_payments (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.billing_orders(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('MOCK', 'WECHAT', 'ALIPAY')),
  provider_transaction_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING', 'PAID', 'FAILED', 'CLOSED', 'REFUNDED')
  ),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  request_idempotency_key TEXT NOT NULL UNIQUE,
  response_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_transaction_id)
);

CREATE TABLE public.billing_subscriptions (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  plan_id UUID NOT NULL REFERENCES public.billing_plans(id) ON DELETE RESTRICT,
  source_order_id UUID NOT NULL UNIQUE REFERENCES public.billing_orders(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('ACTIVE', 'EXPIRED', 'CANCELLED')
  ),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  auto_renew BOOLEAN NOT NULL DEFAULT FALSE CHECK (auto_renew = FALSE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE public.billing_user_entitlements (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  plan_entitlement_id UUID REFERENCES public.billing_plan_entitlements(id) ON DELETE RESTRICT,
  feature_key TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('PLAN', 'ADMIN')),
  source_order_id UUID REFERENCES public.billing_orders(id) ON DELETE RESTRICT,
  entitlement_value JSONB NOT NULL DEFAULT '{}'::JSONB,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  UNIQUE (user_id, feature_key, source_order_id)
);

CREATE TABLE public.billing_usage_quotas (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  feature_key TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  quota_limit BIGINT NOT NULL CHECK (quota_limit >= 0),
  reserved_units BIGINT NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  used_units BIGINT NOT NULL DEFAULT 0 CHECK (used_units >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (reserved_units + used_units <= quota_limit),
  UNIQUE (user_id, feature_key, period_start, period_end)
);

CREATE TABLE public.billing_credit_accounts (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL DEFAULT 'CREDITS' CHECK (currency = 'CREDITS'),
  available_balance BIGINT NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  reserved_balance BIGINT NOT NULL DEFAULT 0 CHECK (reserved_balance >= 0),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, currency)
);

CREATE TABLE public.billing_usage_records (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  quota_id UUID REFERENCES public.billing_usage_quotas(id) ON DELETE RESTRICT,
  credit_account_id UUID REFERENCES public.billing_credit_accounts(id) ON DELETE RESTRICT,
  task_idempotency_key TEXT NOT NULL UNIQUE,
  feature_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (
    status IN ('RESERVED', 'FINALIZED', 'RELEASED')
  ),
  quota_units BIGINT NOT NULL DEFAULT 0 CHECK (quota_units >= 0),
  credit_amount BIGINT NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'CREDITS' CHECK (currency = 'CREDITS'),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (quota_units > 0 OR credit_amount > 0)
);

CREATE TABLE public.billing_credit_ledger (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.billing_credit_accounts(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (
    entry_type IN ('PURCHASE', 'GRANT', 'RESERVE', 'CONSUME', 'RELEASE', 'ADJUSTMENT')
  ),
  delta_available BIGINT NOT NULL,
  delta_reserved BIGINT NOT NULL,
  available_after BIGINT NOT NULL CHECK (available_after >= 0),
  reserved_after BIGINT NOT NULL CHECK (reserved_after >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  audit_log_id UUID,
  reference_type TEXT,
  reference_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.billing_webhook_events (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  order_id UUID REFERENCES public.billing_orders(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  order_number TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('MOCK', 'WECHAT', 'ALIPAY')),
  provider_event_id TEXT NOT NULL,
  provider_transaction_id TEXT,
  request_idempotency_key TEXT,
  amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR currency = 'CNY'),
  paid_at TIMESTAMPTZ,
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (
    status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')
  ),
  payload_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_code TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id),
  CHECK (
    status <> 'FAILED'
    OR NULLIF(btrim(error_code), '') IS NOT NULL
  ),
  CHECK (
    (
      status IN ('RECEIVED', 'PROCESSING', 'PROCESSED')
      AND signature_valid IS TRUE
      AND order_number IS NOT NULL
      AND provider_transaction_id IS NOT NULL
      AND request_idempotency_key IS NOT NULL
      AND amount_minor IS NOT NULL
      AND currency IS NOT NULL
      AND paid_at IS NOT NULL
    )
    OR
    (
      status = 'FAILED'
      AND (
        (
          signature_valid IS TRUE
          AND order_number IS NOT NULL
          AND provider_transaction_id IS NOT NULL
          AND request_idempotency_key IS NOT NULL
          AND amount_minor IS NOT NULL
          AND currency IS NOT NULL
          AND paid_at IS NOT NULL
        )
        OR
        (
          order_number IS NULL
          AND provider_transaction_id IS NULL
          AND request_idempotency_key IS NULL
          AND amount_minor IS NULL
          AND currency IS NULL
          AND paid_at IS NULL
        )
      )
    )
  )
);

CREATE TABLE public.billing_refund_requests (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.billing_orders(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_amount_minor BIGINT NOT NULL CHECK (requested_amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')
  ),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.billing_refunds (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  refund_request_id UUID NOT NULL UNIQUE REFERENCES public.billing_refund_requests(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES public.billing_orders(id) ON DELETE RESTRICT,
  payment_id UUID NOT NULL REFERENCES public.billing_payments(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('MOCK', 'WECHAT', 'ALIPAY')),
  provider_refund_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'SUCCEEDED', 'FAILED')
  ),
  refunded_amount_minor BIGINT NOT NULL CHECK (refunded_amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  idempotency_key TEXT NOT NULL UNIQUE,
  response_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_refund_id)
);

CREATE TABLE public.billing_invoice_requests (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  order_id UUID REFERENCES public.billing_orders(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  invoice_title TEXT NOT NULL,
  tax_identifier TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  delivery_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'ISSUED', 'REJECTED', 'CANCELLED')
  ),
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.billing_admins (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'BILLING_ADMIN' CHECK (
    role IN ('BILLING_ADMIN', 'BILLING_REVIEWER')
  ),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.billing_admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  target_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  reason TEXT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.billing_rate_limits (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, action, window_started_at)
);

ALTER TABLE public.billing_credit_ledger
  ADD CONSTRAINT billing_credit_ledger_audit_log_id_fkey
  FOREIGN KEY (audit_log_id)
  REFERENCES public.billing_admin_audit_logs(id)
  ON DELETE RESTRICT;

CREATE INDEX billing_orders_user_created_idx
  ON public.billing_orders (user_id, created_at DESC);
CREATE INDEX billing_payments_order_idx
  ON public.billing_payments (order_id);
CREATE INDEX billing_subscriptions_user_status_idx
  ON public.billing_subscriptions (user_id, status, ends_at DESC);
CREATE INDEX billing_user_entitlements_active_idx
  ON public.billing_user_entitlements (user_id, feature_key, valid_until);
CREATE INDEX billing_usage_records_user_created_idx
  ON public.billing_usage_records (user_id, created_at DESC);
CREATE INDEX billing_credit_ledger_account_created_idx
  ON public.billing_credit_ledger (account_id, created_at DESC);
CREATE INDEX billing_webhook_events_order_idx
  ON public.billing_webhook_events (order_id);
CREATE INDEX billing_refund_requests_user_created_idx
  ON public.billing_refund_requests (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.billing_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_protect_order_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.product_id,
    NEW.amount_minor,
    NEW.currency,
    NEW.snapshot_product_name,
    NEW.snapshot_product_type,
    NEW.snapshot_plan_id,
    NEW.snapshot_duration_days,
    NEW.snapshot_credit_grant,
    NEW.snapshot_entitlement_version,
    NEW.snapshot_entitlements,
    NEW.snapshot_details,
    NEW.accepted_agreement_version
  ) IS DISTINCT FROM ROW(
    OLD.product_id,
    OLD.amount_minor,
    OLD.currency,
    OLD.snapshot_product_name,
    OLD.snapshot_product_type,
    OLD.snapshot_plan_id,
    OLD.snapshot_duration_days,
    OLD.snapshot_credit_grant,
    OLD.snapshot_entitlement_version,
    OLD.snapshot_entitlements,
    OLD.snapshot_details,
    OLD.accepted_agreement_version
  ) THEN
    RAISE EXCEPTION 'billing order snapshots are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_protect_credit_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'billing credit ledger is immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_validate_webhook_event_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.id,
    NEW.order_number,
    NEW.provider,
    NEW.provider_event_id,
    NEW.provider_transaction_id,
    NEW.request_idempotency_key,
    NEW.amount_minor,
    NEW.currency,
    NEW.paid_at,
    NEW.signature_valid,
    NEW.payload_summary,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.order_number,
    OLD.provider,
    OLD.provider_event_id,
    OLD.provider_transaction_id,
    OLD.request_idempotency_key,
    OLD.amount_minor,
    OLD.currency,
    OLD.paid_at,
    OLD.signature_valid,
    OLD.payload_summary,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'billing webhook event payload is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (
      (OLD.status = 'RECEIVED' AND NEW.status IN ('PROCESSING', 'FAILED'))
      OR
      (OLD.status = 'PROCESSING' AND NEW.status IN ('PROCESSED', 'FAILED'))
    ) THEN
    RAISE EXCEPTION 'invalid billing webhook event status transition'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_orders_protect_snapshot
BEFORE UPDATE ON public.billing_orders
FOR EACH ROW EXECUTE FUNCTION public.billing_protect_order_snapshot();

CREATE TRIGGER billing_credit_ledger_immutable
BEFORE UPDATE OR DELETE ON public.billing_credit_ledger
FOR EACH ROW EXECUTE FUNCTION public.billing_protect_credit_ledger();

CREATE TRIGGER billing_webhook_events_validate_update
BEFORE UPDATE ON public.billing_webhook_events
FOR EACH ROW EXECUTE FUNCTION public.billing_validate_webhook_event_update();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'billing_plans',
    'billing_products',
    'billing_plan_entitlements',
    'billing_orders',
    'billing_payment_intents',
    'billing_payments',
    'billing_subscriptions',
    'billing_user_entitlements',
    'billing_usage_quotas',
    'billing_usage_records',
    'billing_credit_accounts',
    'billing_webhook_events',
    'billing_refund_requests',
    'billing_refunds',
    'billing_invoice_requests',
    'billing_admins',
    'billing_rate_limits'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON public.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION public.billing_set_updated_at()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.billing_set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_protect_order_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_protect_credit_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_validate_webhook_event_update() FROM PUBLIC;
