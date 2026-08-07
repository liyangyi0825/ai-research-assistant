\set ON_ERROR_STOP on

begin;

do $$
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
  expected_indexes constant text[] := array[
    'billing_orders_user_created_idx',
    'billing_payments_order_idx',
    'billing_subscriptions_user_status_idx',
    'billing_user_entitlements_active_idx',
    'billing_usage_records_user_created_idx',
    'billing_credit_ledger_account_created_idx',
    'billing_webhook_events_order_idx',
    'billing_refund_requests_user_created_idx'
  ];
  missing_items text[];
begin
  select array_agg(item order by item)
  into missing_items
  from unnest(expected_tables) as item
  where to_regclass(format('public.%I', item)) is null;
  if missing_items is not null then
    raise exception 'missing billing tables: %', missing_items;
  end if;

  select array_agg(item order by item)
  into missing_items
  from unnest(expected_indexes) as item
  where not exists (
    select 1
    from pg_catalog.pg_class
    where relnamespace = 'public'::regnamespace
      and relname = item
      and relkind = 'i'
  );
  if missing_items is not null then
    raise exception 'missing billing indexes: %', missing_items;
  end if;

  with expected(table_name, constraint_name, constraint_type) as (
    values
      ('billing_plans', 'billing_plans_pkey', 'p'),
      ('billing_plans', 'billing_plans_code_key', 'u'),
      ('billing_plans', 'billing_plans_billing_period_check', 'c'),
      ('billing_products', 'billing_products_pkey', 'p'),
      ('billing_products', 'billing_products_sku_key', 'u'),
      ('billing_orders', 'billing_orders_pkey', 'p'),
      ('billing_orders', 'billing_orders_order_number_key', 'u'),
      ('billing_payment_intents', 'billing_payment_intents_order_id_key', 'u'),
      ('billing_payments', 'billing_payments_request_idempotency_key_key', 'u'),
      ('billing_subscriptions', 'billing_subscriptions_source_order_id_key', 'u'),
      ('billing_credit_accounts', 'billing_credit_accounts_user_id_currency_key', 'u'),
      ('billing_credit_ledger', 'billing_credit_ledger_idempotency_key_key', 'u'),
      ('billing_credit_ledger', 'billing_credit_ledger_audit_log_id_fkey', 'f'),
      ('billing_webhook_events', 'billing_webhook_events_provider_provider_event_id_key', 'u'),
      ('billing_refund_requests', 'billing_refund_requests_user_order_key', 'u'),
      ('billing_invoice_requests', 'billing_invoice_requests_user_order_key', 'u')
  )
  select array_agg(format('%I.%I', table_name, constraint_name) order by table_name, constraint_name)
  into missing_items
  from expected
  where not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = to_regclass(format('public.%I', table_name))
      and conname = constraint_name
      and contype = constraint_type::"char"
  );
  if missing_items is not null then
    raise exception 'missing billing constraints: %', missing_items;
  end if;

  with expected_constraint_counts(table_name, constraint_count) as (
    values
      ('billing_plans', 3),
      ('billing_products', 9),
      ('billing_plan_entitlements', 5),
      ('billing_orders', 16),
      ('billing_payment_intents', 12),
      ('billing_payments', 9),
      ('billing_subscriptions', 8),
      ('billing_user_entitlements', 7),
      ('billing_usage_quotas', 10),
      ('billing_credit_accounts', 7),
      ('billing_usage_records', 10),
      ('billing_usage_continuations', 7),
      ('billing_credit_ledger', 8),
      ('billing_webhook_events', 10),
      ('billing_refund_requests', 8),
      ('billing_refunds', 12),
      ('billing_invoice_requests', 7),
      ('billing_admins', 4),
      ('billing_admin_audit_logs', 3),
      ('billing_rate_limits', 4),
      ('billing_feature_usage_costs', 5)
  ),
  actual_constraint_counts as (
    select class.relname as table_name, count(constraint.oid)::integer as constraint_count
    from pg_catalog.pg_class as class
    left join pg_catalog.pg_constraint as constraint on constraint.conrelid = class.oid
    where class.relnamespace = 'public'::regnamespace
      and class.relname like 'billing\_%' escape '\'
      and class.relkind = 'r'
    group by class.relname
  )
  select array_agg(
    format('%I(expected=%s)', expected.table_name, expected.constraint_count)
    order by expected.table_name
  )
  into missing_items
  from expected_constraint_counts as expected
  left join actual_constraint_counts as actual using (table_name)
  where actual.constraint_count is distinct from expected.constraint_count;
  if missing_items is not null then
    raise exception 'billing constraint inventory mismatch: %', missing_items;
  end if;
