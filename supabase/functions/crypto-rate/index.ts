// crypto-rate — server-side USDT->PHP rate proxy for the storefront checkout.
// Removes the per-browser CoinGecko rate-limit failure (bursts return TypeError).
// Returns CoinGecko-compatible shape {"tether":{"php":<number>}} so checkout.js
// needs only a URL swap (its existing parse data?.tether?.php keeps working).
// verify_jwt=false: public read-only exchange rate, called unauthenticated by the storefront.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=30',
};

// Warm-invocation in-memory cache (best-effort; edge instances are ephemeral).
let cache: { php: number; ts: number } | null = null;
const TTL_MS = 60_000;

async function fromCoinGecko(): Promise<number | null> {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=php',
      { headers: { accept: 'application/json' } },
    );
    if (!r.ok) return null;
    const d = await r.json();
    const php = d?.tether?.php;
    return typeof php === 'number' && php > 0 ? php : null;
  } catch {
    return null;
  }
}

// Secondary source: USD->PHP (USDT is ~1:1 USD). Free, no key.
async function fromErApi(): Promise<number | null> {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!r.ok) return null;
    const d = await r.json();
    const php = d?.rates?.PHP;
    return typeof php === 'number' && php > 0 ? php : null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) {
    return json({ tether: { php: cache.php }, cached: true });
  }

  let php = await fromCoinGecko();
  if (php == null) php = await fromErApi();

  if (php != null) {
    cache = { php, ts: now };
    return json({ tether: { php } });
  }

  // Both sources failed — serve last known good rather than an empty box.
  if (cache) return json({ tether: { php: cache.php }, stale: true });

  return json({ error: 'rate_unavailable' }, 503);
});
