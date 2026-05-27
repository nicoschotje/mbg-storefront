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

// localStorage key — survives reloads (including iOS pull-to-refresh)
// so the customer never loses their bag mid-flow.
const CART_STORAGE_KEY = 'mbg_cart';

// Reads any previously-persisted cart on module load. Wrapped in try/catch
// because Safari Private Mode throws on localStorage access.
(function restoreCartFromStorage() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      // Only the cart map + applied promo are persisted; everything else
      // (discount rules, free-delivery threshold) is derived from DB.
      if (saved.cart && typeof saved.cart === 'object') _cart = saved.cart;
      if (typeof saved.promo === 'string') _appliedPromo = saved.promo;
    }
  } catch(_) { /* ignore — corrupted or unavailable storage */ }
})();

// Snapshots the current cart to localStorage. Called from every mutation
// path (addToCart, setQty, removeItem, applyPromo, clearCart) so a reload
// triggered by iOS pull-to-refresh, tab restore, or PWA relaunch keeps the bag.
function persistCart() {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify({
      cart: _cart,
      promo: _appliedPromo
    }));
  } catch(_) { /* storage full / private mode — silently degrade to in-memory */ }
}

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
  return Number(ss?.free_delivery_min) || DEFAULT_FREE_DELIVERY_THRESHOLD;
}

export function freeDeliveryEnabled() {
  const ss = getStoreSettings();
  return ss?.free_delivery_enabled !== false; // default ON if column missing/null
}

// Price helper — variants may override the parent price.
export function priceForItem(item) {
  if (item?.variant && item.variant.price_override != null) {
    return Number(item.variant.price_override) || 0;
  }
  return Number(item?.product?.price || 0);
}

// Display name helper — "Exhale 1g — Blue Dream" for variants, parent name otherwise.
export function displayNameForItem(item) {
  if (item?.variant?.name) return `${item.product.name} — ${item.variant.name}`;
  return item?.product?.name || '';
}

export function getSubtotal() {
  return getCartItems().reduce((s,i) => s + priceForItem(i) * i.qty, 0);
}

export function getDiscount() {
  const sub = getSubtotal();
  return calcDiscount(sub, _appliedPromo);
}

// ── Mutations ────────────────────────────────────────────────
// `variant` is optional. When present, the same parent product can sit in
// the cart multiple times under different cart keys (one per variant), so
// the cart key is composite: `<parent_id>_<variant_id>`. For plain products
// the key stays equal to product.id, preserving every existing call site.
export function addToCart(product, qty = 1, variant = null) {
  if (!product || !product.id) return;
  const cartKey = variant ? `${product.id}_${variant.id}` : product.id;
  if (!_cart[cartKey]) _cart[cartKey] = { product, qty: 0, variant: variant || null };
  _cart[cartKey].qty = Math.max(0, (_cart[cartKey].qty || 0) + qty);
  if (_cart[cartKey].qty === 0) delete _cart[cartKey];
  persistCart(); // snapshot to localStorage so a refresh doesn't wipe the bag
  emit();
  if (qty > 0) {
    const label = variant ? `${product.name} — ${variant.name}` : product.name;
    showToast(`${label} added to bag`);
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
  persistCart(); // mirror the new quantity to localStorage
  emit();
}
export function removeItem(productId) {
  delete _cart[productId];
  persistCart(); // mirror removal to localStorage
  emit();
}
export function clearCart() {
  _cart = {};
  _appliedPromo = null;
  // Order placed (or cart manually emptied) — drop the persisted copy
  // so a subsequent reload doesn't restore a stale bag.
  try { localStorage.removeItem(CART_STORAGE_KEY); } catch(_) {}
  emit();
}

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
  if (!c) { _appliedPromo = null; persistCart(); emit(); return { ok: true, source: 'cleared' }; }
  const sub = getSubtotal();
  const d = calcDiscount(sub, c);
  if (d.source === 'promo') {
    _appliedPromo = c;
    persistCart(); // promo is part of the cart snapshot
    emit();
    return { ok: true, amount: d.amount, source: 'promo' };
  }
  _appliedPromo = null;
  persistCart();
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
  const fdEnabled = freeDeliveryEnabled();
  const fdt       = freeDeliveryThreshold();
  const remaining = Math.max(0, fdt - subtotal);
  const pct       = fdt > 0 ? Math.min(100, (subtotal / fdt) * 100) : 0;

  drawer.innerHTML = `
    <div class="cart-panel">
      <div class="cart-header">
        <h3>Your Bag</h3>
        <button class="cart-close" aria-label="Close">×</button>
      </div>

      ${fdEnabled ? `
<div class="free-deliv-progress">
  <div class="fdp-text">${remaining > 0
    ? `Add <b>${esc(formatPrice(remaining))}</b> more for <b>free delivery</b>`
    : `<b>You&rsquo;ve unlocked free delivery</b>`}</div>
  <div class="fdp-bar"><div class="fdp-fill" style="width:${pct}%"></div></div>
</div>` : ''}

      <div class="cart-items">
        ${items.length === 0
          ? `<div class="cart-empty">
                <div class="cart-empty-icon">🛍️</div>
                <div class="cart-empty-text">Your bag is empty</div>
              </div>`
          : items.map(it => {
            const key = it.variant ? `${it.product.id}_${it.variant.id}` : it.product.id;
            return `
            <div class="cart-row" data-id="${esc(key)}">
              <div class="cart-row-img">${it.product.image_url || it.product.image
                ? `<img src="${esc(it.product.image_url || it.product.image)}" alt=""/>`
                : `<div class="cart-row-fallback">${esc(it.product.emoji || '🌿')}</div>`}</div>
              <div class="cart-row-mid">
                <div class="cart-row-name">${esc(displayNameForItem(it))}</div>
                <div class="cart-row-price">${esc(formatPrice(priceForItem(it)))}</div>
              </div>
              <div class="cart-qty">
                <button class="qb minus" data-id="${esc(key)}">−</button>
                <span class="qn">${it.qty}</span>
                <button class="qb plus" data-id="${esc(key)}">+</button>
              </div>
            </div>`;
          }).join('')}
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
    const key = b.dataset.id; const entry = _cart[key];
    if (entry) addToCart(entry.product, 1, entry.variant || null);
  }));
  drawer.querySelectorAll('.qb.minus').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.id; const entry = _cart[key];
    if (entry) addToCart(entry.product, -1, entry.variant || null);
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
