\set ON_ERROR_STOP on

\if :{?drill_commit}
\else
  \set drill_commit false
\endif

begin;

insert into auth.users (id, aud, role, created_at, updated_at)
values
  ('00000000-0000-4000-8000-00000000b001', 'authenticated', 'authenticated', timestamptz '2026-01-01 00:00:00+00', timestamptz '2026-01-01 00:00:00+00'),
  ('00000000-0000-4000-8000-00000000b002', 'authenticated', 'authenticated', timestamptz '2026-01-01 00:00:00+00', timestamptz '2026-01-01 00:00:00+00');

insert into public.billing_plans (
  id, code, name, description, billing_period, is_active, display_metadata,
  created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b010',
  'PRO',
  'Pro',
  'Synthetic billing recovery drill plan',
  'MONTHLY',
  false,
  '{"fixture":"billing-drill"}'::jsonb,
  timestamptz '2026-01-01 00:00:00+00',
  timestamptz '2026-01-01 00:00:00+00'
);

insert into public.billing_products (
  id, plan_id, sku, name, description, product_type, price_minor, currency,
  duration_days, credit_grant, entitlement_version, is_active, display_metadata,
  created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000b011',
    '00000000-0000-4000-8000-00000000b010',
    'PRO_MONTHLY',
    'Pro Monthly',
    'Synthetic billing recovery drill subscription',
    'SUBSCRIPTION',
    1990,
    'CNY',
    30,
    0,
    'pro-v1',
    false,
    '{"fixture":"billing-drill"}'::jsonb,
    timestamptz '2026-01-01 00:00:00+00',
    timestamptz '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-00000000b012',
    null,
    'CREDIT_PACK_100',
    'Credit Pack 100',
    'Synthetic billing recovery drill credit pack',
    'CREDIT_PACK',
    990,
    'CNY',
    null,
    100,
    'credit-v1',
    false,
    '{"fixture":"billing-drill"}'::jsonb,
    timestamptz '2026-01-01 00:00:00+00',
    timestamptz '2026-01-01 00:00:00+00'
  );

insert into public.billing_orders (
  id, order_number, user_id, product_id, provider, status, amount_minor, currency,
  snapshot_product_name, snapshot_product_type, snapshot_plan_id,
  snapshot_duration_days, snapshot_credit_grant, snapshot_entitlement_version,
  snapshot_entitlements, snapshot_details, accepted_agreement_version,
  expires_at, paid_at, refund_status, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000b020',
    'DRILL-PENDING-009',
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b011',
    'MOCK',
    'PENDING',
    1990,
    'CNY',
    'Pro Monthly',
    'SUBSCRIPTION',
    '00000000-0000-4000-8000-00000000b010',
    30,
    0,
    'pro-v1',
    '[{"feature_key":"summarize","periodic_limit":100,"credit_grant":0}]'::jsonb,
    '{"fixture":"billing-drill"}'::jsonb,
    'billing-drill-v1',
    timestamptz '2099-01-01 00:00:00+00',
    null,
    'NONE',
    timestamptz '2026-01-01 00:00:00+00',
    timestamptz '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-00000000b021',
    'DRILL-SUBSCRIPTION-009',
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b011',
    'MOCK',
    'PAID',
    1990,
    'CNY',
    'Pro Monthly',
    'SUBSCRIPTION',
    '00000000-0000-4000-8000-00000000b010',
    30,
    0,
    'pro-v1',
    '[{"feature_key":"summarize","periodic_limit":100,"credit_grant":0}]'::jsonb,
    '{"fixture":"billing-drill"}'::jsonb,
    'billing-drill-v1',
    timestamptz '2099-01-01 00:00:00+00',
    timestamptz '2026-01-02 00:00:00+00',
    'NONE',
    timestamptz '2026-01-01 00:00:00+00',
    timestamptz '2026-01-02 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-00000000b022',
    'DRILL-CREDIT-009',
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b012',
    'MOCK',
    'PAID',
    990,
    'CNY',
    'Credit Pack 100',
    'CREDIT_PACK',
    null,
    null,
    100,
    'credit-v1',
    '[]'::jsonb,
    '{"fixture":"billing-drill"}'::jsonb,
    'billing-drill-v1',
    timestamptz '2099-01-01 00:00:00+00',
    timestamptz '2026-01-03 00:00:00+00',
    'NONE',
    timestamptz '2026-01-01 00:00:00+00',
    timestamptz '2026-01-03 00:00:00+00'
  );

insert into public.billing_payments (
  id, order_id, user_id, provider, provider_transaction_id, status,
  amount_minor, currency, request_idempotency_key, response_summary, paid_at,
  created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-00000000b030',
    '00000000-0000-4000-8000-00000000b021',
    '00000000-0000-4000-8000-00000000b001',
    'MOCK',
    'DRILL-MOCK-SUBSCRIPTION-009',
    'PAID',
    1990,
    'CNY',
    'drill-subscription-payment-009',
    '{"fixture":"billing-drill"}'::jsonb,
    timestamptz '2026-01-02 00:00:00+00',
    timestamptz '2026-01-02 00:00:00+00',
    timestamptz '2026-01-02 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-00000000b031',
    '00000000-0000-4000-8000-00000000b022',
    '00000000-0000-4000-8000-00000000b001',
    'MOCK',
    'DRILL-MOCK-CREDIT-009',
    'PAID',
    990,
    'CNY',
    'drill-credit-payment-009',
    '{"fixture":"billing-drill"}'::jsonb,
    timestamptz '2026-01-03 00:00:00+00',
    timestamptz '2026-01-03 00:00:00+00',
    timestamptz '2026-01-03 00:00:00+00'
  );

