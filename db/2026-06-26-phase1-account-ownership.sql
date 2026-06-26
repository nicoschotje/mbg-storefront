-- MBG Tier 2 — Phase 1, Milestone 0: account ownership + visibility (DB layer)
-- Target: Supabase ihnnipynpdtcbdfbpemq. Tested first on dev branch
-- `phase1-account-ownership` (project_ref wcgfweloedvkobodlpux).
--
-- Summary
--  1. orders.order_owner_id  — the account that PLACED the order (nullable FK).
--     customer_name/customer_phone stay as RECIPIENT/contact only.
--  2. store_customers.last_payment_method — for one-tap checkout (Milestone 2+).
--  3. RLS: remove the phone-as-identity read leak. A recipient phone must NEVER
--     grant read access. Logged-in accounts read only their own orders; guests
--     read a specific order only via its unguessable id (capability), both via
--     the get_my_orders() RPC below. anon loses ALL direct SELECT on orders.
--  4. get_my_orders(session_token, order_ids) — the single read path:
--       * valid session token  -> that account's orders (by order_owner_id)
--       * order_ids (uuids)     -> exactly those orders (guest capability tokens)
--     SECURITY DEFINER, granted to anon ONLY (not PUBLIC/authenticated — keeps
--     the Phase 0 posture). Self-gates on the session token / id; returns
--     customer-safe columns only (no other-customer PII, no internal fields).
--  5. place_customer_order() — accept & store order_owner_id from the payload
--     (the place-order edge function resolves it from the session token via
--     validate_customer_session and never trusts a browser-supplied owner id).
--  6. Conservative backfill — attach order_owner_id ONLY when the order's
--     normalized phone maps to EXACTLY ONE store_customer. Never attach an
--     ambiguous order. (Live dry-run 2026-06-26: 88 orders, 83 unique matches,
--     0 ambiguous.)
--
-- order_status authority: already enforced by the existing sync_order_status_columns
-- trigger (BEFORE INSERT/UPDATE) which keeps legacy `status` in sync with the
-- authoritative `order_status`. No change needed; documented here for the record.
--
-- REVERSAL: drop get_my_orders; ALTER TABLE ... DROP COLUMN order_owner_id,
-- last_payment_method; recreate orders_anon_select_own; restore place_customer_order
-- without order_owner_id. (Backfill is data-only and harmless to leave.)

