-- MBG storefront deep-debug — security guard migration
-- Applied to Supabase ihnnipynpdtcbdfbpemq on 2026-06-08
-- (migration name: guard_admin_only_customer_rpcs). Recorded here for review.
--
-- WHY: three SECURITY DEFINER functions were EXECUTE-able by the `anon` role
-- with NO internal authorization check. Proven exploitable from the public anon
-- key alone (is_admin() = false, yet):
--   * list_store_customers()  -> returned all 41 customers' PII (name/phone/email/address)
--   * reset_customer_pin(id,pin) -> could reset ANY customer's PIN (account takeover)
--   * delete_store_customer(id)  -> could delete ANY customer
-- FIX: add an is_admin() guard (the same pattern delete_order/get_totp_secret
-- already use). Additive, reversible, and transparent to the dashboard, which
-- authenticates as admin via request headers. The storefront never calls these.
--
-- Verified after apply (as the anon role):
--   reset_customer_pin   -> {"success":false,"error":"Admin authentication required"}
--   delete_store_customer-> {"success":false,"error":"Admin authentication required"}
--   list_store_customers -> ERROR 42501 Unauthorized: admin gateway required
--
-- Only the guard line was added; the rest of each body is unchanged.

-- (full CREATE OR REPLACE bodies are in the migration history; the guard added
--  to each is shown below for review)

-- reset_customer_pin / delete_store_customer (jsonb-returning):
--   IF NOT public.is_admin() THEN
--     RETURN jsonb_build_object('success', false, 'error', 'Admin authentication required');
--   END IF;

-- list_store_customers (TABLE-returning):
--   IF NOT public.is_admin() THEN
--     RAISE EXCEPTION 'Unauthorized: admin gateway required' USING ERRCODE = '42501';
--   END IF;

-- ── REVERT (only if the dashboard's customer screen breaks because it does NOT
--    send admin auth — unlikely, since delete_order already requires is_admin()).
--    Re-create each function WITHOUT the guard line to restore prior behaviour.
