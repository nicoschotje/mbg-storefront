-- MBG Tier 2 — Phase 2, Milestone 3
-- Add payment_status to get_my_orders() so the customer's My Orders view can
-- show the payment journey (received → under review → confirmed) alongside the
-- fulfilment order_status. Additive change to an EXISTING SECURITY DEFINER
-- function — no new function, no new advisor finding, no grant change (anon-only,
-- search_path locked, as established in Phase 1).
--
-- REVERSAL: re-create get_my_orders without the payment_status column (Phase 1
-- version in db/2026-06-26-phase1-account-ownership.sql).

CREATE OR REPLACE FUNCTION public.get_my_orders(
  p_session_token text DEFAULT NULL,
  p_order_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_customer_id uuid := NULL;
  v_token_hash  text;
  v_orders      jsonb;
BEGIN
  IF p_session_token IS NOT NULL AND length(p_session_token) > 0 THEN
    v_token_hash := encode(digest(p_session_token, 'sha256'), 'hex');
    SELECT s.customer_id INTO v_customer_id
    FROM public.customer_sessions s
    JOIN public.store_customers c ON c.id = s.customer_id
    WHERE s.token_hash = v_token_hash
      AND s.is_valid = true
      AND s.expires_at > now()
      AND c.is_active = true
    LIMIT 1;
  END IF;

  IF v_customer_id IS NULL
     AND (p_order_ids IS NULL OR array_length(p_order_ids, 1) IS NULL) THEN
    RETURN jsonb_build_object('orders', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) INTO v_orders
  FROM (
    SELECT o.id, o.order_number, o.order_status, o.payment_status, o.status_updated_at,
           o.delivery_notes, o.total, o.delivery_address, o.created_at,
           COALESCE(o.order_items, o.items) AS items
    FROM public.orders o
    WHERE (v_customer_id IS NOT NULL AND o.order_owner_id = v_customer_id)
       OR (p_order_ids IS NOT NULL AND o.id = ANY (p_order_ids))
    ORDER BY o.created_at DESC
    LIMIT 50
  ) t;

  RETURN jsonb_build_object('orders', v_orders);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_my_orders(text, uuid[]) FROM PUBLIC, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_my_orders(text, uuid[]) TO anon;
