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

console.log(`\nAll ${pass} assertions passed.`);
