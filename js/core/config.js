/* MBG Storefront v2 — Config
 * All hardcoded constants live here.
 */

// Storefront runs on the OLD Supabase project (ckmnhgattkiziuykhczo) —
// that is where store_customers, products, banners and the auth RPCs live.
export const SUPABASE_URL  = 'https://ckmnhgattkiziuykhczo.supabase.co';
export const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrbW5oZ2F0dGtpeml1eWtoY3pvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NjU1MzksImV4cCI6MjA4ODM0MTUzOX0.l2ErPyJe6q2sI4UpNtRp9qRfeVkfdrHSOdkensj83IA';
export const EDGE_URL      = `${SUPABASE_URL}/functions/v1`;

// Brand
export const BRAND_NAME       = "Mr. Beanie's Greenies";
export const BRAND_SHORT      = 'MBG';
export const SUPPORT_TG_BOT   = 'MyWebShopStore_bot';

// Default delivery zones (overridden by store_settings.delivery_rate_multiplier)
export const DELIVERY_ZONES = [
  { id: 'metro_near',  label: 'Metro Near',  fee: 85,  desc: 'NCR nearby areas' },
  { id: 'metro_far',   label: 'Metro Far',   fee: 150, desc: 'Farther NCR areas' },
  { id: 'provincial',  label: 'Provincial',  fee: 250, desc: 'Outside NCR' }
];

// Free delivery threshold (fallback if store_settings has none)
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

