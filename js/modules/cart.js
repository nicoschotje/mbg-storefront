/* MBG Storefront v2 — Cart module */
import { sb } from '../core/supabase.js';
import { esc, formatPrice, openOverlay, closeOverlay, showToast } from '../core/utils.js';
import { DEFAULT_FREE_DELIVERY_THRESHOLD } from '../core/config.js';
import { getStoreSettings } from './banners.js?v=20260518-mobile';

// In-memory cart  { [productId]: { product, qty } }
let _cart = {};
let _appliedPromo = null;     // string code applied
let _autoDiscount = null;     // auto-apply rule
let _discountRules = [];      // loaded from DB

const subscribers = [];
export function onCartChange(fn) {
  subscribers.push(fn);
  return () => { const i = subscribers.indexOf(fn); if (i>=0) subscribers.splice(i,1); };
}
function emit() { subscribers.forEach(fn => { try { fn(); } catch(_){} }); }

export function getCartItems()    { return Object.values(_cart); }
export function getCartCount()    { return Object.values(_cart).reduce((s,i)=>s+i.qty,0); }
export function getCartProduct(id){ return _cart[id]; }
export function getAppliedPromo() { return _appliedPromo; }

export function freeDeliveryThreshold() {
  const ss = getStoreSettings();
  return Number(ss?.free_delivery_threshold) || DEFAULT_FREE_DELIVERY_THRESHOLD;
}

export function getSubtotal() {
  return getCartItems().reduce((s,i) => s + Number(i.product.price||0) * i.qty, 0);
}

export function getDiscount() {
  const sub = getSubtotal();
  return calcDiscount(sub, _appliedPromo);
}

// ── Mutations ────────────────────────────────────────────────
export function addToCart(product, qty = 1) {
  if (!product || !product.id) return;
  if (!_cart[product.id]) _cart[product.id] = { product, qty: 0 };
  _cart[product.id].qty = Math.max(0, (_cart[product.id].qty || 0) + qty);
  if (_cart[product.id].qty === 0) delete _cart[product.id];
  emit();
  if (qty > 0) {
    showToast(`${product.name} added to bag`);
    // Pulse the cart count badge — tactile feedback
    const badge = document.getElementById('cartCountHeader');
    if (badge && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      badge.classList.remove('bumped');
      // Force reflow so the animation can re-trigger on rapid adds
      // eslint-disable-next-line no-unused-expressions
      void badge.offsetWidth;
      badge.classList.add('bumped');
      setTimeout(() => badge.classList.remove('bumped'), 700);
    }
  }
}
export function setQty(productId, qty) {
  if (!_cart[productId]) return;
  qty = Math.max(0, Math.floor(qty || 0));
  if (qty === 0) delete _cart[productId];
  else _cart[productId].qty = qty;
  emit();
}
export function removeItem(productId) { delete _cart[productId]; emit(); }
export function clearCart() { _cart = {}; _appliedPromo = null; emit(); }

// ── Promo / discount loading ────────────────────────────────
export async function loadDiscountRules() {
  try {
    const { data } = await sb().from('discount_rules')
      .select('*').eq('is_active', true).order('min_order_amount');
    _discountRules = data || [];
  } catch(_) { _discountRules = []; }
  return _discountRules;
}

export function calcDiscount(subtotal, promoCode) {
  if (promoCode) {
    const code = String(promoCode).toUpperCase();
    const rule = _discountRules.find(r => r.promo_code && r.promo_code.toUpperCase() === code && subtotal >= (r.min_order_amount || 0));
    if (rule) {
      const amt = rule.discount_type === 'percent' ? subtotal * rule.discount_value/100 : rule.discount_value;
      return { rule, amount: amt, source: 'promo' };
    }
    return { rule: null, amount: 0, source: 'promo_invalid' };
  }
  // Auto-apply highest qualifying non-promo rule
  const eligible = _discountRules.filter(r => !r.promo_code && subtotal >= (r.min_order_amount || 0));
  if (!eligible.length) return { rule: null, amount: 0, source: 'none' };
  let best = eligible[0]; let bestAmt = -1;
  for (const r of eligible) {
    const amt = r.discount_type === 'percent' ? subtotal * r.discount_value/100 : r.discount_value;
    if (amt > bestAmt) { bestAmt = amt; best = r; }
  }
  return { rule: best, amount: bestAmt, source: 'auto' };
}

export function applyPromo(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) { _appliedPromo = null; emit(); return { ok: true, source: 'cleared' }; }
  const sub = getSubtotal();
  const d = calcDiscount(sub, c);
  if (d.source === 'promo') {
    _appliedPromo = c;
    emit();
    return { ok: true, amount: d.amount, source: 'promo' };
  }
  _appliedPromo = null;
  emit();
  return { ok: false, source: 'promo_invalid' };
}

