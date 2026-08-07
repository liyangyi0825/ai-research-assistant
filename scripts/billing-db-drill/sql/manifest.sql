\set ON_ERROR_STOP on

with
migration_manifest as (
  select coalesce(jsonb_agg(version order by version), '[]'::jsonb) as value
  from supabase_migrations.schema_migrations
),
safe_table_counts(table_name, row_count) as (
  values
    ('billing_plans', (select count(*) from public.billing_plans)),
    ('billing_products', (select count(*) from public.billing_products)),
    ('billing_plan_entitlements', (select count(*) from public.billing_plan_entitlements)),
    ('billing_orders', (select count(*) from public.billing_orders)),
    ('billing_payment_intents', (select count(*) from public.billing_payment_intents)),
    ('billing_payments', (select count(*) from public.billing_payments)),
    ('billing_subscriptions', (select count(*) from public.billing_subscriptions)),
    ('billing_user_entitlements', (select count(*) from public.billing_user_entitlements)),
    ('billing_usage_quotas', (select count(*) from public.billing_usage_quotas)),
    ('billing_usage_records', (select count(*) from public.billing_usage_records)),
    ('billing_usage_continuations', (select count(*) from public.billing_usage_continuations)),
    ('billing_credit_accounts', (select count(*) from public.billing_credit_accounts)),
    ('billing_credit_ledger', (select count(*) from public.billing_credit_ledger)),
    ('billing_webhook_events', (select count(*) from public.billing_webhook_events)),
    ('billing_refund_requests', (select count(*) from public.billing_refund_requests)),
    ('billing_refunds', (select count(*) from public.billing_refunds)),
    ('billing_invoice_requests', (select count(*) from public.billing_invoice_requests)),
    ('billing_admins', (select count(*) from public.billing_admins)),
    ('billing_admin_audit_logs', (select count(*) from public.billing_admin_audit_logs)),
    ('billing_rate_limits', (select count(*) from public.billing_rate_limits)),
    ('billing_feature_usage_costs', (select count(*) from public.billing_feature_usage_costs))
),
table_count_manifest as (
  select jsonb_object_agg(table_name, row_count order by table_name) as value
  from safe_table_counts
),
fixture_order_rows as (
  select
    id,
    order_number,
    provider,
    status,
    amount_minor,
    currency,
    concat_ws('|', id::text, order_number, provider, status, amount_minor::text, currency) as checksum_input
  from public.billing_orders
  where id::text like '00000000-0000-4000-8000-00000000b0%'
),
fixture_order_manifest as (
  select jsonb_build_object(
    'tuples', coalesce(
      jsonb_agg(jsonb_build_array(id, order_number, provider, status, amount_minor, currency) order by id),
      '[]'::jsonb
    ),
    'sha256', encode(
      extensions.digest(
        convert_to(coalesce(string_agg(checksum_input, E'\n' order by id), ''), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ) as value
  from fixture_order_rows
),
fixture_payment_rows as (
  select
    id,
    order_id,
    provider,
    status,
    amount_minor,
    currency,
    concat_ws('|', id::text, order_id::text, provider, status, amount_minor::text, currency) as checksum_input
  from public.billing_payments
  where id::text like '00000000-0000-4000-8000-00000000b0%'
),
fixture_payment_manifest as (
  select jsonb_build_object(
    'tuples', coalesce(
      jsonb_agg(jsonb_build_array(id, order_id, provider, status, amount_minor, currency) order by id),
      '[]'::jsonb
    ),
    'sha256', encode(
      extensions.digest(
        convert_to(coalesce(string_agg(checksum_input, E'\n' order by id), ''), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ) as value
  from fixture_payment_rows
),
fixture_balance_rows as (
  select
    id,
    user_id,
    currency,
    available_balance,
    reserved_balance,
    version,
    concat_ws(
      '|', id::text, user_id::text, currency, available_balance::text,
      reserved_balance::text, version::text
    ) as checksum_input
  from public.billing_credit_accounts
  where id::text like '00000000-0000-4000-8000-00000000b0%'
),
fixture_balance_manifest as (
  select jsonb_build_object(
    'tuples', coalesce(
      jsonb_agg(
        jsonb_build_array(id, user_id, currency, available_balance, reserved_balance, version)
        order by id
      ),
      '[]'::jsonb
    ),
    'sha256', encode(
      extensions.digest(
        convert_to(coalesce(string_agg(checksum_input, E'\n' order by id), ''), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ) as value
  from fixture_balance_rows
),
fixture_audit_rows as (
  select
    id,
    actor_user_id,
    target_user_id,
    action,
    target_type,
    target_id,
    concat_ws(
      '|', id::text, actor_user_id::text, target_user_id::text,
      action, target_type, target_id
    ) as checksum_input
  from public.billing_admin_audit_logs
  where id::text like '00000000-0000-4000-8000-00000000b0%'
),
fixture_audit_manifest as (
  select jsonb_build_object(
    'tuples', coalesce(
      jsonb_agg(
        jsonb_build_array(id, actor_user_id, target_user_id, action, target_type, target_id)
        order by id
      ),
      '[]'::jsonb
    ),
    'sha256', encode(
      extensions.digest(
        convert_to(coalesce(string_agg(checksum_input, E'\n' order by id), ''), 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ) as value
  from fixture_audit_rows
),
fixture_manifest as (
  select jsonb_build_object(
    'orders', fixture_order_manifest.value,
    'payments', fixture_payment_manifest.value,
    'credit_balances', fixture_balance_manifest.value,
    'admin_audits', fixture_audit_manifest.value
  ) as value
  from fixture_order_manifest, fixture_payment_manifest, fixture_balance_manifest, fixture_audit_manifest
),
catalog_manifest as (
  select jsonb_build_object(
    'plans', (
      select coalesce(
        jsonb_agg(jsonb_build_array(code, name, billing_period, is_active) order by code),
        '[]'::jsonb
      )
      from public.billing_plans
      where is_active = false
    ),
    'products', (
      select coalesce(
        jsonb_agg(
          jsonb_build_array(
            sku, name, product_type, price_minor, currency, duration_days,
            credit_grant, is_active
          )
          order by sku
        ),
        '[]'::jsonb
      )
      from public.billing_products
      where is_active = false
    )
  ) as value
),
security_manifest as (
  select jsonb_build_object(
    'billing_tables', count(*),
    'rls_enabled_tables', count(*) filter (where relrowsecurity),
    'security_definer_functions', (
      select count(*)
      from pg_catalog.pg_proc
      where pronamespace = 'public'::regnamespace
        and proname like 'billing\_%' escape '\'
        and prosecdef
    )
  ) as value
  from pg_catalog.pg_class
  where relnamespace = 'public'::regnamespace
    and relkind = 'r'
    and relname like 'billing\_%' escape '\'
),
behavior_manifest as (
  select jsonb_build_object(
    'pending_orders', count(*) filter (where status = 'PENDING'),
    'paid_orders', count(*) filter (where status = 'PAID'),
    'processed_events', (
      select count(*)
      from public.billing_webhook_events
      where id::text like '00000000-0000-4000-8000-00000000b0%'
        and status = 'PROCESSED'
    ),
    'fixture_refunds', (
      select count(*)
      from public.billing_refund_requests
      where id::text like '00000000-0000-4000-8000-00000000b0%'
    )
  ) as value
  from public.billing_orders
  where id::text like '00000000-0000-4000-8000-00000000b0%'
)
-- BILLING_DRILL_MANIFEST
select jsonb_build_object(
  'migration_versions', migration_manifest.value,
  'table_counts', table_count_manifest.value,
  'fixture_checksums', fixture_manifest.value,
  'catalog', catalog_manifest.value,
  'security_checks', security_manifest.value,
  'behavior_checks', behavior_manifest.value
)
from migration_manifest,
  table_count_manifest,
  fixture_manifest,
  catalog_manifest,
  security_manifest,
  behavior_manifest;
