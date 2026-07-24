// Test-only ESM loader. Redirects the storefront's external/browser deps to
// in-memory stubs so the REAL cart.js / saved-address.js can run under Node.
const STUBS = {
  supabase: `export function sb(){ return {}; }
             export function logActivity(){}`,
  // esc/timeAgo mirror the REAL js/core/utils.js implementations so tests that
  // exercise rendering (e.g. the ETA line) see genuine HTML-escaping / relative
  // time rather than a pass-through stub.
  utils: `export function esc(str){
            if (str == null) return '';
            return String(str)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
          }
          export const formatPrice = n => '₱' + (Number(n) || 0);
          export const openOverlay = () => {};
          export const closeOverlay = () => {};
          export const showToast = (m) => { (globalThis.__toasts ||= []).push(m); };
          export const normalisePhone = s => String(s||'');
          export const isValidPHPhone = () => true;
          export function timeAgo(iso){
            if (!iso) return '';
            const ms = Date.now() - new Date(iso).getTime();
            const s = Math.floor(ms / 1000);
            if (s < 60) return 'just now';
            const m = Math.floor(s / 60);
            if (m < 60) return m + 'm ago';
            const h = Math.floor(m / 60);
            if (h < 24) return h + 'h ago';
            const d = Math.floor(h / 24);
            if (d < 7)  return d + 'd ago';
            return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
          }`,
  config: `export const DEFAULT_FREE_DELIVERY_THRESHOLD = 5000;`,
  banners: `export function getStoreSettings(){ return globalThis.__storeSettings || {}; }`,
  auth: `export function getSession(){ return globalThis.__session || null; }
         export function getAuthPhone(){ return globalThis.__phone || null; }`,
};

function stubName(spec) {
  if (spec.includes('supabase.js')) return 'supabase';
  if (spec.includes('utils.js'))    return 'utils';
  if (spec.includes('config.js'))   return 'config';
  if (spec.includes('banners.js'))  return 'banners';
  if (spec.includes('auth.js'))     return 'auth';
  return null;
}

export async function resolve(spec, ctx, next) {
  const name = stubName(spec);
  if (name) return { url: 'stubvirtual:' + name, shortCircuit: true };
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  if (url.startsWith('stubvirtual:')) {
    const name = url.slice('stubvirtual:'.length);
    return { format: 'module', source: STUBS[name], shortCircuit: true };
  }
  return next(url, ctx);
}
