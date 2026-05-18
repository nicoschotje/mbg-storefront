/* MBG Storefront v2 — Checkout
 * Posts orders via the place-order edge function (matches old storefront).
 */
import { sb, logActivity } from '../core/supabase.js';
import { esc, formatPrice, normalisePhone, isValidPHPhone, openOverlay, closeOverlay, showToast } from '../core/utils.js';
import { EDGE_URL, SUPABASE_ANON, PAYMENT_METHODS } from '../core/config.js';
import { getStoreSettings } from './banners.js?v=20260518-mobile';
import { getCartItems, getSubtotal, getDiscount, clearCart, getAppliedPromo } from './cart.js?v=20260518-mobile';
import { getSession, getAuthPhone } from '../core/auth.js';
import { getSelectedCoords } from './address.js?v=20260518-mobile';
import { calculateDelivery } from './delivery.js?v=20260518-mobile';

let _selectedPay = 'gcash';

// Hard ceiling for receipt screenshots — matches the payment-receipts
// Supabase storage bucket's 5 MB file_size_limit. Checked client-side so
// an oversized iPhone photo fails fast with a clear message instead of a
// silent 500 from the upload edge function.
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

export function openCheckoutScreen() {
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
  renderCheckout(host, session);
  host.classList.add('open');
  document.body.classList.add('lock-scroll');
  openOverlay('checkoutScreen', () => closeCheckoutScreen());
}

export function closeCheckoutScreen() {
  const host = document.getElementById('checkoutScreen');
  if (!host) return;
  host.classList.remove('open');
  document.body.classList.remove('lock-scroll');
  closeOverlay('checkoutScreen');
}

// Runs the distance-based calculator with the live store_settings values
// and whatever customer coordinates the address autocomplete has captured.
function computeDelivery(ss, subtotal) {
  const coords = getSelectedCoords();
  return calculateDelivery({
    storeLat:        Number(ss?.store_lat),
    storeLng:        Number(ss?.store_lng),
    customerLat:     coords ? coords.lat : null,
    customerLng:     coords ? coords.lng : null,
    subtotal,
    surgeMultiplier: ss?.delivery_rate_multiplier,
    freeDeliveryMin: ss?.free_delivery_min,
    fallbackFee:     Number(ss?.delivery_fee) || 0
  });
}

// Recomputes the quote and updates the delivery-related DOM in place.
// Called after each render and whenever the address coordinates change,
// so the customer sees the fee react without losing their typed input.
function refreshDelivery(host) {
  const ss = getStoreSettings();
  const subtotal = getSubtotal();
  const disc = getDiscount();
  const delivery = computeDelivery(ss, subtotal);
  const total = Math.max(0, subtotal + delivery.fee - disc.amount);

  const labelEl = host.querySelector('#deliveryLabel');
  if (labelEl) labelEl.textContent = delivery.label;

  const feeEl = host.querySelector('#coDeliveryFee');
  if (feeEl) feeEl.textContent = delivery.fee === 0 ? 'FREE' : formatPrice(delivery.fee);

  const totalEl = host.querySelector('#coTotal');
  if (totalEl) totalEl.textContent = formatPrice(total);

  const btn = host.querySelector('#placeOrderBtn');
  if (btn && !btn.disabled) btn.textContent = `Place Order · ${formatPrice(total)}`;

  const noteEl = host.querySelector('#deliveryNote');
  if (noteEl) {
    const isEstimate = !getSelectedCoords() && delivery.fee > 0;
    noteEl.textContent = isEstimate
      ? 'Delivery fee estimated — enter a full address for an exact quote.'
      : '';
    noteEl.hidden = !isEstimate;
  }
}

// The address autocomplete fires this when coordinates are picked or cleared.
document.addEventListener('mbg:deliveryAddrChanged', () => {
  const host = document.getElementById('checkoutScreen');
  if (host && host.classList.contains('open')) refreshDelivery(host);
});

