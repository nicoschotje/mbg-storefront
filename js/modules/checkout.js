/* MBG Storefront v2 — Checkout
 * Posts orders via the place-order edge function (matches old storefront).
 */
import { sb, logActivity } from '../core/supabase.js';
import { esc, formatPrice, normalisePhone, isValidPHPhone, openOverlay, closeOverlay, showToast } from '../core/utils.js';
import { EDGE_URL, SUPABASE_ANON, PAYMENT_METHODS } from '../core/config.js';
import { getStoreSettings } from './banners.js?v=20260608-deepfix';
import { getCartItems, getSubtotal, getDiscount, clearCart, getAppliedPromo, priceForItem, displayNameForItem } from './cart.js?v=20260608-deepfix';
import { getSession, getAuthPhone } from '../core/auth.js?v=20260520-polish';
import { getSelectedCoords, setSelectedCoords } from './address.js?v=20260608-deepfix';
import { initAddressMap } from './leaflet-map.js?v=20260608-deepfix';
import { getSavedAddresses, saveAddress, deleteAddress, addressLabel } from './saved-address.js?v=20260615-savedaddr';
import { rememberMyOrderId } from './my-orders-store.js?v=20260626-phase1';

let _selectedPay = 'gcash';
let _selectedZoneId = null;   // null = Within Metro Manila (distance-based fee)
let _deliveryZones = [];      // active delivery_zones rows, loaded once

// Server-issued delivery quote (Phase 3 B6b). The browser computes NO delivery
// fee: quote_delivery issues {quote_id, fee, label, expires_at}, the UI renders
// exactly that, and the order carries quote_id so place-order charges exactly
// the quoted fee. No quote → Place Order stays disabled (fail-closed).
let _quote = null;            // { quote_id, fee, label, expires_at } or null
let _quoteErr = false;        // last quote attempt failed → tap-to-retry line
let _quoteSeq = 0;            // stale guard: only the latest request may write _quote
let _quoteTimer = null;       // debounce handle for quote triggers
let _quoteInvalidCount = 0;   // consecutive place-order 409 quote_invalid rejections
let _quoteBlocked = false;    // 2-strike terminal state: stop auto-requoting, ask to reload
let _placing = false;         // a submit is in flight — placeOrder owns the button, refreshDelivery must not touch it

const QUOTE_DEBOUNCE_MS = 400;
const QUOTE_LOADING_TEXT = 'Calculating delivery…';
const QUOTE_RETRY_TEXT   = 'Delivery quote unavailable — tap to retry';
const QUOTE_BLOCKED_TEXT = 'Prices may have changed — please reload the page';

// Hard ceiling for receipt screenshots — matches the payment-receipts
// Supabase storage bucket's 5 MB file_size_limit. Checked client-side so
// an oversized iPhone photo fails fast with a clear message instead of a
// silent 500 from the upload edge function.
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

// Loads owner-defined delivery zones (flat rates for Outside Metro Manila).
// Cached after first fetch; warmed at module load so the selector is ready
// the instant checkout opens.
async function loadDeliveryZones() {
  if (_deliveryZones.length) return _deliveryZones;
  try {
    const { data } = await sb().from('delivery_zones')
      .select('id, name, base_fee')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    _deliveryZones = data || [];
  } catch (_) { _deliveryZones = []; }
  return _deliveryZones;
}
loadDeliveryZones();

// Payment methods available given the dashboard's store_settings toggles.
// Shared by the full form and the quick-confirm card so they never disagree.
function availablePays(ss) {
  const cryptoOn = !!(ss?.crypto_enabled && ss?.crypto_usdt_address);
  return PAYMENT_METHODS.filter(p => {
    if (p.id === 'usdt')  return cryptoOn;
    if (p.id === 'gcash') return ss?.gcash_enabled === true;
    if (p.id === 'maya')  return ss?.maya_enabled === true;
    return true;
  });
}

// Per-account remembered payment method (device-local). The server-side source
// of truth is store_customers.last_payment_method (written by place_customer_order
// in Phase 1); this cache lets the UI default the method instantly without an
// extra round-trip. See DEFECTS.md for the cross-device pre-fill follow-up.
function lastPayKey(session) { return 'mbg_last_pay::' + (session?.customer_id || 'guest'); }
function preferredPayMethod(session) {
  const ss = getStoreSettings();
  const pays = availablePays(ss);
  let last = '';
  try { last = localStorage.getItem(lastPayKey(session)) || ''; } catch(_) {}
  if (last && pays.some(p => p.id === last)) return last;
  return pays.some(p => p.id === _selectedPay) ? _selectedPay : (pays[0]?.id || 'gcash');
}
function rememberPayMethod(session, method) {
  try { localStorage.setItem(lastPayKey(session), method); } catch(_) {}
}

// A logged-in customer with a complete saved address + known name/phone can
// skip the full form: returns that address, else null (→ full form).
function quickConfirmAddress(session) {
  if (!session?.customer_id) return null;
  const name = session?.display_name;
  const phone = getAuthPhone() || session?.phone;
  if (!name || !phone) return null;
  const list = getSavedAddresses();
  return list.find(a => a && a.street && a.barangay && a.city && a.province) || null;
}

export async function openCheckoutScreen() {
  const session = getSession();
  if (getCartItems().length === 0) {
    showToast('Your bag is empty.');
    return;
  }
  let host = document.getElementById('checkoutScreen');
  if (!host) {
    host = document.createElement('section');
    host.id = 'checkoutScreen';
    host.className = 'checkout-screen';
    document.body.appendChild(host);
  }
  await loadDeliveryZones();
  _selectedPay = preferredPayMethod(session);
  _quoteInvalidCount = 0;
  _quoteBlocked = false;
  _placing = false;
  // Frictionless path: returning customer with a saved address → one-line confirm.
  const quickAddr = quickConfirmAddress(session);
  if (quickAddr) renderQuickConfirm(host, session, quickAddr);
  else renderCheckout(host, session);
  // Checkout-open quote — fired AFTER render, so renderQuickConfirm has
  // already synced its saved-address pin into the shared accessors.
  scheduleQuote(host);
  host.classList.add('open');
  document.body.classList.add('lock-scroll');
  openOverlay('checkoutScreen', () => closeCheckoutScreen());
}

