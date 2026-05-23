/* MBG Storefront v2 — Order Tracking */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON } from '../core/config.js';
import { esc, formatPrice, normalisePhone, isValidPHPhone, openOverlay, closeOverlay, parseItems, timeAgo, showToast } from '../core/utils.js';
import { getAuthPhone } from '../core/auth.js';

// Friendly, customer-facing labels for the dashboard's order_status values.
const STATUS_LABELS = {
  pending:'Order received', confirmed:'Confirmed', preparing:'Preparing your order',
  out_for_delivery:'Out for delivery', completed:'Delivered', cancelled:'Cancelled'
};

let _orders = [];

// Realtime postgres_changes was removed: its websocket cannot send the
// x-customer-phone request header that orders_anon_select_own RLS requires,
// so broadcasts never reach this client. We poll the REST endpoint instead.
const POLL_MS = 15000;
let _pollTimer = null;
let _pollCtx = null;   // { list, phone } while the tracking screen is open

// Order lookups run against RLS policy orders_anon_select_own, which requires
// the customer's phone in an x-customer-phone request header. The shared sb()
// client does not set it, so tracking builds its own client scoped to the
// phone once it is known — used for both the REST SELECT and Realtime.
let _scoped = null;
let _scopedPhone = null;

function scopedClient(phone) {
  if (_scoped && _scopedPhone === phone) return _scoped;
  _scoped = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-customer-phone': phone } }
  });
  _scopedPhone = phone;
  return _scoped;
}

// Same SELECT used by the initial load and every poll tick.
async function queryOrders(phone) {
  const client = scopedClient(phone);
  const { data, error } = await client.from('orders')
    .select('*')
    .or(`customer_phone.eq.${phone},contact.eq.${phone}`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

export function openTrackingScreen(initialPhone) {
  let host = document.getElementById('trackingScreen');
  if (!host) {
    host = document.createElement('section');
    host.id = 'trackingScreen';
    host.className = 'tracking-screen';
    document.body.appendChild(host);
  }
  // The logged-in identity always wins over a passed-in phone (Path B > Path A).
  // As a final fallback, use the phone saved by the last placed order this
  // session, so My Orders auto-loads even when the customer reaches it without
  // tapping "Track my orders".
  let lastOrderPhone = '';
  try { lastOrderPhone = localStorage.getItem('mbg_last_order_phone') || ''; } catch(_) {}
  const knownPhone = getAuthPhone() || initialPhone || lastOrderPhone || '';
  renderShell(host, knownPhone);
  host.classList.add('open');
  document.body.classList.add('lock-scroll');
  openOverlay('trackingScreen', () => closeTrackingScreen());

  // Phone already known (logged-in or post-checkout handoff) — skip the gate.
  if (knownPhone) loadOrders(host, normalisePhone(knownPhone));
}

export function closeTrackingScreen() {
  const host = document.getElementById('trackingScreen');
  if (!host) return;
  host.classList.remove('open');
  document.body.classList.remove('lock-scroll');
  closeOverlay('trackingScreen');
  stopPolling();
}

function renderShell(host, phone) {
  // Gate is shown only for anonymous lookups (Path C). When the phone is
  // already known the orders list renders immediately with a loading state.
  const gated = !phone;
  host.innerHTML = `
    <div class="tracking-inner">
      <header class="checkout-header">
        <button class="checkout-back" aria-label="Back">←</button>
        <h2>My Orders</h2>
        <span class="checkout-spacer"></span>
      </header>
      ${gated ? `
      <section class="check-section">
        <p class="trk-hint">Enter the phone number you used at checkout.</p>
        <label class="field">
          <span>Phone number</span>
          <input id="trkPhone" type="tel" inputmode="tel" placeholder="+63 9XX XXX XXXX"/>
        </label>
        <button id="trkLookup" class="btn-primary" type="button">Find my orders</button>
      </section>` : ''}
      <div id="trkResults" class="trk-results">${gated ? '' : '<div class="loading">Looking up your orders…</div>'}</div>
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
    _orders = await queryOrders(phone);
    renderOrders(list, _orders);
    startPolling(list, phone);
  } catch(e) {
    console.warn('[tracking] orders fetch failed', e);
    list.innerHTML = `<div class="empty">Could not load orders. Please try again.</div>`;
  }
}

// Visibility-aware polling — replaces the Realtime subscription.
function startPolling(list, phone) {
  _pollCtx = { list, phone };
  if (!document.hidden) resumePolling();
}

function resumePolling() {
  if (_pollTimer || !_pollCtx) return;
  _pollTimer = setInterval(refetchOrders, POLL_MS);
}

function pausePolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function stopPolling() {
  pausePolling();
  _pollCtx = null;
}

async function refetchOrders() {
  if (!_pollCtx) return;
  const { list, phone } = _pollCtx;
  if (!list.isConnected) { stopPolling(); return; }
  try {
    _orders = await queryOrders(phone);
    renderOrders(list, _orders);
  } catch(e) {
    console.warn('[tracking] poll refetch failed', e);
  }
}

// Pause polling while the tab is backgrounded; resume on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pausePolling();
  else resumePolling();
});

function renderOrders(list, orders) {
  if (!orders.length) {
    list.innerHTML = `<div class="empty">
      <div class="empty-emoji">📦</div>
      <div>No orders yet for this number.</div>
    </div>`;
    return;
  }
  list.innerHTML = orders.map(o => {
    // Schema contract: READ from order_items (the new canonical column);
    // fall back to legacy items column for older rows still in flight.
    const items = parseItems(o.order_items || o.items);
    const summary = items.length
      ? items.slice(0,2).map(i => `${i.emoji||'🌿'} ${i.name||''} ×${i.qty||i.quantity||1}`).join(', ') +
        (items.length > 2 ? `, +${items.length-2} more` : '')
      : '—';
    // order_status is the source of truth (kept in sync by a DB trigger).
    const status = o.order_status || 'pending';
    const updatedTs = o.status_updated_at || o.created_at;
    return `<article class="ord-card status-${esc(status)}">
      <header>
        <span class="ord-num">#${esc(o.order_number || (o.id || '').slice(0,8))}</span>
        <span class="ord-badge">${esc(STATUS_LABELS[status] || status)}</span>
      </header>
      <div class="ord-summary">${esc(summary)}</div>
      <footer>
        <span class="ord-total">${esc(formatPrice(o.total||0))}</span>
        <span class="ord-time">${esc(timeAgo(o.created_at))}</span>
      </footer>
      <div class="ord-updated">Updated ${esc(timeAgo(updatedTs))}</div>
      <div class="ord-addr">${esc(o.delivery_address || '')}</div>
    </article>`;
  }).join('');
}

document.addEventListener('mbg:openTracking', (e) => openTrackingScreen(e?.detail?.phone));

// Checkout fires mbg:orderPlaced right after a successful place-order. If
// the tracking screen is already mounted (e.g. the customer opened it once
// during the session) the in-memory list would otherwise show stale data
// until the next 15s poll tick — refetch immediately so the new order is
// visible the moment the customer taps "Track my orders".
document.addEventListener('mbg:orderPlaced', (e) => {
  const phone = e?.detail?.phone;
  if (!phone) return;
  if (_pollCtx) {
    // Tracking already open — reuse its DOM target and refetch now.
    _pollCtx.phone = normalisePhone(phone);
    refetchOrders();
  }
});
