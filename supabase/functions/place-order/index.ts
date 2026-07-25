// place-order — MBG Tier 2 (delivery-quote binding)
//
// Delivery-quote consistency fix (MG-563):
//  * The storefront shows the fee from the quote_delivery RPC and sends that
//    quote's `quote_id`. This function now FORWARDS `quote_id` (and
//    `delivery_zone_id`) to place_customer_order, whose B6a quote fork
//    atomically claims the quote and binds the saved fee to the QUOTED fee —
//    so the price shown at checkout and the price saved on the order can no
//    longer diverge. Previously quote_id was dropped here and the fee was
//    recomputed with a second engine (serverCalcDeliveryFee), which produced a
//    different number (the ₱282-shown-vs-₱384-saved defect).
//  * On the quote path the quoted fee is the ONLY authority; the server no
//    longer recomputes delivery. The legacy recompute survives ONLY for old
//    cached bundles that send no quote_id (back-compat) and is removed once
//    strict enforcement is enabled after the cache/SW-version bump.
//  * A quote rejection (RPC P0004) is surfaced as HTTP 409 {error:'quote_invalid'}
//    so the storefront's refresh-and-reconfirm flow fires (never a silent charge).
//
// Unchanged: account ownership resolved server-side from `session_token`; the
// subtotal and discount are recomputed server-side (browser subtotal/total are
// still not trusted); USDT snapshot; Telegram owner alert.
//
// Still verify_jwt=false + service-role key (custom session auth, not Supabase JWT).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ENV_TG_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
const ENV_TG_OWNER  = Deno.env.get('TELEGRAM_OWNER_CHAT_ID') || ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
// Round UP to 2 decimals so the store is never short-paid on a USDT order.
// Mirrors js/modules/crypto-pricing.js ceilTo2 (keep the two in sync).
const ceil2 = (n: number) => Math.ceil((Number(n) * 100) - 1e-6) / 100

