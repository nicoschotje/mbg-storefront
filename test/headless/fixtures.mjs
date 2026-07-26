/* Synthetic fixture data for the headless mobile drive.
 * All data is fake — no customer data, addresses, coordinates beyond generic
 * Manila-area landmarks, PINs, or secrets. */

export const TOKEN = 'sess_stub_0001';
export const FUTURE = '2030-01-01T00:00:00Z';
export const QUOTE_ID = '22222222-2222-4222-8222-222222222222';
export const ORDER_ID = '33333333-3333-4333-8333-333333333333';

export const SESSION = {
  success: true,
  session_token: TOKEN,
  customer_id: '11111111-1111-4111-8111-111111111111',
  display_name: 'Test Customer',
  phone: '09170000001',
  saved_address: null,
  expires_at: FUTURE,
  has_webauthn: false,
};

export const STORE_SETTINGS = {
  id: 1, store_name: "Mr. Beanie's Greenies", store_address: 'Quezon City',
  store_lat: 14.6007, store_lng: 121.0827,
  is_open: true, store_online: true, closed_message: null,
  operating_hours: { days: [0, 1, 2, 3, 4, 5, 6], open: '10:00', close: '22:00' },
  gcash_enabled: true, gcash_number: '0917 000 0000', gcash_name: 'MBG Store', gcash_qr_url: null,
  maya_enabled: true, maya_number: '0918 000 0000', maya_qr_url: null,
  bank_name: 'BPI', bank_account: '0000-000-000', bank_account_name: 'MBG Store', bank_qr_url: null,
  crypto_enabled: false, crypto_usdt_address: null, crypto_usdt_network: null,
  delivery_fee: 120, delivery_rate_multiplier: 1,
  free_delivery_min: 5000, free_delivery_enabled: true, min_order_amount: 0,
  topbar_banner_url: null, store_logo_url: null, theme_color: '#192D1E',
  webauthn_rp_id: 'localhost', updated_at: '2026-07-01T00:00:00Z',
};

export const CATEGORIES = [
  { id: 'c1', name: 'Flower', emoji: '🌸', sort_order: 1, description: 'Top shelf', is_active: true },
  { id: 'c2', name: 'Edibles', emoji: '🍪', sort_order: 2, description: 'Baked daily', is_active: true },
  { id: 'c3', name: 'Concentrates', emoji: '💧', sort_order: 3, description: '', is_active: true },
  { id: 'c4', name: 'Vapes', emoji: '💨', sort_order: 4, description: '', is_active: true },
  { id: 'c5', name: 'Merch & Accessories', emoji: '🎽', sort_order: 5, description: '', is_active: true },
];

export const PRODUCTS = [
  {
    id: 'p1', name: 'Blue Dream', price: 1200, image_url: '', emoji: '🌿',
    type: 'Sativa', subtitle: 'Top shelf', description: 'Citrus-forward and uplifting.',
    category_id: 'c1', subcategory_id: null, stock_qty: 25,
    is_active: true, is_featured: true, is_hot_deal: false, has_variants: false,
  },
  {
    id: 'p2', name: 'Extra Long Product Name That Keeps Going For Layout Stress Testing', price: 24999.5,
    image_url: '', emoji: '🍫', type: 'Hybrid', subtitle: 'A very long subtitle to stress the card layout on narrow phones',
    category_id: 'c2', subcategory_id: null, stock_qty: 10,
    is_active: true, is_featured: true, is_hot_deal: true, has_variants: false,
  },
  {
    id: 'p3', name: 'House Blend', price: 950, image_url: '', emoji: '🌱',
    type: 'Indica', subtitle: 'Smooth', description: 'Evening classic.',
    category_id: 'c1', subcategory_id: null, stock_qty: 8,
    is_active: true, is_featured: false, is_hot_deal: false, has_variants: true,
  },
  {
    id: 'p4', name: 'Brownie Bites', price: 350, image_url: '', emoji: '🍪',
    type: '', subtitle: '10 pcs', category_id: 'c2', subcategory_id: null, stock_qty: 30,
    is_active: true, is_featured: false, is_hot_deal: false, has_variants: false,
  },
];

export const VARIANTS = [
  { id: 'v1', parent_product_id: 'p3', name: 'Sunset Sherbet', strain_type: 'indica', sort_order: 1, price_override: null, stock_qty: 5, is_available: true },
  { id: 'v2', parent_product_id: 'p3', name: 'Northern Lights Extra Long Strain Name', strain_type: 'indica', sort_order: 2, price_override: 1100, stock_qty: 3, is_available: true },
  { id: 'v3', parent_product_id: 'p3', name: 'Green Crack', strain_type: 'sativa', sort_order: 3, price_override: null, stock_qty: 0, is_available: true },
];

export const DELIVERY_ZONES = [
  { id: 'z1', name: 'Metro Manila', base_fee: 120, is_active: true, sort_order: 1 },
  { id: 'z2', name: 'Rizal / Cavite fringe', base_fee: 220, is_active: true, sort_order: 2 },
];

export const ORDERS = [
  {
    id: ORDER_ID, order_number: 'MBG-1001', order_status: 'preparing',
    payment_status: 'pending', status_updated_at: '2026-07-26T10:05:00Z',
    delivery_notes: 'Rider will message you on arrival',
    total: 2520, delivery_address: '12 Sample St, Poblacion, Makati, Metro Manila 1210',
    created_at: '2026-07-26T10:00:00Z',
    eta_message: '25–35 minutes', eta_updated_at: '2026-07-26T10:04:00Z',
    items: [{ id: 'p1', product_id: 'p1', name: 'Blue Dream', emoji: '🌿', qty: 2, variant_id: null }],
  },
  {
    id: '44444444-4444-4444-8444-444444444444', order_number: 'MBG-0990',
    order_status: 'completed', payment_status: 'paid',
    status_updated_at: '2026-07-20T18:00:00Z', delivery_notes: null,
    total: 950, delivery_address: '12 Sample St, Poblacion, Makati, Metro Manila 1210',
    created_at: '2026-07-20T16:00:00Z', eta_message: null, eta_updated_at: null,
    items: [{ id: 'p3', product_id: 'p3', name: 'House Blend', emoji: '🌱', qty: 1, variant_id: 'v1' }],
  },
];

/* The registry installed on window.__MBG_FIX before the app boots. */
export function buildFixtures() {
  return `
window.__MBG_FIX = {
  tables: {
    store_settings: [${JSON.stringify(STORE_SETTINGS)}],
    banners: [],
    announcements: [],
    categories: ${JSON.stringify(CATEGORIES)},
    subcategories: [],
    products: ${JSON.stringify(PRODUCTS)},
    product_variants: ${JSON.stringify(VARIANTS)},
    discount_rules: [],
    customer_tiers: [],
    delivery_zones: ${JSON.stringify(DELIVERY_ZONES)},
    restock_notifications: [],
    activity_log: [],
  },
  rpcs: {
    verify_customer_pin: ${JSON.stringify(SESSION)},
    login_with_remember_token: ${JSON.stringify(SESSION)},
    validate_customer_session: { valid: true },
    create_remember_token: { success: true, remember_token: 'rt_stub_1' },
    logout_customer_session: {},
    revoke_remember_tokens: {},
    quote_delivery: { success: true, quote_id: '${QUOTE_ID}', fee: 120, label: '\\u20B1120 \\u00B7 Metro Manila', expires_at: '${FUTURE}' },
    get_my_orders: { orders: ${JSON.stringify(ORDERS)} },
    get_my_wallet: { ok: false },
  },
};
`;
}
