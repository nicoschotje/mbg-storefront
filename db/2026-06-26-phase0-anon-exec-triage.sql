-- MBG Tier 2 — Phase 0: anon-executable SECURITY DEFINER triage
-- Applied to Supabase ihnnipynpdtcbdfbpemq on 2026-06-26 in two migrations:
--   20260626065913  phase0_anon_exec_security_triage   (explicit anon/auth revokes + hardening)
--   20260626070152  phase0_anon_exec_revoke_public     (remove the PUBLIC grant path)
-- Recorded here for review. Reversible (see REVERSAL notes).
--
-- ── CONTEXT ──────────────────────────────────────────────────────────────────
-- The security advisor flagged 36 SECURITY DEFINER functions executable by the
-- public `anon` role. Goal: stop the public anon role from reaching the
-- dangerous/admin functions WITHOUT breaking the storefront or the dashboard.
--
-- KEY ARCHITECTURE FACT (corrects the original Phase 0 brief):
-- BOTH apps authenticate to this project with the public ANON key.
--   * Storefront = plain anon.
--   * Dashboard  = anon + an `x-admin-secret` / `x-admin-token` header that the
--     functions verify internally via is_admin(). It is NOT a privileged DB role.
-- Therefore the dashboard genuinely CALLS many "admin" functions AS anon. The
-- original revoke list assumed these were not anon-called; revoking anon EXECUTE
-- on them would break live dashboard admin login / order delete / customer mgmt
-- / 2FA. Per the task's rule #4 (if genuinely client-called, do NOT revoke —
-- gate it behind a validated session instead) those KEEP anon and rely on their
-- internal is_admin()/PIN/session gate (the EXECUTE grant only lets the call
-- reach the gate; the gate is the real protection).
--
-- The `authenticated` role is used by NO client (there is no Supabase Auth
-- anywhere), so EXECUTE was revoked from `authenticated` on the whole revoke
-- list — pure defence-in-depth, breaks nothing.
--
-- ── EVIDENCE GATHERED (storefront full grep + dashboard DASHBOARD-AUDIT.md / js2) ─
-- Storefront calls NONE of the revoke-list functions.
-- Dashboard calls as anon: delete_order, verify_owner_pin, verify_sales_pin,
--   list_store_customers, reset_customer_pin, update_customer_address,
--   toggle_customer_active, unlock_store_customer, delete_store_customer, plus
--   the admin-session / 2FA lifecycle (is_admin, validate_admin_session,
--   invalidate_admin_session, get_totp_secret, enroll_owner_totp,
--   consume_totp_recovery_code, get_customer_audit).
-- increment_discount_uses is called only by the place-order edge function with
--   the SERVICE_ROLE key (grants don't apply). export_customer_data is unwired.
--   roll_up_variant_stock / auto_enrich_new_order are TRIGGER functions,
--   rls_auto_enable is an EVENT TRIGGER, cleanup_expired_auth_data is
--   maintenance — none are browser-callable.

-- ═════════════════════════════════════════════════════════════════════════════
-- A) NOT called by any browser client → block anon entirely
--    (revoke anon + authenticated + PUBLIC)
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.auto_enrich_new_order()        FROM PUBLIC, anon, authenticated; -- trigger fn
REVOKE EXECUTE ON FUNCTION public.roll_up_variant_stock()        FROM PUBLIC, anon, authenticated; -- trigger fn
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()              FROM PUBLIC, anon, authenticated; -- event-trigger fn
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_auth_data()    FROM PUBLIC, anon, authenticated; -- maintenance (service_role/cron)
REVOKE EXECUTE ON FUNCTION public.increment_discount_uses(uuid)  FROM PUBLIC, anon, authenticated; -- place-order edge fn only (service_role)
REVOKE EXECUTE ON FUNCTION public.export_customer_data(text)     FROM PUBLIC, anon, authenticated; -- unwired; re-GRANT anon when a storefront "export my data" feature ships

-- ═════════════════════════════════════════════════════════════════════════════
-- B) Called by the live dashboard AS anon → keep the explicit anon grant,
--    remove the PUBLIC + authenticated reach. Each function self-checks
--    is_admin()/PIN/session internally (verified).
-- ═════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.delete_order(uuid)                        FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.reset_customer_pin(uuid, text)            FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_totp_secret()                        FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.enroll_owner_totp(text, text[])          FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.consume_totp_recovery_code(text)         FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_owner_pin(text, text, text, text) FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_sales_pin(text, text, text)       FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_admin()                               FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_admin_session(text)             FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.invalidate_admin_session(text)           FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_store_customer(uuid)               FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_customer_audit(uuid, integer)        FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_store_customers()                    FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_customer_address(uuid, text)      FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.toggle_customer_active(uuid, boolean)    FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.unlock_store_customer(uuid)               FROM PUBLIC, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- C) HARDEN the two dashboard functions that had NO internal gate. Previously
--    any anon caller could flip a customer active/inactive or clear a lockout
--    with no authentication. Add the same is_admin() guard the sibling RPCs use.
--    The dashboard sends x-admin-secret on every call (same client that already
--    calls is_admin-gated list_store_customers), so is_admin() returns true and
--    the dashboard is unaffected. The storefront never calls these.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.toggle_customer_active(p_customer_id uuid, p_active boolean)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: admin gateway required' USING ERRCODE = '42501';
  END IF;
  UPDATE store_customers SET is_active = p_active, updated_at = now()
  WHERE id = p_customer_id;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlock_store_customer(p_customer_id uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: admin gateway required' USING ERRCODE = '42501';
  END IF;
  UPDATE store_customers SET failed_attempts = 0, locked_until = NULL, updated_at = now()
  WHERE id = p_customer_id;
  RETURN FOUND;
END;
$function$;

-- ── VERIFICATION (after apply) ───────────────────────────────────────────────
-- Security advisor: 81 -> 53 findings, 0 NEW vs baseline, 28 removed.
--   anon_security_definer_function_executable          36 -> 30
--   authenticated_security_definer_function_executable 36 -> 14
-- As the anon role (SET ROLE anon), exercising the exact PostgREST EXECUTE path:
--   validate_customer_session('dummy')  -> {"valid":false}                 (storefront OK)
--   is_admin()                          -> false                           (dashboard OK)
--   validate_admin_session('dummy')     -> {"valid":false}                 (dashboard OK)
--   verify_sales_pin('0000',..)         -> {"success":false,"Wrong PIN"}   (dashboard login OK)
--   toggle_customer_active(..)          -> ERROR "Unauthorized: admin gateway required"  (NEW guard works)
--   unlock_store_customer(..)           -> ERROR "Unauthorized: admin gateway required"  (NEW guard works)
--   increment_discount_uses(..)         -> ERROR "permission denied for function"        (anon blocked)
--   export_customer_data / cleanup_expired_auth_data -> permission denied               (anon blocked)
--
-- ── REVERSAL ─────────────────────────────────────────────────────────────────
-- To undo grants:  GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO PUBLIC, anon, authenticated;
-- To undo hardening: CREATE OR REPLACE the two functions above without the
--   `IF NOT public.is_admin() ...` block (original bodies were a bare UPDATE).
