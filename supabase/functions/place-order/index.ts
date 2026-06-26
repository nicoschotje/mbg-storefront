// place-order — MBG Tier 2 Phase 1 (Milestone 1)
//
// Changes vs the previous version:
//  * Account ownership: the storefront passes its CUSTOM session token
//    (`session_token`). We resolve the owning account SERVER-SIDE via the
//    validate_customer_session RPC and stamp it as orders.order_owner_id.
//    The browser never supplies an owner id. customer_name/customer_phone are
//    recipient/contact only.
//  * Server-side total authority: subtotal is recomputed from items × current
//    DB prices (variant price_override ?? product price); the delivery fee is
//    recomputed from the zone / distance using authoritative store_settings;
//    the discount is recomputed (as before) against the server subtotal; and
//    the order total is derived from those server figures. Browser-supplied
//    subtotal/delivery_fee/total are no longer trusted.
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
      session_token,
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
      .select('store_lat, store_lng, delivery_rate_multiplier, delivery_fee, free_delivery_min, free_delivery_enabled, telegram_bot_token, telegram_chat_id')
      .limit(1).single()

    const serverFee = await serverCalcDeliveryFee(SB, ss, {
      zoneId: delivery_zone_id || null,
      lat: delivery_lat != null ? Number(delivery_lat) : null,
      lng: delivery_lng != null ? Number(delivery_lng) : null,
      subtotal: serverSubtotal,
    })

    const serverDiscount = await serverCalcDiscount(SB, promo_code, pricedItems, serverSubtotal)
    const finalTotal = Math.max(0, round2(serverSubtotal + serverFee - serverDiscount.amount))

    const payload = {
      customer_name,
      customer_phone: customer_phone || null,
      delivery_address: delivery_address || null,
      delivery_zone: delivery_zone || null,
      delivery_fee: String(serverFee),
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
    }

    const { data: rpcResult, error: rpcErr } = await SB.rpc('place_customer_order', { payload })

    if (rpcErr) {
      const code = (rpcErr as any).code || ''
      const msg = rpcErr.message || 'Order failed'
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