insert into public.billing_subscriptions (
  id, user_id, plan_id, source_order_id, status, starts_at, ends_at,
  auto_renew, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b040',
  '00000000-0000-4000-8000-00000000b001',
  '00000000-0000-4000-8000-00000000b010',
  '00000000-0000-4000-8000-00000000b021',
  'ACTIVE',
  timestamptz '2026-01-02 00:00:00+00',
  timestamptz '2099-01-01 00:00:00+00',
  false,
  timestamptz '2026-01-02 00:00:00+00',
  timestamptz '2026-01-02 00:00:00+00'
);

insert into public.billing_user_entitlements (
  id, user_id, feature_key, source_type, source_order_id, entitlement_value,
  valid_from, valid_until, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b041',
  '00000000-0000-4000-8000-00000000b001',
  'summarize',
  'PLAN',
  '00000000-0000-4000-8000-00000000b021',
  '{"periodic_limit":100}'::jsonb,
  timestamptz '2026-01-02 00:00:00+00',
  timestamptz '2099-01-01 00:00:00+00',
  timestamptz '2026-01-02 00:00:00+00',
  timestamptz '2026-01-02 00:00:00+00'
);

insert into public.billing_usage_quotas (
  id, user_id, subscription_id, feature_key, period_start, period_end,
  quota_limit, reserved_units, used_units, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b042',
  '00000000-0000-4000-8000-00000000b001',
  '00000000-0000-4000-8000-00000000b040',
  'summarize',
  timestamptz '2026-01-02 00:00:00+00',
  timestamptz '2099-01-01 00:00:00+00',
  100,
  0,
  0,
  timestamptz '2026-01-02 00:00:00+00',
  timestamptz '2026-01-02 00:00:00+00'
);

insert into public.billing_credit_accounts (
  id, user_id, currency, available_balance, reserved_balance, version,
  created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b050',
  '00000000-0000-4000-8000-00000000b001',
  'CREDITS',
  100,
  0,
  1,
  timestamptz '2026-01-03 00:00:00+00',
  timestamptz '2026-01-03 00:00:00+00'
);

insert into public.billing_credit_ledger (
  id, account_id, user_id, entry_type, delta_available, delta_reserved,
  available_after, reserved_after, idempotency_key, reference_type,
  reference_id, metadata, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b051',
  '00000000-0000-4000-8000-00000000b050',
  '00000000-0000-4000-8000-00000000b001',
  'PURCHASE',
  100,
  0,
  100,
  0,
  'drill-credit-purchase-009',
  'ORDER',
  '00000000-0000-4000-8000-00000000b022',
  '{"fixture":"billing-drill"}'::jsonb,
  timestamptz '2026-01-03 00:00:00+00',
  timestamptz '2026-01-03 00:00:00+00'
);

insert into public.billing_refund_requests (
  id, order_id, user_id, requested_amount_minor, currency, reason, status,
  created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b060',
  '00000000-0000-4000-8000-00000000b021',
  '00000000-0000-4000-8000-00000000b001',
  1990,
  'CNY',
  'Synthetic billing recovery drill refund request',
  'PENDING',
  timestamptz '2026-01-04 00:00:00+00',
  timestamptz '2026-01-04 00:00:00+00'
);

insert into public.billing_invoice_requests (
  id, order_id, user_id, invoice_title, tax_identifier, amount_minor, currency,
  delivery_email, status, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b061',
  '00000000-0000-4000-8000-00000000b021',
  '00000000-0000-4000-8000-00000000b001',
  'Synthetic Billing Drill',
  null,
  1990,
  'CNY',
  'billing-drill@invalid.example',
  'PENDING',
  timestamptz '2026-01-04 00:00:00+00',
  timestamptz '2026-01-04 00:00:00+00'
);

insert into public.billing_webhook_events (
  id, order_id, user_id, order_number, provider, provider_event_id,
  provider_transaction_id, request_idempotency_key, amount_minor, currency,
  paid_at, signature_valid, status, payload_summary, processed_at, created_at,
  updated_at
)
values (
  '00000000-0000-4000-8000-00000000b070',
  '00000000-0000-4000-8000-00000000b022',
  '00000000-0000-4000-8000-00000000b001',
  'DRILL-CREDIT-009',
  'MOCK',
  'DRILL-MOCK-EVENT-009',
  'DRILL-MOCK-CREDIT-009',
  'drill-credit-payment-009',
  990,
  'CNY',
  timestamptz '2026-01-03 00:00:00+00',
  true,
  'PROCESSED',
  '{"fixture":"billing-drill"}'::jsonb,
  timestamptz '2026-01-03 00:00:00+00',
  timestamptz '2026-01-03 00:00:00+00',
  timestamptz '2026-01-03 00:00:00+00'
);

insert into public.billing_admins (
  id, user_id, role, is_active, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b080',
  '00000000-0000-4000-8000-00000000b002',
  'BILLING_ADMIN',
  true,
  timestamptz '2026-01-01 00:00:00+00',
  timestamptz '2026-01-01 00:00:00+00'
);

insert into public.billing_admin_audit_logs (
  id, actor_user_id, target_user_id, action, target_type, target_id, reason,
  before_value, after_value, created_at, updated_at
)
values (
  '00000000-0000-4000-8000-00000000b081',
  '00000000-0000-4000-8000-00000000b002',
  '00000000-0000-4000-8000-00000000b001',
  'DRILL_BASELINE',
  'RECOVERY_FIXTURE',
  '00000000-0000-4000-8000-00000000b001',
  'Synthetic billing recovery drill baseline',
  null,
  '{"fixture":"billing-drill"}'::jsonb,
  timestamptz '2026-01-01 00:00:00+00',
  timestamptz '2026-01-01 00:00:00+00'
);

\if :drill_commit
  commit;
\else
  rollback;
\endif
