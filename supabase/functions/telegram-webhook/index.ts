// telegram-webhook — KEEP-as-is port for mrbeanies-prod (P2). Handles /start + /status
// from customers. P3 may simplify the welcome text but the linking behaviour is correct.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function sendTgMessage(chatId: number | string, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors })

  try {
    const update = await req.json()
    const message = update?.message
    if (!message) return new Response('ok', { status: 200, headers: cors })

    const chatId = message.chat?.id
    const userId = message.from?.id
    const text = message.text || ''
    const firstName = message.from?.first_name || 'there'
    const username = message.from?.username || null

    if (!chatId) return new Response('ok', { status: 200, headers: cors })

    const SB = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    if (text.startsWith('/start')) {
      await SB.from('telegram_users').upsert({
        telegram_chat_id: String(chatId),
        telegram_user_id: String(userId),
        first_name: firstName,
        username: username,
        updated_at: new Date().toISOString()
      }, { onConflict: 'telegram_chat_id' })

      const startParam = text.replace('/start', '').trim()

      if (startParam.startsWith('order_')) {
        const orderRef = startParam.replace('order_', '')
        let order = null
        const { data: byNumber } = await SB.from('orders')
          .select('id, order_number, telegram_chat_id')
          .eq('order_number', orderRef)
          .single()
        if (byNumber) {
          order = byNumber
        } else {
          const { data: byId } = await SB.from('orders')
            .select('id, order_number, telegram_chat_id')
            .ilike('id', `${orderRef}%`)
            .single()
          if (byId) order = byId
        }

        if (order) {
          await SB.from('orders').update({
            telegram_chat_id: String(chatId),
            telegram_user_id: String(userId)
          }).eq('id', order.id)

          await sendTgMessage(chatId,
            `🍬 *Mr. Greenies* 💚\n\nHi ${firstName}! You're now connected for order *#${order.order_number || orderRef}*.\n\nYou'll receive a status message here whenever your order changes state.`
          )
        } else {
          await sendTgMessage(chatId,
            `🍬 *Welcome to Mr. Greenies!* 💚\n\nHi ${firstName}! You're all set to receive order updates here.`
          )
        }
      } else {
        await sendTgMessage(chatId,
          `🍬 *Welcome to Mr. Greenies!* 💚\n\nHi ${firstName}! After you place an order, tap *"Get Order Updates"* to link it to this chat.`
        )
      }
    }

    if (text.startsWith('/status')) {
      const { data: linkedOrders } = await SB.from('orders')
        .select('order_number, order_status, created_at')
        .eq('telegram_chat_id', String(chatId))
        .order('created_at', { ascending: false })
        .limit(3)

      if (linkedOrders && linkedOrders.length > 0) {
        const orderList = linkedOrders.map((o: any) =>
          `  • #${o.order_number} — ${o.order_status.replace(/_/g, ' ')}`
        ).join('\n')
        await sendTgMessage(chatId, `Your recent orders:\n${orderList}`)
      } else {
        await sendTgMessage(chatId, `No orders linked to this chat yet.`)
      }
    }

    return new Response('ok', { status: 200, headers: cors })

  } catch (err: any) {
    console.error('Webhook error:', err)
    return new Response('ok', { status: 200, headers: cors })
  }
})