// One-line confirm card for returning customers. Reuses placeOrder() unchanged
// by rendering the same #co* fields as hidden inputs (pre-filled from the saved
// address + session). "Edit details" expands to the full editable form.
function renderQuickConfirm(host, session, addr) {
  const ss = getStoreSettings();

  // Restore the saved address's map pin BEFORE the checkout-open quote fires,
  // so requestQuote reads these coords through getSelectedCoords().
  if (addr.coords && Number.isFinite(addr.coords.lat) && Number.isFinite(addr.coords.lng)) {
    setSelectedCoords(addr.coords);
  } else {
    setSelectedCoords(null);
  }

  const pays = availablePays(ss);
  if (!pays.some(p => p.id === _selectedPay) && pays.length) _selectedPay = pays[0].id;

  const name  = session?.display_name || addr.name || '';
  const phone = getAuthPhone() || session?.phone || addr.phone || '';
  const fullAddr = [addr.street, addr.barangay, addr.city, addr.province]
    .filter(Boolean).join(', ') + (addr.postal ? ' ' + addr.postal : '');

  host.innerHTML = `
    <div class="checkout-inner">
      <header class="checkout-header">
        <button class="checkout-back" aria-label="Back">←</button>
        <h2>Checkout</h2>
        <span class="checkout-spacer"></span>
      </header>

      <section class="check-section quick-confirm">
        <h3>Confirm &amp; pay</h3>
        <div class="qc-line">📍 Deliver to <b>${esc(fullAddr)}</b></div>
        <div class="qc-line">👤 <b>${esc(name)}</b> · ${esc(phone)}</div>
        <div class="qc-line">🚚 Delivery <b id="coDeliveryFee">${QUOTE_LOADING_TEXT}</b></div>
        <div class="qc-line qc-total"><span>Total</span><b id="coTotal">—</b></div>

        <div class="qc-paylabel">Pay by</div>
        <div class="pay-grid">
          ${pays.map(p => `<button type="button" class="pay-option${p.id === _selectedPay ? ' active' : ''}" data-pay="${esc(p.id)}">
            <span class="pay-glyph">${esc(p.icon)}</span><span>${esc(p.label)}</span></button>`).join('')}
        </div>
        <div id="payInfoBox" class="pay-info-box"></div>

        <button type="button" id="confirmEditBtn" class="field-change-link">✎ Edit address / details</button>
      </section>

      <!-- Hidden fields consumed by placeOrder() (pre-filled, recipient-only) -->
      <input type="hidden" id="coName"     value="${esc(name)}">
      <input type="hidden" id="coPhone"    value="${esc(phone)}">
      <input type="hidden" id="coStreet"   value="${esc(addr.street || '')}">
      <input type="hidden" id="coBarangay" value="${esc(addr.barangay || '')}">
      <input type="hidden" id="coCity"     value="${esc(addr.city || '')}">
      <input type="hidden" id="coProvince" value="${esc(addr.province || '')}">
      <input type="hidden" id="coPostal"   value="${esc(addr.postal || '')}">
      <input type="hidden" id="coNotes"    value="${esc(addr.notes || '')}">
      <input type="hidden" id="coPromo"    value="${esc(getAppliedPromo() || '')}">
    </div>

    <div class="checkout-cta-bar">
      <button id="placeOrderBtn" class="place-order-btn" type="button" data-label-base="Confirm order" disabled>Confirm order</button>
    </div>`;

  host.querySelector('.checkout-back')?.addEventListener('click', closeCheckoutScreen);
  host.querySelectorAll('.pay-option').forEach(p => p.addEventListener('click', () => {
    _selectedPay = p.dataset.pay;
    renderQuickConfirm(host, session, addr);
  }));
  host.querySelector('#placeOrderBtn')?.addEventListener('click', () => placeOrder(host));
  // Quick-confirm has no #deliveryLabel — its fee line doubles as the
  // tap-to-retry target when a quote attempt fails.
  host.querySelector('#coDeliveryFee')?.addEventListener('click', () => retryQuote(host));
  host.querySelector('#confirmEditBtn')?.addEventListener('click', () => {
    renderCheckout(host, session);
    applySavedAddress(host, addr); // keep the address when expanding to full edit
  });
  refreshDelivery(host);
}

export function closeCheckoutScreen() {
  const host = document.getElementById('checkoutScreen');
  if (!host) return;
  host.classList.remove('open');
  document.body.classList.remove('lock-scroll');
  closeOverlay('checkoutScreen');
  _selectedZoneId = null;
  // Drop the quote state so a reopened checkout always starts from a fresh
  // server quote — and a late in-flight response can't write into it.
  ++_quoteSeq;
  clearTimeout(_quoteTimer);
  _quote = null;
  _quoteErr = false;
  _quoteInvalidCount = 0;
  _quoteBlocked = false;
  _placing = false;
}

// ── Server-issued delivery quotes (Phase 3 B6b) ──────────────────────────────
// The old client-side fee math (zone base_fee lookup + the delivery.js
// haversine calculator) is gone from checkout: the quote_delivery RPC is the
// only fee authority. requestQuote and placeOrder MUST read zone/coords/
// subtotal through the same accessors (_selectedZoneId, getSelectedCoords(),
// getSubtotal()) so the quoted mode and the order payload can never disagree.

// Builds the quote_delivery input from the shared accessors. Mode pin: a
// selected zone sends zone_id ONLY (no coords, even if a pin was dropped
// earlier); otherwise coords when picked, or neither (server fallback fee).
function buildQuoteInput() {
  const p_input = {
    session_token: getSession()?.token || null,
    subtotal: Number(getSubtotal().toFixed(2)),
    zone_id: _selectedZoneId || null,
  };
  if (!_selectedZoneId) {
    const coords = getSelectedCoords();
    if (coords) {
      p_input.dest_lat = coords.lat;
      p_input.dest_lng = coords.lng;
    }
  }
  return p_input;
}

// Requests a fresh quote immediately. UI triggers should go through
// scheduleQuote (debounced); direct calls are for the retry tap, the
// place-order guard, and the 409 quote_invalid refresh.
async function requestQuote(host) {
  const seq = ++_quoteSeq;
  _quote = null;
  _quoteErr = false;
  refreshDelivery(host);

  let data = null;
  let failed = false;
  try {
    const res = await sb().rpc('quote_delivery', { p_input: buildQuoteInput() });
    data = res.data;
    failed = !!res.error;
  } catch (_) {
    failed = true;
  }
  if (seq !== _quoteSeq) return; // superseded by a newer request — drop it

  if (failed || !data || data.success !== true) {
    _quote = null;
    _quoteErr = true;
  } else {
    _quote = {
      quote_id:   data.quote_id,
      fee:        Number(data.fee),
      label:      data.label,
      expires_at: data.expires_at,
    };
    _quoteErr = false;
  }
  refreshDelivery(host);
}

// Debounced quote trigger (checkout open, address change, zone change). Clears
// the current quote first — fail-closed: Place Order stays disabled until the
// fresh quote lands.
function scheduleQuote(host) {
  ++_quoteSeq; // invalidate any in-flight response right away
  _quote = null;
  _quoteErr = false;
  // A fresh address/zone change is a legitimate new attempt — lift the
  // 2-strike block so the new inputs get quoted.
  _quoteBlocked = false;
  _quoteInvalidCount = 0;
  refreshDelivery(host);
  clearTimeout(_quoteTimer);
  _quoteTimer = setTimeout(() => requestQuote(host), QUOTE_DEBOUNCE_MS);
}