function renderCheckout(host, session) {
  const ss = getStoreSettings();
  const items = getCartItems();
  const subtotal = getSubtotal();
  const disc = getDiscount();

  // A re-render rebuilds every field — preserve whatever the customer has
  // already typed (the delivery address in particular must survive).
  const prev = {
    name:  host.querySelector('#coName')?.value,
    phone: host.querySelector('#coPhone')?.value,
    addr:  host.querySelector('#coAddr')?.value,
    notes: host.querySelector('#coNotes')?.value,
    promo: host.querySelector('#coPromo')?.value
  };
  const valName  = prev.name  !== undefined ? prev.name  : (session?.display_name || '');
  const valPhone = prev.phone !== undefined ? prev.phone : (getAuthPhone() || session?.phone || '');
  const valAddr  = prev.addr  !== undefined ? prev.addr  : (session?.saved_address || '');
  const valNotes = prev.notes !== undefined ? prev.notes : '';
  const valPromo = prev.promo !== undefined ? prev.promo : (getAppliedPromo() || '');

  const delivery = computeDelivery(ss, subtotal);
  const total = Math.max(0, subtotal + delivery.fee - disc.amount);

  // Filter pay methods — hide USDT if not enabled
  const cryptoOn = !!(ss?.crypto_enabled && ss?.crypto_usdt_address);
  const pays = PAYMENT_METHODS.filter(p => p.id !== 'usdt' || cryptoOn);

  host.innerHTML = `
    <div class="checkout-inner">
      <header class="checkout-header">
        <button class="checkout-back" aria-label="Back">←</button>
        <h2>Checkout</h2>
        <span class="checkout-spacer"></span>
      </header>

      <section class="check-section">
        <h3>Your details</h3>
        <label class="field">
          <span>Full name</span>
          <input id="coName" type="text" autocomplete="name" placeholder="Juan Dela Cruz" value="${esc(valName)}">
        </label>
        <label class="field">
          <span>Mobile number</span>
          <input id="coPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+63 9XX XXX XXXX" value="${esc(valPhone)}">
        </label>
        <label class="field">
          <span>Complete delivery address</span>
          <textarea id="coAddr" rows="3" placeholder="House/Unit, Street, Barangay, City">${esc(valAddr)}</textarea>
        </label>
        <label class="field">
          <span>Delivery notes (optional)</span>
          <input id="coNotes" type="text" placeholder="Landmarks, gate code, etc." value="${esc(valNotes)}">
        </label>
      </section>

      <section class="check-section">
        <h3>Delivery</h3>
        <div class="delivery-quote"><b id="deliveryLabel">${esc(delivery.label)}</b></div>
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
            <span>${esc(it.product.name)} × ${it.qty}</span>
            <b>${esc(formatPrice(it.product.price * it.qty))}</b>
          </div>`).join('')}
        </div>
        <div class="summary-totals">
          <div class="row"><span>Subtotal</span><b>${esc(formatPrice(subtotal))}</b></div>
          <div class="row"><span>Delivery</span><b id="coDeliveryFee">${delivery.fee === 0 ? 'FREE' : esc(formatPrice(delivery.fee))}</b></div>
          ${disc.amount > 0 ? `<div class="row"><span>Discount</span><b>− ${esc(formatPrice(disc.amount))}</b></div>` : ''}
          <div class="row total"><span>Total</span><b id="coTotal">${esc(formatPrice(total))}</b></div>
        </div>
      </section>
    </div>

    <div class="checkout-cta-bar">
      <button id="placeOrderBtn" class="place-order-btn" type="button">Place Order · ${esc(formatPrice(total))}</button>
    </div>`;

  host.querySelector('.checkout-back')?.addEventListener('click', closeCheckoutScreen);
  host.querySelectorAll('.pay-option').forEach(p => p.addEventListener('click', () => {
    _selectedPay = p.dataset.pay;
    renderCheckout(host, session);
  }));
  renderPayInfo(host.querySelector('#payInfoBox'), _selectedPay, total);

  host.querySelector('#placeOrderBtn')?.addEventListener('click', () => placeOrder(host));
  refreshDelivery(host);
}

function renderPayInfo(box, method, totalPHP) {
  if (!box) return;
  const ss = getStoreSettings();
  if (method === 'gcash' || method === 'maya') {
    const num   = method === 'gcash' ? ss?.gcash_number : ss?.maya_number;
    const qrUrl = method === 'gcash' ? ss?.gcash_qr_url : ss?.maya_qr_url;
    const name  = ss?.store_name || "Mr. Beanie's Greenies";
    box.innerHTML = `<div class="pay-info">
      <h4>${method === 'gcash' ? 'GCash' : 'Maya'} Payment</h4>
      <div class="pay-row"><span>Account name</span><b>${esc(name)}</b></div>
      <div class="pay-row"><span>Number</span><b>${esc(num || 'See QR')}</b></div>
      ${qrUrl ? `<img class="pay-qr" src="${esc(qrUrl)}" alt="QR code"/>` : ''}
      <p class="pay-note">After paying, upload your receipt screenshot below.</p>
      <input type="file" id="receiptFile" accept="image/png,image/jpeg,image/jpg,image/webp"/>
    </div>`;
    return;
  }
  if (method === 'bank_transfer') {
    box.innerHTML = `<div class="pay-info">
      <h4>Bank Transfer</h4>
      <div class="pay-row"><span>Bank</span><b>${esc(ss?.bank_name || '—')}</b></div>
      <div class="pay-row"><span>Account name</span><b>${esc(ss?.bank_account_name || ss?.store_name || 'Mr. Beanies Greenies')}</b></div>
      <div class="pay-row"><span>Account number</span><b>${esc(ss?.bank_account_number || '—')}</b></div>
      ${ss?.bank_qr_url ? `<img class="pay-qr" src="${esc(ss.bank_qr_url)}" alt="Bank QR"/>` : ''}
      <p class="pay-note">After transferring, upload your receipt below.</p>
      <input type="file" id="receiptFile" accept="image/png,image/jpeg,image/jpg,image/webp"/>
    </div>`;
    return;
  }
  if (method === 'usdt') {
    renderUSDTPayment(box);
    return;
  }
  box.innerHTML = '';
}

// ── USDT payment rendering ──────────────────────────────────
function renderUSDTPayment(box) {
  if (!box) return;
  const ss = getStoreSettings();
  const networks = [
    { id: 'erc20',   label: 'ERC-20 (Ethereum)', color: '#627EEA' },
    { id: 'trc20',   label: 'TRC-20 (TRON)',     color: '#EB0029' },
    { id: 'bep20',   label: 'BEP-20 (BSC)',      color: '#F0B90B' },
    { id: 'polygon', label: 'Polygon (MATIC)',   color: '#8247E5' },
  ];
  const walletAddress = ss?.crypto_usdt_address || ss?.usdt_wallet_address || '';
  const qrUrl         = ss?.crypto_qr_url || ss?.usdt_qr_url || '';
  box.innerHTML = `<div class="pay-info usdt-block">
    <h4>USDT Payment</h4>
    <div class="usdt-rate" id="usdtRate">Fetching live rate…</div>
    <div class="usdt-network-label">Select network:</div>
    <div class="usdt-network-grid">
      ${networks.map((n, i) => `
        <label class="usdt-network-option${i === 0 ? ' selected' : ''}">
          <input type="radio" name="usdtNetwork" value="${esc(n.id)}" ${i === 0 ? 'checked' : ''}/>
          <span class="usdt-network-dot" style="background:${esc(n.color)}"></span>
          <span class="usdt-network-name">${esc(n.label)}</span>
        </label>`).join('')}
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

  // Network selection highlight
  box.querySelectorAll('.usdt-network-option').forEach(opt => {
    opt.addEventListener('click', () => {
      box.querySelectorAll('.usdt-network-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });

  // Copy wallet address to clipboard
  box.querySelector('#usdtCopyBtn')?.addEventListener('click', async () => {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      const btn = box.querySelector('#usdtCopyBtn');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
    } catch(_) { showToast('Copy failed — select the address manually'); }
  });

  // Live PHP rate from CoinGecko
  fetchUSDTPHPRate(box);
}

async function fetchUSDTPHPRate(box) {
  let phpRate = null;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=php',
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
}

async function placeOrder(host) {
  const name  = host.querySelector('#coName').value.trim();
  const phone = normalisePhone(host.querySelector('#coPhone').value.trim() || getAuthPhone() || '');
  const addr  = host.querySelector('#coAddr').value.trim();
  const notes = host.querySelector('#coNotes').value.trim();
  const promo = host.querySelector('#coPromo').value.trim().toUpperCase() || null;

  if (!name)  { showToast('Please enter your name'); return; }
  if (!isValidPHPhone(phone)) { showToast('Enter a valid PH mobile number'); return; }
  if (!addr || addr.length < 10) { showToast('Please enter a complete delivery address'); return; }

  const items = getCartItems();
  if (!items.length) { showToast('Your bag is empty'); return; }

  const subtotal = getSubtotal();
  const disc     = getDiscount();
  const ss = getStoreSettings();
  const delivery = computeDelivery(ss, subtotal);
  const finalFee = delivery.fee;
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
  btn.disabled = true;
  btn.dataset.label = btn.textContent;
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
      customer_name:    name,
      customer_phone:   phone,
      delivery_address: addr,
      delivery_zone:    getSelectedCoords() ? 'distance' : 'estimated',
      delivery_fee:     finalFee,
      subtotal:         Number(subtotal.toFixed(2)),
      total:            Number(total.toFixed(2)),
      discount_amount:  Number(disc.amount.toFixed(2)),
      promo_code:       promo,
      payment_method:   _selectedPay,
      receipt_url:      receiptUrl,
      notes:            notes || null,
      items: items.map(({ product: p, qty }) => ({
        id: p.id, name: p.name, emoji: p.emoji || '🌿',
        price: Number(p.price), qty, quantity: qty,
        image_url: p.image_url || p.image || null
      }))
    };

    // Attach delivery coordinates only if the customer picked a Nominatim
    // suggestion — a manually typed address still places the order fine.
    const coords = getSelectedCoords();
    if (coords) {
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
    if (!resp.ok || data.error) throw new Error(data.error || `Order failed (${resp.status})`);

    logActivity('order_placed', {
      order_number: data.order_number, total, items_count: items.length, payment_method: _selectedPay
    });

    // Show success screen immediately with a "pending" verification badge
    showSuccessScreen(data.order_number, items, total);
    clearCart();
    closeCheckoutScreen();

    // Verify receipt in background — badge updates when done
    if (needsReceipt && receiptFile) {
      verifyReceipt(data.order_number, _selectedPay, receiptFile)
        .then(result => updateVerificationBadge(data.order_number, result))
        .catch(() => updateVerificationBadge(data.order_number, { status: 'manual_review' }));
    }
  } catch(e) {
    console.error('[checkout] placeOrder error', e);
    showToast(e.message || 'Order failed.');
  } finally {
    btn.disabled = false;
    btn.textContent = btn.dataset.label || 'Place Order';
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
  if (!badge) return;
  const { status, mismatch_reason } = result || {};
  if (status === 'verified') {
    badge.className = 'verify-badge verified';
    badge.innerHTML = '&#10003; Payment verified';
  } else if (status === 'mismatch') {
    badge.className = 'verify-badge mismatch';
    badge.innerHTML = `&#9888; Amount mismatch &mdash; ${mismatch_reason || 'please contact us'}`;
  } else {
    badge.className = 'verify-badge review';
    badge.innerHTML = '&#8987; Receipt sent for manual review';
  }
}


// ── Success screen ──────────────────────────────────────────
export function showSuccessScreen(orderNum, items, total) {
  let host = document.getElementById('successScreen');
  if (!host) {
    host = document.createElement('section');
    host.id = 'successScreen';
    host.className = 'success-screen';
    document.body.appendChild(host);
  }
  const summary = items.map(i => `${i.product.emoji || '🌿'} ${i.product.name} ×${i.qty}`).join(', ');
  host.innerHTML = `
    <div class="success-card">
      <div class="success-icon">&#10003;</div>
      <h2>Order placed</h2>
      <p class="success-num">#${esc(orderNum || '—')}</p>
      <div class="success-items">${esc(summary)}</div>
      <div class="success-total">${esc(formatPrice(total))}</div>
      <div id="verify-badge-${esc(orderNum)}" class="verify-badge pending">&#8987; Verifying your receipt&hellip;</div>
      <p class="success-note">We&rsquo;ll prepare your order and message you when it&rsquo;s on the way. Salamat!</p>
      <div class="success-actions">
        <button id="successKeepShopping" type="button" class="btn-ghost">Keep shopping</button>
        <button id="successTrack" type="button" class="btn-primary">Track my orders</button>
      </div>
    </div>`;
  host.classList.add('open');
  openOverlay('successScreen', () => host.classList.remove('open'));
  host.querySelector('#successKeepShopping')?.addEventListener('click', () => {
    host.classList.remove('open');
    closeOverlay('successScreen');
  });
  host.querySelector('#successTrack')?.addEventListener('click', () => {
    host.classList.remove('open');
    closeOverlay('successScreen');
    document.dispatchEvent(new CustomEvent('mbg:openTracking'));
  });
}

// Wire global event hook
document.addEventListener('mbg:openCheckout', () => openCheckoutScreen());