// ── Drawer rendering ────────────────────────────────────────
export function bindCartTriggers({ openBtnSel, drawerId, countEl }) {
  const drawer = document.getElementById(drawerId);
  document.querySelectorAll(openBtnSel).forEach(b => b.addEventListener('click', () => openCart(drawer)));
  // Re-render on cart changes
  onCartChange(() => {
    if (countEl) {
      const n = getCartCount();
      countEl.textContent = String(n);
      countEl.style.display = n > 0 ? 'inline-flex' : 'none';
    }
    if (drawer && drawer.classList.contains('open')) renderCartDrawer(drawer);
  });
}

export function openCart(drawer) {
  if (!drawer) return;
  renderCartDrawer(drawer);
  drawer.classList.add('open');
  document.body.classList.add('lock-scroll');
  openOverlay('cartDrawer', () => closeCart(drawer));
}
export function closeCart(drawer) {
  if (!drawer) drawer = document.getElementById('cartDrawer');
  if (!drawer) return;
  drawer.classList.remove('open');
  document.body.classList.remove('lock-scroll');
  closeOverlay('cartDrawer');
}

function renderCartDrawer(drawer) {
  const items    = getCartItems();
  const subtotal = getSubtotal();
  const disc     = getDiscount();
  const fdt      = freeDeliveryThreshold();
  const remaining = Math.max(0, fdt - subtotal);
  const pct = fdt > 0 ? Math.min(100, (subtotal / fdt) * 100) : 0;

  drawer.innerHTML = `
    <div class="cart-panel">
      <div class="cart-header">
        <h3>Your Bag</h3>
        <button class="cart-close" aria-label="Close">×</button>
      </div>

      <div class="free-deliv-progress">
        <div class="fdp-text">${remaining > 0
          ? `Add <b>${esc(formatPrice(remaining))}</b> more for <b>free delivery</b>`
          : `<b>You&rsquo;ve unlocked free delivery</b>`}</div>
        <div class="fdp-bar"><div class="fdp-fill" style="width:${pct}%"></div></div>
      </div>

      <div class="cart-items">
        ${items.length === 0
          ? `<div class="cart-empty">
                <div class="cart-empty-icon">🛍️</div>
                <div class="cart-empty-text">Your bag is empty</div>
              </div>`
          : items.map(it => `
            <div class="cart-row" data-id="${esc(it.product.id)}">
              <div class="cart-row-img">${it.product.image_url || it.product.image
                ? `<img src="${esc(it.product.image_url || it.product.image)}" alt=""/>`
                : `<div class="cart-row-fallback">${esc(it.product.emoji || '🌿')}</div>`}</div>
              <div class="cart-row-mid">
                <div class="cart-row-name">${esc(it.product.name)}</div>
                <div class="cart-row-price">${esc(formatPrice(it.product.price))}</div>
              </div>
              <div class="cart-qty">
                <button class="qb minus" data-id="${esc(it.product.id)}">−</button>
                <span class="qn">${it.qty}</span>
                <button class="qb plus" data-id="${esc(it.product.id)}">+</button>
              </div>
            </div>`).join('')}
      </div>

      ${items.length > 0 ? `
      <div class="promo-row">
        <input id="promoInput" type="text" maxlength="20" placeholder="Promo code" value="${esc(_appliedPromo||'')}"/>
        <button id="applyPromoBtn" type="button">Apply</button>
      </div>
      <div id="promoMsg" class="promo-msg ${disc.source==='promo'?'ok':disc.source==='promo_invalid'?'err':''}">
        ${disc.source==='promo' ? `Promo applied — saved ${esc(formatPrice(disc.amount))}` :
          disc.source==='promo_invalid' ? `Invalid or ineligible promo` :
          disc.source==='auto' ? `Auto-discount: ${esc(disc.rule?.label || 'Promo')} − ${esc(formatPrice(disc.amount))}` : ''}
      </div>

      <div class="cart-totals">
        <div class="row"><span>Subtotal</span><b>${esc(formatPrice(subtotal))}</b></div>
        ${disc.amount > 0 ? `<div class="row"><span>Discount</span><b>− ${esc(formatPrice(disc.amount))}</b></div>` : ''}
      </div>

      <div class="cart-cta">
        <button id="cartCheckoutBtn" class="cart-checkout-btn" type="button">Checkout · ${esc(formatPrice(Math.max(0, subtotal - disc.amount)))}</button>
      </div>` : ''}
    </div>`;

  drawer.querySelector('.cart-close')?.addEventListener('click', () => closeCart(drawer));
  drawer.querySelectorAll('.qb.plus').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id; if (_cart[id]) addToCart(_cart[id].product, 1);
  }));
  drawer.querySelectorAll('.qb.minus').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.id; if (_cart[id]) addToCart(_cart[id].product, -1);
  }));
  const applyBtn = drawer.querySelector('#applyPromoBtn');
  applyBtn?.addEventListener('click', () => {
    const v = drawer.querySelector('#promoInput').value;
    const r = applyPromo(v);
    if (!r.ok) showToast('Invalid or ineligible promo code');
    else if (r.source === 'promo') showToast('Promo applied');
    renderCartDrawer(drawer);
  });
  drawer.querySelector('#cartCheckoutBtn')?.addEventListener('click', () => {
    closeCart(drawer);
    document.dispatchEvent(new CustomEvent('mbg:openCheckout'));
  });
}
