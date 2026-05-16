/* MBG Storefront v2 — Order Tracking */
import { sb } from '../core/supabase.js';
import { esc, formatPrice, normalisePhone, isValidPHPhone, openOverlay, closeOverlay, parseItems, timeAgo, showToast } from '../core/utils.js';
import { getAuthPhone } from '../core/auth.js';

const STATUS_LABELS = {
  pending:'Pending', confirmed:'Confirmed', preparing:'Preparing',
  out_for_delivery:'On the way', completed:'Delivered', cancelled:'Cancelled'
};

let _channel = null;
let _orders = [];

export function openTrackingScreen(initialPhone) {
  let host = document.getElementById('trackingScreen');
  if (!host) {
    host = document.createElement('section');
    host.id = 'trackingScreen';
    host.className = 'tracking-screen';
    document.body.appendChild(host);
  }
  renderShell(host, initialPhone || getAuthPhone() || '');
  host.classList.add('open');
  document.body.classList.add('lock-scroll');
  openOverlay('trackingScreen', () => closeTrackingScreen());

  // Auto-load if we already have a phone
  const phone = initialPhone || getAuthPhone();
  if (phone) loadOrders(host, phone);
}

export function closeTrackingScreen() {
  const host = document.getElementById('trackingScreen');
  if (!host) return;
  host.classList.remove('open');
  document.body.classList.remove('lock-scroll');
  closeOverlay('trackingScreen');
  if (_channel) { try { sb().removeChannel(_channel); } catch(_) {} _channel = null; }
}

function renderShell(host, phone) {
  host.innerHTML = `
    <div class="tracking-inner">
      <header class="checkout-header">
        <button class="checkout-back" aria-label="Back">←</button>
        <h2>My Orders</h2>
        <span class="checkout-spacer"></span>
      </header>
      <section class="check-section">
        <label class="field">
          <span>Phone number</span>
          <input id="trkPhone" type="tel" inputmode="tel" placeholder="+63 9XX XXX XXXX" value="${esc(phone)}"/>
        </label>
        <button id="trkLookup" class="btn-primary" type="button">Find my orders</button>
      </section>
      <div id="trkResults" class="trk-results"></div>
    </div>`;
  host.querySelector('.checkout-back')?.addEventListener('click', closeTrackingScreen);
  host.querySelector('#trkLookup')?.addEventListener('click', () => {
    const v = host.querySelector('#trkPhone').value.trim();
    if (!isValidPHPhone(v)) { showToast('Enter a valid PH number'); return; }
    loadOrders(host, normalisePhone(v));
  });
}

async function loadOrders(host, phone) {
  const list = host.querySelector('#trkResults');
  if (!list) return;
  list.innerHTML = `<div class="loading">Looking up your orders…</div>`;
  try {
    const { data, error } = await sb().from('orders')
      .select('*')
      .or(`customer_phone.eq.${phone},contact.eq.${phone}`)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    _orders = data || [];
    renderOrders(list, _orders);
    subscribeToOrders(phone, list);
  } catch(e) {
    console.warn('[tracking] orders fetch failed', e);
    list.innerHTML = `<div class="empty">Could not load orders. Please try again.</div>`;
  }
}

function subscribeToOrders(phone, list) {
  if (_channel) { try { sb().removeChannel(_channel); } catch(_) {} _channel = null; }
  _channel = sb().channel('mbg-tracking')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, (payload) => {
      const upd = payload.new;
      if (!upd) return;
      if (upd.customer_phone !== phone && upd.contact !== phone) return;
      const i = _orders.findIndex(o => o.id === upd.id);
      if (i >= 0) _orders[i] = { ..._orders[i], ...upd };
      else _orders.unshift(upd);
      renderOrders(list, _orders);
    })
    .subscribe();
}

function renderOrders(list, orders) {
  if (!orders.length) {
    list.innerHTML = `<div class="empty">
      <div class="empty-emoji">📦</div>
      <div>No orders yet for this number.</div>
    </div>`;
    return;
  }
  list.innerHTML = orders.map(o => {
    const items = parseItems(o.items);
    const summary = items.length
      ? items.slice(0,2).map(i => `${i.emoji||'🌿'} ${i.name||''} ×${i.qty||i.quantity||1}`).join(', ') +
        (items.length > 2 ? `, +${items.length-2} more` : '')
      : '—';
    const status = o.order_status || 'pending';
    return `<article class="ord-card status-${esc(status)}">
      <header>
        <span class="ord-num">#${esc(o.order_number || o.id.slice(0,8))}</span>
        <span class="ord-badge">${esc(STATUS_LABELS[status] || status)}</span>
      </header>
      <div class="ord-summary">${esc(summary)}</div>
      <footer>
        <span class="ord-total">${esc(formatPrice(o.total||0))}</span>
        <span class="ord-time">${esc(timeAgo(o.created_at))}</span>
      </footer>
      <div class="ord-addr">${esc(o.delivery_address || '')}</div>
    </article>`;
  }).join('');
}

document.addEventListener('mbg:openTracking', () => openTrackingScreen());

