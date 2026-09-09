-- Forward-only repair for databases that applied the original 006 grant.
REVOKE ALL ON FUNCTION public.billing_adjust_credit_legacy(UUID, BIGINT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