// Tap handler for the "quote unavailable" line.
function retryQuote(host) {
  if (_quote || !_quoteErr) return;
  requestQuote(host);
}

// Renders the current quote state into whichever checkout layout is on screen.
// THE single fee-render step — no client fee math anywhere in this path.
// While _quote is null: delivery line shows loading/retry text, the total
// shows "—" (never ₱0, never a stale client fee) and Place Order is disabled
// with its plain label.
function refreshDelivery(host) {
  const subtotal = getSubtotal();
  const disc = getDiscount();
  const quoted = !!_quote;
  const total = quoted ? Math.max(0, subtotal + _quote.fee - disc.amount) : null;
  const pendingText = _quoteBlocked ? QUOTE_BLOCKED_TEXT
    : _quoteErr ? QUOTE_RETRY_TEXT
    : QUOTE_LOADING_TEXT;

  const labelEl = host.querySelector('#deliveryLabel');
  if (labelEl) labelEl.textContent = quoted ? _quote.label : pendingText;

  const feeEl = host.querySelector('#coDeliveryFee');
  if (feeEl) {
    if (quoted) feeEl.textContent = _quote.fee === 0 ? 'FREE' : formatPrice(_quote.fee);
    // Full form: the loading/retry line lives on #deliveryLabel, so the
    // summary row just shows a placeholder. Quick-confirm has no
    // #deliveryLabel — its fee line IS the loading/retry line.
    else feeEl.textContent = labelEl ? '—' : pendingText;
  }

  const totalEl = host.querySelector('#coTotal');
  if (totalEl) totalEl.textContent = quoted ? formatPrice(total) : '—';

  // While a submit is in flight, placeOrder owns the button (disabled +
  // "Placing order…" spinner). refreshDelivery must not touch it — an async
  // quote landing mid-submit would otherwise re-enable it (double-submit) or
  // wipe the spinner text.
  const btn = host.querySelector('#placeOrderBtn');
  if (btn && !_placing) {
    const base = btn.dataset.labelBase || 'Place Order';
    btn.disabled = !quoted;
    btn.textContent = quoted ? `${base} · ${formatPrice(total)}` : base;
  }

  // Keep the payment "Send exactly" box in sync with the recomputed total.
  // Without this the pay box keeps the first-paint estimate while the summary
  // and button update, so bank-transfer customers see two different amounts.
  const payBox = host.querySelector('#payInfoBox');
  if (payBox) renderPayInfo(payBox, _selectedPay, total);

  const noteEl = host.querySelector('#deliveryNote');
  if (noteEl) {
    // Server quoted the flat fallback fee (no zone, no pin) — nudge for a pin.
    const isEstimate = quoted && _quote.fee > 0 && !_selectedZoneId && !getSelectedCoords();
    noteEl.textContent = isEstimate
      ? '⚠️ Enter your full address above for an accurate delivery fee.'
      : '';
    noteEl.hidden = !isEstimate;
  }

  syncPayInfo(host, total);
}

// Re-renders the payment info box when the rendered total changes, so the
// "Send exactly" amount always matches the quoted total (and shows "—" while
// no quote is held). A chosen receipt file is carried into the fresh DOM —
// a re-quote must never wipe the customer's uploaded screenshot.
function syncPayInfo(host, total) {
  const box = host.querySelector('#payInfoBox');
  if (!box) return;
  const key = total == null ? 'pending' : String(total);
  if (box.dataset.renderedTotal === key) return;
  const oldFile = box.querySelector('#receiptFile');
  renderPayInfo(box, _selectedPay, total);
  const newFile = box.querySelector('#receiptFile');
  if (oldFile && newFile && oldFile.files && oldFile.files.length) {
    newFile.replaceWith(oldFile);
  }
  box.dataset.renderedTotal = key;
}

// The address autocomplete / map pin fires this when coordinates are picked,
// moved, or cleared — each change invalidates the quote and requests a new one.
document.addEventListener('mbg:deliveryAddrChanged', () => {
  const host = document.getElementById('checkoutScreen');
  if (host && host.classList.contains('open')) scheduleQuote(host);
});

