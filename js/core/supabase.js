/* MBG Storefront v2 — Supabase client */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON } from './config.js?v=20260608-audit';

let _sb = null;

export function sb() {
  if (!_sb) {
    _sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 5 } }
    });
  }
  return _sb;
}

// Logs an activity row (best-effort, never throws to caller)
export function logActivity(action, details = {}) {
  try {
    const ph = sessionStorage.getItem('mg_pin_hash') || 'unknown';
    sb().from('activity_log').insert({ pin_hash: ph, action, details })
      .then(() => {}, () => {});
  } catch(_) {}
}
