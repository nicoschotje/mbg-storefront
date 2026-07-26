// notify-customer — P3 patch: read bot token from store_settings first,
// fall back to Deno.env. Keeps the minimal status line per spec.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ENV_TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const STATUS_DISPLAY: Record<string, string> = {
  new:              'pending payment',
  pending:          'pending payment',
  confirmed:        'confirmed',
  preparing:        'being prepared',
  out_for_delivery: 'out for delivery',
  completed:        'completed',
  cancelled:        'cancelled',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { order_id, new_status, custom_message } = await req.json()
    if (!order_id || !new_status) {
      return new Response(JSON.stringify({ error: 'order_id and new_status required' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const SB = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { data: order, error } = await SB.from('orders').select('*').eq('id', order_id).single()
    if (error || !order) throw new Error('Order not found')

    // Token resolution: store_settings first, then env. Lets the dashboard
    // Settings UI manage Telegram without anyone needing to touch Supabase secrets.
    const { data: s } = await SB.from('store_settings')
      .select('telegram_bot_token').limit(1).single()
    const TOKEN = (s?.telegram_bot_token || ENV_TG_TOKEN || '').trim()

    if (!TOKEN) {
      return new Response(
        JSON.stringify({ success: true, notified: false, reason: 'No bot token configured' }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    if (!order.telegram_chat_id) {
      return new Response(
        JSON.stringify({ success: true, notified: false, reason: 'No customer Telegram ID on this order' }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    const display = STATUS_DISPLAY[new_status] || new_status
    const name = (order.customer_name || 'there').toString().split(/\s+/)[0]
    const msg = custom_message || `Hi ${name}, your order is now ${display}.`

    const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: order.telegram_chat_id,
        text: msg,
        disable_web_page_preview: true,
      })
    })
    const tgData = await tgRes.json()

    if (!tgData.ok && tgData.error_code === 403) {
      return new Response(
        JSON.stringify({
          success: true,
          notified: false,
          reason: 'Customer has not started a private chat with the bot.'
        }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ success: true, notified: tgData.ok }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
    )

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})