function renderCheckout(host, session) {
  const ss = getStoreSettings();
  const items = getCartItems();
  const subtotal = getSubtotal();
  const disc = getDiscount();

  // A re-render rebuilds every field — preserve whatever the customer has
  // already typed (the delivery address in particular must survive).
  const prev = {
    name:     host.querySelector('#coName')?.value,
    phone:    host.querySelector('#coPhone')?.value,
    street:   host.querySelector('#coStreet')?.value,
    barangay: host.querySelector('#coBarangay')?.value,
    city:     host.querySelector('#coCity')?.value,
    province: host.querySelector('#coProvince')?.value,
    postal:   host.querySelector('#coPostal')?.value,
    notes:    host.querySelector('#coNotes')?.value,
    promo:    host.querySelector('#coPromo')?.value
  };
  const valName     = prev.name     !== undefined ? prev.name     : (session?.display_name || '');
  const valPhone    = prev.phone    !== undefined ? prev.phone    : (getAuthPhone() || session?.phone || '');
  const valStreet   = prev.street   !== undefined ? prev.street   : (session?.saved_address || '');
  const valBarangay = prev.barangay !== undefined ? prev.barangay : '';
  const valCity     = prev.city     !== undefined ? prev.city     : '';
  const valProvince = prev.province !== undefined ? prev.province : '';
  const valPostal   = prev.postal   !== undefined ? prev.postal   : '';
  const valNotes    = prev.notes    !== undefined ? prev.notes    : '';
  const valPromo    = prev.promo    !== undefined ? prev.promo    : (getAppliedPromo() || '');

  // Filter pay methods by the dashboard's store_settings toggles.
  const pays = availablePays(ss);

  // If the previously selected method was just filtered out, fall back to
  // the first still-available option so the UI and payInfo box stay in sync.
  if (!pays.some(p => p.id === _selectedPay) && pays.length) {
    _selectedPay = pays[0].id;
  }

  host.innerHTML = `
    <div class="checkout-inner">
      <header class="checkout-header">
        <button class="checkout-back" aria-label="Back">←</button>
        <h2>Checkout</h2>
        <span class="checkout-spacer"></span>
      </header>

      <section class="check-section">
        <h3>Your details</h3>
        <div id="savedAddrBar" class="saved-addr-bar" hidden></div>
        <label class="field">
          <span>Full name</span>
          <input id="coName" type="text"
            autocomplete="name"
            placeholder="Juan Dela Cruz"
            value="${esc(valName)}"
            ${valName ? 'readonly' : ''}>
          ${valName ? '<span class="field-change-link" data-unlock="coName">✎ Edit</span>' : ''}
        </label>
        <label class="field">
          <span>Mobile number</span>
          <input id="coPhone" type="tel" inputmode="tel"
            autocomplete="tel"
            placeholder="+63 9XX XXX XXXX"
            value="${esc(valPhone)}"
            ${valPhone ? 'readonly' : ''}>
          ${valPhone ? '<span class="field-change-link" data-unlock="coPhone">✎ Edit</span>' : ''}
        </label>
        <label class="field">
          <span>Street / Building</span>
          <input id="coStreet" type="text" inputmode="text" autocomplete="street-address" placeholder="House/Unit, Street" value="${esc(valStreet)}">
        </label>
        <label class="field">
          <span>Barangay</span>
          <input id="coBarangay" type="text" inputmode="text" autocomplete="address-level3" placeholder="Enter your barangay" value="${esc(valBarangay)}">
        </label>
        <div class="field-row">
          <label class="field">
            <span>City / Municipality</span>
            <input id="coCity" type="text" inputmode="text" autocomplete="address-level2" placeholder="City" value="${esc(valCity)}">
          </label>
          <label class="field">
            <span>Province</span>
            <input id="coProvince" type="text" inputmode="text" autocomplete="address-level1" placeholder="Province" value="${esc(valProvince)}">
          </label>
        </div>
        <label class="field field-half">
          <span>Postal code (optional)</span>
          <input id="coPostal" type="text" inputmode="numeric" autocomplete="postal-code" placeholder="1605" value="${esc(valPostal)}">
        </label>
        <div class="address-map-wrap">
          <div class="address-map-toolbar">
            <button type="button" id="addrLocateBtn" class="addr-locate-btn">📍 Use my location</button>
            <span class="map-caption">Tap the map to drop your pin · drag to fine-tune</span>
          </div>
          <div id="addr-map" class="address-map"></div>
        </div>
        <label class="field">
          <span>Delivery notes (optional)</span>
          <input id="coNotes" type="text" placeholder="Landmarks, gate code, etc." value="${esc(valNotes)}">
        </label>
        <button type="button" id="saveAddrBtn" class="saved-addr-save-btn">💾 Save this address</button>
      </section>

      <section class="check-section">
        <h3>Delivery</h3>
        ${_deliveryZones.length ? `
        <label class="field">
          <span>Delivery area</span>
          <select id="coZoneSelect">
            <option value="">Within Metro Manila</option>
            ${_deliveryZones.map(z => `<option value="${esc(z.id)}" ${_selectedZoneId === z.id ? 'selected' : ''}>Outside Metro Manila — ${esc(z.name)} (₱${Number(z.base_fee || 0).toLocaleString('en-PH')})</option>`).join('')}
          </select>
        </label>` : ''}
        <div class="delivery-quote"><b id="deliveryLabel">${QUOTE_LOADING_TEXT}</b></div>
        <p class="delivery-note" id="deliveryNote" hidden></p>
      </section>

      <section class="check-section">
        <h3>Payment method</h3>
        <div class="pay-grid">
          ${pays.map(p => {
            const active = p.id === _selectedPay ? ' active' : '';
            return `<button type="button" class="pay-option${active}" data-pay="${esc(p.id)}">
              <span class="pay-glyph">${esc(p.icon)}</span><span>${esc(p.label)}</span>
            </button>`;
          }).join('')}
        </div>
        <div id="payInfoBox" class="pay-info-box"></div>
        <label class="field" id="promoFieldCo">
          <span>Promo code (optional)</span>
          <input id="coPromo" type="text" maxlength="20" value="${esc(valPromo)}" placeholder="e.g. WELCOME10">
        </label>
      </section>

      <section class="check-section">
        <h3>Order summary</h3>
        <div class="summary-list">
          ${items.map(it => `<div class="sum-row">
            <span>${esc(displayNameForItem(it))} × ${it.qty}</span>
            <b>${esc(formatPrice(priceForItem(it) * it.qty))}</b>
          </div>`).join('')}
        </div>
        <div class="summary-totals">
          <div class="row"><span>Subtotal</span><b>${esc(formatPrice(subtotal))}</b></div>
          <div class="row"><span>Delivery</span><b id="coDeliveryFee">—</b></div>
          ${disc.amount > 0 ? `<div class="row"><span>Discount</span><b>− ${esc(formatPrice(disc.amount))}</b></div>` : ''}
          <div class="row total"><span>Total</span><b id="coTotal">—</b></div>
        </div>
      </section>
    </div>

    <div class="checkout-cta-bar">
      <button id="placeOrderBtn" class="place-order-btn" type="button" data-label-base="Place Order" disabled>Place Order</button>
    </div>`;

  host.querySelector('.checkout-back')?.addEventListener('click', closeCheckoutScreen);
  host.querySelectorAll('.pay-option').forEach(p => p.addEventListener('click', () => {
    _selectedPay = p.dataset.pay;
    renderCheckout(host, session);
  }));

  host.querySelector('#placeOrderBtn')?.addEventListener('click', () => placeOrder(host));
  host.querySelector('#deliveryLabel')?.addEventListener('click', () => retryQuote(host));

  // The name/phone fields render readonly when pre-filled; the inline "Edit"
  // link unlocks the field so the customer can override the value.
  host.querySelectorAll('.field-change-link[data-unlock]').forEach(el => {
    el.addEventListener('click', () => {
      const input = host.querySelector('#' + el.dataset.unlock);
      if (input) { input.removeAttribute('readonly'); input.focus(); }
      el.remove();
    });
  });

  initAddressMap();
  refreshDelivery(host);

  const zoneSelect = host.querySelector('#coZoneSelect');
  if (zoneSelect) {
    zoneSelect.addEventListener('change', () => {
      _selectedZoneId = zoneSelect.value || null;
      scheduleQuote(host);
    });
  }

  // Saved addresses: render the "Use saved address" chips and wire the
  // "Save this address" button.
  renderSavedAddrBar(host);
  host.querySelector('#saveAddrBtn')?.addEventListener('click', () => {
    const get = (id) => (host.querySelector('#' + id)?.value || '').trim();
    const addr = {
      name:     get('coName'),
      phone:    get('coPhone'),
      street:   get('coStreet'),
      barangay: get('coBarangay'),
      city:     get('coCity'),
      province: get('coProvince'),
      postal:   get('coPostal'),
      notes:    get('coNotes'),
      coords:   getSelectedCoords() || null,
    };
    if (!addr.street || !addr.city) {
      showToast('Enter your street and city before saving.');
      return;
    }
    const saved = saveAddress(addr);
    if (!saved) { showToast('Could not save this address.'); return; }
    renderSavedAddrBar(host);
    // localStorage-backed, per-device — see saved-address.js for the limitation.
    showToast('Address saved on this device');
  });
}

