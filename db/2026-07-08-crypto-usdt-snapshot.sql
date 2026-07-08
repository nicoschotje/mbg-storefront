-- 2026-07-08 — Crypto (USDT) checkout: order-level payment snapshot (PR 1).
--
-- Adds a single nullable JSONB column to orders. The place-order edge function
-- writes it at placement for USDT orders (payment_method = 'usdt'); every other
-- payment method (Bank Transfer, GCash/Maya) leaves it NULL, so there is no
-- behaviour change for them. The snapshot is the authoritative record of the
-- rate + amount the customer was instructed to send, frozen at placement:
--   { payment_method, network, subtotal, delivery_fee, discount, final_php_total,
--     market_rate, owner_adjustment, checkout_rate, crypto_fee_php, crypto_php_due,
--     usdt_due, rounding, rate_source, rate_timestamp }
--
-- Additive and reversible. No backfill: existing orders keep a NULL snapshot and
-- are NEVER recomputed by later store_settings changes. The crypto processing
-- fee (PR 2) lives only inside this JSON (crypto_fee_php / crypto_php_due) and is
-- deliberately NOT added to orders.total, so the ledger shape
-- (total = subtotal + delivery − discount) is untouched.

alter table public.orders
  add column if not exists crypto_snapshot jsonb;

comment on column public.orders.crypto_snapshot is
  'USDT checkout snapshot, frozen at order placement by the place-order edge function. NULL for non-USDT orders. Never recomputed by later settings changes.';

-- Rollback:
--   alter table public.orders drop column if exists crypto_snapshot;
