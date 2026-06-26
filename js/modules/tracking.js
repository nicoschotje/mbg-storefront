/* MBG Storefront v2 — Order Tracking / My Orders
 *
 * Phase 1: account-based visibility. Orders are read ONLY through the
 * get_my_orders() RPC — never by phone matching (the old privacy leak where
 * any recipient phone granted read access is gone).
 *
 *   * Logged-in account  -> get_my_orders(session_token)  → orders the account
 *     OWNS (orders.order_owner_id), regardless of the recipient phone.
 *   * Guest / this device -> get_my_orders(null, order_ids) where order_ids are
 *     the unguessable order uuids placed on this device (capability tokens).
 *
 * Both paths are combined: a logged-in customer also sees any orders they
 * placed on this device before signing in.
 */
import { sb } from '../core/supabase.js';
import { esc, formatPrice, openOverlay, closeOverlay, parseItems, timeAgo } from '../core/utils.js';
import { getSession } from '../core/auth.js?v=20260520-polish';
import { getMyOrderIds } from './my-orders-store.js?v=20260626-phase1';

// Friendly, customer-facing labels for the dashboard's order_status values.
const STATUS_LABELS = {
  pending:'Order received', confirmed:'Confirmed', preparing:'Preparing your order',
  out_for_delivery:'Out for delivery', completed:'Delivered', cancelled:'Cancelled'
};

let _orders = [];

// Realtime postgres_changes can't carry the session token get_my_orders needs,
// so we poll the RPC instead.
const POLL_MS = 15000;
let _pollTimer = null;
let _pollCtx = null;   // { list } while the tracking screen is open

// The single read path. Returns the orders the current visitor is allowed to
// see: their account's orders (when logged in) plus any orders placed on this
// device. Never sends a phone number.
async function fetchMyOrders() {
  const token = getSession()?.token || null;
  const ids = getMyOrderIds();
  if (!token && ids.length === 0) return [];
  const { data, error } = await sb().rpc('get_my_orders', {
    p_session_token: token,
    p_order_ids: ids.length ? ids : null,
  });
  if (error) throw error;
  return (data && Array.isArray(data.orders)) ? data.orders : [];
}

export function openTrackingScreen() {
  let host = document.getElementById('trackingScreen');
  if (!host) {
    host = document.createElement('section');
    host.id = 'trackingScreen';
    host.className = 'tracking-screen';
    document.body.appendChild(host);
  }
  renderShell(host);
  host.classList.add('open');
  document.body.classList.add('lock-scroll');
  openOverlay('trackingScreen', () => closeTrackingScreen());
  loadOrders(host);
}

export function closeTrackingScreen() {
  const host = document.getElementById('trackingScreen');
  if (!host) return;
  host.classList.remove('open');
  document.body.classList.remove('lock-scroll');
  closeOverlay('trackingScreen');
  stopPolling();
}

function renderShell(host) {
  host.innerHTML = `
    <div class="tracking-inner">
      <header class="checkout-header">
        <button class="checkout-back" aria-label="Back">←</button>
        <h2>My Orders</h2>
        <span class="checkout-spacer"></span>
      </header>
      <div id="trkResults" class="trk-results"><div class="loading">Looking up your orders…</div></div>
    </div>`;
  host.querySelector('.checkout-back')?.addEventListener('click', closeTrackingScreen);
}

async function loadOrders(host) {
  const list = host.querySelector('#trkResults');
  if (!list) return;
  list.innerHTML = `<div class="loading">Looking up your orders…</div>`;
  try {
    _orders = await fetchMyOrders();
    renderOrders(list, _orders);
    startPolling(list);
  } catch(e) {
    console.warn('[tracking] orders fetch failed', e);
    list.innerHTML = `<div class="empty">Could not load orders. Please try again.</div>`;
  }
}

// Visibility-aware polling.
function startPolling(list) {
  _pollCtx = { list };
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
  const { list } = _pollCtx;
  if (!list.isConnected) { stopPolling(); return; }
  try {
    _orders = await fetchMyOrders();
    renderOrders(list, _orders);
  } catch(e) {
    console.warn('[tracking] poll refetch failed', e);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pausePolling();
  else resumePolling();
});

function renderOrders(list, orders) {
  if (!orders.length) {
    const signedIn = !!getSession()?.token;
    list.innerHTML = `<div class="empty">
      <div class="empty-emoji">📦</div>
      <div>${signedIn
        ? 'No orders yet. When you place an order it will appear here.'
        : 'No orders on this device yet. Sign in to see orders on your account, or place an order to start tracking.'}</div>
    </div>`;
    return;
  }
  list.innerHTML = orders.map(o => {
    // get_my_orders returns the canonical items (order_items, falling back to
    // legacy items) under `items`.
    const items = parseItems(o.items);
    const summary = items.length
      ? items.slice(0,2).map(i => `${i.emoji||'🌿'} ${i.name||''} ×${i.qty||i.quantity||1}`).join(', ') +
        (items.length > 2 ? `, +${items.length-2} more` : '')
      : '—';
    // order_status is the source of truth (kept in sync by a DB trigger).
    const status = o.order_status || 'pending';
    const updatedTs = o.status_updated_at || o.created_at;
    const note = (o.delivery_notes || '').trim();
    const noteHtml = note ? `<div class="ord-note">
        <div class="ord-note-label">📦 Message from the store:</div>
        <div class="ord-note-body">${esc(note)}</div>
      </div>` : '';
    return `<article class="ord-card status-${esc(status)}">
      <header>
        <span class="ord-num">#${esc(o.order_number || (o.id || '').slice(0,8))}</span>
        <span class="ord-badge">${esc(STATUS_LABELS[status] || status)}</span>
      </header>
      ${noteHtml}
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

document.addEventListener('mbg:openTracking', () => openTrackingScreen());

// Checkout fires mbg:orderPlaced right after a successful place-order. If the
// tracking screen is already mounted, refetch immediately so the new order
// shows without waiting for the next poll tick.
document.addEventListener('mbg:orderPlaced', () => {
  if (_pollCtx) refetchOrders();
});
