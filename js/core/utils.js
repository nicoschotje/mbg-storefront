/* MBG Storefront v2 — Utilities */

// Format ₱ price with thousands separator
export function formatPrice(n) {
  const num = Number(n) || 0;
  return '₱' + num.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Format Philippine phone to +63 9XX XXX XXXX
export function formatPhone(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\D/g, '');
  if (s.startsWith('63')) s = '+' + s;
  else if (s.startsWith('09')) s = '+63' + s.slice(1);
  else if (s.startsWith('9') && s.length === 10) s = '+63' + s;
  else if (!s.startsWith('+')) s = '+' + s;
  return s;
}

// Strip spaces, dashes, parentheses — but keep the leading + and 0.
// Existing rows in `orders.customer_phone` are stored as the user typed
// them ("09175242123", "0923-662-8789"); we don't want to drop that
// format because tracking.js filters orders by raw phone equality.
export function normalisePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d+]/g, '');
}

// Canonical PH form: digits only, no country code, no leading 0.
// Mirrors the Postgres normalize_phone() RPC. Use this for VALIDATING
// that a user input could be a real PH mobile — never for filtering or
// inserting (those still use the raw normalisePhone() value).
export function canonicalPhPhone(raw) {
  if (!raw) return '';
  let v = String(raw).replace(/\D/g, '');
  if (v.length >= 12 && v.startsWith('63')) v = v.slice(2);
  if (v.length >= 11 && v.startsWith('0'))  v = v.slice(1);
  return v;
}

// A PH mobile in canonical form is exactly 10 digits starting with 9.
// Accepts every real-world entry style: "09175242123", "9175242123",
// "+639175242123", "639175242123", "0917 524 2123", "(0917) 524 2123".
// Earlier the regex was applied to the raw-normalised string and could
// reject inputs the verify_customer_pin RPC would have happily accepted.
export function isValidPHPhone(p) {
  return /^9\d{9}$/.test(canonicalPhPhone(p));
}

// Safe HTML escape — never inject user data with innerHTML directly
export function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Toast notifications — replaces alert/confirm
export function showToast(msg, kind = 'info', ms = 2600) {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  // Cap visual stacking — drop the oldest toast once 3 are on screen
  if (host.children.length >= 3) host.firstElementChild?.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  // animate in
  requestAnimationFrame(() => el.classList.add('show'));
  // Each toast owns its own dismissal timer so stacked toasts dismiss independently
  const dismiss = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

export function debounce(fn, ms = 250) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Time-ago helper for "My Orders"
export function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

// History overlay stack — Android back button closes the most recent overlay.
const overlayStack = [];
export function openOverlay(id, closeFn) {
  overlayStack.push({ id, closeFn });
  // First overlay → recede the underlying page (iOS-style depth illusion)
  if (overlayStack.length === 1) document.body.classList.add('modal-open');
  try { history.pushState({ mbgOverlay: id }, '', location.href); } catch(_) {}
}
export function closeOverlay(id) {
  const idx = overlayStack.findIndex(o => o.id === id);
  if (idx >= 0) overlayStack.splice(idx, 1);
  if (overlayStack.length === 0) document.body.classList.remove('modal-open');
}
export function installPopstateHandler() {
  window.addEventListener('popstate', () => {
    if (overlayStack.length === 0) return;
    const top = overlayStack.pop();
    try { top.closeFn?.(); } catch(_) {}
  });
}

// Detect in-app browser (Telegram WebView, Messenger, etc.)
export function isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /(FBAN|FBAV|Instagram|Line|Messenger|Telegram|TwitterAndroid|TikTok|Mobile.*WeChat)/i.test(ua);
}

// Safe JSON parse for items column
export function parseItems(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw) || []; } catch(_) { return []; }
}

// base64url <-> ArrayBuffer (for WebAuthn)
export function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function base64urlToBuffer(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return buf;
}