// Renders the row of saved-address chips above the form. Each chip refills the
// checkout fields with one tap; the × removes it. Hidden when none are saved.
function renderSavedAddrBar(host) {
  const bar = host.querySelector('#savedAddrBar');
  if (!bar) return;
  const list = getSavedAddresses();
  if (!list.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = `
    <div class="saved-addr-label">Use a saved address</div>
    <div class="saved-addr-chips">
      ${list.map(a => `
        <div class="saved-addr-chip" data-id="${esc(a.id)}">
          <button type="button" class="saved-addr-use" data-id="${esc(a.id)}">📍 ${esc(addressLabel(a))}</button>
          <button type="button" class="saved-addr-del" data-id="${esc(a.id)}" aria-label="Remove saved address">×</button>
        </div>`).join('')}
    </div>`;
  bar.querySelectorAll('.saved-addr-use').forEach(btn => btn.addEventListener('click', () => {
    const a = getSavedAddresses().find(x => x.id === btn.dataset.id);
    if (a) applySavedAddress(host, a);
  }));
  bar.querySelectorAll('.saved-addr-del').forEach(btn => btn.addEventListener('click', () => {
    deleteAddress(btn.dataset.id);
    renderSavedAddrBar(host);
    showToast('Saved address removed');
  }));
}

// Fills the checkout fields from a saved address and restores its map pin +
// delivery coordinates. Field values are set directly (no input events) so the
// address.js autocomplete listener doesn't wipe the coordinates we restore.
function applySavedAddress(host, a) {
  const setVal = (id, v) => { const el = host.querySelector('#' + id); if (el != null) el.value = v || ''; };
  // Only overwrite identity fields when the saved record actually has them, so
  // a saved address can't blank out a session-prefilled name/phone.
  if (a.name)  setVal('coName', a.name);
  if (a.phone) setVal('coPhone', a.phone);
  setVal('coStreet', a.street);
  setVal('coBarangay', a.barangay);
  setVal('coCity', a.city);
  setVal('coProvince', a.province);
  setVal('coPostal', a.postal);
  setVal('coNotes', a.notes);

  if (a.coords && Number.isFinite(a.coords.lat) && Number.isFinite(a.coords.lng)) {
    setSelectedCoords(a.coords);
    document.dispatchEvent(new CustomEvent('mbg:addrPicked', { detail: a.coords }));
  } else {
    setSelectedCoords(null);
  }
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
  showToast('Address filled in');
}

function ensureQrLightbox() {
  if (document.getElementById('qr-lightbox')) return;
  const lb = document.createElement('div');
  lb.id = 'qr-lightbox';
  lb.innerHTML = '<div id="qr-lb-backdrop"></div><img id="qr-lb-img" src="" alt="QR code"/>';
  document.body.appendChild(lb);
  document.getElementById('qr-lb-backdrop').addEventListener('click', () => {
    document.getElementById('qr-lightbox').classList.remove('active');
  });
  document.getElementById('qr-lb-img').addEventListener('click', () => {
    document.getElementById('qr-lightbox').classList.remove('active');
  });
}

// Wires every [data-copy] button in a container to copy its value to the
// clipboard with brief "Copied!" feedback. Used by the payment screen so the
// customer can one-tap the exact amount and the payee details (Path B).
function attachCopyButtons(box) {
  box.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const val = btn.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(val);
        const old = btn.dataset.label || btn.textContent;
        btn.dataset.label = old;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove('copied'); }, 1500);
      } catch(_) { showToast('Copy failed — please select it manually'); }
    });
  });
}

function wireQrLightboxTriggers(box) {
  box.querySelectorAll('.pay-qr, .usdt-qr').forEach(img => {
    img.style.cursor = 'pointer';
    img.addEventListener('click', () => {
      document.getElementById('qr-lb-img').src = img.src;
      document.getElementById('qr-lightbox').classList.add('active');
    });
  });
}

function renderPayInfo(box, method, totalPHP) {
  if (!box) return;
  ensureQrLightbox();
  const ss = getStoreSettings();
  // totalPHP == null → the server quote hasn't landed yet, so the total is
  // unknown: show "—" (never ₱0) and no copy button until the quote resolves.
  const hasTotal  = totalPHP != null;
  const amountStr  = hasTotal ? (Number(totalPHP) || 0).toFixed(2) : '';
  const amountDisp = hasTotal ? formatPrice(totalPHP) : '—';
  // Prominent "send exactly ₱X" block with a copy button — the exact amount is
  // the strongest auto-verification signal (OCR matches on it), so we make it
  // one-tap to copy. The static payee QR stays for scan-to-pay.
  const amountBlock = `
    <div class="pay-amount">
      <span class="pay-amount-label">Send exactly</span>
      <b class="pay-amount-val">${esc(amountDisp)}</b>
      ${hasTotal ? `<button type="button" class="copy-btn" data-copy="${esc(amountStr)}">Copy amount</button>` : ''}
    </div>`;
  const payRow = (label, value, copy) => `
    <div class="pay-row">
      <span>${esc(label)}</span>
      <b>${esc(value || '—')}</b>
      ${value && copy !== false ? `<button type="button" class="copy-mini" data-copy="${esc(value)}">Copy</button>` : ''}
    </div>`;

  if (method === 'gcash' || method === 'maya') {
    const num   = method === 'gcash' ? ss?.gcash_number : ss?.maya_number;
    const qrUrl = method === 'gcash' ? ss?.gcash_qr_url : ss?.maya_qr_url;
    const label = method === 'gcash' ? 'GCash' : 'Maya';
    const name  = (method === 'gcash' ? ss?.gcash_name : null) || ss?.store_name || "Mr. Beanie's Greenies";
    box.innerHTML = `<div class="pay-info">
      <h4>${label} Payment</h4>
      ${amountBlock}
      ${payRow(`${label} name`, name)}
      ${payRow(`${label} number`, num || 'See QR', !!num)}
      ${qrUrl ? `<div class="pay-qr-wrap"><img class="pay-qr" src="${esc(qrUrl)}" alt="${label} QR code"/>
        <div class="pay-qr-cap">Scan to pay, then enter the exact amount above</div></div>` : ''}
      <p class="pay-confirm">⚠️ Confirm you're paying <b>${esc(name)}</b> exactly <b>${esc(amountDisp)}</b>.</p>
      <p class="pay-note">After paying, upload your receipt screenshot below.</p>
      <input type="file" id="receiptFile" accept="image/png,image/jpeg,image/jpg,image/webp"/>
    </div>`;
    attachCopyButtons(box);
    wireQrLightboxTriggers(box);
    return;
  }
  if (method === 'bank_transfer') {
    const bankName = ss?.bank_name || '—';
    const acctName = ss?.bank_account_name || ss?.store_name || "Mr. Beanie's Greenies";
    const acctNum  = ss?.bank_account || ss?.bank_account_number || '—';
    box.innerHTML = `<div class="pay-info">
      <h4>Bank Transfer</h4>
      ${amountBlock}
      ${payRow('Bank', bankName, false)}
      ${payRow('Account name', acctName)}
      ${payRow('Account number', acctNum)}
      ${ss?.bank_qr_url ? `<div class="pay-qr-wrap"><img class="pay-qr" src="${esc(ss.bank_qr_url)}" alt="Bank QR"/>
        <div class="pay-qr-cap">Scan to pay, then enter the exact amount above</div></div>` : ''}
      <p class="pay-confirm">⚠️ Confirm you're transferring <b>${esc(amountDisp)}</b> to <b>${esc(acctName)}</b>.</p>
      <p class="pay-note">After transferring, upload your receipt below.</p>
      <input type="file" id="receiptFile" accept="image/png,image/jpeg,image/jpg,image/webp"/>
    </div>`;
    attachCopyButtons(box);
    wireQrLightboxTriggers(box);
    return;
  }
  if (method === 'usdt') {
    renderUSDTPayment(box, totalPHP);
    return;
  }
  box.innerHTML = '';
}

