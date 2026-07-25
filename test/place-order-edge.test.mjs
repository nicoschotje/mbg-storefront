// Exercises the REAL place-order edge function (supabase/functions/place-order/
// index.ts) under Node via the edge stub loader. Locks the MG-563 review fix:
// the quote lookup can never collapse into a silent ₱0 fee — a failed read is
// a retryable 503 with NO RPC call and NO payment snapshot, a missing row is a
// 409 re-quote, fee_centavos must be finite and non-negative (0 = legitimate
// free delivery), and a browser-supplied delivery_fee never reaches any total.
// Run: node --experimental-strip-types --import ./test/edge-register.mjs ./test/place-order-edge.test.mjs
import assert from 'node:assert/strict';

// ── Deno/fetch shims (BEFORE importing the module: env is read at load time) ──
globalThis.Deno = {
  env: { get: (k) => ({
    SUPABASE_URL: 'http://edge-test.local',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  }[k] || '') },
};
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (String(url).includes('/functions/v1/crypto-rate')) {
    return { ok: true, json: async () => ({ tether: { php: 61.44 } }) };
  }
  return { ok: true, json: async () => ({}) };
};

await import('../supabase/functions/place-order/index.ts');
const handler = globalThis.__edgeHandler;
assert.ok(handler, 'serve() handler captured');

let pass = 0;
const ok = (msg) => { console.log('  ✓ ' + msg); pass++; };