-- ── 1. orders.order_owner_id ─────────────────────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_owner_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_owner_id_fkey') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_order_owner_id_fkey
      FOREIGN KEY (order_owner_id) REFERENCES public.store_customers(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_order_owner_id ON public.orders(order_owner_id);

COMMENT ON COLUMN public.orders.order_owner_id IS
  'Account (store_customers.id) that PLACED the order. Stamped server-side from the customer session token. customer_name/customer_phone are recipient/contact only. Never set from the browser.';

-- ── 2. store_customers.last_payment_method ───────────────────────────────────
ALTER TABLE public.store_customers
  ADD COLUMN IF NOT EXISTS last_payment_method text;

-- ── 3. RLS: kill the recipient-phone read leak ───────────────────────────────
-- Old policy granted SELECT when customer_phone = x-customer-phone header, so
-- anyone who knew/guessed a recipient phone could read those orders.
DROP POLICY IF EXISTS orders_anon_select_own ON public.orders;
-- orders_admin_header_all (is_admin), orders_service_all (service_role) remain.
-- orders_anon_cancel_own (phone-based UPDATE cancel) is left as-is for now and
-- tracked in DEFECTS.md (D-13) — it is an UPDATE path, not a read path.

-- ── 4. get_my_orders RPC — the only storefront read path ─────────────────────
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
  -- Resolve the logged-in account from the session token (same scheme as
  -- validate_customer_session). An invalid/expired token simply yields no
  -- owner — it never errors, so guests still get their id-based results.
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
    SELECT o.id,
           o.order_number,
           o.order_status,
           o.status_updated_at,
           o.delivery_notes,
           o.total,
           o.delivery_address,
           o.created_at,
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

-- Keep the Phase 0 posture: anon only, never PUBLIC/authenticated.
REVOKE EXECUTE ON FUNCTION public.get_my_orders(text, uuid[]) FROM PUBLIC, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_my_orders(text, uuid[]) TO anon;

-- ── 5. place_customer_order — accept & store order_owner_id ───────────────────
-- Identical to the live function except: the INSERT now also writes
-- order_owner_id from NULLIF(payload->>'order_owner_id','')::uuid. The edge
-- function resolves that id from the session token; the browser never supplies it.
CREATE OR REPLACE FUNCTION public.place_customer_order(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_item jsonb; v_product_id uuid; v_variant_id uuid; v_qty int;
  v_available numeric; v_prod_name text; v_prod_active boolean;
  v_var_stock numeric; v_var_avail boolean; v_var_name text;
  v_stock_units numeric;
  v_new_id uuid; v_new_number text; v_items jsonb;
  v_owner_id uuid;
BEGIN
  v_items := payload->'items';
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Items array is empty' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_owner_id := NULLIF(payload->>'order_owner_id','')::uuid;
  EXCEPTION WHEN others THEN v_owner_id := NULL;
  END;

  -- ── Validation pass (locks every affected row FOR UPDATE) ──
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    BEGIN v_product_id := (v_item->>'id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Invalid product id: %', v_item->>'id' USING ERRCODE = 'P0001';
    END;

    v_variant_id := NULL;
    BEGIN
      IF NULLIF(v_item->>'variant_id','') IS NOT NULL THEN
        v_variant_id := (v_item->>'variant_id')::uuid;
      END IF;
    EXCEPTION WHEN others THEN
      v_variant_id := NULL;
    END;

    v_qty := COALESCE(NULLIF(v_item->>'quantity','')::int, NULLIF(v_item->>'qty','')::int, 1);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'Invalid quantity for item %', v_product_id USING ERRCODE = 'P0001';
    END IF;

    v_stock_units := 1.0;

    SELECT stock_qty, name, COALESCE(is_active, true)
      INTO v_available, v_prod_name, v_prod_active
      FROM products WHERE id = v_product_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found: %', v_product_id USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_prod_active THEN
      RAISE EXCEPTION 'Product is inactive: %', v_prod_name USING ERRCODE = 'P0002';
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT stock_qty, COALESCE(is_available, true), name, COALESCE(stock_units, 1.0)
        INTO v_var_stock, v_var_avail, v_var_name, v_stock_units
        FROM product_variants
        WHERE id = v_variant_id AND parent_product_id = v_product_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found: %', v_variant_id USING ERRCODE = 'P0001';
      END IF;
      IF NOT v_var_avail THEN
        RAISE EXCEPTION 'Variant is sold out: %', COALESCE(v_var_name, v_prod_name) USING ERRCODE = 'P0003';
      END IF;
      IF v_var_stock IS NOT NULL AND v_var_stock < (v_qty::numeric * v_stock_units) THEN
        RAISE EXCEPTION 'Insufficient stock for % — %: requested %, available %',
          v_prod_name, COALESCE(v_var_name,''), v_qty, v_var_stock USING ERRCODE = 'P0003';
      END IF;
    ELSE
      IF v_available IS NULL OR v_available < v_qty THEN
        RAISE EXCEPTION 'Insufficient stock for %: requested %, available %',
          v_prod_name, v_qty, COALESCE(v_available, 0) USING ERRCODE = 'P0003';
      END IF;
    END IF;
  END LOOP;

  -- ── Decrement pass ──
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_product_id := (v_item->>'id')::uuid;
    v_variant_id := NULL;
    BEGIN
      IF NULLIF(v_item->>'variant_id','') IS NOT NULL THEN
        v_variant_id := (v_item->>'variant_id')::uuid;
      END IF;
    EXCEPTION WHEN others THEN
      v_variant_id := NULL;
    END;
    v_qty := COALESCE(NULLIF(v_item->>'quantity','')::int, NULLIF(v_item->>'qty','')::int, 1);

    v_stock_units := 1.0;
    IF v_variant_id IS NOT NULL THEN
      SELECT COALESCE(stock_units, 1.0) INTO v_stock_units
        FROM product_variants WHERE id = v_variant_id;
    END IF;

    IF v_variant_id IS NOT NULL THEN
      UPDATE product_variants
        SET stock_qty    = GREATEST(0, stock_qty - (v_qty::numeric * v_stock_units)),
            is_available = CASE WHEN (stock_qty - (v_qty::numeric * v_stock_units)) <= 0 THEN false ELSE is_available END,
            updated_at   = now()
        WHERE id = v_variant_id AND stock_qty IS NOT NULL;
    ELSE
      UPDATE products SET stock_qty = stock_qty - v_qty, updated_at = now()
        WHERE id = v_product_id;
    END IF;
  END LOOP;

  INSERT INTO orders (
    customer_name, customer_phone, contact, delivery_address, delivery_zone, delivery_fee,
    subtotal, total, discount_amount, promo_code, payment_method, receipt_url, notes, items,
    order_status, status, payment_status, telegram_user_id, telegram_chat_id,
    delivery_lat, delivery_lng, order_owner_id
  ) VALUES (
    payload->>'customer_name',
    NULLIF(payload->>'customer_phone',''),
    NULLIF(payload->>'customer_phone',''),
    COALESCE(NULLIF(payload->>'delivery_address',''), 'Store Pickup'),
    COALESCE(NULLIF(payload->>'delivery_zone',''), 'pickup'),
    COALESCE(NULLIF(payload->>'delivery_fee','')::numeric, 0),
    COALESCE(NULLIF(payload->>'subtotal','')::numeric, 0),
    COALESCE(NULLIF(payload->>'total','')::numeric, 0),
    COALESCE(NULLIF(payload->>'discount_amount','')::numeric, 0),
    NULLIF(payload->>'promo_code',''),
    COALESCE(NULLIF(payload->>'payment_method',''), 'gcash'),
    NULLIF(payload->>'receipt_url',''),
    NULLIF(payload->>'notes',''),
    v_items, 'pending', 'pending', 'pending',
    NULLIF(payload->>'telegram_user_id',''),
    NULLIF(payload->>'telegram_chat_id',''),
    NULLIF(payload->>'delivery_lat',''),
    NULLIF(payload->>'delivery_lng',''),
    v_owner_id
  ) RETURNING id, order_number INTO v_new_id, v_new_number;

  -- Remember the account's most recent payment method for one-tap checkout.
  IF v_owner_id IS NOT NULL THEN
    UPDATE public.store_customers
       SET last_payment_method = COALESCE(NULLIF(payload->>'payment_method',''), last_payment_method),
           updated_at = now()
     WHERE id = v_owner_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'order_id', v_new_id, 'order_number', v_new_number);
END;
$function$;

-- ── 6. Conservative backfill (unique normalized-phone match only) ─────────────
WITH uniq AS (
  SELECT phone_normalized, (array_agg(id))[1] AS cid, COUNT(*) AS n
  FROM public.store_customers
  WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''
  GROUP BY phone_normalized
),
uniq_one AS (SELECT phone_normalized, cid FROM uniq WHERE n = 1)
UPDATE public.orders o
   SET order_owner_id = u.cid
  FROM uniq_one u
 WHERE o.order_owner_id IS NULL
   AND o.customer_phone IS NOT NULL
   AND public.normalize_phone(o.customer_phone) = u.phone_normalized;
