// telegram-intelligence-alerts — KEEP-as-is port for mrbeanies-prod (P2).
// Sends VIP/dormant/discount/churn/rising/summary alerts to the admin Telegram chat.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: settings, error: settingsError } = await supabase
      .from('store_settings')
      .select('telegram_bot_token, telegram_chat_id')
      .limit(1)
      .single();

    if (settingsError || !settings?.telegram_bot_token || !settings?.telegram_chat_id) {
      return new Response(JSON.stringify({ error: 'Telegram not configured in store_settings' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const botToken = settings.telegram_bot_token;
    const adminChatId = settings.telegram_chat_id;

    let alertType = 'all';
    try {
      const body = await req.json();
      alertType = body?.alert_type || 'all';
    } catch { /* default to all */ }

    const { data: intelligence, error: intError } = await supabase
      .from('mbg_client_intelligence')
      .select(`*, client:mbg_clients!inner(name, telegram_id, telegram_chat_id, phone)`)
      .gt('lifetime_order_count', 0);

    if (intError) throw intError;
    if (!intelligence || intelligence.length === 0) {
      return new Response(JSON.stringify({ message: 'No intelligence data to alert on' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const messages: string[] = [];

    const vipDormant = intelligence.filter((i: any) =>
      ['crown', 'whale'].includes(i.lifetime_tier) &&
      ['dormant', 'churned'].includes(i.recent_tier)
    );
    if (vipDormant.length > 0 && (alertType === 'all' || alertType === 'vip_dormant')) {
      let msg = '🚨 *VIP GONE DORMANT*\n\n';
      for (const v of vipDormant) {
        const name = v.client?.name || 'Unknown';
        msg += `• *${name}* — ${v.lifetime_tier.toUpperCase()}\n`;
        msg += `  ₱${Number(v.lifetime_spend).toLocaleString()} lifetime · ${v.days_since_last_order}d inactive\n`;
        msg += `  ➡️ Action: Personal outreach NOW\n\n`;
      }
      messages.push(msg);
    }

    const reactivate = intelligence.filter((i: any) => i.action_tag === 'reactivate_now');
    if (reactivate.length > 0 && (alertType === 'all' || alertType === 'reactivate')) {
      let msg = '🔄 *REACTIVATION NEEDED*\n\n';
      for (const r of reactivate) {
        const name = r.client?.name || 'Unknown';
        msg += `• *${name}* — ${r.days_since_last_order}d since last order\n`;
        msg += `  Tier: ${r.lifetime_tier} · ₱${Number(r.lifetime_spend).toLocaleString()} lifetime\n\n`;
      }
      messages.push(msg);
    }

    const rising = intelligence.filter((i: any) => i.spend_trend === 'rising');
    if (rising.length > 0 && (alertType === 'all' || alertType === 'rising')) {
      let msg = '📈 *RISING CLIENTS*\n\n';
      for (const r of rising) {
        const name = r.client?.name || 'Unknown';
        msg += `• *${name}* — spend trending UP ↑\n`;
        msg += `  30d: ₱${Number(r.recent_30d_spend).toLocaleString()} · ${r.recent_30d_order_count} orders\n\n`;
      }
      messages.push(msg);
    }

    const discountAbuse = intelligence.filter((i: any) => Number(i.lifetime_discount_ratio) > 0.25);
    if (discountAbuse.length > 0 && (alertType === 'all' || alertType === 'discount_abuse')) {
      let msg = '⚠️ *DISCOUNT ABUSE DETECTED*\n\n';
      for (const d of discountAbuse) {
        const name = d.client?.name || 'Unknown';
        const ratio = (Number(d.lifetime_discount_ratio) * 100).toFixed(1);
        msg += `• *${name}* — ${ratio}% discount ratio\n`;
        msg += `  ₱${Number(d.lifetime_total_discounts).toLocaleString()} in total discounts\n\n`;
      }
      messages.push(msg);
    }

    const churnRisk = intelligence.filter((i: any) =>
      i.inactivity_risk === 'critical' && i.lifetime_order_count > 0
    );
    if (churnRisk.length > 0 && (alertType === 'all' || alertType === 'churn_risk')) {
      let msg = '🔴 *CHURN RISK CRITICAL*\n\n';
      for (const c of churnRisk) {
        const name = c.client?.name || 'Unknown';
        msg += `• *${name}* — ${c.days_since_last_order}d inactive\n`;
        msg += `  Was: ₱${Number(c.lifetime_spend).toLocaleString()} / ${c.lifetime_order_count} orders\n\n`;
      }
      messages.push(msg);
    }

    if (alertType === 'all' || alertType === 'summary') {
      const totalRevenue = intelligence.reduce((s: number, i: any) => s + Number(i.lifetime_spend || 0), 0);
      const totalClients = intelligence.length;
      const activeClients = intelligence.filter((i: any) => ['hot', 'active'].includes(i.recent_tier)).length;
      const atRisk = intelligence.filter((i: any) => ['high', 'critical'].includes(i.inactivity_risk)).length;

      const tierCounts: Record<string, number> = {};
      for (const i of intelligence) {
        tierCounts[i.lifetime_tier] = (tierCounts[i.lifetime_tier] || 0) + 1;
      }

      let msg = '📊 *MBG DAILY INTELLIGENCE SUMMARY*\n\n';
      msg += `👥 Total Clients: *${totalClients}*\n`;
      msg += `₱ Total Revenue: *₱${totalRevenue.toLocaleString()}*\n`;
      msg += `✅ Active Now: *${activeClients}*\n`;
      msg += `⚠️ At Risk: *${atRisk}*\n\n`;
      msg += `*Tier Breakdown:*\n`;
      for (const [tier, count] of Object.entries(tierCounts)) {
        const emoji = tier === 'crown' ? '👑' : tier === 'whale' ? '🐳' : tier === 'steady' ? '⭐' : tier === 'frequent_small' ? '🛒' : '⚠️';
        msg += `${emoji} ${tier}: ${count}\n`;
      }
      msg += `\n📅 ${new Date().toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' })}`;
      messages.push(msg);
    }

    const sendResults: any[] = [];
    for (const msg of messages) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: adminChatId,
            text: msg,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
          })
        });
        const result = await res.json();
        sendResults.push({ success: result.ok, message_id: result.result?.message_id });
      } catch (e) {
        sendResults.push({ success: false, error: String(e) });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      alerts_sent: messages.length,
      results: sendResults,
      alert_type: alertType,
      timestamp: new Date().toISOString()
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Telegram alert error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
