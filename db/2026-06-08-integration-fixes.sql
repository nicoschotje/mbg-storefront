-- MBG cross-system integration fixes — applied to Supabase ihnnipynpdtcbdfbpemq on 2026-06-08.
-- Recorded here for review/traceability; already live in the project's migration history
-- (see INTEGRATION-AUDIT.md §4). Additive/safe; verified with a real order (then reverted).

-- 1) rollup_variant_stock_to_parent ------------------------------------------------
-- Variant stock is the single source of truth; parent products.stock_qty is kept = Σ variants
-- so the dashboard / low-stock / plain-product reads become truthful with no UI rewrite.
CREATE OR REPLACE FUNCTION public.roll_up_variant_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE pid uuid;
BEGIN
  pid := COALESCE(NEW.parent_product_id, OLD.parent_product_id);
  IF pid IS NOT NULL THEN
    UPDATE products p
       SET stock_qty = COALESCE((SELECT SUM(v.stock_qty)
                                   FROM product_variants v
                                  WHERE v.parent_product_id = pid), 0),
           updated_at = now()
     WHERE p.id = pid;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_rollup_variant_stock ON public.product_variants;
CREATE TRIGGER trg_rollup_variant_stock
  AFTER INSERT OR UPDATE OF stock_qty OR DELETE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.roll_up_variant_stock();

-- 2) backfill_parent_stock_from_variants -------------------------------------------
UPDATE products p
   SET stock_qty = COALESCE((SELECT SUM(v.stock_qty)
                               FROM product_variants v
                              WHERE v.parent_product_id = p.id), 0)
 WHERE p.has_variants;

-- 3) add_closed_message_to_store_settings ------------------------------------------
ALTER TABLE public.store_settings ADD COLUMN IF NOT EXISTS closed_message text;

-- 4) drop_orders_anon_insert_bypass ------------------------------------------------
-- Anon could INSERT orders directly (no stock decrement). The edge function uses the
-- service role, so the stock-decrementing RPC is now the only path to create an order.
DROP POLICY IF EXISTS orders_anon_insert_validated ON public.orders;

-- 5) harden_function_search_paths --------------------------------------------------
ALTER FUNCTION public.sync_order_status_columns() SET search_path = public;
ALTER FUNCTION public.increment_discount_uses(uuid) SET search_path = public;

-- 6) revoke_public_execute_on_decrement_stock --------------------------------------
-- Legacy SECURITY DEFINER fn with no internal auth; any anon caller could zero/inflate
-- stock. Unused by the storefront (RPC does its own row-locked decrement).
REVOKE EXECUTE ON FUNCTION public.decrement_stock(uuid, numeric) FROM PUBLIC, anon, authenticated;