// ── Scripted Supabase mock ───────────────────────────────────────────────────
// Every query chain the function builds is thenable and resolves to the result
// scripted for its table; every call is recorded for the no-RPC assertions.
const PRODUCT = { id: '11111111-1111-4111-8111-111111111111', price: 1000, is_active: true };
const STORE_SETTINGS = {
  store_lat: 14.6007, store_lng: 121.0827, delivery_rate_multiplier: 1,
  delivery_fee: 379, free_delivery_min: 0, free_delivery_enabled: false,
  telegram_bot_token: null, telegram_chat_id: null,
  crypto_enabled: false, crypto_usdt_address: null, crypto_usdt_network: null,
};
function makeSB({ quotes, settings = STORE_SETTINGS, rpcResult } = {}) {
  const calls = { rpc: [], tables: [], updates: [] };
  const sb = {
    calls,
    rpc(name, args) {
      calls.rpc.push({ name, args });
      if (name === 'place_customer_order') {
        return Promise.resolve(rpcResult ?? {
          data: { success: true, order_id: 'ord-test-1', order_number: 'MG-TEST' }, error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(tableName) {
      calls.tables.push(tableName);
      const result = (() => {
        if (tableName === 'products')        return { data: [PRODUCT], error: null };
        if (tableName === 'store_settings')  return { data: settings, error: null };
        if (tableName === 'delivery_quotes') return quotes ?? { data: null, error: null };
        return { data: null, error: null };
      })();
      const chain = {
        update(patch) { calls.updates.push({ table: tableName, patch }); return chain; },
        then(res, rej) { return Promise.resolve(result).then(res, rej); },
      };
      for (const m of ['select', 'eq', 'in', 'limit', 'single', 'maybeSingle']) chain[m] = () => chain;
      return chain;
    },
  };
  return sb;
}

const QUOTE_ID = '7ffb9c25-79e6-4275-82ec-c15fd107db33';
// Every body carries a TAMPERED browser fee/subtotal/total — no test below may
// see any of these numbers surface in a total, a payload, or a snapshot.
const body = (extra = {}) => JSON.stringify({
  customer_name: 'EDGE-TEST', delivery_address: '1 Test St', delivery_zone: 'Metro Manila',
  delivery_fee: 1, subtotal: 1, total: 1,
  payment_method: 'gcash',
  items: [{ id: PRODUCT.id, quantity: 1 }],
  ...extra,
});
const post = (b) => handler(new Request('http://edge-test.local/place-order', { method: 'POST', body: b }));
const rpcPayload = (sb) => sb.calls.rpc.find(c => c.name === 'place_customer_order')?.args?.payload;

// ── 1. Valid paid quote: quoted fee drives edge total, RPC payload, response ──
console.log('CASE 1 — valid paid quote (₱415):');
{
  const sb = globalThis.__sbMock = makeSB({ quotes: { data: { fee_centavos: 41500 }, error: null } });
  const res = await post(body({ quote_id: QUOTE_ID }));
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.total, 1415);
  ok('200; edge total 1415 = server subtotal 1000 + quoted 415 (fee once)');
  const p = rpcPayload(sb);
  assert.equal(p.quote_id, QUOTE_ID);
  assert.equal(p.delivery_fee, '415');
  assert.equal(p.subtotal, '1000');
  assert.equal(p.total, '1415');
  ok('RPC payload carries quote_id and the QUOTED fee — tampered ₱1 figures nowhere');
}

// ── 2. Valid FREE-delivery quote: fee_centavos = 0 is a legitimate fee ───────
console.log('CASE 2 — valid free-delivery quote (fee_centavos = 0):');
{
  const sb = globalThis.__sbMock = makeSB({ quotes: { data: { fee_centavos: 0 }, error: null } });
  const res = await post(body({ quote_id: QUOTE_ID }));
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.total, 1000);
  const p = rpcPayload(sb);
  assert.equal(p.delivery_fee, '0');
  assert.equal(p.quote_id, QUOTE_ID);
  ok('200; zero fee accepted; total 1000; RPC gets fee 0 on the QUOTE path (not legacy)');
}

// ── 3. Quote lookup DB error: retryable 503, nothing downstream happens ──────
console.log('CASE 3 — quote lookup returns a database error:');
{
  const sb = globalThis.__sbMock = makeSB({
    quotes: { data: null, error: { code: '08006', message: 'connection failure' } },
  });
  fetchCalls.length = 0;
  const res = await post(body({ quote_id: QUOTE_ID, payment_method: 'usdt' }));
  const out = await res.json();
  assert.equal(res.status, 503);
  assert.deepEqual(out, { error: 'quote_lookup_failed' });
  ok('503 { error: "quote_lookup_failed" } — never a ₱0 fee');
  assert.equal(sb.calls.rpc.filter(c => c.name === 'place_customer_order').length, 0);
  ok('place_customer_order NOT called → no order, no stock movement');
  assert.equal(sb.calls.updates.length, 0);
  assert.equal(fetchCalls.filter(u => u.includes('crypto-rate')).length, 0);
  ok('no crypto snapshot and no USDT pricing attempted (even on a USDT order)');
}

// ── 4. Quote row missing: 409 quote_invalid/missing, nothing downstream ──────
console.log('CASE 4 — quote lookup returns no row:');
{
  const sb = globalThis.__sbMock = makeSB({ quotes: { data: null, error: null } });
  const res = await post(body({ quote_id: QUOTE_ID }));
  const out = await res.json();
  assert.equal(res.status, 409);
  assert.deepEqual(out, { error: 'quote_invalid', reason: 'missing' });
  assert.equal(sb.calls.rpc.filter(c => c.name === 'place_customer_order').length, 0);
  ok('409 { quote_invalid, missing }; no RPC call, no order, no stock change');
}

// ── 5. USDT order with a valid quote: snapshot fee == saved fee == totals ────
console.log('CASE 5 — USDT order, valid quote:');
{
  const sb = globalThis.__sbMock = makeSB({
    quotes: { data: { fee_centavos: 41500 }, error: null },
    settings: { ...STORE_SETTINGS, crypto_enabled: true, crypto_usdt_address: 'TTestAddr', crypto_usdt_network: 'TRC20' },
  });
  const res = await post(body({ quote_id: QUOTE_ID, payment_method: 'usdt' }));
  const out = await res.json();
  assert.equal(res.status, 200);
  const snap = sb.calls.updates.find(u => u.table === 'orders')?.patch?.crypto_snapshot;
  assert.ok(snap, 'crypto snapshot stamped');
  assert.equal(snap.delivery_fee, 415);
  ok('snapshot delivery_fee 415 = quoted fee = fee the RPC binds/saves');
  const p = rpcPayload(sb);
  assert.equal(snap.final_php_total, 1415);
  assert.equal(Number(p.total), 1415);
  assert.equal(out.total, 1415);
  ok('snapshot final_php_total = RPC payload total = response total = 1415');
  assert.equal(snap.usdt_due, 23.04); // ceil2(1415 / 61.44 = 23.0306…) — always UP
  ok('usdt_due 23.04 priced from the authoritative total, never browser figures');
}

// ── 6. Corrupt fee on a present row is rejected, not coerced ─────────────────
console.log('CASE 6 — present row with invalid fee_centavos:');
{
  for (const bad of ['garbage', -100]) {
    const sb = globalThis.__sbMock = makeSB({ quotes: { data: { fee_centavos: bad }, error: null } });
    const res = await post(body({ quote_id: QUOTE_ID }));
    const out = await res.json();
    assert.equal(res.status, 409);
    assert.deepEqual(out, { error: 'quote_invalid', reason: 'fee_invalid' });
    assert.equal(sb.calls.rpc.filter(c => c.name === 'place_customer_order').length, 0);
  }
  ok('fee_centavos "garbage" and -100 → 409 fee_invalid, no RPC (0 stays legal)');
}

// ── 7. Legacy no-quote path unchanged (until strict enforcement) ─────────────
console.log('CASE 7 — quote_id completely absent (old cached bundle):');
{
  const sb = globalThis.__sbMock = makeSB({});
  const res = await post(body()); // no quote_id key at all
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.total, 1379); // 1000 + flat store_settings fallback 379
  const p = rpcPayload(sb);
  assert.equal(p.quote_id, null);
  assert.equal(p.delivery_fee, '379');
  ok('legacy fallback intact: server-computed ₱379, quote_id null, tampered ₱1 ignored');
}

console.log(`\nAll ${pass} edge-function assertions passed.`);
