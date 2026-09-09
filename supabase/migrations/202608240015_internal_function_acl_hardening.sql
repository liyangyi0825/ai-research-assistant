BEGIN;

REVOKE ALL ON FUNCTION public.billing_assert_semester_plan(UUID)
FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
