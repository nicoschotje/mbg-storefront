// compute-client-intelligence — KEEP-as-is port for mrbeanies-prod (P2).
// Walks every MBG client, computes lifetime + recent stats, tier + behavior + action tags,
// and upserts into mbg_client_intelligence.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json().catch(() => ({}));
    const targetClientId = body.client_id || null;

    let clientQuery = supabase.from("mbg_clients").select("*");
    if (targetClientId) clientQuery = clientQuery.eq("id", targetClientId);
    const { data: clients, error: clientsErr } = await clientQuery;
    if (clientsErr) throw clientsErr;

    if (!clients || clients.length === 0) {
      return new Response(JSON.stringify({ message: "No clients found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: allOrders, error: ordersErr } = await supabase
      .from("mbg_orders").select("*").order("order_date", { ascending: false });
    if (ordersErr) throw ordersErr;

    const orders = allOrders || [];
    const now = new Date();
    const day30 = new Date(now.getTime() - 30 * 86400000);
    const day60 = new Date(now.getTime() - 60 * 86400000);
    const day90 = new Date(now.getTime() - 90 * 86400000);

    const clientStats = clients.map((client: any) => {
      const co = orders.filter((o: any) => o.client_id === client.id);
      const ls = co.reduce((s: number, o: any) => s + Number(o.amount || 0), 0);
      const loc = co.length;
      const laov = loc > 0 ? ls / loc : 0;
      const ld = co.reduce((s: number, o: any) => s + Number(o.discount_amount || 0), 0);
      const lcogs = co.reduce((s: number, o: any) => s + Number(o.cost_of_sale || 0), 0);
      const lp = ls - ld - lcogs;
      const dr = ls > 0 ? ld / ls : 0;
      const pm = ls > 0 ? (lp / ls) * 100 : 0;

      const r30 = co.filter((o: any) => new Date(o.order_date) >= day30);
      const r30s = r30.reduce((s: number, o: any) => s + Number(o.amount || 0), 0);
      const r30c = r30.length;
      const r30a = r30c > 0 ? r30s / r30c : 0;
      const r30d = r30.reduce((s: number, o: any) => s + Number(o.discount_amount || 0), 0);
      const r30dr = r30s > 0 ? r30d / r30s : 0;

      const r60 = co.filter((o: any) => new Date(o.order_date) >= day60);
      const r60s = r60.reduce((s: number, o: any) => s + Number(o.amount || 0), 0);
      const r60c = r60.length;
      const r60a = r60c > 0 ? r60s / r60c : 0;
      const r60d = r60.reduce((s: number, o: any) => s + Number(o.discount_amount || 0), 0);

      const lastDate = co.length > 0 ? new Date(co[0].order_date) : null;
      const dsl = lastDate ? Math.floor((now.getTime() - lastDate.getTime()) / 86400000) : 999;

      const r90 = co.filter((o: any) => new Date(o.order_date) >= day90);
      const pv = r90.length / 3;

      const p30 = co.filter((o: any) => { const d = new Date(o.order_date); return d >= day60 && d < day30; });
      const p30s = p30.reduce((s: number, o: any) => s + Number(o.amount || 0), 0);
      const p30c = p30.length;

      let st = "stable";
      if (r30s > p30s * 1.2) st = "rising";
      else if (p30s > 0 && r30s < p30s * 0.8) st = "declining";

      let ft = "stable";
      if (r30c > p30c + 1) ft = "rising";
      else if (r30c < p30c - 1) ft = "declining";

      const ddo60 = r60.filter((o: any) => Number(o.discount_amount || 0) > 0).length;
      const dd = r60c > 0 ? ddo60 / r60c > 0.4 : false;

      let ir = "none";
      if (dsl > 60) ir = "critical";
      else if (dsl > 30) ir = "high";
      else if (dsl > 14) ir = "medium";
      else if (dsl > 7) ir = "low";

      return { client, ls, loc, laov, ld, lp, dr, pm, r30s, r30c, r30a, r30d, r30dr, r60s, r60c, r60a, r60d, dsl, pv, st, ft, dd, ir };
    });

    function pRank(arr: number[], v: number): number {
      if (arr.length === 0) return 0.5;
      const s = [...arr].sort((a, b) => a - b);
      const i = s.findIndex((x) => x >= v);
      return i === -1 ? 1.0 : i / s.length;
    }

    const aS = clientStats.map((c: any) => c.ls);
    const aO = clientStats.map((c: any) => c.loc);
    const aA = clientStats.map((c: any) => c.laov);
    const aM = clientStats.map((c: any) => c.pm);
    const a30S = clientStats.map((c: any) => c.r30s);
    const a30C = clientStats.map((c: any) => c.r30c);
    const a30A = clientStats.map((c: any) => c.r30a);

    const results: any[] = [];

    for (const cs of clientStats) {
      const lts = Math.round(
        (pRank(aS, cs.ls) * 0.35 + pRank(aO, cs.loc) * 0.20 + pRank(aA, cs.laov) * 0.15 +
         pRank(aM, cs.pm) * 0.20 + (1 - cs.dr) * 0.10) * 100
      );
      const invD = cs.dsl > 0 ? Math.max(0, 1 - cs.dsl / 90) : 1;
      const rts = Math.round(
        (pRank(a30S, cs.r30s) * 0.30 + pRank(a30C, cs.r30c) * 0.25 + pRank(a30A, cs.r30a) * 0.15 +
         invD * 0.20 + (1 - cs.r30dr) * 0.10) * 100
      );
      const aovP = pRank(aA, cs.laov);
      let lt = "frequent_small";
      if (lts >= 85 && cs.dr < 0.10) lt = "crown";
      else if (aovP >= 0.9 && cs.loc < 12 && cs.dr < 0.15) lt = "whale";
      else if (lts >= 50 && cs.dr >= 0.25) lt = "high_volume_low_margin";
      else if (lts >= 40 && lts < 70 && cs.dr < 0.15) lt = "steady";
      else if (aovP < 0.3 && cs.loc >= 24) lt = "frequent_small";
      else if (lts < 30 && cs.dr >= 0.30) lt = "margin_drainer";
      else if (lts >= 70) lt = "crown";
      else if (lts >= 40) lt = "steady";

      let rt = "active";
      if (cs.r30c >= 5 || cs.r30s > cs.laov * 2) rt = "hot";
      else if (cs.r30c >= 2) rt = "active";
      else if (cs.r30c === 1) rt = "cooling";
      else if (cs.dsl <= 60) rt = "dormant";
      else rt = "churned";

      let bt = "frequent_small", bd = "Regular small purchases";
      if (lt === "crown") { bt = "full_price_loyalist"; bd = "Consistently purchases at full price with high loyalty"; }
      else if (lt === "whale") { bt = "strategic_whale"; bd = "Large infrequent purchases, strategic buying pattern"; }
      else if (cs.dr >= 0.25 && cs.loc >= 10) { bt = "bulk_bargainer"; bd = "High volume buyer who consistently negotiates discounts"; }
      else if (cs.dr >= 0.30) { bt = "discount_hunter"; bd = "Primarily buys during promotions or with discounts"; }
      else if (lt === "margin_drainer") { bt = "margin_drainer"; bd = "Low spend, high discount ratio, negative profit contribution"; }

      let at = "maintain";
      if (["crown", "whale"].includes(lt) && ["dormant", "churned"].includes(rt)) at = "reactivate_now";
      else if (["crown", "whale"].includes(lt) && ["active", "hot"].includes(rt)) at = "priority_service";
      else if (lt === "steady" && rt === "hot") at = "upsell_opportunity";
      else if (lt === "frequent_small" && ["active", "hot"].includes(rt)) at = "upsell_opportunity";
      else if (lt === "high_volume_low_margin") at = "discount_control";
      else if (lt === "margin_drainer") at = "do_not_chase";
      else if (rt === "churned" && lts < 40) at = "low_priority";
      else if (cs.st === "rising") at = "upsell_opportunity";

      const clientName = cs.client.client_name || cs.client.name || 'Unknown';

      const record = {
        client_id: cs.client.id,
        client_name: clientName,
        telegram_id: cs.client.telegram_id,
        telegram_username: cs.client.telegram_username || cs.client.telegram_id,
        lifetime_spend: cs.ls, lifetime_order_count: cs.loc, lifetime_aov: cs.laov,
        lifetime_total_discounts: cs.ld, lifetime_discount_ratio: cs.dr,
        lifetime_total_profit: cs.lp, profit_margin: cs.pm,
        recent_30d_spend: cs.r30s, recent_30d_order_count: cs.r30c, recent_30d_aov: cs.r30a,
        recent_30d_discounts: cs.r30d, recent_30d_discount_ratio: cs.r30dr,
        recent_60d_spend: cs.r60s, recent_60d_order_count: cs.r60c, recent_60d_aov: cs.r60a,
        recent_60d_discounts: cs.r60d,
        days_since_last_order: cs.dsl, purchase_velocity: cs.pv,
        spend_trend: cs.st, frequency_trend: cs.ft,
        discount_dependency: cs.dd, inactivity_risk: cs.ir,
        lifetime_tier_score: lts, recent_tier_score: rts,
        lifetime_score: lts, recent_score: rts,
        lifetime_tier: lt, recent_tier: rt,
        behavior_tag: bt, behavior_tag_description: bd, action_tag: at,
        last_computed_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("mbg_client_intelligence").upsert(record, { onConflict: "client_id" });
      if (error) console.error("Upsert error:", clientName, error);
      results.push({ client: clientName, tier: lt, action: at, score: lts });
    }

    return new Response(
      JSON.stringify({ success: true, computed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
