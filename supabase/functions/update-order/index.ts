// update-order — P3 cleanup: replace hardcoded ADMIN_KEY constant with env var.
// Either:
//   (a) Caller sends x-admin-key header matching the UPDATE_ORDER_ADMIN_KEY secret, OR
//   (b) Caller sends x-admin-secret / x-admin-token that satisfies is_admin() RPC.
// Either path is sufficient. Set UPDATE_ORDER_ADMIN_KEY to a long random value
// in Project Settings → Edge Functions → Secrets and rotate when needed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const UPDATE_ORDER_ADMIN_KEY = Deno.env.get('UPDATE_ORDER_ADMIN_KEY') || ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key, x-admin-secret, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // ── Authn paths ──
  // Path A: legacy header x-admin-key matches the configured secret
  const presentedKey = req.headers.get('x-admin-key') || ''
  const keyAuthOK = UPDATE_ORDER_ADMIN_KEY.length >= 16 && presentedKey === UPDATE_ORDER_ADMIN_KEY

  // Path B: is_admin() RPC — forwards x-admin-secret / x-admin-token from the caller.
  // Cheap to call (STABLE SECURITY DEFINER, single row lookup).
  const forwardClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    global: {
      headers: {
        'x-admin-secret': req.headers.get('x-admin-secret') || '',
        'x-admin-token':  req.headers.get('x-admin-token')  || '',
      }
    }
  })
  // NOTE: is_admin() reads request.headers via current_setting. Service-role client
  // doesn't forward those by default; pass them through with rpc 'headers' option.
  let rpcAuthOK = false
  if (!keyAuthOK) {
    const { data: isAdmin } = await forwardClient.rpc('is_admin')
    rpcAuthOK = Boolean(isAdmin)
  }

  if (!keyAuthOK && !rpcAuthOK) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  try {
    const { order_id, status, payment_status } = await req.json()
    if (!order_id || !status) throw new Error('order_id and status required')

    const update: any = { order_status: status }
    if (payment_status) update.payment_status = payment_status

    const { data: order, error } = await supabase
      .from('orders')
      .update(update)
      .eq('id', order_id)
      .select()
      .single()

    if (error) throw error

    sendStatusTelegram(supabase, order, status).catch(console.error)

    return new Response(
      JSON.stringify({ success: true, order }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})

async function sendStatusTelegram(supabase: any, order: any, status: string) {
  const { data: s } = await supabase.from('store_settings').select('telegram_bot_token,telegram_chat_id').single()
  if (!s?.telegram_bot_token || !s?.telegram_chat_id) return

  const labels: any = {
    processing: '🔄 Processing',
    delivering: '🚚 Out for Delivery',
    delivered:  '✅ Delivered',
    cancelled:  '❌ Cancelled'
  }
  const label = labels[status]
  if (!label) return

  const msg = `${label}\n\n*${order.order_number}* — ${order.customer_name}\n₱${order.total}`

  await fetch(`https://api.telegram.org/bot${s.telegram_bot_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: s.telegram_chat_id, text: msg, parse_mode: 'Markdown' })
  })
}
