/* MBG Storefront v2 — Config
 * All hardcoded constants live here.
 */

// ⚠️ CLICK-TEST ONLY — THIS BRANCH POINTS AT STAGING, NEVER MERGE ⚠️
// This single commit swaps the production Supabase target for the staging
// project `mrbeanies-staging` (ref: oyyaivofnjltrnnnszrf) so Netlify builds a
// deploy preview the owner can click-test the B6b quote flow against. The anon
// key is public by design — Row-Level Security enforces access. This branch
// exists solely for the preview; it is thrown away after the click-test.
export const SUPABASE_URL  = 'https://oyyaivofnjltrnnnszrf.supabase.co';
export const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95eWFpdm9mbmpsdHJubm5zenJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MDEzNDQsImV4cCI6MjA5ODI3NzM0NH0.kfVLt_k7w3A3DNYqT-fvJcjAX1lAHfx4_3u5LVJZ0x0';
export const EDGE_URL      = `${SUPABASE_URL}/functions/v1`;

// Brand
export const BRAND_NAME       = "Mr. Beanie's Greenies";
export const BRAND_SHORT      = 'MBG';
export const SUPPORT_TG_BOT   = 'MyWebShopStore_bot';

// Delivery pricing model
// Flat-rate zones have been replaced by a distance-based calculator
// (see js/modules/delivery.js). The fee is computed from the Haversine
// distance between the store and the customer's selected coordinates,
// scaled by store_settings.delivery_rate_multiplier (surge). When the
// customer has no coordinates, checkout falls back to the flat
// store_settings.delivery_fee. All pricing inputs are read live from
// store_settings so the owner can tune them from the dashboard.

// Free delivery threshold (fallback only — store_settings.free_delivery_min
// is the live value used at checkout).
export const DEFAULT_FREE_DELIVERY_THRESHOLD = 5000;

// Payment methods (mirror old storefront)
export const PAYMENT_METHODS = [
  { id: 'gcash',         label: 'GCash',         icon: 'G',  needsReceipt: true  },
  { id: 'maya',          label: 'Maya',          icon: 'M',  needsReceipt: true  },
  { id: 'bank_transfer', label: 'Bank Transfer', icon: 'B',  needsReceipt: true  },
  { id: 'usdt',          label: 'USDT (Crypto)',   icon: 'U', needsReceipt: true  }
];

// Auth tuning
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const LOGIN_FAIL_LIMIT = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 min

// PWA
export const SW_PATH = './service-worker.js';

// Fallback hero / category banner images (Unsplash; used only if banners table empty)
export const FALLBACK_HERO = 'https://images.unsplash.com/photo-1536819114556-1c10c64c5066?w=1200&q=80';
export const FALLBACK_CATEGORY_BANNERS = {
  'Flower':         'https://images.unsplash.com/photo-1603909223429-69bb7101f420?w=1200&q=80',
  'Carts & Vapes':  'https://images.unsplash.com/photo-1590736969955-71cc94901144?w=1200&q=80',
  'Vapes':          'https://images.unsplash.com/photo-1590736969955-71cc94901144?w=1200&q=80',
  'Carts':          'https://images.unsplash.com/photo-1590736969955-71cc94901144?w=1200&q=80',
  'Dabs':           'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=1200&q=80',
  'Concentrates':   'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=1200&q=80',
  'Edibles':        'https://images.unsplash.com/photo-1517816743773-6e0fd518b4a6?w=1200&q=80',
  'Snacks':         'https://images.unsplash.com/photo-1582719188393-bb71ca45dbb9?w=1200&q=80'
};

