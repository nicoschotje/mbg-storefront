// Exercises the REAL cart.js + saved-address.js logic under Node via the stub
// loader. Validates: (1) quantity cap = min(100, stock), (2) saved-address
// persistence/dedup/namespacing. Run: node --import ./test/register.mjs ./test/run-tests.mjs
import assert from 'node:assert/strict';

// ── Browser-global shims (set BEFORE importing the modules under test, because
//    cart.js reads localStorage at module-load time). ─────────────────────────
const _store = new Map();
globalThis.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: k => _store.delete(k),
  clear: () => _store.clear(),
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.document = { getElementById: () => null };

let pass = 0;
const ok = (msg) => { console.log('  ✓ ' + msg); pass++; };

const cart = await import('../js/modules/cart.js');
const saved = await import('../js/modules/saved-address.js');
const myOrders = await import('../js/modules/my-orders-store.js');
const delivery = await import('../js/modules/delivery.js');

// ── CHANGE 1: quantity cap = min(100, stock) ─────────────────────────────────
console.log('CHANGE 1 — quantity cap (min(100, stock)):');

assert.equal(cart.MAX_QTY_PER_ITEM, 100);
ok('MAX_QTY_PER_ITEM is 100');

assert.equal(cart.maxQtyForItem({ product: {} }), 100);
ok('untracked stock → cap 100');

assert.equal(cart.maxQtyForItem({ product: { stock_qty: 250 } }), 100);
ok('stock 250 → cap 100 (100 ceiling wins)');

assert.equal(cart.maxQtyForItem({ product: { stock_qty: 7 } }), 7);
ok('stock 7 → cap 7 (stock wins)');

assert.equal(
  cart.maxQtyForItem({ product: { stock_qty: 999 }, variant: { stock_qty: 3 } }),
  3,
);
ok('variant line uses VARIANT stock (3), not parent (999)');

// addToCart clamps a big add down to stock
cart.clearCart();
cart.addToCart({ id: 'p1', name: 'Test', stock_qty: 5 }, 50);
assert.equal(cart.getCartProduct('p1').qty, 5);
ok('addToCart(+50) on stock 5 → clamped to 5');

// typing 500 via setQty clamps to the 100 per-item cap when stock is ample
cart.clearCart();
cart.addToCart({ id: 'p2', name: 'Bulk', stock_qty: 1000 }, 1);
cart.setQty('p2', 500);
assert.equal(cart.getCartProduct('p2').qty, 100);
ok('setQty(500) on stock 1000 → clamped to 100 (per-item cap)');

// untracked product can still go to 100
cart.clearCart();
cart.addToCart({ id: 'p3', name: 'Untracked' }, 1);
cart.setQty('p3', 100);
assert.equal(cart.getCartProduct('p3').qty, 100);
ok('untracked product reaches 100');

cart.clearCart();

// ── CHANGE 2: saved addresses (per-customer localStorage) ────────────────────
console.log('CHANGE 2 — saved addresses:');

globalThis.__session = { customer_id: 'cust-1', phone: '09170000001' };
const A = { name: 'Juan', phone: '09170000001', street: '12 Mabini St', barangay: 'Poblacion', city: 'Makati', province: 'NCR', postal: '1200', coords: { lat: 14.55, lng: 121.02 } };

assert.equal(saved.getSavedAddresses().length, 0);
ok('starts empty for cust-1');

const e1 = saved.saveAddress(A);
assert.ok(e1 && e1.id);
assert.equal(saved.getSavedAddresses().length, 1);
ok('saveAddress stores one entry');

assert.equal(saved.addressLabel(e1), '12 Mabini St, Makati');
ok('addressLabel → "12 Mabini St, Makati"');

// Coords round-trip
assert.deepEqual(saved.getSavedAddresses()[0].coords, { lat: 14.55, lng: 121.02 });
ok('coordinates persisted with the address');

// Re-saving the same address de-dupes
saved.saveAddress({ ...A, name: 'Juan D.' });
assert.equal(saved.getSavedAddresses().length, 1);
ok('re-saving same street/city de-dupes (still 1)');