// Maps the owner-configured USDT network (store_settings.crypto_usdt_network,
// e.g. "ERC-20") to a display label + brand colour. Defaults to ERC-20 because
// the configured wallet is an Ethereum 0x… address.
function usdtNetworkInfo(raw) {
  const key = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const MAP = {
    erc20:    { label: 'ERC-20 (Ethereum)',        color: '#627EEA' },
    eth:      { label: 'ERC-20 (Ethereum)',        color: '#627EEA' },
    ethereum: { label: 'ERC-20 (Ethereum)',        color: '#627EEA' },
    trc20:    { label: 'TRC-20 (Tron)',            color: '#EB0029' },
    tron:     { label: 'TRC-20 (Tron)',            color: '#EB0029' },
    bep20:    { label: 'BEP-20 (BNB Smart Chain)', color: '#F0B90B' },
    bsc:      { label: 'BEP-20 (BNB Smart Chain)', color: '#F0B90B' },
    polygon:  { label: 'Polygon',                  color: '#8247E5' },
    matic:    { label: 'Polygon',                  color: '#8247E5' },
    solana:   { label: 'Solana',                   color: '#14F195' },
    sol:      { label: 'Solana',                   color: '#14F195' },
  };
  return MAP[key] || { label: raw ? String(raw) : 'ERC-20 (Ethereum)', color: '#627EEA' };
}

// ── USDT payment rendering ──────────────────────────────────
function renderUSDTPayment(box, totalPHP) {
  if (!box) return;
  const ss = getStoreSettings();
  // Show ONLY the network the owner configured (crypto_usdt_network). The old
  // hard-coded 4-network picker let a customer choose TRC-20 (Tron) while the
  // wallet is an Ethereum 0x… address — sending on the wrong chain loses funds
  // permanently. The address is fixed, so the network is informational and must
  // reflect what the owner actually accepts.
  const netInfo       = usdtNetworkInfo(ss?.crypto_usdt_network);
  const walletAddress = ss?.crypto_usdt_address || ss?.usdt_wallet_address || '';
  const qrUrl         = ss?.crypto_qr_url || ss?.usdt_qr_url || '';
  box.innerHTML = `<div class="pay-info usdt-block">
    <h4>USDT Payment</h4>
    <div class="usdt-rate" id="usdtRate">Fetching live rate…</div>
    <div class="pay-amount usdt-send-wrap" id="usdtSendWrap" hidden>
      <span class="pay-amount-label">Send exactly</span>
      <b class="pay-amount-val" id="usdtSendVal">—</b>
      <button type="button" class="copy-btn" data-copy="" id="usdtSendCopy">Copy amount</button>
    </div>
    <div class="usdt-network-label">Network</div>
    <div class="usdt-network-grid">
      <div class="usdt-network-option selected" aria-readonly="true">
        <span class="usdt-network-dot" style="background:${esc(netInfo.color)}"></span>
        <span class="usdt-network-name">${esc(netInfo.label)}</span>
      </div>
    </div>
    ${qrUrl ? `<img class="usdt-qr" src="${esc(qrUrl)}" alt="USDT QR code" loading="lazy"/>` : ''}
    <div class="usdt-address-wrap">
      <span class="usdt-address" id="usdtAddress">${esc(walletAddress || '—')}</span>
      <button class="usdt-copy-btn" id="usdtCopyBtn" type="button" aria-label="Copy wallet address">Copy</button>
    </div>
    <p class="usdt-warning">&#9888; Always confirm the network matches before sending. Sending to the wrong network results in permanent loss.</p>
    <p class="pay-note">After sending, upload your transaction screenshot below.</p>
    <input type="file" id="receiptFile" accept="image/png,image/jpeg,image/jpg,image/webp"/>
  </div>`;

  ensureQrLightbox();
  wireQrLightboxTriggers(box);

  // Copy wallet address to clipboard
  box.querySelector('#usdtCopyBtn')?.addEventListener('click', async () => {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      const btn = box.querySelector('#usdtCopyBtn');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
    } catch(_) { showToast('Copy failed — select the address manually'); }
  });

  attachCopyButtons(box);

  // Live PHP rate via the crypto-rate edge function
  fetchUSDTPHPRate(box, totalPHP);
}