end;
$$;

do $$
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
$$;

do $$
declare
  expected_trigger_functions constant text[] := array[
    'public.billing_set_updated_at()',
    'public.billing_protect_order_snapshot()',
    'public.billing_protect_credit_ledger()',
    'public.billing_validate_webhook_event_update()'
  ];
  missing_or_unsafe text[];
  updated_trigger_count integer;
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
  into updated_trigger_count
  from pg_catalog.pg_trigger
  where tgfoid = 'public.billing_set_updated_at()'::regprocedure
    and tgname like 'billing\_%\_set\_updated\_at' escape '\'
    and not tgisinternal;
  if updated_trigger_count is distinct from 18 then
    raise exception 'billing updated timestamp trigger inventory mismatch';
  end if;
end;
$$;

do $$
declare
  expected_functions constant text[] := array[
    'public.billing_claim_payment_intent(uuid,uuid,text,text,uuid)',
    'public.billing_complete_payment_intent(uuid,uuid,text,text,text,timestamptz,timestamptz)',
    'public.billing_fail_payment_intent(uuid,uuid,text)',
    'public.billing_claim_mock_payment_confirmation(uuid,uuid,text,timestamptz)',
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
    'public.billing_admin_grant_subscription(uuid,uuid,uuid,integer,text,text)',
    'public.billing_admin_review_refund(uuid,uuid,text,text,text)',
    'public.billing_admin_review_invoice(uuid,uuid,text,text,text)',
    'public.billing_admin_upsert_plan(uuid,uuid,text,text,text,text,boolean,text,text)',
    'public.billing_admin_upsert_product(uuid,uuid,uuid,text,text,text,text,bigint,text,integer,bigint,text,boolean,text,text)',
    'public.billing_reject_audit_log_mutation()'
  ];
  missing_functions text[];
  unsafe_functions text[];
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
end;
$$;

do $$
declare
  expected_writer_functions constant text[] := array[
    'public.billing_claim_payment_intent(uuid,uuid,text,text,uuid)',
    'public.billing_complete_payment_intent(uuid,uuid,text,text,text,timestamptz,timestamptz)',
    'public.billing_fail_payment_intent(uuid,uuid,text)',
    'public.billing_claim_mock_payment_confirmation(uuid,uuid,text,timestamptz)',
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
    'public.billing_admin_upsert_plan(uuid,uuid,text,text,text,text,boolean,text,text)',
    'public.billing_admin_upsert_product(uuid,uuid,uuid,text,text,text,text,bigint,text,integer,bigint,text,boolean,text,text)'
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

  select array_agg(signature order by signature)
  into unsafe_functions
  from unnest(expected_writer_functions) as signature
  where not pg_catalog.has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE');
  if unsafe_functions is not null then
    raise exception 'billing writer RPC lacks its service execute grant: %', unsafe_functions;
  end if;
end;
$$;

do $$
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
$$;

do $$
declare
  actual_plans jsonb;
  actual_products jsonb;
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
end;
$$;

set local role authenticated;

do $$
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
$$;

reset role;

do $$
declare
  result jsonb;
  replay jsonb;
  expected_failure boolean;
begin
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

  result := public.billing_request_refund(
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b021',
    'Synthetic billing recovery drill refund request'
  );
  replay := public.billing_request_refund(
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000b021',
    'Synthetic billing recovery drill refund request'
  );
  if result ->> 'id' is distinct from '00000000-0000-4000-8000-00000000b060'
    or replay ->> 'id' is distinct from result ->> 'id' then
    raise exception 'refund request replay was not idempotent';
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
end;
$$;

rollback;
