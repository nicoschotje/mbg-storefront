-- MBG security hardening pass — owner-approved 2026-07-23
-- Covers DEFECTS.md: D-14, D-05, D-06 (partial), D-07, D-08
-- Applied to prod (mrbeanies-prod / ihnnipynpdtcbdfbpemq) as migration
--   `security_pass_d14_d05_d08`. Tested first on mrbeanies-staging (oyyaivofnjltrnnnszrf).
--
-- This file is the record of record. The DDL below is exactly what was applied.
-- =============================================================================

-- D-14 — remove the phone-header raw-anon cancel path.
--   Before: policy orders_anon_cancel_own let anon UPDATE an order to 'cancelled'
--   whenever customer_phone = x-customer-phone header. A phone number is not a
--   secret, so anyone who knew a customer's number could cancel their pending order.
--   The dashboard/staff cancel path is cancel_order() (SECURITY DEFINER, hard-gated
--   on is_admin()) plus the orders_admin_header_all / orders_sales_update policies —
--   none of which depend on this policy. The storefront has no customer self-cancel
--   UI, so no live client relies on it. Dropping it removes the phone-only cancel.
DROP POLICY IF EXISTS orders_anon_cancel_own ON public.orders;

-- D-05 — active_sessions: remove always-true anon INSERT (rls_policy_always_true).
--   No legitimate anon writer (storefront never writes this table; auth uses
--   customer_sessions via SECURITY DEFINER RPCs). service_role + is_admin policies remain.
DROP POLICY IF EXISTS active_sessions_insert_any ON public.active_sessions;

-- D-06 — auth_audit_log: remove always-true anon INSERT (rls_policy_always_true).
--   Auth RPCs write this table as SECURITY DEFINER (owner bypasses RLS); there is no
--   direct anon writer. audit_service_all remains; the auth_audit_log_block_modify
--   trigger still blocks UPDATE/DELETE.
--   NOTE: two always-true INSERT policies are deliberately LEFT IN PLACE because the
--   live storefront legitimately writes them as anon, and locking them risks a silent
--   regression with no data-exposure upside (both are internal append targets, not read
--   leaks):
--     * activity_log."Allow insert for all"  — client best-effort telemetry (logActivity)
--     * restock_notifications.customers_can_subscribe — the "notify me when restocked" form
DROP POLICY IF EXISTS audit_anon_insert ON public.auth_audit_log;

-- D-07 — rls-enabled-but-no-policy tables (rls_enabled_no_policy): add an explicit
--   service_role policy so intent is recorded. Functionally unchanged — with no policy,
--   anon/authenticated were already denied; this just documents "service-role only".
DO $$ BEGIN
  IF to_regclass('public.customer_remember_tokens') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='customer_remember_tokens' AND policyname='remember_tokens_service_only') THEN
    EXECUTE 'CREATE POLICY remember_tokens_service_only ON public.customer_remember_tokens FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
  IF to_regclass('public.report_refresh_state') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='report_refresh_state' AND policyname='report_refresh_state_service_only') THEN
    EXECUTE 'CREATE POLICY report_refresh_state_service_only ON public.report_refresh_state FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- D-08 — stop public LISTING on the four public buckets (public_bucket_allows_listing).
--   Public object access via /storage/v1/object/public/<bucket>/<path> bypasses RLS on
--   public buckets, so image/QR display is unaffected (verified: store_settings.*_qr_url
--   and products.image_url are all /object/public/ URLs; storefront makes no .list() call).
--   Removing the broad SELECT policy only removes the list-all-files capability.
DROP POLICY IF EXISTS "Public read banners"        ON storage.objects;
DROP POLICY IF EXISTS "Public read product-images" ON storage.objects;
DROP POLICY IF EXISTS "Public read qr-images"      ON storage.objects;
DROP POLICY IF EXISTS "Public read store-banners"  ON storage.objects;

-- =============================================================================
-- VERIFICATION LOG (2026-07-23, run against prod after apply)
-- -----------------------------------------------------------------------------
-- Advisor (security), target findings before -> after:
--   rls_enabled_no_policy .......... 2 -> 0   (D-07 fully resolved)
--   public_bucket_allows_listing ... 4 -> 0   (D-08 fully resolved)
--   rls_policy_always_true ......... 4 -> 2   (2 remaining = activity_log + restock,
--                                              intentionally kept; see D-06 note)
--   anon_security_definer_function_executable ... 86 (unchanged; that is D-02, not in scope)
--
-- Orders UPDATE policies remaining (no phone path):
--   orders_admin_header_all  (is_admin())          — dashboard/HQ
--   orders_sales_update      (current_role_scope()='sales')
--   orders_service_all       (service_role)
--
-- Live anon functional tests (SET LOCAL ROLE anon, rolled back — nothing persisted):
--   restock_notifications INSERT ... OK        (kept working)
--   activity_log         INSERT ... OK        (kept working)
--   active_sessions      INSERT ... BLOCKED[42501]
--   auth_audit_log       INSERT ... BLOCKED[42501]
--
-- Storefront visual paths unaffected (public object URLs): product images, banners,
-- payment QR (bank/gcash/maya/usdt), receipt upload (INSERT policy untouched).
-- =============================================================================