// A different address adds a second
saved.saveAddress({ ...A, street: '5 Rizal Ave', city: 'Pasig' });
assert.equal(saved.getSavedAddresses().length, 2);
ok('different address → 2 entries');

// Missing city is rejected
assert.equal(saved.saveAddress({ street: 'Nowhere' }), null);
assert.equal(saved.getSavedAddresses().length, 2);
ok('address without a city is rejected');

// Namespacing: a different customer has their own (empty) list
globalThis.__session = { customer_id: 'cust-2', phone: '09170000002' };
assert.equal(saved.getSavedAddresses().length, 0);
ok('cust-2 sees its own empty list (namespaced)');

// Back to cust-1, delete one
globalThis.__session = { customer_id: 'cust-1', phone: '09170000001' };
const list = saved.getSavedAddresses();
saved.deleteAddress(list[0].id);
assert.equal(saved.getSavedAddresses().length, 1);
ok('deleteAddress removes one entry');

// ── CHANGE 3: my-orders-store (Phase 1 — device order ids, no phone) ─────────
console.log('CHANGE 3 — my-orders-store (device order ids):');

assert.deepEqual(myOrders.getMyOrderIds(), []);
ok('starts empty');

myOrders.rememberMyOrderId('id-aaa');
myOrders.rememberMyOrderId('id-bbb');
assert.deepEqual(myOrders.getMyOrderIds(), ['id-bbb', 'id-aaa']);
ok('newest id first');

myOrders.rememberMyOrderId('id-aaa');
assert.deepEqual(myOrders.getMyOrderIds(), ['id-aaa', 'id-bbb']);
ok('re-remembering moves to front, no duplicate');

myOrders.rememberMyOrderId('');
myOrders.rememberMyOrderId(null);
assert.equal(myOrders.getMyOrderIds().length, 2);
ok('empty / null ids are ignored');

// ── CHANGE 4: delivery fee formula (locks the place-order edge-fn mirror) ────
console.log('CHANGE 4 — delivery fee formula (server mirror lock):');

const QC = { storeLat: 14.6007, storeLng: 121.0827, customerLat: 14.6490, customerLng: 121.0273 };
assert.equal(delivery.calculateDelivery({ ...QC, subtotal: 1000, surgeMultiplier: 1, freeDeliveryMin: 0, fallbackFee: 50 }).fee, 208);
ok('~8 km @ surge 1 → ₱208');

assert.equal(delivery.calculateDelivery({ ...QC, subtotal: 1000, surgeMultiplier: 2.5, freeDeliveryMin: 0, fallbackFee: 50 }).fee, 519);
ok('~8 km @ surge 2.5 → ₱519');

assert.equal(delivery.calculateDelivery({ storeLat: 14.6, storeLng: 121.0, customerLat: null, customerLng: null, subtotal: 100, surgeMultiplier: 1, freeDeliveryMin: 0, fallbackFee: 75 }).fee, 75);
ok('no coords → flat fallback ₱75');

assert.equal(delivery.calculateDelivery({ ...QC, subtotal: 5000, surgeMultiplier: 1, freeDeliveryMin: 5000, fallbackFee: 50 }).fee, 0);
ok('subtotal ≥ free_delivery_min → ₱0');

// ── CHANGE 5: addToCart silent + variant (Phase 2 reorder path) ──────────────
console.log('CHANGE 5 — addToCart silent/variant (reorder):');
cart.clearCart();
cart.addToCart({ id: 'rp1', name: 'Reorder Prod', stock_qty: 10 }, 3, null, true);
assert.equal(cart.getCartProduct('rp1').qty, 3);
ok('silent add still adds the quantity');

const rv = { id: 'v1', name: '1g', stock_qty: 5 };
cart.addToCart({ id: 'rp2', name: 'Variant Prod', stock_qty: 99 }, 2, rv, true);
assert.equal(cart.getCartProduct('rp2_v1').qty, 2);
ok('silent add preserves the variant (composite cart key)');

cart.addToCart({ id: 'rp2', name: 'Variant Prod', stock_qty: 99 }, 999, rv, true);
assert.equal(cart.getCartProduct('rp2_v1').qty, 5);
ok('silent add still clamps to variant stock (5)');
cart.clearCart();

console.log(`\nAll ${pass} assertions passed.`);
