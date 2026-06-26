/* MBG Storefront v2 — device-local "my orders" id store
 *
 * Holds the ids of orders placed on THIS device (unguessable uuid capability
 * tokens). My Orders uses them so a customer can see their orders WITHOUT any
 * phone-based matching (the old privacy leak). They also survive a later login:
 * get_my_orders() unions the logged-in account's orders with these ids, so a
 * guest who later signs in still sees the orders they placed before logging in.
 */
const KEY = 'mbg_my_order_ids';
const MAX = 50;

export function getMyOrderIds() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x) : [];
  } catch (_) { return []; }
}

export function rememberMyOrderId(id) {
  if (!id || typeof id !== 'string') return;
  try {
    const next = [id, ...getMyOrderIds().filter(x => x !== id)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (_) { /* private mode / quota — degrade silently */ }
}