// USDT→PHP rate from the crypto-rate edge function — the same server-cached
// source the storefront preview reads (verify_jwt=false, so no auth header).
// Returns null when unavailable so a USDT order that can't be priced is
// REJECTED rather than snapshotted with a bogus rate.
async function fetchUsdtPhpRate(): Promise<number | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/crypto-rate`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const d = await res.json()
    const php = d?.tether?.php
    return typeof php === 'number' && php > 0 ? php : null
  } catch (_) {
    return null
  }
}

// ── Authoritative subtotal from items × current DB prices ────────────────────
// Effective unit price mirrors the storefront's priceForItem():
//   variant.price_override (when a variant is chosen and it has an override),
//   else the parent product's price. Rejects items whose product/variant is
//   missing or inactive so a tampered cart can never underpay.
async function serverCalcSubtotal(
  supabase: any,
  items: any[]
): Promise<{ subtotal: number; pricedItems: any[] }> {
  const productIds = [...new Set(items.map(it => it.product_id || it.id).filter(Boolean))]
  const variantIds = [...new Set(items.map(it => it.variant_id).filter(Boolean))]

  const { data: products, error: pErr } = await supabase
    .from('products').select('id, price, is_active').in('id', productIds)
  if (pErr) throw new Error('Could not price your order — please try again.')
  const prodById = new Map((products || []).map((p: any) => [p.id, p]))

  let varById = new Map<string, any>()
  if (variantIds.length) {
    const { data: variants, error: vErr } = await supabase
      .from('product_variants').select('id, price_override, parent_product_id').in('id', variantIds)
    if (vErr) throw new Error('Could not price your order — please try again.')
    varById = new Map((variants || []).map((v: any) => [v.id, v]))
  }

  let subtotal = 0
  const pricedItems = items.map(it => {
    const pid = it.product_id || it.id
    const product = prodById.get(pid)
    if (!product) throw new Error('One of your items is no longer available. Please review your cart.')
    if (product.is_active === false) throw new Error('One of your items is no longer available. Please review your cart.')

    let unit = Number(product.price) || 0
    if (it.variant_id) {
      const v = varById.get(it.variant_id)
      if (!v || v.parent_product_id !== pid) {
        throw new Error('One of your selected options is no longer available. Please review your cart.')
      }
      if (v.price_override != null) unit = Number(v.price_override) || 0
    }
    const qty = Number(it.quantity ?? it.qty) || 0
    if (qty <= 0) throw new Error('Invalid quantity in your cart.')
    subtotal += unit * qty
    return { ...it, price: unit, qty, quantity: qty }
  })

  return { subtotal: round2(subtotal), pricedItems }
}

// ── Authoritative delivery fee — line-for-line port of js/modules/delivery.js
//    (calculateDelivery) + checkout.js computeDelivery, run against the live
//    store_settings / delivery_zones rather than browser values. ──────────────
const BASE_FARE = 55, PER_KM = 15, PER_MINUTE = 2, AVG_SPEED_KMH = 30
const VALID_SURGE = [1, 1.5, 2, 2.5, 3]

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function serverCalcDeliveryFee(
  supabase: any, ss: any,
  opts: { zoneId: string | null; lat: number | null; lng: number | null; subtotal: number }
): Promise<number> {
  const freeMin = Number(ss?.free_delivery_min) || 0
  const freeEnabled = ss?.free_delivery_enabled !== false
  const qualifiesFree = freeEnabled && freeMin > 0 && opts.subtotal >= freeMin

  // Fixed Outside-Metro-Manila zone → flat base_fee.
  if (opts.zoneId) {
    const { data: zone } = await supabase
      .from('delivery_zones').select('base_fee, is_active').eq('id', opts.zoneId).maybeSingle()
    if (zone && zone.is_active !== false) {
      return qualifiesFree ? 0 : Math.max(0, Number(zone.base_fee) || 0)
    }
    // Unknown/inactive zone falls through to the distance/flat calc below.
  }

  const surge = VALID_SURGE.includes(Number(ss?.delivery_rate_multiplier))
    ? Number(ss?.delivery_rate_multiplier) : 1
  const storeLat = Number(ss?.store_lat), storeLng = Number(ss?.store_lng)
  const hasCoords = Number.isFinite(opts.lat) && Number.isFinite(opts.lng) &&
                    Number.isFinite(storeLat) && Number.isFinite(storeLng)

  if (!hasCoords) {
    if (qualifiesFree) return 0
    return Math.max(0, Number(ss?.delivery_fee) || 0)  // flat fallback
  }

  const distanceKm = haversineKm(storeLat, storeLng, opts.lat as number, opts.lng as number)
  const estMinutes = (distanceKm / AVG_SPEED_KMH) * 60
  const rawFare = BASE_FARE + distanceKm * PER_KM + estMinutes * PER_MINUTE
  let fee = Math.ceil(rawFare * surge)
  if (fee < BASE_FARE) fee = BASE_FARE
  return qualifiesFree ? 0 : fee
}

// ── Server-side discount (unchanged logic; now fed server-priced items) ──────
async function serverCalcDiscount(
  supabase: any, promoCode: string | null, items: any[], subtotal: number
): Promise<{ amount: number; ruleId: string | null }> {
  if (!promoCode) return { amount: 0, ruleId: null }
  const code = String(promoCode).toUpperCase()
  const { data: rules, error } = await supabase
    .from('discount_rules').select('*')
    .eq('promo_code', code).eq('is_active', true)
    .lte('min_order_amount', subtotal)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .or(`starts_at.is.null,starts_at.lte.${new Date().toISOString()}`)
  if (error || !rules?.length) return { amount: 0, ruleId: null }
  const rule = rules[0]
  if (rule.max_uses != null && (rule.uses_count || 0) >= rule.max_uses) return { amount: 0, ruleId: null }

  const appliesTo = rule.applicable_to || 'all'
  const ids: string[] = Array.isArray(rule.applicable_ids) ? rule.applicable_ids : []
  let eligibleSubtotal = subtotal
  if (appliesTo !== 'all' && ids.length > 0) {
    eligibleSubtotal = items.reduce((s: number, it: any) => {
      const match =
        (appliesTo === 'product'  && ids.includes(it.product_id || it.id)) ||
        (appliesTo === 'category' && ids.includes(it.category_id))
      return match ? s + (Number(it.price) || 0) * (Number(it.qty || it.quantity) || 1) : s
    }, 0)
    if (eligibleSubtotal === 0) return { amount: 0, ruleId: null }
  }
  let amount = 0
  const t = rule.discount_type
  if (t === 'percent' || t === 'percentage') amount = eligibleSubtotal * (rule.discount_value / 100)
  else if (t === 'fixed') amount = rule.discount_value
  else if (t === 'free_delivery') amount = 0
  if (rule.max_discount_cap != null) amount = Math.min(amount, rule.max_discount_cap)
  return { amount: round2(amount), ruleId: rule.id }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json()
    const {
      customer_name, customer_phone, delivery_address, delivery_zone, delivery_zone_id,
      promo_code, payment_method, receipt_url, notes, items,
      telegram_user_id, telegram_chat_id, delivery_lat, delivery_lng,
      session_token, quote_id,
    } = body

    if (!customer_name || !items?.length) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const SB = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // ── Resolve the owning account from the custom session token (never the browser).
    let orderOwnerId: string | null = null
    if (session_token) {
      const { data: vs } = await SB.rpc('validate_customer_session', { p_token: session_token })
      if (vs && vs.valid === true && vs.customer_id) orderOwnerId = vs.customer_id
    }

    // ── Authoritative money: server subtotal → fee → discount → total.
    const { subtotal: serverSubtotal, pricedItems } = await serverCalcSubtotal(SB, items)

    const { data: ss } = await SB.from('store_settings')
      .select('store_lat, store_lng, delivery_rate_multiplier, delivery_fee, free_delivery_min, free_delivery_enabled, telegram_bot_token, telegram_chat_id, crypto_enabled, crypto_usdt_address, crypto_usdt_network')
      .limit(1).single()

    // ── Delivery-fee authority: canonical quote path vs legacy recompute ──────
    // Canonical: a valid quote_id. The customer already saw this quote's fee
    // (quote_delivery is the single display source); it is the ONLY authority.
    // We read fee_centavos ONLY to build the order total — place_customer_order
    // independently re-reads, atomically CLAIMS, validates (subtotal / mode /
    // destination / operator) and BINDS the same delivery_quotes row, ignoring
    // any browser-supplied fee, so the saved fee equals the displayed fee by
    // construction. A non-existent / expired / consumed / subtotal-, mode-,
    // dest- or zone-mismatched quote raises P0004 → 409 quote_invalid below.
    //
    // Presence rules: the legacy server recompute is allowed ONLY when quote_id
    // is COMPLETELY ABSENT (undefined / null) — an old cached bundle from before
    // the quote switch (removed at the strict-enforcement rollout step). A PRESENT
    // quote_id must be a well-formed uuid; anything malformed is REJECTED with 409
    // quote_invalid and never silently recomputed with a second engine.
    const quoteProvided = quote_id !== undefined && quote_id !== null
    const quoteId = quoteProvided ? String(quote_id).trim() : ''
    const wellFormedQuote = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(quoteId)

    if (quoteProvided && !wellFormedQuote) {
      // A quote_id was supplied but is not a valid id — do NOT fall back to a
      // second delivery calculation; force the client to re-quote.
      return new Response(JSON.stringify({ error: 'quote_invalid', reason: 'malformed_quote_id' }), {
        status: 409, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }
    const hasQuote = quoteProvided && wellFormedQuote

    let effectiveFee: number
    if (hasQuote) {
      // The fee that feeds finalTotal and the USDT snapshot comes from the
      // quote row and ONLY the quote row. Three outcomes, none of which may
      // collapse into a silent ₱0: a failed read is a retryable 503 (the DB
      // said nothing — do not guess a fee, do not touch the RPC), a missing
      // row is a 409 re-quote signal, and a present row must carry a finite,
      // non-negative fee_centavos — 0 itself is legitimate (free delivery).
      // place_customer_order re-reads and binds this same row inside its own
      // transaction, so the fee used for payment math here and the fee saved
      // there can only agree — or the order is rejected. Never diverge.
      const { data: q, error: qErr } = await SB.from('delivery_quotes')
        .select('fee_centavos').eq('id', quoteId).maybeSingle()
      if (qErr) {
        // Sanitised technical log only — no customer data, no payload echo.
        console.error('place-order quote lookup failed:', (qErr as any).code || '', qErr.message || 'unknown')
        return new Response(JSON.stringify({ error: 'quote_lookup_failed' }), {
          status: 503, headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }
      if (!q) {
        return new Response(JSON.stringify({ error: 'quote_invalid', reason: 'missing' }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }
      const feeCentavos = Number(q.fee_centavos)
      if (!Number.isFinite(feeCentavos) || feeCentavos < 0) {
        console.error('place-order quote fee invalid:', String(q.fee_centavos))
        return new Response(JSON.stringify({ error: 'quote_invalid', reason: 'fee_invalid' }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }
      effectiveFee = feeCentavos / 100
    } else {
      effectiveFee = await serverCalcDeliveryFee(SB, ss, {
        zoneId: delivery_zone_id || null,
        lat: delivery_lat != null ? Number(delivery_lat) : null,
        lng: delivery_lng != null ? Number(delivery_lng) : null,
        subtotal: serverSubtotal,
      })
    }

    const serverDiscount = await serverCalcDiscount(SB, promo_code, pricedItems, serverSubtotal)
    const finalTotal = Math.max(0, round2(serverSubtotal + effectiveFee - serverDiscount.amount))

    // ── USDT: price the order server-side and build the authoritative snapshot.
    //    Done BEFORE the order row is created so a USDT order we cannot price is
    //    rejected cleanly (no orphan / no bogus snapshot). The crypto fee (PR 2)
    //    is a surcharge on the USDT amount only — it is deliberately NOT added to
    //    orders.total, so the ledger shape (total = subtotal + delivery − discount)
    //    is untouched.
    let cryptoSnapshot: Record<string, unknown> | null = null
    if ((payment_method || '') === 'usdt') {
      if (!ss?.crypto_enabled || !ss?.crypto_usdt_address) {
        return new Response(JSON.stringify({ error: 'USDT payments are not available right now. Please choose another payment method.' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }
      const marketRate = await fetchUsdtPhpRate()
      // PR 1: checkout_rate = market_rate (PR 2 adds the signed owner adjustment).
      const checkoutRate = marketRate
      if (checkoutRate == null || !(checkoutRate > 0)) {
        return new Response(JSON.stringify({ error: 'Unable to calculate the USDT amount right now. Please try again in a moment or choose another payment method.' }), {
          status: 503, headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }
      const cryptoFeePhp = 0                                   // PR 2 wires the configurable fee
      const cryptoPhpDue = round2(finalTotal + cryptoFeePhp)
      const usdtDue = ceil2(cryptoPhpDue / checkoutRate)
      if (!(usdtDue > 0)) {
        return new Response(JSON.stringify({ error: 'Unable to calculate the USDT amount right now. Please try again in a moment or choose another payment method.' }), {
          status: 503, headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }
      cryptoSnapshot = {
        v: 1,
        payment_method: 'usdt',
        network: ss?.crypto_usdt_network || null,
        subtotal: serverSubtotal,
        delivery_fee: effectiveFee,
        discount: serverDiscount.amount,
        final_php_total: finalTotal,
        market_rate: marketRate,
        owner_adjustment: 0,                                   // PR 2
        checkout_rate: checkoutRate,
        crypto_fee_php: cryptoFeePhp,                          // PR 2
        crypto_php_due: cryptoPhpDue,
        usdt_due: usdtDue,
        rounding: 'ceil_2dp',
        rate_source: 'crypto-rate',
        rate_timestamp: new Date().toISOString(),
      }
    }

    const payload = {
      customer_name,
      customer_phone: customer_phone || null,
      delivery_address: delivery_address || null,
      delivery_zone: delivery_zone || null,
      delivery_zone_id: delivery_zone_id || null,   // forwarded so the RPC can bind a zone-mode quote
      // Quote path: display / back-compat only — place_customer_order binds the
      // fee from the claimed quote and ignores this. Legacy path: authoritative.
      delivery_fee: String(effectiveFee),
      subtotal: String(serverSubtotal),
      total: String(finalTotal),
      discount_amount: String(serverDiscount.amount),
      promo_code: promo_code || null,
      payment_method: payment_method || null,
      receipt_url: receipt_url || null,
      notes: notes || null,
      items: pricedItems,
      order_owner_id: orderOwnerId,                       // resolved server-side; null for guests
      telegram_user_id: telegram_user_id ? String(telegram_user_id) : null,
      telegram_chat_id: telegram_chat_id ? String(telegram_chat_id) : null,
      delivery_lat: delivery_lat != null ? String(delivery_lat) : null,
      delivery_lng: delivery_lng != null ? String(delivery_lng) : null,
      // Enables the RPC's quote-consumption fork. null/blank → legacy branch.
      quote_id: hasQuote ? quoteId : null,
    }

    const { data: rpcResult, error: rpcErr } = await SB.rpc('place_customer_order', { payload })

    if (rpcErr) {
      const code = (rpcErr as any).code || ''
      const msg = rpcErr.message || 'Order failed'
      // P0004 = quote_invalid (missing / expired / consumed / subtotal-, mode-,
      // dest- or operator-mismatch). The storefront's 409 handler keys on the
      // EXACT string 'quote_invalid' to clear the quote, re-quote once, and ask
      // the customer to confirm the refreshed fee — so return that literally,
      // with the specific reason alongside for logs/telemetry. No order exists.
      if (code === 'P0004') {
        console.error('place-order quote rejected:', msg)
        return new Response(JSON.stringify({ error: 'quote_invalid', reason: msg, code }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' }
        })
      }
      let status = 500
      if (code === 'P0001') status = 400
      else if (code === 'P0002' || code === 'P0003') status = 409
      console.error('place-order RPC error:', code, msg)
      return new Response(JSON.stringify({ error: msg, code }), {
        status, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const orderId = rpcResult?.order_id
    const orderNumber = rpcResult?.order_number

    // Stamp the USDT snapshot onto the freshly created order. place_customer_order
    // owns the insert (stock lock/decrement) and carries no crypto fields, so the
    // snapshot is written with a follow-up service-role update. orders.total and
    // every ledger-shaped column are left exactly as the RPC set them. Later
    // store_settings changes never recompute this — the snapshot is frozen here.
    if (cryptoSnapshot && orderId) {
      const { error: snapErr } = await SB.from('orders')
        .update({ crypto_snapshot: cryptoSnapshot }).eq('id', orderId)
      if (snapErr) console.error('place-order: crypto_snapshot update failed (non-fatal):', snapErr.message)
    }

    if (serverDiscount.ruleId) {
      SB.rpc('increment_discount_uses', { p_rule_id: serverDiscount.ruleId }).then().catch(console.error)
    }

    // ── Telegram owner alert ────────────────────────────────────────────
    try {
      const token = (ss?.telegram_bot_token || ENV_TG_TOKEN || '').trim()
      const ownerChat = (ss?.telegram_chat_id || ENV_TG_OWNER || '').trim()
      if (token && ownerChat) {
        const orderRef = orderNumber ? `\n_Order ${orderNumber}_` : ''
        const msg = `🔔 New order received from *${customer_name}*${orderRef}`
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ownerChat, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true,
          })
        })
      }
    } catch (e) {
      console.error('Telegram owner alert failed (non-fatal):', e)
    }

    return new Response(
      JSON.stringify({ success: true, order_number: orderNumber || orderId, order_id: orderId, total: finalTotal }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (err: any) {
    console.error('place-order error:', err)
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})