async function fetchUSDTPHPRate(box, totalPHP) {
  let phpRate = null;
  try {
    const res = await fetch(
      'https://ihnnipynpdtcbdfbpemq.supabase.co/functions/v1/crypto-rate',
      { cache: 'no-store' }
    );
    const data = await res.json();
    phpRate = data?.tether?.php ?? null;
  } catch(_) { /* rate unavailable — handled below */ }
  const rateEl = box.querySelector('#usdtRate');
  if (!rateEl) return;
  rateEl.textContent = phpRate
    ? `1 USDT ≈ ₱${phpRate.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : 'Live rate unavailable';

  // The number the customer actually needs: total ÷ rate, rounded UP to
  // 2 decimals so the store never receives less than the peso total.
  // Re-renders arrive with fresh totals via renderPayInfo, so this stays
  // in sync with delivery/promo changes by construction.
  const wrap = box.querySelector('#usdtSendWrap');
  if (wrap) {
    const total = Number(totalPHP) || 0;
    if (phpRate && total > 0) {
      const usdt = Math.ceil((total / phpRate) * 100) / 100;
      const valEl = wrap.querySelector('#usdtSendVal');
      if (valEl) valEl.textContent = usdt.toFixed(2) + ' USDT';
      const copyBtn = wrap.querySelector('#usdtSendCopy');
      if (copyBtn) copyBtn.setAttribute('data-copy', usdt.toFixed(2));
      wrap.hidden = false;
    } else {
      wrap.hidden = true;
    }
  }
}

async function placeOrder(host) {
  const name     = host.querySelector('#coName').value.trim();
  const phone    = normalisePhone(host.querySelector('#coPhone').value.trim() || getAuthPhone() || '');
  const street   = host.querySelector('#coStreet').value.trim();
  const barangay = host.querySelector('#coBarangay').value.trim();
  const city     = host.querySelector('#coCity').value.trim();
  const province = host.querySelector('#coProvince').value.trim();
  const postal   = host.querySelector('#coPostal').value.trim();
  const notes    = host.querySelector('#coNotes').value.trim();
  const promo    = host.querySelector('#coPromo').value.trim().toUpperCase() || null;

  if (!name)  { showToast('Please enter your name'); return; }
  if (!isValidPHPhone(phone)) { showToast('Enter a valid PH mobile number'); return; }
  if (!street)   { showToast('Please enter your street / building'); return; }
  if (!barangay) { showToast('Please enter your barangay'); return; }
  if (!city)     { showToast('Please enter your city / municipality'); return; }
  if (!province) { showToast('Please enter your province'); return; }

  // The five structured fields collapse into the existing delivery_address
  // column — the orders schema is unchanged.
  const addr = `${street}, ${barangay}, ${city}, ${province}${postal ? ' ' + postal : ''}`;

  const items = getCartItems();
  if (!items.length) { showToast('Your bag is empty'); return; }

  // Hard quote gate: every order must carry a server-issued quote_id. Still
  // loading, or the last attempt failed → no order (fail-closed).
  if (!_quote) {
    showToast('Getting your delivery quote — one moment');
    requestQuote(host);
    return;
  }

  // Freeze the quote and its bound location mode for the whole async submit.
  // A map-pin drag or zone change mid-submit clears/replaces _quote (via
  // scheduleQuote); reading it again after the upload/place-order awaits would
  // crash or send a quote_id that no longer matches the fee. The non-null
  // _quote here was issued for exactly the current zone/coords (any change
  // nulls it), so this snapshot is internally consistent.
  const quote  = _quote;
  const zoneId = _selectedZoneId;
  const coords = zoneId ? null : getSelectedCoords();

  const subtotal = getSubtotal();
  const disc     = getDiscount();
  const finalFee = quote.fee;
  const total  = Math.max(0, subtotal + finalFee - disc.amount);

  const needsReceipt = ['gcash','maya','bank_transfer','usdt'].includes(_selectedPay);
  const receiptInput = host.querySelector('#receiptFile');
  const receiptFile  = needsReceipt ? receiptInput?.files?.[0] : null;
  if (needsReceipt && !receiptFile) {
    showToast('Please upload your payment screenshot');
    return;
  }
  if (receiptFile && receiptFile.size > MAX_RECEIPT_BYTES) {
    showToast('Image too large. Please upload an image under 5 MB.');
    return;
  }

  const btn = host.querySelector('#placeOrderBtn');
  _placing = true;   // placeOrder now owns the button; refreshDelivery won't touch it
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Placing order…';

  try {
    // Upload the receipt FIRST. If this throws, the catch below surfaces
    // the error and the order is never placed — the customer retries with
    // their screenshot intact rather than the order going through blind.
    let receiptUrl = null;
    if (needsReceipt && receiptFile) {
      receiptUrl = await uploadReceipt(receiptFile);
    }

    const payload = {
      // Custom session token (NOT a Supabase JWT). place-order resolves the
      // owning account from this via validate_customer_session and stamps
      // order_owner_id server-side. The browser never sends an owner id.
      session_token:    getSession()?.token || null,
      customer_name:    name,
      customer_phone:   phone,
      delivery_address: addr,
      delivery_zone:    zoneId
                          ? (_deliveryZones.find(z => z.id === zoneId)?.name || 'Outside Metro Manila')
                          : (coords ? 'Metro Manila' : 'Metro Manila (estimated)'),
      // The server charges exactly the stored quote; delivery_fee rides along
      // for display/back-compat only (place-order ignores it on the quote path).
      quote_id:         quote.quote_id,
      delivery_fee:     finalFee,
      subtotal:         Number(subtotal.toFixed(2)),
      total:            Number(total.toFixed(2)),
      discount_amount:  Number(disc.amount.toFixed(2)),
      promo_code:       promo,
      payment_method:   _selectedPay,
      receipt_url:      receiptUrl,
      notes:            notes || null,
      // `id` MUST be the parent product UUID — the place_customer_order RPC
      // locks/decrements that row's stock. variant_id / variant_name ride
      // along inside the items jsonb so the order record preserves the chosen
      // strain for fulfilment and history.
      items: items.map(it => {
        const p = it.product;
        const v = it.variant || null;
        const linePrice = priceForItem(it);
        return {
          id: p.id,
          product_id: p.id,
          name: p.name,
          variant_id: v ? v.id : null,
          variant_name: v ? v.name : null,
          display_name: displayNameForItem(it),
          category_id: p.category_id || null,
          emoji: p.emoji || '🌿',
          price: Number(linePrice),
          qty: it.qty,
          quantity: it.qty,
          image_url: p.image_url || p.image || null
        };
      })
    };

    // Mode mirror (B6a per-mode quote binding): the payload carries exactly
    // the location signal the quote was issued for. Zone mode → zone_id only
    // (no coords, even if a pin was dropped earlier); pin mode → coords only;
    // fallback → neither. zoneId/coords are the frozen snapshot from submit
    // start, so the payload mode matches the quote even if the customer
    // interacts mid-submit.
    if (zoneId) {
      payload.delivery_zone_id = zoneId;
    } else if (coords) {
      payload.delivery_lat = coords.lat;
      payload.delivery_lng = coords.lng;
    }

    const resp = await fetch(`${EDGE_URL}/place-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`
      },
      body: JSON.stringify(payload)
    });

    let data = {};
    try { data = await resp.json(); } catch(_) {
      throw new Error(`Server error (${resp.status}). Please try again.`);
    }

    // The server rejected our quote (missing / expired / consumed / mode
    // mismatch). Refresh the quote once and ask the customer to confirm
    // again — NEVER auto-resubmit. A second consecutive rejection won't be
    // fixed by another quote (usually stale cart prices) → stop requoting.
    if (resp.status === 409 && data.error === 'quote_invalid') {
      _quoteInvalidCount += 1;
      _quote = null;
      _quoteErr = false;
      if (_quoteInvalidCount >= 2) {
        // A 2nd consecutive rejection won't self-heal via re-quote (usually
        // stale cart prices) — enter the terminal blocked state so the UI
        // stops the requote loop and honestly asks for a reload.
        _quoteBlocked = true;
        showToast('Prices may have changed — please reload the page and try again');
      } else {
        showToast('Your delivery fee was refreshed — please confirm your order again');
        requestQuote(host);
      }
      return;
    }
    // Any non-quote_invalid response ends a quote_invalid streak — the "2
    // consecutive" cap must not count rejections separated by other failures.
    _quoteInvalidCount = 0;
    if (!resp.ok || data.error) throw new Error(data.error || `Order failed (${resp.status})`);

    logActivity('order_placed', {
      order_number: data.order_number, total, items_count: items.length, payment_method: _selectedPay
    });

    // Remember this order id on THIS device (unguessable uuid capability) so
    // My Orders can show it without any phone-based matching, and so it still
    // appears if the customer later signs in (get_my_orders unions account
    // orders with these ids).
    rememberMyOrderId(data.order_id);
    // Remember the chosen payment method so checkout defaults to it next time.
    rememberPayMethod(getSession(), _selectedPay);

    // Show success screen immediately with a "pending" verification badge
    showSuccessScreen(data.order_number, items, total, data.order_id);
    clearCart();
    closeCheckoutScreen();

    // Tell any already-mounted tracking screen to refetch so the new order
    // shows immediately instead of waiting for the next 15s poll tick.
    document.dispatchEvent(new CustomEvent('mbg:orderPlaced', {
      detail: { order_id: data.order_id, order_number: data.order_number }
    }));

    // Verify receipt in background — badge updates when done
    if (needsReceipt && receiptFile) {
      verifyReceipt(data.order_number, _selectedPay, receiptFile)
        .then(result => updateVerificationBadge(data.order_number, result))
        .catch(() => updateVerificationBadge(data.order_number, { status: 'manual_review' }));
    }
  } catch(e) {
    console.error('[checkout] placeOrder error', e);
    // A network failure (fetch threw before any response) also breaks a
    // quote_invalid streak — it's a different failure mode.
    _quoteInvalidCount = 0;
    showToast(e.message || 'Order failed.');
  } finally {
    // Release the button back to refreshDelivery, then re-sync: on success the
    // screen has closed; on a 409 refresh / blocked / error the button
    // re-disables until the fresh quote lands (or stays disabled if blocked).
    _placing = false;
    refreshDelivery(host);
  }
}

// Uploads the payment screenshot to the payment-receipts bucket via the
// upload-receipt edge function and returns its permanent public URL.
// Throws on any failure — the caller (placeOrder) must NOT place the order
// without a receipt, so the error propagates to the customer for a retry.
async function uploadReceipt(file) {
  const fd = new FormData();
  fd.append('file', file);

  let resp;
  try {
    resp = await fetch(`${EDGE_URL}/upload-receipt`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` },
      body: fd
    });
  } catch(e) {
    console.error('[checkout] receipt upload network error', e);
    throw new Error('Could not upload your receipt — check your connection and try again.');
  }

  let j = {};
  try { j = await resp.json(); } catch(_) {}

  if (!resp.ok || j.error) {
    console.error('[checkout] receipt upload failed', resp.status, j.error);
    throw new Error(j.error || `Receipt upload failed (${resp.status}). Please try again.`);
  }

  const url = j.url || j.public_url || null;
  if (!url) {
    console.error('[checkout] receipt upload returned no URL', j);
    throw new Error('Receipt upload failed — please try again.');
  }
  return url;
}
// ── Payment verification helpers ────────────────────────────────────────────────
// Calls the verify-payment Supabase edge function with the screenshot file.
async function verifyReceipt(orderRef, paymentMethod, file) {
  const fd = new FormData();
  fd.append('order_ref', orderRef);
  fd.append('payment_method', paymentMethod);
  fd.append('file', file);
  try {
    const res = await fetch(`${EDGE_URL}/verify-payment`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` },
      body: fd
    });
    return res.ok ? res.json() : { status: 'manual_review' };
  } catch(_) {
    return { status: 'manual_review' };
  }
}

// Updates the verification badge on the success screen once async verify completes.
function updateVerificationBadge(orderNum, result) {
  const badge = document.getElementById(`verify-badge-${CSS.escape(orderNum)}`);
  const steps = document.getElementById(`pay-steps-${CSS.escape(orderNum)}`);
  // Advance the Received → Under review → Confirmed stepper.
  const setStep = (which) => {
    if (!steps) return;
    const [s1, s2, s3] = steps.querySelectorAll('.ps-step');
    if (!s1) return;
    s1.className = 'ps-step done';
    s2.className = 'ps-step ' + (which === 'confirmed' ? 'done' : which === 'mismatch' ? 'warn' : 'active');
    s3.className = 'ps-step ' + (which === 'confirmed' ? 'done' : '');
  };
  if (!badge) return;
  const { status, mismatch_reason } = result || {};
  if (status === 'verified') {
    badge.className = 'verify-badge verified';
    badge.innerHTML = '&#10003; Payment confirmed';
    setStep('confirmed');
  } else if (status === 'mismatch') {
    badge.className = 'verify-badge mismatch';
    badge.innerHTML = `&#9888; Amount mismatch &mdash; ${mismatch_reason || 'please contact us'}`;
    setStep('mismatch');
  } else {
    badge.className = 'verify-badge review';
    badge.innerHTML = '&#8987; Under review — we&rsquo;ll confirm shortly';
    setStep('review');
  }
}


// ── Success screen ──────────────────────────────────────────
export function showSuccessScreen(orderNum, items, total, orderId) {
  let host = document.getElementById('successScreen');
  if (!host) {
    host = document.createElement('section');
    host.id = 'successScreen';
    host.className = 'success-screen';
    document.body.appendChild(host);
  }
  const summary = items.map(i => `${i.product.emoji || '🌿'} ${displayNameForItem(i)} ×${i.qty}`).join(', ');
  host.innerHTML = `
    <div class="success-card">
      <div class="success-icon">&#10003;</div>
      <h2>Order placed</h2>
      <p class="success-num">#${esc(orderNum || '—')}</p>
      <div class="success-items">${esc(summary)}</div>
      <div class="success-total">${esc(formatPrice(total))}</div>

      <div class="success-ref">
        <span>Payment reference</span>
        <b>#${esc(orderNum || '—')}</b>
        ${orderNum ? `<button type="button" class="copy-mini" data-copy="${esc(orderNum)}">Copy</button>` : ''}
      </div>

      <div class="pay-status">
        <div class="pay-status-steps" id="pay-steps-${esc(orderNum)}">
          <span class="ps-step done">Received</span>
          <span class="ps-step active">Under review</span>
          <span class="ps-step">Confirmed</span>
        </div>
        <div id="verify-badge-${esc(orderNum)}" class="verify-badge pending">&#8987; Checking your payment&hellip;</div>
      </div>

      <p class="success-note">We&rsquo;ll prepare your order and message you when it&rsquo;s on the way. Salamat!</p>
      <div class="success-actions">
        <button id="successKeepShopping" type="button" class="btn-ghost">Keep shopping</button>
        <button id="successTrack" type="button" class="btn-primary">Track my orders</button>
      </div>
    </div>`;
  host.classList.add('open');
  attachCopyButtons(host);
  openOverlay('successScreen', () => host.classList.remove('open'));
  host.querySelector('#successKeepShopping')?.addEventListener('click', () => {
    host.classList.remove('open');
    closeOverlay('successScreen');
  });
  host.querySelector('#successTrack')?.addEventListener('click', () => {
    host.classList.remove('open');
    closeOverlay('successScreen');
    document.dispatchEvent(new CustomEvent('mbg:openTracking', { detail: { order_id: orderId } }));
  });
}

// Wire global event hook
document.addEventListener('mbg:openCheckout', () => openCheckoutScreen());
