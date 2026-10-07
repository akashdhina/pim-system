-- Phase 4 follow-up: close a gap found during verification.
--
-- `revoke all on function public.current_pim_role() from public` (in the
-- prior migration) revokes from the PUBLIC pseudo-role, but Supabase
-- projects configure default privileges that separately grant EXECUTE on
-- newly created public-schema functions to anon/authenticated/service_role
-- regardless of that revoke. Verified after applying the prior migration:
-- anon actually had EXECUTE here.
--
-- Not exploitable as found - the function resolves auth.uid(), which is
-- null for an anonymous request, so it always returns null to anon either
-- way - but it contradicts the documented intent ("the anonymous role has
-- no reason to ever call it"), so it is revoked explicitly rather than left
-- as an unexplained discrepancy between the code comment and reality.
-- service_role keeps EXECUTE (harmless - it already bypasses RLS entirely).

revoke execute on function public.current_pim_role() from anon;
