/* MBG Storefront v2 — Saved delivery addresses
 *
 * Lets a logged-in customer save a delivery address at checkout and refill it
 * with one tap on a later visit.
 *
 * WHERE THIS IS STORED — AND WHY (the known limitation)
 * -----------------------------------------------------
 * Addresses are persisted in the browser's localStorage, namespaced by the
 * logged-in customer's id (so two accounts on the same device keep separate
 * lists). They are NOT synced to the server, so they do not follow the
 * customer to a different browser/device.
 *
 * The reason is deliberate: the only server-side writer for a customer's
 * address is the `update_customer_address` RPC, which is gated behind
 * `is_admin()` and rejects the anon storefront. There is no session-token
 * authenticated RPC to persist an address from the storefront, and adding one
 * would require a production database migration — out of scope for this change.
 * If/when such an RPC exists, the get/save/delete functions below are the only
 * place that needs to learn to mirror to it.
 *
 * The data model supports MULTIPLE saved addresses (capped at MAX_SAVED); the
 * checkout UI lets the customer pick which one to use.
 */
import { getSession, getAuthPhone } from '../core/auth.js?v=20260520-polish';

const KEY_PREFIX = 'mbg_saved_addr_v1::';
const MAX_SAVED  = 5;

// Namespace the storage key by customer so saved addresses are tied to the
// account, not just the browser. Falls back to phone, then 'guest' (the
// storefront sits behind a login gate, so 'guest' is only a defensive default).
function customerKey() {
  const s = getSession();
  const id = s?.customer_id || s?.phone || getAuthPhone() || 'guest';
  return KEY_PREFIX + String(id);
}

// A stable signature of the address fields, used to de-duplicate saves.
function signature(a) {
  return ['street', 'barangay', 'city', 'province', 'postal']
    .map(k => String(a?.[k] || '').trim().toLowerCase())
    .join('|');
}

function randomId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch (_) { /* fall through */ }
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Keep only the fields we care about, trimmed. Returns null if there's not
// enough to be a usable address (street + city are the minimum).
function normalize(addr) {
  if (!addr) return null;
  const t = (v) => String(v == null ? '' : v).trim();
  const out = {
    name:     t(addr.name),
    phone:    t(addr.phone),
    street:   t(addr.street),
    barangay: t(addr.barangay),
    city:     t(addr.city),
    province: t(addr.province),
    postal:   t(addr.postal),
    notes:    t(addr.notes),
    coords:   null,
  };
  const c = addr.coords;
  if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))) {
    out.coords = { lat: Number(c.lat), lng: Number(c.lng) };
  }
  if (!out.street || !out.city) return null;
  return out;
}

export function getSavedAddresses() {
  try {
    const raw = localStorage.getItem(customerKey());
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function persist(list) {
  try {
    localStorage.setItem(customerKey(), JSON.stringify(list.slice(0, MAX_SAVED)));
  } catch (_) { /* private mode / quota — degrade silently */ }
}

// Save (or refresh) an address. Re-saving an address that matches an existing
// one (same street/barangay/city/province/postal) moves it to the front
// instead of creating a duplicate. Returns the stored entry, or null if the
// input wasn't a usable address.
export function saveAddress(addr) {
  const norm = normalize(addr);
  if (!norm) return null;
  const sig = signature(norm);
  const without = getSavedAddresses().filter(a => signature(a) !== sig);
  const entry = { ...norm, id: randomId(), savedAt: Date.now() };
  persist([entry, ...without]);
  return entry;
}

export function deleteAddress(id) {
  persist(getSavedAddresses().filter(a => a.id !== id));
}

export function hasSavedAddress() {
  return getSavedAddresses().length > 0;
}

// Short human label for a saved-address chip, e.g. "12 Mabini St, Makati".
export function addressLabel(a) {
  const s = [a?.street, a?.city].filter(Boolean).join(', ');
  if (!s) return 'Saved address';
  return s.length > 40 ? s.slice(0, 39) + '…' : s;
}
