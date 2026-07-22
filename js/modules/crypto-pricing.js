/* MBG Storefront — Crypto (USDT) checkout pricing
 *
 * PURE math only: no DOM, no network, no browser globals — so it runs as-is
 * under the Node test harness and stays a faithful mirror of the server-side
 * computation in supabase/functions/place-order/index.ts. Keep the two in sync:
 * the browser value here is a LIVE PREVIEW; the amount snapshotted by
 * place-order at placement is the authority.
 *
 * Locked design decisions (see the checkout brief):
 *   1. usdt_due is rounded UP to 2 decimals (the store is never short-paid).
 *   3. The crypto processing fee is a payment-method surcharge on the USDT
 *      amount due. It does NOT change the PHP order total and is reported
 *      separately; it is added to crypto_php_due only.
 *   5. checkout_rate must be > 0 or the order cannot be priced.
 *
 * Formula:
 *   checkout_rate = market_rate + owner_adjustment      (adjustment default 0)
 *   crypto_fee_php = flat ₱ or % of the PHP total       (default off → 0)
 *   crypto_php_due = final_php_total + crypto_fee_php
 *   usdt_due       = CEIL(crypto_php_due / checkout_rate, 2 dp)
 */

// Round UP to 2 decimals. Scale by 100, nudge down by a tiny epsilon so a value
// already sitting exactly on a cent boundary isn't bumped an extra cent by
// binary-float noise (e.g. 3379/61.44 → 54.9967… → 55.00, not 55.01), then ceil.
export function ceilTo2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return NaN;
  return Math.ceil(v * 100 - 1e-6) / 100;
}

// Standard 2-dp round for money-shaped snapshot fields (fee, php_due).
export function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

// checkout_rate = market_rate + owner_adjustment (signed ₱/USDT, default 0).
// Returns null when the result is not a usable positive rate — the caller must
// then refuse to quote a "send exactly" amount (failure handling).
export function checkoutRate(marketRate, ownerAdjustment = 0) {
  const m = Number(marketRate);
  const a = Number(ownerAdjustment) || 0;
  if (!Number.isFinite(m)) return null;
  const rate = m + a;
  return rate > 0 ? rate : null;
}

// crypto_fee_php from an owner fee config. PR 1 always passes a disabled config
// (→ 0); PR 2 wires the store_settings fee fields in here.
//   fee = { enabled, type: 'flat'|'percent', value }
export function cryptoFeePhp(fee, phpTotal) {
  if (!fee || !fee.enabled) return 0;
  const value = Number(fee.value) || 0;
  if (value <= 0) return 0;
  const type = String(fee.type || 'flat').toLowerCase();
  if (type === 'percent' || type === 'percentage') {
    return round2(Math.max(0, (Number(phpTotal) || 0) * value / 100));
  }
  return round2(Math.max(0, value)); // flat ₱
}

// Full computation. Returns { ok:true, ...snapshotFields } or
// { ok:false, reason } so the UI and the edge function share one code path for
// the failure states ("Unable to calculate USDT amount right now").
//
//   opts = {
//     phpTotal,                       // trusted final PHP order total
//     marketRate,                     // from the crypto-rate source
//     ownerAdjustment = 0,            // PR 2
//     fee = { enabled:false },        // PR 2
//   }
export function computeUsdtDue(opts = {}) {
  const phpTotal = Number(opts.phpTotal);
  if (!Number.isFinite(phpTotal) || phpTotal < 0) {
    return { ok: false, reason: 'invalid_total' };
  }
  const marketRate = Number(opts.marketRate);
  const rate = checkoutRate(marketRate, opts.ownerAdjustment || 0);
  if (rate == null) return { ok: false, reason: 'invalid_rate' };

  const feePhp = cryptoFeePhp(opts.fee, phpTotal);
  const cryptoPhpDue = round2(phpTotal + feePhp);
  const usdtDue = ceilTo2(cryptoPhpDue / rate);
  if (!Number.isFinite(usdtDue) || usdtDue <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }

  return {
    ok: true,
    marketRate,
    ownerAdjustment: Number(opts.ownerAdjustment) || 0,
    checkoutRate: rate,
    cryptoFeePhp: feePhp,
    cryptoPhpDue,
    usdtDue,
    rounding: 'ceil_2dp',
  };
}
