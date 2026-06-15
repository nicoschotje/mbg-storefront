// Test-only ESM loader. Redirects the storefront's external/browser deps to
// in-memory stubs so the REAL cart.js / saved-address.js can run under Node.
const STUBS = {
  supabase: `export function sb(){ return {}; }
             export function logActivity(){}`,
  utils: `export const esc = s => String(s == null ? '' : s);
          export const formatPrice = n => '₱' + (Number(n) || 0);
          export const openOverlay = () => {};
          export const closeOverlay = () => {};
          export const showToast = (m) => { (globalThis.__toasts ||= []).push(m); };
          export const normalisePhone = s => String(s||'');
          export const isValidPHPhone = () => true;`,
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
