// import-sheets-data — KEEP-as-is port for mrbeanies-prod (P2).
// NOTE for P3: existing function writes to mbg_import_log.import_source but the table
// column is mbg_import_log.source. This was a latent bug on the old project too
// (mbg_import_log has 0 rows there). Fix the column name in P3 cleanup.
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

    const { data: importData, source } = await req.json();

    if (!Array.isArray(importData) || importData.length === 0) {
      return new Response(JSON.stringify({ error: "No data provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: logEntry } = await supabase
      .from("mbg_import_log")
      .insert({ source: source || "manual", row_count: importData.length, status: "processing" })
      .select()
      .single();

    let importedCount = 0;
    const errors: string[] = [];

    for (const row of importData) {
      try {
        const clientName = row.client_name || row.name || "Unknown";
        let clientId = row.client_id;

        if (!clientId) {
          const { data: existing } = await supabase
            .from("mbg_clients")
            .select("id")
            .eq("client_name", clientName)
            .maybeSingle();

          if (existing) {
            clientId = existing.id;
          } else {
            const { data: existing2 } = await supabase
              .from("mbg_clients")
              .select("id")
              .eq("name", clientName)
              .maybeSingle();

            if (existing2) {
              clientId = existing2.id;
            } else {
              const { data: newClient, error: clientErr } = await supabase
                .from("mbg_clients")
                .insert({
                  name: clientName,
                  client_name: clientName,
                  telegram_id: row.telegram_id || null,
                  telegram_username: row.telegram_username || null,
                  source: 'sheets_import'
                })
                .select()
                .single();
              if (clientErr) { errors.push(`Client create error for ${clientName}: ${clientErr.message}`); continue; }
              clientId = newClient?.id;
            }
          }
        }

        if (!clientId) { errors.push(`No client_id for ${clientName}`); continue; }

        if (row.order_date && row.amount) {
          await supabase.from("mbg_orders").insert({
            client_id: clientId,
            order_date: row.order_date,
            amount: parseFloat(row.amount) || 0,
            discount_amount: parseFloat(row.discount_amount) || 0,
            cost_of_sale: parseFloat(row.cost_of_sale) || 0,
            order_type: row.order_type || "standard",
            status: row.status || "completed",
          });
        }

        if (row.lifetime_tier || row.lifetime_spend) {
          const ls = parseFloat(row.lifetime_spend) || 0;
          const loc = parseInt(row.lifetime_order_count) || 0;
          const ldr = parseFloat(row.lifetime_discount_ratio) || 0;
          const pm = parseFloat(row.profit_margin) || 0;

          const { error: upsertErr } = await supabase.from("mbg_client_intelligence").upsert({
            client_id: clientId,
            client_name: clientName,
            telegram_id: row.telegram_id || null,
            telegram_username: row.telegram_username || null,
            lifetime_spend: ls,
            lifetime_order_count: loc,
            lifetime_aov: loc > 0 ? ls / loc : 0,
            lifetime_total_discounts: ls * ldr,
            lifetime_discount_ratio: ldr,
            lifetime_total_profit: ls * (pm / 100),
            profit_margin: pm,
            lifetime_tier: row.lifetime_tier || "frequent_small",
            recent_tier: row.recent_tier || "active",
            behavior_tag: row.behavior_tag || "frequent_small",
            behavior_tag_description: row.behavior_tag_description || null,
            action_tag: row.action_tag || "maintain",
            spend_trend: row.spend_trend || "stable",
            frequency_trend: row.frequency_trend || "stable",
            inactivity_risk: row.inactivity_risk || "none",
            discount_dependency: row.discount_dependency === true || row.discount_dependency === "true",
            purchase_velocity: parseFloat(row.purchase_velocity) || 0,
            days_since_last_order: parseInt(row.days_since_last_order) || 0,
            lifetime_tier_score: parseInt(row.lifetime_tier_score) || 0,
            recent_tier_score: parseInt(row.recent_tier_score) || 0,
            lifetime_score: parseInt(row.lifetime_tier_score) || 0,
            recent_score: parseInt(row.recent_tier_score) || 0,
            last_computed_at: new Date().toISOString(),
          }, { onConflict: "client_id" });

          if (upsertErr) {
            errors.push(`Intelligence upsert error for ${clientName}: ${upsertErr.message}`);
          }
        }

        importedCount++;
      } catch (rowErr) {
        errors.push(`Row error: ${String(rowErr)}`);
      }
    }

    if (logEntry) {
      await supabase
        .from("mbg_import_log")
        .update({ status: errors.length > 0 ? "completed_with_errors" : "success", row_count: importedCount })
        .eq("id", logEntry.id);
    }

    return new Response(
      JSON.stringify({ success: true, imported: importedCount, errors: errors.length > 0 ? errors : undefined }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
