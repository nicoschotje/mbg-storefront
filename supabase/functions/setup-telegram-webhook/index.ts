// setup-telegram-webhook — KEEP-as-is port for mrbeanies-prod (P2).
// Run with ?action=set (default) once TELEGRAM_BOT_TOKEN is configured; or
// ?action=info / ?action=delete to inspect / remove the webhook.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    if (!TELEGRAM_BOT_TOKEN) {
      return new Response(JSON.stringify({ error: 'No TELEGRAM_BOT_TOKEN set' }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const url = new URL(req.url)
    const action = url.searchParams.get('action') || 'set'

    if (action === 'info') {
      const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`)
      const data = await resp.json()
      return new Response(JSON.stringify(data, null, 2), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    if (action === 'delete') {
      const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`)
      const data = await resp.json()
      return new Response(JSON.stringify(data, null, 2), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
      })
    }

    const webhookUrl = `${SUPABASE_URL}/functions/v1/telegram-webhook`

    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message'],
        drop_pending_updates: true
      })
    })
    const data = await resp.json()

    const meResp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`)
    const meData = await meResp.json()

    return new Response(JSON.stringify({
      webhook_set: data, bot_info: meData, webhook_url: webhookUrl
    }, null, 2), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }
})
