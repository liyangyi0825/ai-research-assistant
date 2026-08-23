\set ON_ERROR_STOP on

begin;

set local search_path = pg_catalog, public;

do $verify$
declare
  expected_migration_versions constant text[] := array[
    '202607210001',
    '202607210002',
    '202607210003',
    '202607230004',
    '202607290005',
    '202607290006',
    '202607290007',
    '202607290008',
    '202607290009',
    '202608050010',
    '202608120011',
    '202608160012',
    '202608180013',
    '202608210014'
  ];
  expected_tables constant text[] := array[
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
    'billing_usage_continuations',
    'billing_credit_accounts',
    'billing_credit_ledger',
    'billing_webhook_events',
    'billing_refund_requests',
    'billing_refunds',
    'billing_invoice_requests',
    'billing_admins',
    'billing_admin_audit_logs',
    'billing_rate_limits',
    'billing_feature_usage_costs'
  ];
  actual_migration_versions text[];
  missing_items text[];
begin
  select coalesce(array_agg(version::text order by version), array[]::text[])
  into actual_migration_versions
  from supabase_migrations.schema_migrations;
  if actual_migration_versions is distinct from expected_migration_versions then
    raise exception 'billing migration history mismatch';
  end if;

  select array_agg(item order by item)
  into missing_items
  from unnest(expected_tables) as item
  where to_regclass(format('public.%I', item)) is null;
  if missing_items is not null then
    raise exception 'missing billing tables: %', missing_items;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    join pg_catalog.pg_attrdef as default_value
      on default_value.adrelid = attribute.attrelid
     and default_value.adnum = attribute.attnum
    where attribute.attrelid = 'public.billing_refunds'::regclass
      and attribute.attname = 'execution_managed'
      and attribute.attnotnull
      and not attribute.attisdropped
      and pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) = 'true'
  ) then
    raise exception 'billing refund execution marker contract mismatch';
  end if;

  with expected_indexes(
    schema_name, table_name, index_name, column_names, expected_indoptions,
    access_method, expected_unique, expected_predicate
  ) as (
    values
      ('public', 'billing_orders', 'billing_orders_user_created_idx', array['user_id', 'created_at'], array[0, 3], 'btree', false, null::text),
      ('public', 'billing_payments', 'billing_payments_order_idx', array['order_id'], array[0], 'btree', false, null::text),
      ('public', 'billing_subscriptions', 'billing_subscriptions_user_status_idx', array['user_id', 'status', 'ends_at'], array[0, 0, 3], 'btree', false, null::text),
      ('public', 'billing_user_entitlements', 'billing_user_entitlements_active_idx', array['user_id', 'feature_key', 'valid_until'], array[0, 0, 0], 'btree', false, null::text),
      ('public', 'billing_usage_records', 'billing_usage_records_user_created_idx', array['user_id', 'created_at'], array[0, 3], 'btree', false, null::text),
      ('public', 'billing_credit_ledger', 'billing_credit_ledger_account_created_idx', array['account_id', 'created_at'], array[0, 3], 'btree', false, null::text),
      ('public', 'billing_webhook_events', 'billing_webhook_events_order_idx', array['order_id'], array[0], 'btree', false, null::text),
      ('public', 'billing_refund_requests', 'billing_refund_requests_user_created_idx', array['user_id', 'created_at'], array[0, 3], 'btree', false, null::text),
      ('public', 'billing_refunds', 'billing_refunds_claim_expiry_idx', array['claim_expires_at'], array[0], 'btree', false, '((status = ''PENDING''::text) AND (claim_token IS NOT NULL))')
  )
  select array_agg(format('%I.%I.%I', expected.schema_name, expected.table_name, expected.index_name) order by expected.index_name)
  into missing_items
  from expected_indexes as expected
  left join pg_catalog.pg_class as index_class
    on index_class.relnamespace = expected.schema_name::regnamespace
   and index_class.relname = expected.index_name
   and index_class.relkind = 'i'
  left join pg_catalog.pg_index as index_meta on index_meta.indexrelid = index_class.oid
  left join pg_catalog.pg_am as access_method on access_method.oid = index_class.relam
  where index_meta.indexrelid is null
     or index_meta.indrelid is distinct from to_regclass(format('%I.%I', expected.schema_name, expected.table_name))
     or index_meta.indisvalid is not true
     or index_meta.indisready is not true
     or index_meta.indislive is not true
     or index_meta.indisunique is distinct from expected.expected_unique
     or access_method.amname is distinct from expected.access_method
     or index_meta.indnkeyatts is distinct from cardinality(expected.column_names)
     or index_meta.indnatts is distinct from cardinality(expected.column_names)
     or (
       select array_agg(attribute.attname order by key_position.ordinality)
       from unnest(index_meta.indkey) with ordinality as key_position(attnum, ordinality)
       join pg_catalog.pg_attribute as attribute
         on attribute.attrelid = index_meta.indrelid
         and attribute.attnum = key_position.attnum
       where key_position.ordinality <= index_meta.indnkeyatts
     ) is distinct from expected.column_names
     or (
       select array_agg(sort_option.option::integer order by sort_option.ordinality)
       from unnest(index_meta.indoption) with ordinality as sort_option(option, ordinality)
       where sort_option.ordinality <= index_meta.indnkeyatts
     ) is distinct from expected.expected_indoptions
     or pg_catalog.pg_get_expr(index_meta.indpred, index_meta.indrelid)
        is distinct from expected.expected_predicate;
  if missing_items is not null then
    raise exception 'missing, invalid, or mismatched billing indexes: %', missing_items;
  end if;

  with expected_constraints(
    schema_name, table_name, constraint_name, constraint_type, expected_definition
  ) as (
    values
      ('public', 'billing_plans', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_plans', null::text, 'u', '^UNIQUE \(code\)$'),
      ('public', 'billing_plans', 'billing_plans_billing_period_check', 'c', '^CHECK \(\(billing_period = ANY \(ARRAY\[''FREE''::text, ''MONTHLY''::text, ''YEARLY''::text, ''SEMESTER''::text\]\)\)\)$'),

      ('public', 'billing_products', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_products', null::text, 'f', '^FOREIGN KEY \(plan_id\) REFERENCES billing_plans\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_products', null::text, 'u', '^UNIQUE \(sku\)$'),
      ('public', 'billing_products', null::text, 'c', '^CHECK \(\(product_type = ANY \(ARRAY\[''SUBSCRIPTION''::text, ''CREDIT_PACK''::text\]\)\)\)$'),
      ('public', 'billing_products', null::text, 'c', '^CHECK \(\(price_minor >= 0\)\)$'),
      ('public', 'billing_products', null::text, 'c', '^CHECK \(\(currency = ''CNY''::text\)\)$'),
      ('public', 'billing_products', null::text, 'c', '^CHECK \(\(duration_days > 0\)\)$'),
      ('public', 'billing_products', null::text, 'c', '^CHECK \(\(credit_grant >= 0\)\)$'),
      ('public', 'billing_products', null::text, 'c', '^CHECK \(\(\(\(product_type = ''SUBSCRIPTION''::text\) AND \(plan_id IS NOT NULL\) AND \(duration_days IS NOT NULL\)\) OR \(\(product_type = ''CREDIT_PACK''::text\) AND \(plan_id IS NULL\) AND \(credit_grant > 0\)\)\)\)$'),

      ('public', 'billing_plan_entitlements', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_plan_entitlements', null::text, 'f', '^FOREIGN KEY \(plan_id\) REFERENCES billing_plans\(id\) ON DELETE CASCADE$'),
      ('public', 'billing_plan_entitlements', null::text, 'u', '^UNIQUE \(plan_id, feature_key, entitlement_version\)$'),
      ('public', 'billing_plan_entitlements', null::text, 'c', '^CHECK \(\(periodic_limit >= 0\)\)$'),
      ('public', 'billing_plan_entitlements', null::text, 'c', '^CHECK \(\(credit_grant >= 0\)\)$'),

      ('public', 'billing_orders', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_orders', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_orders', null::text, 'f', '^FOREIGN KEY \(product_id\) REFERENCES billing_products\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_orders', null::text, 'f', '^FOREIGN KEY \(snapshot_plan_id\) REFERENCES billing_plans\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_orders', null::text, 'u', '^UNIQUE \(order_number\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(provider = ANY \(ARRAY\[''MOCK''::text, ''WECHAT''::text, ''ALIPAY''::text\]\)\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''PENDING''::text, ''PAID''::text, ''FAILED''::text, ''CANCELLED''::text, ''CLOSED''::text, ''REFUNDING''::text, ''REFUNDED''::text\]\)\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(amount_minor >= 0\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(currency = ''CNY''::text\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(snapshot_product_type = ANY \(ARRAY\[''SUBSCRIPTION''::text, ''CREDIT_PACK''::text\]\)\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(snapshot_duration_days > 0\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(snapshot_credit_grant >= 0\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(jsonb_typeof\(snapshot_entitlements\) = ''array''::text\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(refund_status = ANY \(ARRAY\[''NONE''::text, ''REQUESTED''::text, ''PARTIAL''::text, ''FULL''::text\]\)\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(expires_at > created_at\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(\(status <> ALL \(ARRAY\[''PAID''::text, ''REFUNDING''::text, ''REFUNDED''::text\]\)\) OR \(paid_at IS NOT NULL\)\)\)$'),
      ('public', 'billing_orders', null::text, 'c', '^CHECK \(\(\(\(snapshot_product_type = ''SUBSCRIPTION''::text\) AND \(snapshot_plan_id IS NOT NULL\) AND \(snapshot_duration_days IS NOT NULL\)\) OR \(\(snapshot_product_type = ''CREDIT_PACK''::text\) AND \(snapshot_plan_id IS NULL\) AND \(snapshot_credit_grant > 0\)\)\)\)$'),

      ('public', 'billing_payment_intents', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_payment_intents', null::text, 'f', '^FOREIGN KEY \(order_id\) REFERENCES billing_orders\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_payment_intents', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_payment_intents', null::text, 'u', '^UNIQUE \(order_id\)$'),
      ('public', 'billing_payment_intents', null::text, 'u', '^UNIQUE \(request_idempotency_key\)$'),
      ('public', 'billing_payment_intents', null::text, 'u', '^UNIQUE \(provider, provider_transaction_id\)$'),
      ('public', 'billing_payment_intents', 'billing_payment_intents_merchant_order_unique', 'u', '^UNIQUE \(provider, merchant_order_number\)$'),
      ('public', 'billing_payment_intents', null::text, 'c', '^CHECK \(\(provider = ANY \(ARRAY\[''MOCK''::text, ''WECHAT''::text, ''ALIPAY''::text\]\)\)\)$'),
      ('public', 'billing_payment_intents', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''CREATING''::text, ''CREATED''::text, ''FAILED''::text\]\)\)\)$'),
      ('public', 'billing_payment_intents', null::text, 'c', '^CHECK \(\(\(payment_status IS NULL\) OR \(payment_status = ANY \(ARRAY\[''PENDING''::text, ''PAID''::text, ''FAILED''::text, ''CLOSED''::text\]\)\)\)\)$'),
      ('public', 'billing_payment_intents', null::text, 'c', '^CHECK \(\(amount_minor >= 0\)\)$'),
      ('public', 'billing_payment_intents', null::text, 'c', '^CHECK \(\(currency = ''CNY''::text\)\)$'),
      ('public', 'billing_payment_intents', null::text, 'c', '^CHECK \(\(attempt_count > 0\)\)$'),
      ('public', 'billing_payment_intents', 'billing_payment_intents_lifecycle_check', 'c', '^CHECK \(\(\(NULLIF\(btrim\(merchant_order_number\), ''''::text\) IS NOT NULL\) AND \(\(\(provider = ''WECHAT''::text\) AND \(merchant_order_number ~ ''\^\[A-Za-z0-9_\|\*-\]\{6,32\}\$''::text\)\) OR \(\(provider <> ''WECHAT''::text\) AND \(merchant_order_number ~ ''\^\[A-Za-z0-9_\|\*-\]\{1,64\}\$''::text\)\)\) AND \(\(\(status = ''CREATING''::text\) AND \(claim_token IS NOT NULL\) AND \(claim_expires_at IS NOT NULL\) AND \(provider_transaction_id IS NULL\) AND \(payment_token IS NULL\) AND \(payment_status IS NULL\) AND \(last_error_code IS NULL\)\).*\(\(status = ''CREATED''::text\) AND \(claim_token IS NULL\) AND \(claim_expires_at IS NULL\) AND \(last_error_code IS NULL\).*\(payment_status = ''PENDING''::text\).*\(payment_token IS NOT NULL\).*\(paid_at IS NULL\).*\(payment_status = ''PAID''::text\).*\(provider_transaction_id IS NOT NULL\).*\(paid_at IS NOT NULL\).*\(payment_status = ANY \(ARRAY\[''FAILED''::text, ''CLOSED''::text\]\)\).*\(payment_token IS NULL\).*\(paid_at IS NULL\).*\(\(status = ''FAILED''::text\) AND \(claim_token IS NULL\) AND \(claim_expires_at IS NULL\) AND \(provider_transaction_id IS NULL\) AND \(payment_token IS NULL\) AND \(payment_status IS NULL\) AND \(NULLIF\(btrim\(last_error_code\), ''''::text\) IS NOT NULL\)\)\)\)\)$'),

      ('public', 'billing_payments', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_payments', null::text, 'f', '^FOREIGN KEY \(order_id\) REFERENCES billing_orders\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_payments', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_payments', null::text, 'u', '^UNIQUE \(request_idempotency_key\)$'),
      ('public', 'billing_payments', null::text, 'u', '^UNIQUE \(provider, provider_transaction_id\)$'),
      ('public', 'billing_payments', null::text, 'c', '^CHECK \(\(provider = ANY \(ARRAY\[''MOCK''::text, ''WECHAT''::text, ''ALIPAY''::text\]\)\)\)$'),
      ('public', 'billing_payments', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''PENDING''::text, ''PAID''::text, ''FAILED''::text, ''CLOSED''::text, ''REFUNDED''::text\]\)\)\)$'),
      ('public', 'billing_payments', null::text, 'c', '^CHECK \(\(amount_minor >= 0\)\)$'),
      ('public', 'billing_payments', null::text, 'c', '^CHECK \(\(currency = ''CNY''::text\)\)$'),

      ('public', 'billing_subscriptions', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_subscriptions', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_subscriptions', null::text, 'f', '^FOREIGN KEY \(plan_id\) REFERENCES billing_plans\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_subscriptions', null::text, 'f', '^FOREIGN KEY \(source_order_id\) REFERENCES billing_orders\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_subscriptions', null::text, 'u', '^UNIQUE \(source_order_id\)$'),
      ('public', 'billing_subscriptions', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''ACTIVE''::text, ''EXPIRED''::text, ''CANCELLED''::text\]\)\)\)$'),
      ('public', 'billing_subscriptions', null::text, 'c', '^CHECK \(\(auto_renew = false\)\)$'),
      ('public', 'billing_subscriptions', null::text, 'c', '^CHECK \(\(ends_at > starts_at\)\)$'),

      ('public', 'billing_user_entitlements', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_user_entitlements', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_user_entitlements', null::text, 'f', '^FOREIGN KEY \(plan_entitlement_id\) REFERENCES billing_plan_entitlements\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_user_entitlements', null::text, 'f', '^FOREIGN KEY \(source_order_id\) REFERENCES billing_orders\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_user_entitlements', null::text, 'u', '^UNIQUE \(user_id, feature_key, source_order_id\)$'),
      ('public', 'billing_user_entitlements', null::text, 'c', '^CHECK \(\(source_type = ANY \(ARRAY\[''PLAN''::text, ''ADMIN''::text\]\)\)\)$'),
      ('public', 'billing_user_entitlements', null::text, 'c', '^CHECK \(\(\(valid_until IS NULL\) OR \(valid_until > valid_from\)\)\)$'),

      ('public', 'billing_usage_quotas', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_usage_quotas', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_usage_quotas', null::text, 'f', '^FOREIGN KEY \(subscription_id\) REFERENCES billing_subscriptions\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_usage_quotas', null::text, 'u', '^UNIQUE \(subscription_id, feature_key\)$'),
      ('public', 'billing_usage_quotas', null::text, 'u', '^UNIQUE \(user_id, feature_key, period_start, period_end\)$'),
      ('public', 'billing_usage_quotas', null::text, 'c', '^CHECK \(\(quota_limit >= 0\)\)$'),
      ('public', 'billing_usage_quotas', null::text, 'c', '^CHECK \(\(reserved_units >= 0\)\)$'),
      ('public', 'billing_usage_quotas', null::text, 'c', '^CHECK \(\(used_units >= 0\)\)$'),
      ('public', 'billing_usage_quotas', null::text, 'c', '^CHECK \(\(period_end > period_start\)\)$'),
      ('public', 'billing_usage_quotas', null::text, 'c', '^CHECK \(\(\(reserved_units \+ used_units\) <= quota_limit\)\)$'),

      ('public', 'billing_credit_accounts', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_credit_accounts', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_credit_accounts', null::text, 'u', '^UNIQUE \(user_id, currency\)$'),
      ('public', 'billing_credit_accounts', null::text, 'c', '^CHECK \(\(currency = ''CREDITS''::text\)\)$'),
      ('public', 'billing_credit_accounts', null::text, 'c', '^CHECK \(\(available_balance >= 0\)\)$'),
      ('public', 'billing_credit_accounts', null::text, 'c', '^CHECK \(\(reserved_balance >= 0\)\)$'),
      ('public', 'billing_credit_accounts', null::text, 'c', '^CHECK \(\(version >= 0\)\)$'),

      ('public', 'billing_usage_records', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_usage_records', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_usage_records', null::text, 'f', '^FOREIGN KEY \(quota_id\) REFERENCES billing_usage_quotas\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_usage_records', null::text, 'f', '^FOREIGN KEY \(credit_account_id\) REFERENCES billing_credit_accounts\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_usage_records', null::text, 'u', '^UNIQUE \(task_idempotency_key\)$'),
      ('public', 'billing_usage_records', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''RESERVED''::text, ''FINALIZED''::text, ''RELEASED''::text\]\)\)\)$'),
      ('public', 'billing_usage_records', null::text, 'c', '^CHECK \(\(quota_units >= 0\)\)$'),
      ('public', 'billing_usage_records', null::text, 'c', '^CHECK \(\(credit_amount >= 0\)\)$'),
      ('public', 'billing_usage_records', null::text, 'c', '^CHECK \(\(currency = ''CREDITS''::text\)\)$'),
      ('public', 'billing_usage_records', null::text, 'c', '^CHECK \(\(\(quota_units > 0\) OR \(credit_amount > 0\)\)\)$'),

      ('public', 'billing_usage_continuations', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_usage_continuations', null::text, 'f', '^FOREIGN KEY \(root_usage_record_id\) REFERENCES billing_usage_records\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_usage_continuations', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_usage_continuations', null::text, 'u', '^UNIQUE \(user_id, root_task_idempotency_key, feature_key, operation_key, stage_key\)$'),
      ('public', 'billing_usage_continuations', null::text, 'c', '^CHECK \(\(\(request_hash IS NULL\) OR \(request_hash ~ ''\^\[0-9a-f\]\{64\}\$''::text\)\)\)$'),
      ('public', 'billing_usage_continuations', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''AVAILABLE''::text, ''CLAIMED''::text, ''COMPLETED''::text\]\)\)\)$'),
      ('public', 'billing_usage_continuations', null::text, 'c', '^CHECK \(\(\(\(status = ''AVAILABLE''::text\) AND \(claim_token IS NULL\) AND \(lease_expires_at IS NULL\)\) OR \(\(status = ''CLAIMED''::text\) AND \(claim_token IS NOT NULL\) AND \(lease_expires_at IS NOT NULL\) AND \(request_hash IS NOT NULL\)\) OR \(\(status = ''COMPLETED''::text\) AND \(claim_token IS NULL\) AND \(lease_expires_at IS NULL\) AND \(request_hash IS NOT NULL\) AND \(completed_at IS NOT NULL\)\)\)\)$'),

      ('public', 'billing_credit_ledger', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_credit_ledger', null::text, 'f', '^FOREIGN KEY \(account_id\) REFERENCES billing_credit_accounts\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_credit_ledger', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_credit_ledger', 'billing_credit_ledger_audit_log_id_fkey', 'f', '^FOREIGN KEY \(audit_log_id\) REFERENCES billing_admin_audit_logs\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_credit_ledger', null::text, 'u', '^UNIQUE \(idempotency_key\)$'),
      ('public', 'billing_credit_ledger', null::text, 'c', '^CHECK \(\(entry_type = ANY \(ARRAY\[''PURCHASE''::text, ''GRANT''::text, ''RESERVE''::text, ''CONSUME''::text, ''RELEASE''::text, ''ADJUSTMENT''::text\]\)\)\)$'),
      ('public', 'billing_credit_ledger', null::text, 'c', '^CHECK \(\(available_after >= 0\)\)$'),
      ('public', 'billing_credit_ledger', null::text, 'c', '^CHECK \(\(reserved_after >= 0\)\)$'),

      ('public', 'billing_webhook_events', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_webhook_events', null::text, 'f', '^FOREIGN KEY \(order_id\) REFERENCES billing_orders\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_webhook_events', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_webhook_events', null::text, 'u', '^UNIQUE \(provider, provider_event_id\)$'),
      ('public', 'billing_webhook_events', null::text, 'c', '^CHECK \(\(provider = ANY \(ARRAY\[''MOCK''::text, ''WECHAT''::text, ''ALIPAY''::text\]\)\)\)$'),
      ('public', 'billing_webhook_events', null::text, 'c', '^CHECK \(\(\(amount_minor IS NULL\) OR \(amount_minor >= 0\)\)\)$'),
      ('public', 'billing_webhook_events', null::text, 'c', '^CHECK \(\(\(currency IS NULL\) OR \(currency = ''CNY''::text\)\)\)$'),
      ('public', 'billing_webhook_events', 'billing_webhook_events_status_check', 'c', '^CHECK \(\(status = ANY \(ARRAY\[''RECEIVED''::text, ''PROCESSING''::text, ''PROCESSED''::text, ''RETRYABLE''::text, ''FAILED''::text\]\)\)\)$'),
      ('public', 'billing_webhook_events', 'billing_webhook_events_error_code_check', 'c', '^CHECK \(\(\(status <> ALL \(ARRAY\[''FAILED''::text, ''RETRYABLE''::text\]\)\) OR \(NULLIF\(btrim\(error_code\), ''''::text\) IS NOT NULL\)\)\)$'),
      ('public', 'billing_webhook_events', 'billing_webhook_events_payload_state_check', 'c', '^CHECK \(\(\(\(status = ANY \(ARRAY\[''RECEIVED''::text, ''PROCESSING''::text, ''PROCESSED''::text, ''RETRYABLE''::text\]\)\) AND \(signature_valid IS TRUE\) AND \(order_number IS NOT NULL\) AND \(provider_transaction_id IS NOT NULL\) AND \(request_idempotency_key IS NOT NULL\) AND \(amount_minor IS NOT NULL\) AND \(currency IS NOT NULL\) AND \(paid_at IS NOT NULL\)\) OR \(\(status = ''FAILED''::text\) AND \(\(\(signature_valid IS TRUE\) AND \(order_number IS NOT NULL\) AND \(provider_transaction_id IS NOT NULL\) AND \(request_idempotency_key IS NOT NULL\) AND \(amount_minor IS NOT NULL\) AND \(currency IS NOT NULL\) AND \(paid_at IS NOT NULL\)\) OR \(\(order_number IS NULL\) AND \(provider_transaction_id IS NULL\) AND \(request_idempotency_key IS NULL\) AND \(amount_minor IS NULL\) AND \(currency IS NULL\) AND \(paid_at IS NULL\)\)\)\)\)\)$'),
      ('public', 'billing_webhook_events', 'billing_webhook_events_retry_state_check', 'c', '^CHECK \(\(\(retry_count >= 0\) AND \(retry_count <= 8\) AND \(\(\(status = ''RETRYABLE''::text\) AND \(retry_after IS NOT NULL\)\) OR \(\(status <> ''RETRYABLE''::text\) AND \(retry_after IS NULL\)\)\)\)\)$'),

      ('public', 'billing_refund_requests', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_refund_requests', null::text, 'f', '^FOREIGN KEY \(order_id\) REFERENCES billing_orders\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_refund_requests', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_refund_requests', null::text, 'f', '^FOREIGN KEY \(reviewed_by\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_refund_requests', 'billing_refund_requests_user_order_key', 'u', '^UNIQUE \(user_id, order_id\)$'),
      ('public', 'billing_refund_requests', null::text, 'c', '^CHECK \(\(requested_amount_minor > 0\)\)$'),
      ('public', 'billing_refund_requests', null::text, 'c', '^CHECK \(\(currency = ''CNY''::text\)\)$'),
      ('public', 'billing_refund_requests', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''PENDING''::text, ''APPROVED''::text, ''REJECTED''::text, ''CANCELLED''::text\]\)\)\)$'),

      ('public', 'billing_refunds', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_refunds', null::text, 'f', '^FOREIGN KEY \(refund_request_id\) REFERENCES billing_refund_requests\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_refunds', null::text, 'f', '^FOREIGN KEY \(order_id\) REFERENCES billing_orders\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_refunds', null::text, 'f', '^FOREIGN KEY \(payment_id\) REFERENCES billing_payments\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_refunds', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_refunds', null::text, 'u', '^UNIQUE \(refund_request_id\)$'),
      ('public', 'billing_refunds', null::text, 'u', '^UNIQUE \(idempotency_key\)$'),
      ('public', 'billing_refunds', null::text, 'u', '^UNIQUE \(provider, provider_refund_id\)$'),
      ('public', 'billing_refunds', null::text, 'c', '^CHECK \(\(provider = ANY \(ARRAY\[''MOCK''::text, ''WECHAT''::text, ''ALIPAY''::text\]\)\)\)$'),
      ('public', 'billing_refunds', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''PENDING''::text, ''SUCCEEDED''::text, ''FAILED''::text\]\)\)\)$'),
      ('public', 'billing_refunds', null::text, 'c', '^CHECK \(\(refunded_amount_minor > 0\)\)$'),
      ('public', 'billing_refunds', null::text, 'c', '^CHECK \(\(currency = ''CNY''::text\)\)$'),
      ('public', 'billing_refunds', 'billing_refunds_claim_state_check', 'c', '^CHECK \(\(\(\(NOT execution_managed\) AND \(claim_token IS NULL\) AND \(claim_expires_at IS NULL\) AND \(last_error_code IS NULL\)\) OR \(execution_managed AND \(\(\(status = ''PENDING''::text\) AND \(completed_at IS NULL\) AND \(\(\(claim_token IS NULL\) AND \(claim_expires_at IS NULL\)\) OR \(\(claim_token IS NOT NULL\) AND \(claim_expires_at IS NOT NULL\)\)\)\) OR \(\(status = ''FAILED''::text\) AND \(claim_token IS NULL\) AND \(claim_expires_at IS NULL\) AND \(completed_at IS NULL\) AND \(NULLIF\(btrim\(last_error_code\), ''''::text\) IS NOT NULL\)\) OR \(\(status = ''SUCCEEDED''::text\) AND \(claim_token IS NULL\) AND \(claim_expires_at IS NULL\) AND \(last_error_code IS NULL\) AND \(NULLIF\(btrim\(provider_refund_id\), ''''::text\) IS NOT NULL\) AND \(completed_at IS NOT NULL\)\)\)\)\)\)$'),

      ('public', 'billing_invoice_requests', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_invoice_requests', null::text, 'f', '^FOREIGN KEY \(order_id\) REFERENCES billing_orders\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_invoice_requests', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_invoice_requests', 'billing_invoice_requests_user_order_key', 'u', '^UNIQUE \(user_id, order_id\)$'),
      ('public', 'billing_invoice_requests', null::text, 'c', '^CHECK \(\(amount_minor >= 0\)\)$'),
      ('public', 'billing_invoice_requests', null::text, 'c', '^CHECK \(\(currency = ''CNY''::text\)\)$'),
      ('public', 'billing_invoice_requests', null::text, 'c', '^CHECK \(\(status = ANY \(ARRAY\[''PENDING''::text, ''ISSUED''::text, ''REJECTED''::text, ''CANCELLED''::text\]\)\)\)$'),

      ('public', 'billing_admins', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_admins', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_admins', null::text, 'u', '^UNIQUE \(user_id\)$'),
      ('public', 'billing_admins', null::text, 'c', '^CHECK \(\(role = ANY \(ARRAY\[''BILLING_ADMIN''::text, ''BILLING_REVIEWER''::text\]\)\)\)$'),

      ('public', 'billing_admin_audit_logs', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_admin_audit_logs', null::text, 'f', '^FOREIGN KEY \(actor_user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),
      ('public', 'billing_admin_audit_logs', null::text, 'f', '^FOREIGN KEY \(target_user_id\) REFERENCES auth.users\(id\) ON DELETE RESTRICT$'),

      ('public', 'billing_rate_limits', null::text, 'p', '^PRIMARY KEY \(id\)$'),
      ('public', 'billing_rate_limits', null::text, 'f', '^FOREIGN KEY \(user_id\) REFERENCES auth.users\(id\) ON DELETE CASCADE$'),
      ('public', 'billing_rate_limits', null::text, 'u', '^UNIQUE \(user_id, action, window_started_at\)$'),
      ('public', 'billing_rate_limits', null::text, 'c', '^CHECK \(\(request_count >= 0\)\)$'),

      ('public', 'billing_feature_usage_costs', null::text, 'p', '^PRIMARY KEY \(feature_key\)$'),
      ('public', 'billing_feature_usage_costs', null::text, 'c', '^CHECK \(\(quota_units >= 0\)\)$'),
      ('public', 'billing_feature_usage_costs', null::text, 'c', '^CHECK \(\(credit_amount >= 0\)\)$'),
      ('public', 'billing_feature_usage_costs', null::text, 'c', '^CHECK \(\(\(quota_units > 0\) OR \(credit_amount > 0\)\)\)$'),
      ('public', 'billing_feature_usage_costs', null::text, 'c', '^CHECK \(\(\(NOT allow_credit_fallback\) OR \(credit_amount > 0\)\)\)$')
  ),
  actual_constraints as (
    select
      constraint_meta.oid,
      namespace.nspname as schema_name,
      class.relname as table_name,
      constraint_meta.conname as constraint_name,
      constraint_meta.contype as constraint_type,
      constraint_meta.convalidated,
      pg_catalog.pg_get_constraintdef(constraint_meta.oid) as actual_definition
    from pg_catalog.pg_constraint as constraint_meta
    join pg_catalog.pg_class as class on class.oid = constraint_meta.conrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = constraint_meta.connamespace
    where constraint_meta.contype in ('c', 'f', 'p', 'u')
      and exists (
        select 1
        from expected_constraints as expected
        where expected.schema_name = namespace.nspname
          and expected.table_name = class.relname
      )
  ),
  constraint_matches as (
    select
      expected.schema_name,
      expected.table_name,
      expected.constraint_name as expected_constraint_name,
      expected.constraint_type,
      expected.expected_definition,
      actual.oid as actual_oid
    from expected_constraints as expected
    join actual_constraints as actual
      on actual.schema_name = expected.schema_name
     and actual.table_name = expected.table_name
     and actual.constraint_type = expected.constraint_type::"char"
     and (expected.constraint_name is null or actual.constraint_name = expected.constraint_name)
     and actual.convalidated is true
     and actual.actual_definition ~ expected.expected_definition
  ),
  expected_match_counts as (
    select
      expected.schema_name,
      expected.table_name,
      expected.constraint_name,
      expected.constraint_type,
      expected.expected_definition,
      count(matches.actual_oid) as matched_actual_count
    from expected_constraints as expected
    left join constraint_matches as matches
      on matches.schema_name = expected.schema_name
     and matches.table_name = expected.table_name
     and matches.expected_constraint_name is not distinct from expected.constraint_name
     and matches.constraint_type = expected.constraint_type
     and matches.expected_definition = expected.expected_definition
    group by
      expected.schema_name, expected.table_name, expected.constraint_name,
      expected.constraint_type, expected.expected_definition
  ),
  actual_match_counts as (
    select
      actual.oid,
      actual.schema_name,
      actual.table_name,
      actual.constraint_name,
      count(matches.expected_definition) as matched_expected_count
    from actual_constraints as actual
    left join constraint_matches as matches on matches.actual_oid = actual.oid
    group by actual.oid, actual.schema_name, actual.table_name, actual.constraint_name
  ),
  constraint_mismatches as (
    select format(
      '%I.%I.%s', expected.schema_name, expected.table_name,
      coalesce(expected.constraint_name, expected.expected_definition)
    ) as item
    from expected_match_counts as expected
    where expected.matched_actual_count <> 1
    union all
    select format('%I.%I.%I', actual.schema_name, actual.table_name, actual.constraint_name)
    from actual_match_counts as actual
    where actual.matched_expected_count <> 1
  )
  select array_agg(item order by item)
  into missing_items
  from constraint_mismatches;
  if missing_items is not null then
    raise exception 'missing billing constraints: %', missing_items;
  end if;

  with expected_constraint_counts(
    table_name, primary_count, foreign_count, unique_count, check_count
  ) as (
    values
      ('billing_plans', 1, 0, 1, 1),
      ('billing_products', 1, 1, 1, 6),
      ('billing_plan_entitlements', 1, 1, 1, 2),
      ('billing_orders', 1, 3, 1, 12),
      ('billing_payment_intents', 1, 2, 4, 7),
      ('billing_payments', 1, 2, 2, 4),
      ('billing_subscriptions', 1, 3, 1, 3),
      ('billing_user_entitlements', 1, 3, 1, 2),
      ('billing_usage_quotas', 1, 2, 2, 5),
      ('billing_credit_accounts', 1, 1, 1, 4),
      ('billing_usage_records', 1, 3, 1, 5),
      ('billing_usage_continuations', 1, 2, 1, 3),
      ('billing_credit_ledger', 1, 3, 1, 3),
      ('billing_webhook_events', 1, 2, 1, 6),
      ('billing_refund_requests', 1, 3, 1, 3),
      ('billing_refunds', 1, 4, 3, 5),
      ('billing_invoice_requests', 1, 2, 1, 3),
      ('billing_admins', 1, 1, 1, 1),
      ('billing_admin_audit_logs', 1, 2, 0, 0),
      ('billing_rate_limits', 1, 1, 1, 1),
      ('billing_feature_usage_costs', 1, 0, 0, 4)
  ),
  actual_constraint_counts as (
    select
      class.relname as table_name,
      count(constraint_meta.oid) filter (where constraint_meta.contype = 'p')::integer as primary_count,
      count(constraint_meta.oid) filter (where constraint_meta.contype = 'f')::integer as foreign_count,
      count(constraint_meta.oid) filter (where constraint_meta.contype = 'u')::integer as unique_count,
      count(constraint_meta.oid) filter (where constraint_meta.contype = 'c')::integer as check_count,
      bool_and(constraint_meta.convalidated) as all_validated
    from pg_catalog.pg_class as class
    left join pg_catalog.pg_constraint as constraint_meta on constraint_meta.conrelid = class.oid
    where class.relnamespace = 'public'::regnamespace
      and class.relname like 'billing\_%' escape '\'
      and class.relkind = 'r'
    group by class.relname
  )
  select array_agg(
    format('%I', expected.table_name)
    order by expected.table_name
  )
  into missing_items
  from expected_constraint_counts as expected
  left join actual_constraint_counts as actual using (table_name)
  where actual.primary_count is distinct from expected.primary_count
     or actual.foreign_count is distinct from expected.foreign_count
     or actual.unique_count is distinct from expected.unique_count
     or actual.check_count is distinct from expected.check_count
     or actual.all_validated is not true;
  if missing_items is not null then
    raise exception 'billing constraint inventory mismatch: %', missing_items;
  end if;
end;
$verify$;

do $verify$
declare
  expected_tables constant text[] := array[
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
    'billing_usage_continuations',
    'billing_credit_accounts',
    'billing_credit_ledger',
    'billing_webhook_events',
    'billing_refund_requests',
    'billing_refunds',
    'billing_invoice_requests',
    'billing_admins',
    'billing_admin_audit_logs',
    'billing_rate_limits',
    'billing_feature_usage_costs'
  ];
  unsafe_tables text[];
begin
  select array_agg(expected.table_name order by expected.table_name)
  into unsafe_tables
  from unnest(expected_tables) as expected(table_name)
  left join pg_catalog.pg_class as class
    on class.relnamespace = 'public'::regnamespace
   and class.relname = expected.table_name
   and class.relkind = 'r'
  where class.oid is null or class.relrowsecurity is not true;

  if unsafe_tables is not null then
    raise exception 'billing RLS disabled or table unavailable: %', unsafe_tables;
  end if;
end;
$verify$;

do $verify$
declare
  expected_trigger_functions constant text[] := array[
    'public.billing_set_updated_at()',
    'public.billing_protect_order_snapshot()',
    'public.billing_protect_credit_ledger()',
    'public.billing_validate_webhook_event_update()',
    'public.billing_guard_refund_execution_management()'
  ];
  missing_or_unsafe text[];
  updated_trigger_count integer;
  refund_quota_trigger_count integer;
  refund_management_trigger_count integer;
begin
  select array_agg(signature order by signature)
  into missing_or_unsafe
  from unnest(expected_trigger_functions) as signature
  left join pg_catalog.pg_proc as proc on proc.oid = to_regprocedure(signature)
  where proc.oid is null
     or proc.prosecdef is true
     or array_length(proc.proconfig, 1) is distinct from 1
     or replace(proc.proconfig[1], ' ', '') is distinct from 'search_path=pg_catalog,public';
  if missing_or_unsafe is not null then
    raise exception 'missing or unsafe billing trigger functions: %', missing_or_unsafe;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.billing_orders'::regclass
      and tgname = 'billing_orders_protect_snapshot'
      and tgfoid = 'public.billing_protect_order_snapshot()'::regprocedure
      and not tgisinternal
  ) then
    raise exception 'billing order snapshot trigger missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.billing_credit_ledger'::regclass
      and tgname = 'billing_credit_ledger_immutable'
      and tgfoid = 'public.billing_protect_credit_ledger()'::regprocedure
      and not tgisinternal
  ) then
    raise exception 'billing credit ledger immutability trigger missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.billing_webhook_events'::regclass
      and tgname = 'billing_webhook_events_validate_update'
      and tgfoid = 'public.billing_validate_webhook_event_update()'::regprocedure
      and not tgisinternal
  ) then
    raise exception 'billing webhook validation trigger missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.billing_admin_audit_logs'::regclass
      and tgname = 'billing_admin_audit_logs_immutable'
      and tgfoid = 'public.billing_reject_audit_log_mutation()'::regprocedure
      and not tgisinternal
  ) then
    raise exception 'billing administrator audit immutability trigger missing';
  end if;

  select count(*)
  into refund_quota_trigger_count
  from pg_catalog.pg_trigger
  where tgrelid = 'public.billing_usage_quotas'::regclass
    and tgname = 'billing_block_refunding_quota_usage'
    and not tgisinternal;
  if refund_quota_trigger_count is distinct from 1 then
    raise exception 'billing refund quota lock trigger inventory mismatch';
  end if;

  select count(*)
  into refund_management_trigger_count
  from pg_catalog.pg_trigger
  where tgrelid = 'public.billing_refunds'::regclass
    and tgname = 'billing_refunds_execution_management_immutable'
    and not tgisinternal;
  if refund_management_trigger_count is distinct from 1 then
    raise exception 'billing refund execution management trigger inventory mismatch';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.billing_refunds'::regclass
      and tgname = 'billing_refunds_execution_management_immutable'
      and tgfoid = 'public.billing_guard_refund_execution_management()'::regprocedure
      and tgtype = 23
      and tgenabled = 'O'
      and not tgisinternal
  ) then
    raise exception 'billing refund execution management trigger missing';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger
    where tgrelid = 'public.billing_usage_quotas'::regclass
      and tgname = 'billing_block_refunding_quota_usage'
      and tgfoid = 'public.billing_guard_refunding_quota_usage()'::regprocedure
      and tgtype = 19
      and tgenabled = 'O'
      and tgattr::TEXT = (
        select string_agg(attribute.attnum::TEXT, ' ' order by expected.ordinality)
        from unnest(array['reserved_units', 'used_units']) with ordinality
          as expected(column_name, ordinality)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = 'public.billing_usage_quotas'::regclass
         and attribute.attname = expected.column_name
         and not attribute.attisdropped
      )
      and not tgisinternal
  ) then
    raise exception 'billing refund quota lock trigger missing';
  end if;

  select count(*)
  into updated_trigger_count
  from pg_catalog.pg_trigger
  where tgfoid = 'public.billing_set_updated_at()'::regprocedure
    and tgname like 'billing\_%\_set\_updated\_at' escape '\'
    and not tgisinternal;
  if updated_trigger_count is distinct from 18 then
    raise exception 'billing updated timestamp trigger inventory mismatch';
  end if;
end;
$verify$;

do $verify$
declare
  expected_functions constant text[] := array[
    'public.billing_claim_payment_intent(uuid,uuid,text,text,text,uuid)',
    'public.billing_complete_payment_intent(uuid,uuid,text,text,text,text,timestamptz,timestamptz)',
    'public.billing_bind_verified_payment_query(uuid,uuid,text,text,text,text,bigint,text,timestamptz,timestamptz)',
    'public.billing_fail_payment_intent(uuid,uuid,text)',
    'public.billing_claim_mock_payment_confirmation(uuid,uuid,text,timestamptz)',
    'public.billing_mark_webhook_retryable(text,text,text)',
    'public.billing_prepare_webhook_settlement(text,text)',
    'public.billing_settle_paid_order(text,text,text,text,text,bigint,text,timestamptz,jsonb)',
    'public.billing_reserve_usage(uuid,text,text,bigint,bigint,text)',
    'public.billing_finalize_usage(uuid,text)',
    'public.billing_release_usage(uuid,text)',
    'public.billing_provision_usage_continuations(uuid,text,text,text,jsonb,boolean)',
    'public.billing_claim_usage_continuation(uuid,text,text,text,text,text,integer)',
    'public.billing_complete_usage_continuation(uuid,text,text,text,text,text,uuid)',
    'public.billing_release_usage_continuation(uuid,text,text,text,text,text,uuid)',
    'public.billing_adjust_credit(uuid,bigint,text,text,uuid,text)',
    'public.billing_adjust_credit_legacy(uuid,bigint,text,text,uuid,text)',
    'public.billing_consume_order_rate_limit(uuid,timestamptz,integer,bigint)',
    'public.billing_request_refund(uuid,uuid,text)',
    'public.billing_request_invoice(uuid,uuid,text,text,text)',
    'public.billing_require_write_admin(uuid)',
    'public.billing_assert_semester_plan(uuid)',
    'public.billing_admin_grant_subscription(uuid,uuid,uuid,integer,text,text)',
    'public.billing_admin_review_refund(uuid,uuid,text,text,text)',
    'public.billing_admin_review_invoice(uuid,uuid,text,text,text)',
    'public.billing_assert_refund_reversible(uuid)',
    'public.billing_guard_refunding_quota_usage()',
    'public.billing_claim_approved_refund(uuid,uuid,timestamptz)',
    'public.billing_complete_refund(uuid,uuid,text,text,bigint,text,jsonb)',
    'public.billing_fail_refund_claim(uuid,uuid,text)',
    'public.billing_admin_upsert_plan(uuid,uuid,text,text,text,text,boolean,text,text)',
    'public.billing_admin_upsert_product(uuid,uuid,uuid,text,text,text,text,bigint,text,integer,bigint,text,boolean,text,text)',
    'public.billing_reject_audit_log_mutation()'
  ];
  missing_functions text[];
  unsafe_functions text[];
  settlement_definition text;
  verified_query_definition text;
  settlement_lock_order_count bigint;
begin
  select array_agg(signature order by signature)
  into missing_functions
  from unnest(expected_functions) as signature
  where to_regprocedure(signature) is null;
  if missing_functions is not null then
    raise exception 'missing billing functions: %', missing_functions;
  end if;

  select array_agg(signature order by signature)
  into unsafe_functions
  from unnest(expected_functions) as signature
  join pg_catalog.pg_proc as proc on proc.oid = to_regprocedure(signature)
  where proc.prosecdef is not true
     or array_length(proc.proconfig, 1) is distinct from 1
     or replace(proc.proconfig[1], ' ', '') is distinct from 'search_path=pg_catalog,public';
  if unsafe_functions is not null then
    raise exception 'unsafe billing function attributes or search paths: %', unsafe_functions;
  end if;

  -- Verified query lock order contract: billing_orders must precede
  -- billing_payment_intents in every related mutation.
  settlement_definition := lower(pg_catalog.pg_get_functiondef(to_regprocedure(
    'public.billing_settle_paid_order(text,text,text,text,text,bigint,text,timestamptz,jsonb)'
  )));
  select count(*) into settlement_lock_order_count
  from regexp_matches(
    settlement_definition,
    'from\s+public\.billing_orders\s+where\s+id\s*=\s*v_intent_order_id\s+for\s+update;\s+select\s+\*\s+into\s+v_intent\s+from\s+public\.billing_payment_intents[^;]+for\s+update;',
    'g'
  );
  if settlement_lock_order_count is distinct from 2::bigint then
    raise exception 'settlement order-before-intent lock contract mismatch';
  end if;
  verified_query_definition := regexp_replace(
    lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'public.billing_bind_verified_payment_query(uuid,uuid,text,text,text,text,bigint,text,timestamptz,timestamptz)'
    ))),
    '\s+', ' ', 'g'
  );
  if position('from public.billing_orders' in verified_query_definition) = 0
    or position('from public.billing_payment_intents' in verified_query_definition) = 0
    or position('from public.billing_orders' in verified_query_definition)
      > position('from public.billing_payment_intents' in verified_query_definition) then
    raise exception 'verified query order-before-intent lock contract mismatch';
  end if;

  if position(
    'performpublic.billing_assert_semester_plan(p_plan_id)'
    in regexp_replace(
      lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'public.billing_admin_upsert_plan(uuid,uuid,text,text,text,text,boolean,text,text)'
      ))),
      '\s+',
      '',
      'g'
    )
  ) = 0 or position(
    'performpublic.billing_assert_semester_plan(p_plan_id)'
    in regexp_replace(
      lower(pg_catalog.pg_get_functiondef(to_regprocedure(
        'public.billing_admin_upsert_product(uuid,uuid,uuid,text,text,text,text,bigint,text,integer,bigint,text,boolean,text,text)'
      ))),
      '\s+',
      '',
      'g'
    )
  ) = 0 then
    raise exception 'fast-launch catalog guard is not bound to both administrator writers';
  end if;
end;
$verify$;

do $verify$
declare
  expected_writer_functions constant text[] := array[
    'public.billing_claim_payment_intent(uuid,uuid,text,text,text,uuid)',
    'public.billing_complete_payment_intent(uuid,uuid,text,text,text,text,timestamptz,timestamptz)',
    'public.billing_bind_verified_payment_query(uuid,uuid,text,text,text,text,bigint,text,timestamptz,timestamptz)',
    'public.billing_fail_payment_intent(uuid,uuid,text)',
    'public.billing_claim_mock_payment_confirmation(uuid,uuid,text,timestamptz)',
    'public.billing_mark_webhook_retryable(text,text,text)',
    'public.billing_prepare_webhook_settlement(text,text)',
    'public.billing_settle_paid_order(text,text,text,text,text,bigint,text,timestamptz,jsonb)',
    'public.billing_reserve_usage(uuid,text,text,bigint,bigint,text)',
    'public.billing_finalize_usage(uuid,text)',
    'public.billing_release_usage(uuid,text)',
    'public.billing_provision_usage_continuations(uuid,text,text,text,jsonb,boolean)',
    'public.billing_claim_usage_continuation(uuid,text,text,text,text,text,integer)',
    'public.billing_complete_usage_continuation(uuid,text,text,text,text,text,uuid)',
    'public.billing_release_usage_continuation(uuid,text,text,text,text,text,uuid)',
    'public.billing_adjust_credit(uuid,bigint,text,text,uuid,text)',
    'public.billing_consume_order_rate_limit(uuid,timestamptz,integer,bigint)',
    'public.billing_request_refund(uuid,uuid,text)',
    'public.billing_request_invoice(uuid,uuid,text,text,text)',
    'public.billing_require_write_admin(uuid)',
    'public.billing_admin_grant_subscription(uuid,uuid,uuid,integer,text,text)',
    'public.billing_admin_review_refund(uuid,uuid,text,text,text)',
    'public.billing_admin_review_invoice(uuid,uuid,text,text,text)',
    'public.billing_claim_approved_refund(uuid,uuid,timestamptz)',
    'public.billing_complete_refund(uuid,uuid,text,text,bigint,text,jsonb)',
    'public.billing_fail_refund_claim(uuid,uuid,text)',
    'public.billing_admin_upsert_plan(uuid,uuid,text,text,text,text,boolean,text,text)',
    'public.billing_admin_upsert_product(uuid,uuid,uuid,text,text,text,text,bigint,text,integer,bigint,text,boolean,text,text)'
  ];
  expected_internal_functions constant text[] := array[
    'public.billing_assert_semester_plan(uuid)',
    'public.billing_assert_refund_reversible(uuid)',
    'public.billing_guard_refunding_quota_usage()',
    'public.billing_guard_refund_execution_management()'
  ];
  unsafe_functions text[];
begin
  select array_agg(distinct signature order by signature)
  into unsafe_functions
  from unnest(expected_writer_functions) as signature
  join pg_catalog.pg_proc as proc on proc.oid = to_regprocedure(signature)
  cross join lateral pg_catalog.aclexplode(
    coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
  ) as function_acl
  left join pg_catalog.pg_roles as role on role.oid = function_acl.grantee
  where function_acl.privilege_type = 'EXECUTE'
    and (function_acl.grantee = 0 or role.rolname in ('anon', 'authenticated'));
  if unsafe_functions is not null then
    raise exception 'billing writer RPC has a client execute grant: %', unsafe_functions;
  end if;

  select array_agg(distinct signature order by signature)
  into unsafe_functions
  from unnest(expected_internal_functions) as signature
  join pg_catalog.pg_proc as proc on proc.oid = to_regprocedure(signature)
  cross join lateral pg_catalog.aclexplode(
    coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
  ) as function_acl
  left join pg_catalog.pg_roles as role on role.oid = function_acl.grantee
  where function_acl.privilege_type = 'EXECUTE'
    and (
      function_acl.grantee = 0
      or role.rolname in ('anon', 'authenticated', 'service_role')
    );
  if unsafe_functions is not null then
    raise exception 'billing internal guard has a direct execute grant: %', unsafe_functions;
  end if;

  select array_agg(signature order by signature)
  into unsafe_functions
  from unnest(expected_writer_functions) as signature
  where not pg_catalog.has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE');
  if unsafe_functions is not null then
    raise exception 'billing writer RPC lacks its service execute grant: %', unsafe_functions;
  end if;
end;
$verify$;

do $verify$
declare
  legacy_function oid := to_regprocedure(
    'public.billing_adjust_credit_legacy(uuid,bigint,text,text,uuid,text)'
  );
  unsafe_grant boolean;
begin
  if legacy_function is null then
    raise exception 'legacy billing credit function missing';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_proc as proc
    cross join lateral pg_catalog.aclexplode(
      coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
    ) as privilege
    where proc.oid = legacy_function
      and privilege.privilege_type = 'EXECUTE'
      and privilege.grantee is distinct from proc.proowner
  )
  into unsafe_grant;
  if unsafe_grant then
    raise exception 'legacy billing credit RPC remains executable';
  end if;
end;
$verify$;

do $verify$
declare
  actual_plans jsonb;
  actual_products jsonb;
  semester_plan_id uuid;
  guard_rejected boolean := false;
begin
  select jsonb_agg(
    jsonb_build_array(code, name, billing_period, is_active)
    order by code
  )
  into actual_plans
  from public.billing_plans;

  if actual_plans is distinct from '[
    ["FREE", "Free", "FREE", false],
    ["PRO", "Pro", "MONTHLY", false],
    ["PRO_SEMESTER", "Pro Semester", "SEMESTER", false]
  ]'::jsonb then
    raise exception 'billing plan catalog differs from the approved catalog';
  end if;

  select jsonb_agg(
    jsonb_build_array(
      sku, name, product_type, price_minor, currency, duration_days,
      credit_grant, entitlement_version, is_active
    )
    order by sku
  )
  into actual_products
  from public.billing_products;

  if actual_products is distinct from '[
    ["CREDIT_PACK_100", "Credit Pack 100", "CREDIT_PACK", 990, "CNY", null, 100, "credit-v1", false],
    ["PRO_MONTHLY", "Pro Monthly", "SUBSCRIPTION", 1990, "CNY", 30, 0, "pro-v1", false],
    ["PRO_SEMESTER", "Pro Semester", "SUBSCRIPTION", 7900, "CNY", 150, 0, "pro-semester-v1", false]
  ]'::jsonb then
    raise exception 'billing product catalog differs from the approved catalog';
  end if;

  if exists (
    select 1
    from public.billing_products as product
    join public.billing_plans as plan on plan.id = product.plan_id
    where plan.code = 'FREE'
  ) then
    raise exception 'Free must not have a billing product';
  end if;

  if exists (select 1 from public.billing_plans where is_active = true)
    or exists (select 1 from public.billing_products where is_active = true) then
    raise exception 'active billing plan or product found';
  end if;

  select id
  into semester_plan_id
  from public.billing_plans
  where code = 'PRO_SEMESTER';
  perform public.billing_assert_semester_plan(semester_plan_id);

  begin
    update public.billing_plan_entitlements
    set periodic_limit = periodic_limit + 1
    where id = (
      select id
      from public.billing_plan_entitlements
      where plan_id = semester_plan_id
        and entitlement_version = 'pro-semester-v1'
      order by feature_key
      limit 1
    );
    perform public.billing_assert_semester_plan(semester_plan_id);
  exception
    when sqlstate '23514' then
      guard_rejected := true;
  end;
  if guard_rejected is not true then
    raise exception 'fast-launch entitlement drift was accepted';
  end if;
end;
$verify$;

set local role authenticated;

do $verify$
declare
  access_denied boolean := false;
begin
  begin
    perform public.billing_reserve_usage(
      '00000000-0000-4000-8000-00000000b001',
      'verify-unauthorized-009',
      'summarize',
      1,
      0,
      'CREDITS'
    );
  exception
    when sqlstate '42501' then
      access_denied := true;
  end;

  if access_denied is not true then
    raise exception 'authenticated role unexpectedly executed a billing writer RPC';
  end if;
end;
$verify$;

reset role;

do $verify$
declare
  result jsonb;
  replay jsonb;
  expected_failure boolean;
  quota_before public.billing_usage_quotas%rowtype;
  quota_after public.billing_usage_quotas%rowtype;
  account_before public.billing_credit_accounts%rowtype;
  account_after public.billing_credit_accounts%rowtype;
  usage_after public.billing_usage_records%rowtype;
  payment_count_before bigint;
  ledger_count_before bigint;
  subscription_count_before bigint;
  refund_count_before bigint;
  audit_count_before bigint;
  refund_rollback_observed boolean := false;
  retry_lease_mutation_rejected boolean := false;
  refund_execution_id uuid;
begin
  if exists (
    select 1
    from public.billing_refunds
    where id in (
      '00000000-0000-4000-8000-00000000b065',
      '00000000-0000-4000-8000-00000000b066'
    )
      and (
        execution_managed is distinct from false
        or provider_refund_id is not null
        or completed_at is not null
        or last_error_code is not null
      )
  ) or (
    select count(*)
    from public.billing_refunds
    where id in (
      '00000000-0000-4000-8000-00000000b065',
      '00000000-0000-4000-8000-00000000b066'
    )
      and status in ('FAILED', 'SUCCEEDED')
  ) is distinct from 2::bigint then
    raise exception 'legacy refund rows were rewritten';
  end if;

  expected_failure := false;
  begin
    perform public.billing_claim_approved_refund(
      '00000000-0000-4000-8000-00000000b063',
      '00000000-0000-4000-8000-00000000b083',
      clock_timestamp()
    );
  exception
    when sqlstate '55000' then
      expected_failure := true;
  end;
  if expected_failure is not true then
    raise exception 'legacy refund was execution claimed';
  end if;

  begin
    result := public.billing_admin_review_refund(
      '00000000-0000-4000-8000-00000000b002',
      '00000000-0000-4000-8000-00000000b060',
      'APPROVED',
      'Synthetic automatic refund verification',
      'verify-refund-review-012'
    );
    if result ->> 'status' is distinct from 'APPLIED' then
      raise exception 'refund approval was not persisted';
    end if;

    result := public.billing_claim_approved_refund(
      '00000000-0000-4000-8000-00000000b060',
      '00000000-0000-4000-8000-00000000b080',
      clock_timestamp()
    );
    if result ->> 'status' is distinct from 'CLAIMED' then
      raise exception 'approved subscription refund was not claimed';
    end if;

    expected_failure := false;
    begin
      perform public.billing_fail_refund_claim(
        (result ->> 'refund_id')::uuid,
        '00000000-0000-4000-8000-00000000b080',
        'REFUND_PROVIDER_REJECTED'
      );
      perform public.billing_claim_approved_refund(
        '00000000-0000-4000-8000-00000000b060',
        '00000000-0000-4000-8000-00000000b081',
        clock_timestamp()
      );
    exception
      when sqlstate 'P2101' then
        expected_failure := true;
    end;
    if expected_failure is not true then
      raise exception 'permanent refund failure was automatically retried';
    end if;

    replay := public.billing_fail_refund_claim(
      (result ->> 'refund_id')::uuid,
      '00000000-0000-4000-8000-00000000b080',
      'VERIFY_DETERMINISTIC_FAILURE'
    );
    if replay ->> 'status' is distinct from 'RELEASED' then
      raise exception 'deterministic refund claim was not released';
    end if;

    expected_failure := false;
    begin
      perform public.billing_complete_refund(
        (result ->> 'refund_id')::uuid,
        '00000000-0000-4000-8000-00000000b080',
        'VERIFY-REFUND-FAILED-CLAIM',
        'DRILL-MOCK-SUBSCRIPTION-009',
        1990,
        'CNY',
        '{}'::jsonb
      );
    exception
      when sqlstate '55000' then
        expected_failure := true;
    end;
    if expected_failure is not true then
      raise exception 'released refund claim remained completable';
    end if;

    result := public.billing_claim_approved_refund(
      '00000000-0000-4000-8000-00000000b060',
      '00000000-0000-4000-8000-00000000b081',
      clock_timestamp()
    );
    if result ->> 'status' is distinct from 'CLAIMED' then
      raise exception 'released refund claim was not reclaimable';
    end if;
    refund_execution_id := (result ->> 'refund_id')::uuid;

    expected_failure := false;
    begin
      perform public.billing_complete_refund(
        refund_execution_id,
        '00000000-0000-4000-8000-00000000b081',
        'VERIFY-REFUND-012',
        'DRILL-MOCK-SUBSCRIPTION-009',
        1991,
        'CNY',
        '{}'::jsonb
      );
    exception
      when sqlstate '22000' then
        expected_failure := true;
    end;
    if expected_failure is not true then
      raise exception 'mismatched refund amount was accepted';
    end if;

    expected_failure := false;
    begin
      perform public.billing_complete_refund(
        refund_execution_id,
        '00000000-0000-4000-8000-00000000b081',
        'VERIFY-REFUND-012',
        'DRILL-MOCK-SUBSCRIPTION-009',
        1990,
        'USD',
        '{}'::jsonb
      );
    exception
      when sqlstate '22023' then
        expected_failure := true;
    end;
    if expected_failure is not true then
      raise exception 'mismatched refund currency was accepted';
    end if;

    result := public.billing_complete_refund(
      refund_execution_id,
      '00000000-0000-4000-8000-00000000b081',
      'VERIFY-REFUND-012',
      'DRILL-MOCK-SUBSCRIPTION-009',
      1990,
      'CNY',
      '{"fixture":"billing-drill"}'::jsonb
    );
    replay := public.billing_complete_refund(
      refund_execution_id,
      '00000000-0000-4000-8000-00000000b081',
      'VERIFY-REFUND-012',
      'DRILL-MOCK-SUBSCRIPTION-009',
      1990,
      'CNY',
      '{"fixture":"billing-drill"}'::jsonb
    );
    if result ->> 'status' is distinct from 'SUCCEEDED'
       or replay ->> 'status' is distinct from 'SUCCEEDED'
       or not exists (
         select 1 from public.billing_subscriptions
         where id = '00000000-0000-4000-8000-00000000b040'
           and source_order_id = '00000000-0000-4000-8000-00000000b021'
           and status = 'CANCELLED'
       )
       or not exists (
         select 1 from public.billing_usage_quotas
         where id = '00000000-0000-4000-8000-00000000b042'
           and subscription_id = '00000000-0000-4000-8000-00000000b040'
           and quota_limit = 0
       ) then
      raise exception 'refund completion or replay state mismatch';
    end if;

    insert into public.billing_refund_requests (
      id, order_id, user_id, requested_amount_minor, currency, reason, status,
      reviewed_by, review_note, reviewed_at
    ) values (
      '00000000-0000-4000-8000-00000000b062',
      '00000000-0000-4000-8000-00000000b022',
      '00000000-0000-4000-8000-00000000b001',
      990,
      'CNY',
      'Synthetic credit pack manual refund verification',
      'APPROVED',
      '00000000-0000-4000-8000-00000000b002',
      'Manual only',
      clock_timestamp()
    );
    update public.billing_orders
    set status = 'REFUNDING', refund_status = 'REQUESTED'
    where id = '00000000-0000-4000-8000-00000000b022';
    result := public.billing_claim_approved_refund(
      '00000000-0000-4000-8000-00000000b062',
      '00000000-0000-4000-8000-00000000b082',
      clock_timestamp()
    );
    if result ->> 'status' is distinct from 'MANUAL_REVIEW_REQUIRED'
       or exists (
         select 1 from public.billing_refunds
         where refund_request_id = '00000000-0000-4000-8000-00000000b062'
       ) then
      raise exception 'credit pack automatic refund was not rejected';
    end if;

    raise exception 'refund execution rollback sentinel' using errcode = 'P1200';
  exception
    when sqlstate 'P1200' then
      refund_rollback_observed := true;
  end;
  if refund_rollback_observed is not true
     or not exists (
       select 1 from public.billing_orders
       where id = '00000000-0000-4000-8000-00000000b021'
         and status = 'PAID'
         and refund_status = 'NONE'
     )
     or exists (
       select 1 from public.billing_refunds
       where refund_request_id = '00000000-0000-4000-8000-00000000b060'
     ) then
    raise exception 'refund execution rollback failed';
  end if;

  select * into strict quota_before
  from public.billing_usage_quotas
  where id = '00000000-0000-4000-8000-00000000b042';
  select * into strict account_before
  from public.billing_credit_accounts
  where id = '00000000-0000-4000-8000-00000000b050';

  result := public.billing_reserve_usage(
    '00000000-0000-4000-8000-00000000b001',
    'verify-finalize-009',
    'summarize',
    1,
    5,
    'CREDITS'
  );
  if result ->> 'status' is distinct from 'RESERVED' then
    raise exception 'usage reservation did not enter RESERVED state';
  end if;

  select * into strict quota_after
  from public.billing_usage_quotas
  where id = quota_before.id;
  select * into strict account_after
  from public.billing_credit_accounts
  where id = account_before.id;
  select * into strict usage_after
  from public.billing_usage_records
  where task_idempotency_key = 'verify-finalize-009';
  if quota_after.reserved_units is distinct from quota_before.reserved_units + 1
    or quota_after.used_units is distinct from quota_before.used_units
    or account_after.available_balance is distinct from account_before.available_balance - 5
    or account_after.reserved_balance is distinct from account_before.reserved_balance + 5
    or usage_after.status is distinct from 'RESERVED'
    or usage_after.quota_id is distinct from quota_before.id
    or usage_after.credit_account_id is distinct from account_before.id
    or usage_after.quota_units is distinct from 1
    or usage_after.credit_amount is distinct from 5
    or not exists (
      select 1 from public.billing_credit_ledger
      where idempotency_key = 'usage:verify-finalize-009:reserve'
        and entry_type = 'RESERVE'
        and delta_available = -5
        and delta_reserved = 5
    ) then
    raise exception 'usage reservation persisted state mismatch';
  end if;

  result := public.billing_finalize_usage(
    '00000000-0000-4000-8000-00000000b001',
    'verify-finalize-009'
  );
  replay := public.billing_finalize_usage(
    '00000000-0000-4000-8000-00000000b001',
    'verify-finalize-009'
  );
  if result ->> 'status' is distinct from 'FINALIZED'
    or result ->> 'idempotent' is distinct from 'false'
    or replay ->> 'status' is distinct from 'FINALIZED'
    or replay ->> 'idempotent' is distinct from 'true' then
    raise exception 'usage finalization or replay contract failed';
  end if;

  select * into strict quota_after
  from public.billing_usage_quotas
  where id = quota_before.id;
  select * into strict account_after
  from public.billing_credit_accounts
  where id = account_before.id;
  select * into strict usage_after
  from public.billing_usage_records
  where task_idempotency_key = 'verify-finalize-009'
    and status = 'FINALIZED';
  if quota_after.reserved_units is distinct from quota_before.reserved_units
    or quota_after.used_units is distinct from quota_before.used_units + 1
    or account_after.available_balance is distinct from account_before.available_balance - 5
    or account_after.reserved_balance is distinct from account_before.reserved_balance
    or usage_after.finalized_at is null
    or (
      select count(*) from public.billing_credit_ledger
      where idempotency_key in (
        'usage:verify-finalize-009:reserve',
        'usage:verify-finalize-009:finalize'
      )
        and entry_type in ('RESERVE', 'CONSUME')
    ) is distinct from 2::bigint then
    raise exception 'usage finalization persisted state mismatch';
  end if;

  select * into strict quota_before
  from public.billing_usage_quotas
  where id = '00000000-0000-4000-8000-00000000b042';
  select * into strict account_before
  from public.billing_credit_accounts
  where id = '00000000-0000-4000-8000-00000000b050';

  result := public.billing_reserve_usage(
    '00000000-0000-4000-8000-00000000b001',
    'verify-release-009',
    'summarize',
    1,
    5,
    'CREDITS'
  );
  if result ->> 'status' is distinct from 'RESERVED' then
    raise exception 'releasable usage did not enter RESERVED state';
  end if;

  result := public.billing_release_usage(
    '00000000-0000-4000-8000-00000000b001',
    'verify-release-009'
  );
  replay := public.billing_release_usage(
    '00000000-0000-4000-8000-00000000b001',
    'verify-release-009'
  );
  if result ->> 'status' is distinct from 'RELEASED'
    or result ->> 'idempotent' is distinct from 'false'
    or replay ->> 'status' is distinct from 'RELEASED'
    or replay ->> 'idempotent' is distinct from 'true' then
    raise exception 'usage release or replay contract failed';
  end if;

  select * into strict quota_after
  from public.billing_usage_quotas
  where id = quota_before.id;
  select * into strict account_after
  from public.billing_credit_accounts
  where id = account_before.id;
  select * into strict usage_after
  from public.billing_usage_records
  where task_idempotency_key = 'verify-release-009'
    and status = 'RELEASED';
  if quota_after.reserved_units is distinct from quota_before.reserved_units
    or quota_after.used_units is distinct from quota_before.used_units
    or account_after.available_balance is distinct from account_before.available_balance
    or account_after.reserved_balance is distinct from account_before.reserved_balance
    or usage_after.released_at is null
    or (
      select count(*) from public.billing_credit_ledger
      where idempotency_key in (
        'usage:verify-release-009:reserve',
        'usage:verify-release-009:release'
      )
        and entry_type in ('RESERVE', 'RELEASE')
    ) is distinct from 2::bigint then
    raise exception 'usage release persisted state mismatch';
  end if;

  select * into strict account_before
  from public.billing_credit_accounts
  where id = '00000000-0000-4000-8000-00000000b050';

  expected_failure := false;
  begin
    perform public.billing_reserve_usage(
      '00000000-0000-4000-8000-00000000b001',
      'verify-insufficient-balance-009',
      'summarize',
      0,
      100000,
      'CREDITS'
    );
  exception
    when sqlstate '53000' then
      expected_failure := true;
  end;
  if expected_failure is not true then
    raise exception 'insufficient credit balance was accepted';
  end if;

  if exists (
    select 1 from public.billing_usage_records
    where task_idempotency_key = 'verify-insufficient-balance-009'
  ) or exists (
    select 1 from public.billing_credit_ledger
    where idempotency_key like 'usage:verify-insufficient-balance-009:%'
  ) or not exists (
    select 1 from public.billing_credit_accounts
    where id = account_before.id
      and available_balance = account_before.available_balance
      and reserved_balance = account_before.reserved_balance
      and version = account_before.version
  ) then
    raise exception 'insufficient balance attempt changed persisted state';
  end if;

  select count(*) into payment_count_before
  from public.billing_payments
  where order_id = '00000000-0000-4000-8000-00000000b022';
  select count(*) into ledger_count_before
  from public.billing_credit_ledger
  where reference_type = 'ORDER'
    and reference_id = '00000000-0000-4000-8000-00000000b022';
  select count(*) into subscription_count_before
  from public.billing_subscriptions
  where user_id = '00000000-0000-4000-8000-00000000b001';
  select * into strict account_before
  from public.billing_credit_accounts
  where id = '00000000-0000-4000-8000-00000000b050';

  insert into public.billing_webhook_events (
    provider, provider_event_id, order_number, provider_transaction_id,
    request_idempotency_key, amount_minor, currency, paid_at,
    signature_valid, status, payload_summary
  ) values (
    'MOCK', 'DRILL-RETRY-EVENT-013', 'DRILL-RETRY-013', 'DRILL-RETRY-TXN-013',
    'drill-retry-request-013', 1, 'CNY', clock_timestamp(),
    true, 'RECEIVED', '{"fixture":"billing-drill-retry"}'::jsonb
  );
  result := public.billing_mark_webhook_retryable(
    'MOCK', 'DRILL-RETRY-EVENT-013', 'BILLING_DATABASE_TIMEOUT'
  );
  if result ->> 'status' is distinct from 'RETRYABLE' then
    raise exception 'webhook retry transition did not reach RETRYABLE';
  end if;
  begin
    update public.billing_webhook_events
    set retry_after = clock_timestamp() - interval '1 second'
    where provider = 'MOCK' and provider_event_id = 'DRILL-RETRY-EVENT-013';
  exception when sqlstate '23000' then
    retry_lease_mutation_rejected := true;
  end;
  if retry_lease_mutation_rejected is not true then
    raise exception 'direct past webhook retry lease mutation was accepted';
  end if;
  retry_lease_mutation_rejected := false;
  begin
    update public.billing_webhook_events
    set retry_after = clock_timestamp() + interval '1 hour'
    where provider = 'MOCK' and provider_event_id = 'DRILL-RETRY-EVENT-013';
  exception when sqlstate '23000' then
    retry_lease_mutation_rejected := true;
  end;
  if retry_lease_mutation_rejected is not true then
    raise exception 'direct future webhook retry lease mutation was accepted';
  end if;
  perform pg_catalog.pg_sleep(1.1);
  result := public.billing_prepare_webhook_settlement('MOCK', 'DRILL-RETRY-EVENT-013');
  if result ->> 'status' is distinct from 'RECEIVED' then
    raise exception 'webhook retry transition did not return to RECEIVED';
  end if;
  update public.billing_webhook_events set status = 'PROCESSING'
  where provider = 'MOCK' and provider_event_id = 'DRILL-RETRY-EVENT-013';
  update public.billing_webhook_events set status = 'PROCESSED', processed_at = clock_timestamp()
  where provider = 'MOCK' and provider_event_id = 'DRILL-RETRY-EVENT-013';
  if not exists (
    select 1 from public.billing_webhook_events
    where provider = 'MOCK' and provider_event_id = 'DRILL-RETRY-EVENT-013'
      and status = 'PROCESSED' and retry_count = 1 and retry_after is null
  ) then
    raise exception 'webhook retry trigger lifecycle verification failed';
  end if;

  result := public.billing_settle_paid_order(
    'DRILL-CREDIT-009',
    'MOCK',
    'DRILL-MOCK-CREDIT-009',
    'DRILL-MOCK-EVENT-009',
    'drill-credit-payment-009',
    990,
    'CNY',
    timestamptz '2026-01-03 00:00:00+00',
    '{"fixture":"billing-drill"}'::jsonb
  );
  if result ->> 'status' is distinct from 'ALREADY_PROCESSED' then
    raise exception 'duplicate settlement was not idempotent';
  end if;

  if (
    select count(*) from public.billing_payments
    where order_id = '00000000-0000-4000-8000-00000000b022'
  ) is distinct from payment_count_before
    or (
      select count(*) from public.billing_credit_ledger
      where reference_type = 'ORDER'
        and reference_id = '00000000-0000-4000-8000-00000000b022'
    ) is distinct from ledger_count_before
    or (
      select count(*) from public.billing_subscriptions
      where user_id = '00000000-0000-4000-8000-00000000b001'
    ) is distinct from subscription_count_before
    or not exists (
      select 1 from public.billing_credit_accounts
      where id = account_before.id
        and available_balance = account_before.available_balance
        and reserved_balance = account_before.reserved_balance
        and version = account_before.version
    ) then
    raise exception 'duplicate settlement changed persisted state';
  end if;

  expected_failure := false;
  begin
    perform public.billing_settle_paid_order(
      'DRILL-CREDIT-009',
      'MOCK',
      'DRILL-MOCK-CREDIT-009',
      'DRILL-MOCK-EVENT-009',
      'drill-credit-payment-009',
      991,
      'CNY',
      timestamptz '2026-01-03 00:00:00+00',
      '{}'::jsonb
    );
  exception
    when sqlstate '22000' then
      expected_failure := true;
  end;
  if expected_failure is not true then
    raise exception 'mismatched settlement amount was accepted';
  end if;

  expected_failure := false;
  begin
    perform public.billing_settle_paid_order(
      'DRILL-CREDIT-009',
      'MOCK',
      'DRILL-MOCK-CREDIT-009',
      'DRILL-MOCK-EVENT-009',
      'drill-credit-payment-009',
      990,
      'USD',
      timestamptz '2026-01-03 00:00:00+00',
      '{}'::jsonb
    );
  exception
    when sqlstate '22000' then
      expected_failure := true;
  end;
  if expected_failure is not true then
    raise exception 'mismatched settlement currency was accepted';
  end if;

  insert into public.billing_orders (
    id, order_number, user_id, product_id, provider, status, amount_minor,
    currency, snapshot_product_name, snapshot_product_type, snapshot_plan_id,
    snapshot_duration_days, snapshot_credit_grant,
    snapshot_entitlement_version, snapshot_entitlements, snapshot_details,
    accepted_agreement_version, expires_at, paid_at, refund_status,
    created_at, updated_at
  )
  select
    '00000000-0000-4000-8000-00000000b090',
    'DRILL-WECHAT-BILLING-014', user_id, product_id, 'WECHAT', 'PENDING',
    amount_minor, currency, snapshot_product_name, snapshot_product_type,
    snapshot_plan_id, snapshot_duration_days, snapshot_credit_grant,
    snapshot_entitlement_version, snapshot_entitlements, snapshot_details,
    accepted_agreement_version, expires_at, null, 'NONE', created_at, updated_at
  from public.billing_orders
  where id = '00000000-0000-4000-8000-00000000b022';

  insert into public.billing_payment_intents (
    id, order_id, user_id, provider, merchant_order_number,
    request_idempotency_key, status, claim_token, claim_expires_at,
    provider_transaction_id, payment_token, payment_status, amount_minor,
    currency, expires_at, paid_at, last_error_code, attempt_count
  ) values (
    '00000000-0000-4000-8000-00000000b091',
    '00000000-0000-4000-8000-00000000b090',
    '00000000-0000-4000-8000-00000000b001',
    'WECHAT', 'DRILL-WECHAT-MERCHANT-014', 'drill-wechat-payment-014',
    'CREATED', null, null, null, 'weixin://verified-drill-014', 'PENDING',
    990, 'CNY', timestamptz '2099-01-01 00:00:00+00', null, null, 1
  );
  if exists (
    select 1 from public.billing_payment_intents
    where merchant_order_number = 'DRILL-WECHAT-MERCHANT-014'
      and provider_transaction_id is not null
  ) then
    raise exception 'unverified create transaction identity was persisted';
  end if;

  result := public.billing_bind_verified_payment_query(
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b090',
    'WECHAT', 'DRILL-WECHAT-MERCHANT-014', 'DRILL-WECHAT-TXN-014',
    'PAID', 990, 'CNY', timestamptz '2099-01-01 00:00:00+00',
    timestamptz '2026-01-06 00:00:00+00'
  );
  if result ->> 'payment_status' is distinct from 'PAID'
    or result ->> 'provider_transaction_id' is distinct from 'DRILL-WECHAT-TXN-014'
    or exists (
      select 1 from public.billing_payment_intents
      where merchant_order_number = 'DRILL-WECHAT-MERCHANT-014'
        and (
          provider_transaction_id is distinct from 'DRILL-WECHAT-TXN-014'
          or payment_status is distinct from 'PAID'
          or payment_token is not null
        )
    )
    or not exists (
      select 1 from public.billing_orders
      where id = '00000000-0000-4000-8000-00000000b090'
        and status = 'PAID'
        and paid_at = timestamptz '2026-01-06 00:00:00+00'
    )
    or (
      select count(*) from public.billing_payments
      where order_id = '00000000-0000-4000-8000-00000000b090'
        and provider = 'WECHAT'
        and provider_transaction_id = 'DRILL-WECHAT-TXN-014'
        and status = 'PAID'
    ) is distinct from 1::bigint
    or not exists (
      select 1 from public.billing_webhook_events
      where provider = 'WECHAT'
        and provider_event_id = 'QUERY:DRILL-WECHAT-TXN-014'
        and status = 'PROCESSED'
        and signature_valid is true
    )
    or (
      select count(*) from public.billing_credit_ledger
      where idempotency_key =
        'settlement:WECHAT:QUERY:DRILL-WECHAT-TXN-014:credit'
    ) is distinct from 1::bigint then
    raise exception 'verified query transaction was not atomically settled';
  end if;

  replay := public.billing_bind_verified_payment_query(
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b090',
    'WECHAT', 'DRILL-WECHAT-MERCHANT-014', 'DRILL-WECHAT-TXN-014',
    'PAID', 990, 'CNY', timestamptz '2099-01-01 00:00:00+00',
    timestamptz '2026-01-06 00:00:00+00'
  );
  if replay ->> 'payment_status' is distinct from 'PAID'
    or (
      select count(*) from public.billing_payments
      where order_id = '00000000-0000-4000-8000-00000000b090'
    ) is distinct from 1::bigint
    or (
      select count(*) from public.billing_credit_ledger
      where idempotency_key =
        'settlement:WECHAT:QUERY:DRILL-WECHAT-TXN-014:credit'
    ) is distinct from 1::bigint then
    raise exception 'verified query settlement was not exactly once';
  end if;

  select count(*) into refund_count_before
  from public.billing_refund_requests
  where user_id = '00000000-0000-4000-8000-00000000b001'
    and order_id = '00000000-0000-4000-8000-00000000b022';
  if refund_count_before is distinct from 0::bigint then
    raise exception 'refund verification requires an unused paid order';
  end if;

  result := public.billing_request_refund(
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b022',
    'Synthetic billing recovery drill refund request'
  );
  replay := public.billing_request_refund(
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b022',
    'Synthetic billing recovery drill refund request'
  );
  if replay ->> 'id' is distinct from result ->> 'id'
    or (
      select count(*) from public.billing_refund_requests
      where user_id = '00000000-0000-4000-8000-00000000b001'
        and order_id = '00000000-0000-4000-8000-00000000b022'
        and id = (result ->> 'id')::uuid
        and status = 'PENDING'
        and requested_amount_minor = 990
        and currency = 'CNY'
    ) is distinct from refund_count_before + 1 then
    raise exception 'refund request replay was not idempotent';
  end if;

  select count(*) into audit_count_before
  from public.billing_admin_audit_logs
  where action = 'REVIEW_INVOICE'
    and after_value ->> 'idempotency_key' = 'verify-admin-review-009';
  if audit_count_before is distinct from 0::bigint then
    raise exception 'administrator verification idempotency key already exists';
  end if;

  result := public.billing_admin_review_invoice(
    '00000000-0000-4000-8000-00000000b002',
    '00000000-0000-4000-8000-00000000b061',
    'ISSUED',
    'Synthetic billing recovery drill review',
    'verify-admin-review-009'
  );
  replay := public.billing_admin_review_invoice(
    '00000000-0000-4000-8000-00000000b002',
    '00000000-0000-4000-8000-00000000b061',
    'ISSUED',
    'Synthetic billing recovery drill review',
    'verify-admin-review-009'
  );
  if result ->> 'status' is distinct from 'APPLIED'
    or replay ->> 'status' is distinct from 'ALREADY_APPLIED'
    or replay ->> 'audit_id' is distinct from result ->> 'audit_id' then
    raise exception 'administrator replay was not idempotent';
  end if;

  if not exists (
    select 1 from public.billing_invoice_requests
    where id = '00000000-0000-4000-8000-00000000b061'
      and status = 'ISSUED'
      and issued_at is not null
  ) or (
    select count(*) from public.billing_admin_audit_logs
    where action = 'REVIEW_INVOICE'
      and after_value ->> 'idempotency_key' = 'verify-admin-review-009'
  ) <> 1 or not exists (
    select 1 from public.billing_admin_audit_logs
    where action = 'REVIEW_INVOICE'
      and after_value ->> 'idempotency_key' = 'verify-admin-review-009'
      and id = (result ->> 'audit_id')::uuid
  ) then
    raise exception 'administrator review persisted state mismatch';
  end if;
end;
$verify$;

rollback;
