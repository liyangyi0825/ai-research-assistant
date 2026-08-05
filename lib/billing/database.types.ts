export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type UUID = string;
type Timestamp = string;
type Insert<Row, Required extends keyof Row> = Pick<Row, Required> &
  Partial<Omit<Row, Required>>;
type Update<Row> = Partial<Row>;

export type BillingPlanRow = {
  id: UUID;
  code: string;
  name: string;
  description: string | null;
  billing_period: "FREE" | "MONTHLY" | "YEARLY" | "SEMESTER";
  is_active: boolean;
  display_metadata: Json;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingProductRow = {
  id: UUID;
  plan_id: UUID | null;
  sku: string;
  name: string;
  description: string | null;
  product_type: "SUBSCRIPTION" | "CREDIT_PACK";
  price_minor: number;
  currency: "CNY";
  duration_days: number | null;
  credit_grant: number;
  entitlement_version: string;
  is_active: boolean;
  display_metadata: Json;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingOrderEntitlementSnapshot = {
  feature_key: string;
  entitlement_version: string;
  periodic_limit: number | null;
  credit_grant: number;
  configuration: Json;
};

export type BillingPlanEntitlementRow = {
  id: UUID;
  plan_id: UUID;
  feature_key: string;
  entitlement_version: string;
  periodic_limit: number | null;
  credit_grant: number;
  configuration: Json;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingOrderRow = {
  id: UUID;
  order_number: string;
  user_id: UUID;
  product_id: UUID;
  provider: "MOCK" | "WECHAT" | "ALIPAY";
  status:
    | "PENDING"
    | "PAID"
    | "FAILED"
    | "CANCELLED"
    | "CLOSED"
    | "REFUNDING"
    | "REFUNDED";
  amount_minor: number;
  currency: "CNY";
  snapshot_product_name: string;
  snapshot_product_type: "SUBSCRIPTION" | "CREDIT_PACK";
  snapshot_plan_id: UUID | null;
  snapshot_duration_days: number | null;
  snapshot_credit_grant: number;
  snapshot_entitlement_version: string;
  snapshot_entitlements: BillingOrderEntitlementSnapshot[];
  snapshot_details: Json;
  accepted_agreement_version: string;
  expires_at: Timestamp;
  paid_at: Timestamp | null;
  closed_at: Timestamp | null;
  refund_status: "NONE" | "REQUESTED" | "PARTIAL" | "FULL";
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingPaymentRow = {
  id: UUID;
  order_id: UUID;
  user_id: UUID;
  provider: "MOCK" | "WECHAT" | "ALIPAY";
  provider_transaction_id: string;
  status: "PENDING" | "PAID" | "FAILED" | "CLOSED" | "REFUNDED";
  amount_minor: number;
  currency: "CNY";
  request_idempotency_key: string;
  response_summary: Json;
  paid_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingPaymentIntentRow = {
  id: UUID;
  order_id: UUID;
  user_id: UUID;
  provider: "MOCK" | "WECHAT" | "ALIPAY";
  request_idempotency_key: string;
  status: "CREATING" | "CREATED" | "FAILED";
  claim_token: UUID | null;
  claim_expires_at: Timestamp | null;
  provider_transaction_id: string | null;
  payment_token: string | null;
  payment_status: "PENDING" | "PAID" | "FAILED" | "CLOSED" | null;
  amount_minor: number;
  currency: "CNY";
  expires_at: Timestamp;
  paid_at: Timestamp | null;
  last_error_code: string | null;
  attempt_count: number;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingSubscriptionRow = {
  id: UUID;
  user_id: UUID;
  plan_id: UUID;
  source_order_id: UUID | null;
  status: "ACTIVE" | "EXPIRED" | "CANCELLED";
  starts_at: Timestamp;
  ends_at: Timestamp;
  auto_renew: false;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingUserEntitlementRow = {
  id: UUID;
  user_id: UUID;
  plan_entitlement_id: UUID | null;
  feature_key: string;
  source_type: "PLAN" | "ADMIN";
  source_order_id: UUID | null;
  entitlement_value: Json;
  valid_from: Timestamp;
  valid_until: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingUsageQuotaRow = {
  id: UUID;
  user_id: UUID;
  subscription_id: UUID | null;
  feature_key: string;
  period_start: Timestamp;
  period_end: Timestamp;
  quota_limit: number;
  reserved_units: number;
  used_units: number;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingUsageRecordRow = {
  id: UUID;
  user_id: UUID;
  quota_id: UUID | null;
  credit_account_id: UUID | null;
  task_idempotency_key: string;
  feature_key: string;
  status: "RESERVED" | "FINALIZED" | "RELEASED";
  quota_units: number;
  credit_amount: number;
  currency: "CREDITS";
  reserved_at: Timestamp;
  finalized_at: Timestamp | null;
  released_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingUsageContinuationRow = {
  id: UUID;
  root_usage_record_id: UUID | null;
  user_id: UUID;
  root_task_idempotency_key: string;
  feature_key: string;
  operation_key: string;
  stage_key: string;
  request_hash: string | null;
  status: "AVAILABLE" | "CLAIMED" | "COMPLETED";
  claim_token: UUID | null;
  lease_expires_at: Timestamp | null;
  claimed_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingCreditAccountRow = {
  id: UUID;
  user_id: UUID;
  currency: "CREDITS";
  available_balance: number;
  reserved_balance: number;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingCreditLedgerRow = {
  id: UUID;
  account_id: UUID;
  user_id: UUID;
  entry_type:
    | "PURCHASE"
    | "GRANT"
    | "RESERVE"
    | "CONSUME"
    | "RELEASE"
    | "ADJUSTMENT";
  delta_available: number;
  delta_reserved: number;
  available_after: number;
  reserved_after: number;
  idempotency_key: string;
  audit_log_id: UUID | null;
  reference_type: string | null;
  reference_id: string | null;
  metadata: Json;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingWebhookEventRow = {
  id: UUID;
  order_id: UUID | null;
  user_id: UUID | null;
  order_number: string | null;
  provider: "MOCK" | "WECHAT" | "ALIPAY";
  provider_event_id: string;
  provider_transaction_id: string | null;
  request_idempotency_key: string | null;
  amount_minor: number | null;
  currency: "CNY" | null;
  paid_at: Timestamp | null;
  signature_valid: boolean;
  status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED";
  payload_summary: Json;
  error_code: string | null;
  processed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingRefundRequestRow = {
  id: UUID;
  order_id: UUID;
  user_id: UUID;
  requested_amount_minor: number;
  currency: "CNY";
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reviewed_by: UUID | null;
  review_note: string | null;
  reviewed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingRefundRow = {
  id: UUID;
  refund_request_id: UUID;
  order_id: UUID;
  payment_id: UUID;
  user_id: UUID;
  provider: "MOCK" | "WECHAT" | "ALIPAY";
  provider_refund_id: string | null;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  refunded_amount_minor: number;
  currency: "CNY";
  idempotency_key: string;
  response_summary: Json;
  completed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingInvoiceRequestRow = {
  id: UUID;
  order_id: UUID | null;
  user_id: UUID;
  invoice_title: string;
  tax_identifier: string | null;
  amount_minor: number;
  currency: "CNY";
  delivery_email: string;
  status: "PENDING" | "ISSUED" | "REJECTED" | "CANCELLED";
  issued_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingAdminRow = {
  id: UUID;
  user_id: UUID;
  role: "BILLING_ADMIN" | "BILLING_REVIEWER";
  is_active: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingAdminAuditLogRow = {
  id: UUID;
  actor_user_id: UUID;
  target_user_id: UUID | null;
  action: string;
  target_type: string;
  target_id: string | null;
  reason: string;
  before_value: Json | null;
  after_value: Json | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingRateLimitRow = {
  id: UUID;
  user_id: UUID;
  action: string;
  window_started_at: Timestamp;
  request_count: number;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type BillingFeatureUsageCostRow = {
  feature_key: string;
  quota_units: number;
  credit_amount: number;
  allow_credit_fallback: boolean;
  enabled: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type Database = {
  public: {
    Tables: {
      billing_plans: {
        Row: BillingPlanRow;
        Insert: Insert<BillingPlanRow, "code" | "name" | "billing_period">;
        Update: Update<BillingPlanRow>;
        Relationships: [];
      };
      billing_products: {
        Row: BillingProductRow;
        Insert: Insert<
          BillingProductRow,
          "sku" | "name" | "product_type" | "price_minor" | "entitlement_version"
        >;
        Update: Update<BillingProductRow>;
        Relationships: [
          {
            foreignKeyName: "billing_products_plan_id_fkey";
            columns: ["plan_id"];
            isOneToOne: false;
            referencedRelation: "billing_plans";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_plan_entitlements: {
        Row: BillingPlanEntitlementRow;
        Insert: Insert<
          BillingPlanEntitlementRow,
          "plan_id" | "feature_key" | "entitlement_version"
        >;
        Update: Update<BillingPlanEntitlementRow>;
        Relationships: [
          {
            foreignKeyName: "billing_plan_entitlements_plan_id_fkey";
            columns: ["plan_id"];
            isOneToOne: false;
            referencedRelation: "billing_plans";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_feature_usage_costs: {
        Row: BillingFeatureUsageCostRow;
        Insert: Insert<BillingFeatureUsageCostRow, "feature_key" | "quota_units" | "credit_amount">;
        Update: Update<BillingFeatureUsageCostRow>;
        Relationships: [];
      };
      billing_orders: {
        Row: BillingOrderRow;
        Insert: Insert<
          BillingOrderRow,
          | "order_number"
          | "user_id"
          | "product_id"
          | "provider"
          | "amount_minor"
          | "snapshot_product_name"
          | "snapshot_product_type"
          | "snapshot_entitlement_version"
          | "snapshot_entitlements"
          | "accepted_agreement_version"
          | "expires_at"
        >;
        Update: Update<BillingOrderRow>;
        Relationships: [
          {
            foreignKeyName: "billing_orders_product_id_fkey";
            columns: ["product_id"];
            isOneToOne: false;
            referencedRelation: "billing_products";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_orders_snapshot_plan_id_fkey";
            columns: ["snapshot_plan_id"];
            isOneToOne: false;
            referencedRelation: "billing_plans";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_payment_intents: {
        Row: BillingPaymentIntentRow;
        Insert: Insert<
          BillingPaymentIntentRow,
          | "order_id"
          | "user_id"
          | "provider"
          | "request_idempotency_key"
          | "claim_token"
          | "claim_expires_at"
          | "amount_minor"
          | "expires_at"
        >;
        Update: Update<BillingPaymentIntentRow>;
        Relationships: [
          {
            foreignKeyName: "billing_payment_intents_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: true;
            referencedRelation: "billing_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_payments: {
        Row: BillingPaymentRow;
        Insert: Insert<
          BillingPaymentRow,
          | "order_id"
          | "user_id"
          | "provider"
          | "provider_transaction_id"
          | "status"
          | "amount_minor"
          | "request_idempotency_key"
        >;
        Update: Update<BillingPaymentRow>;
        Relationships: [
          {
            foreignKeyName: "billing_payments_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "billing_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_subscriptions: {
        Row: BillingSubscriptionRow;
        Insert: Insert<
          BillingSubscriptionRow,
          "user_id" | "plan_id" | "source_order_id" | "starts_at" | "ends_at"
        >;
        Update: Update<BillingSubscriptionRow>;
        Relationships: [
          {
            foreignKeyName: "billing_subscriptions_plan_id_fkey";
            columns: ["plan_id"];
            isOneToOne: false;
            referencedRelation: "billing_plans";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_subscriptions_source_order_id_fkey";
            columns: ["source_order_id"];
            isOneToOne: true;
            referencedRelation: "billing_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_user_entitlements: {
        Row: BillingUserEntitlementRow;
        Insert: Insert<
          BillingUserEntitlementRow,
          "user_id" | "feature_key" | "source_type" | "valid_from"
        >;
        Update: Update<BillingUserEntitlementRow>;
        Relationships: [
          {
            foreignKeyName: "billing_user_entitlements_plan_entitlement_id_fkey";
            columns: ["plan_entitlement_id"];
            isOneToOne: false;
            referencedRelation: "billing_plan_entitlements";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_user_entitlements_source_order_id_fkey";
            columns: ["source_order_id"];
            isOneToOne: false;
            referencedRelation: "billing_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_usage_quotas: {
        Row: BillingUsageQuotaRow;
        Insert: Insert<
          BillingUsageQuotaRow,
          "user_id" | "feature_key" | "period_start" | "period_end" | "quota_limit"
        >;
        Update: Update<BillingUsageQuotaRow>;
        Relationships: [
          {
            foreignKeyName: "billing_usage_quotas_subscription_id_fkey";
            columns: ["subscription_id"];
            isOneToOne: false;
            referencedRelation: "billing_subscriptions";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_usage_records: {
        Row: BillingUsageRecordRow;
        Insert: Insert<
          BillingUsageRecordRow,
          "user_id" | "task_idempotency_key" | "feature_key"
        >;
        Update: Update<BillingUsageRecordRow>;
        Relationships: [
          {
            foreignKeyName: "billing_usage_records_credit_account_id_fkey";
            columns: ["credit_account_id"];
            isOneToOne: false;
            referencedRelation: "billing_credit_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_usage_records_quota_id_fkey";
            columns: ["quota_id"];
            isOneToOne: false;
            referencedRelation: "billing_usage_quotas";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_usage_continuations: {
        Row: BillingUsageContinuationRow;
        Insert: Insert<
          BillingUsageContinuationRow,
          | "user_id"
          | "root_task_idempotency_key"
          | "feature_key"
          | "operation_key"
          | "stage_key"
        >;
        Update: Update<BillingUsageContinuationRow>;
        Relationships: [
          {
            foreignKeyName: "billing_usage_continuations_root_usage_record_id_fkey";
            columns: ["root_usage_record_id"];
            isOneToOne: false;
            referencedRelation: "billing_usage_records";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_credit_accounts: {
        Row: BillingCreditAccountRow;
        Insert: Insert<BillingCreditAccountRow, "user_id">;
        Update: Update<BillingCreditAccountRow>;
        Relationships: [];
      };
      billing_credit_ledger: {
        Row: BillingCreditLedgerRow;
        Insert: Insert<
          BillingCreditLedgerRow,
          | "account_id"
          | "user_id"
          | "entry_type"
          | "delta_available"
          | "delta_reserved"
          | "available_after"
          | "reserved_after"
          | "idempotency_key"
        >;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "billing_credit_ledger_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "billing_credit_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_credit_ledger_audit_log_id_fkey";
            columns: ["audit_log_id"];
            isOneToOne: false;
            referencedRelation: "billing_admin_audit_logs";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_webhook_events: {
        Row: BillingWebhookEventRow;
        Insert: Insert<
          BillingWebhookEventRow,
          "provider" | "provider_event_id"
        >;
        Update: Update<BillingWebhookEventRow>;
        Relationships: [
          {
            foreignKeyName: "billing_webhook_events_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "billing_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_refund_requests: {
        Row: BillingRefundRequestRow;
        Insert: Insert<
          BillingRefundRequestRow,
          "order_id" | "user_id" | "requested_amount_minor" | "reason"
        >;
        Update: Update<BillingRefundRequestRow>;
        Relationships: [
          {
            foreignKeyName: "billing_refund_requests_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "billing_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_refunds: {
        Row: BillingRefundRow;
        Insert: Insert<
          BillingRefundRow,
          | "refund_request_id"
          | "order_id"
          | "payment_id"
          | "user_id"
          | "provider"
          | "refunded_amount_minor"
          | "idempotency_key"
        >;
        Update: Update<BillingRefundRow>;
        Relationships: [
          {
            foreignKeyName: "billing_refunds_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "billing_orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_refunds_payment_id_fkey";
            columns: ["payment_id"];
            isOneToOne: false;
            referencedRelation: "billing_payments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "billing_refunds_refund_request_id_fkey";
            columns: ["refund_request_id"];
            isOneToOne: true;
            referencedRelation: "billing_refund_requests";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_invoice_requests: {
        Row: BillingInvoiceRequestRow;
        Insert: Insert<
          BillingInvoiceRequestRow,
          "user_id" | "invoice_title" | "amount_minor" | "delivery_email"
        >;
        Update: Update<BillingInvoiceRequestRow>;
        Relationships: [
          {
            foreignKeyName: "billing_invoice_requests_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "billing_orders";
            referencedColumns: ["id"];
          },
        ];
      };
      billing_admins: {
        Row: BillingAdminRow;
        Insert: Insert<BillingAdminRow, "user_id">;
        Update: Update<BillingAdminRow>;
        Relationships: [];
      };
      billing_admin_audit_logs: {
        Row: BillingAdminAuditLogRow;
        Insert: Insert<
          BillingAdminAuditLogRow,
          "actor_user_id" | "action" | "target_type" | "reason"
        >;
        Update: Update<BillingAdminAuditLogRow>;
        Relationships: [];
      };
      billing_rate_limits: {
        Row: BillingRateLimitRow;
        Insert: Insert<
          BillingRateLimitRow,
          "user_id" | "action" | "window_started_at"
        >;
        Update: Update<BillingRateLimitRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      billing_claim_payment_intent: {
        Args: {
          p_user_id: UUID;
          p_order_id: UUID;
          p_provider: string;
          p_request_idempotency_key: string;
          p_claim_token: UUID;
        };
        Returns: Json;
      };
      billing_complete_payment_intent: {
        Args: {
          p_intent_id: UUID;
          p_claim_token: UUID;
          p_provider_transaction_id: string;
          p_payment_token: string;
          p_payment_status: string;
          p_expires_at: Timestamp;
          p_paid_at?: Timestamp | null;
        };
        Returns: Json;
      };
      billing_fail_payment_intent: {
        Args: {
          p_intent_id: UUID;
          p_claim_token: UUID;
          p_error_code: string;
        };
        Returns: Json;
      };
      billing_claim_mock_payment_confirmation: {
        Args: {
          p_user_id: UUID;
          p_order_id: UUID;
          p_provider_transaction_id: string;
          p_paid_at: Timestamp;
        };
        Returns: Json;
      };
      billing_settle_paid_order: {
        Args: {
          p_order_number: string;
          p_provider: string;
          p_provider_transaction_id: string;
          p_provider_event_id: string;
          p_request_idempotency_key: string;
          p_amount_minor: number;
          p_currency: string;
          p_paid_at: Timestamp;
          p_response_summary?: Json;
        };
        Returns: Json;
      };
      billing_reserve_usage: {
        Args: {
          p_user_id: UUID;
          p_task_idempotency_key: string;
          p_feature_key: string;
          p_quota_units?: number;
          p_credit_amount?: number;
          p_currency?: string;
        };
        Returns: Json;
      };
      billing_finalize_usage: {
        Args: { p_user_id: UUID; p_task_idempotency_key: string };
        Returns: Json;
      };
      billing_release_usage: {
        Args: { p_user_id: UUID; p_task_idempotency_key: string };
        Returns: Json;
      };
      billing_provision_usage_continuations: {
        Args: {
          p_user_id: UUID;
          p_root_task_idempotency_key: string;
          p_feature_key: string;
          p_operation_key: string;
          p_stages: Json;
          p_finalize_usage?: boolean;
        };
        Returns: Json;
      };
      billing_claim_usage_continuation: {
        Args: {
          p_user_id: UUID;
          p_root_task_idempotency_key: string;
          p_feature_key: string;
          p_operation_key: string;
          p_stage_key: string;
          p_request_hash: string;
          p_lease_seconds?: number;
        };
        Returns: Json;
      };
      billing_complete_usage_continuation: {
        Args: {
          p_user_id: UUID;
          p_root_task_idempotency_key: string;
          p_feature_key: string;
          p_operation_key: string;
          p_stage_key: string;
          p_request_hash: string;
          p_claim_token: UUID;
        };
        Returns: Json;
      };
      billing_release_usage_continuation: {
        Args: {
          p_user_id: UUID;
          p_root_task_idempotency_key: string;
          p_feature_key: string;
          p_operation_key: string;
          p_stage_key: string;
          p_request_hash: string;
          p_claim_token: UUID;
        };
        Returns: Json;
      };
      billing_adjust_credit: {
        Args: {
          p_user_id: UUID;
          p_amount: number;
          p_reason: string;
          p_idempotency_key: string;
          p_admin_user_id: UUID;
          p_currency?: string;
        };
        Returns: Json;
      };
      billing_admin_grant_subscription: {
        Args: {
          p_admin_user_id: UUID;
          p_user_id: UUID;
          p_plan_id: UUID;
          p_duration_days: number;
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      billing_admin_review_refund: {
        Args: {
          p_admin_user_id: UUID;
          p_request_id: UUID;
          p_decision: "APPROVED" | "REJECTED";
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      billing_admin_review_invoice: {
        Args: {
          p_admin_user_id: UUID;
          p_request_id: UUID;
          p_decision: "ISSUED" | "REJECTED";
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      billing_admin_upsert_plan: {
        Args: {
          p_admin_user_id: UUID;
          p_plan_id: UUID | null;
          p_code: string;
          p_name: string;
          p_description: string | null;
          p_billing_period: "FREE" | "MONTHLY" | "YEARLY" | "SEMESTER";
          p_is_active: boolean;
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      billing_admin_upsert_product: {
        Args: {
          p_admin_user_id: UUID;
          p_product_id: UUID | null;
          p_plan_id: UUID | null;
          p_sku: string;
          p_name: string;
          p_description: string | null;
          p_product_type: "SUBSCRIPTION" | "CREDIT_PACK";
          p_price_minor: number;
          p_currency: "CNY";
          p_duration_days: number | null;
          p_credit_grant: number;
          p_entitlement_version: string;
          p_is_active: boolean;
          p_reason: string;
          p_idempotency_key: string;
        };
        Returns: Json;
      };
      billing_request_refund: {
        Args: {
          p_user_id: UUID;
          p_order_id: UUID;
          p_reason: string;
        };
        Returns: Json;
      };
      billing_request_invoice: {
        Args: {
          p_user_id: UUID;
          p_order_id: UUID;
          p_invoice_title: string;
          p_tax_identifier: string | null;
          p_delivery_email: string;
        };
        Returns: Json;
      };
      billing_consume_order_rate_limit: {
        Args: {
          p_user_id: UUID;
          p_now: Timestamp;
          p_window_seconds?: number;
          p_limit?: number;
        };
        Returns: Json;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
