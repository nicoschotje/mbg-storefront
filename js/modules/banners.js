/* MBG Storefront v2 — Banners + Announcements + Store Settings */
import { sb } from '../core/supabase.js?v=20260608-audit';
import { esc } from '../core/utils.js?v=20260608-audit';
import { FALLBACK_HERO, BRAND_NAME } from '../core/config.js?v=20260608-audit';

let _settings = null;

export function getStoreSettings() { return _settings; }

// Renders the owner's operating_hours into a short readable string. The column is a
// JSON object ({ open:"14:00", close:"00:00", days:[…] }); fall back to a plain string
// if a future row stores one, and to '' if there's nothing usable.
function formatOperatingHours(oh) {
  if (!oh) return '';
  if (typeof oh === 'string') return oh;
  if (typeof oh === 'object' && (oh.open || oh.close)) {
    return `${oh.open || '—'}–${oh.close || '—'}`;
  }
  return '';
}

// SECURITY: never `select('*')` here. store_settings also holds the Telegram
// bot token (a secret) and the owner's chat id — `select('*')` over the anon
// client shipped those to every visitor. Select only the non-secret columns the
// storefront actually needs. (Every column listed is confirmed to exist; adding a
// non-existent column would make PostgREST reject the whole request.)
const STORE_SETTINGS_COLUMNS = [
  'id', 'store_name', 'store_online', 'is_open', 'operating_hours', 'topbar_banner_url',
  'free_delivery_min', 'free_delivery_enabled', 'delivery_fee', 'delivery_rate_multiplier',
  'store_lat', 'store_lng',
  'gcash_enabled', 'gcash_number', 'gcash_qr_url',
  'maya_enabled', 'maya_number', 'maya_qr_url',
  'bank_name', 'bank_account', 'bank_account_name', 'bank_qr_url',
  'crypto_enabled', 'crypto_usdt_address', 'crypto_usdt_network'
].join(', ');

export async function loadStoreSettings() {
  try {
    const { data } = await sb().from('store_settings').select(STORE_SETTINGS_COLUMNS).limit(1).single();
    _settings = data || null;
  } catch(e) { console.warn('[banners] store_settings load failed', e); _settings = null; }

  // ── Store open/closed gate ─────────────────────
  // store_settings on this project exposes two boolean flags: `is_open`
  // (manual open/close toggle) and `store_online` (storefront live switch).
  // The store is only open when neither flag is explicitly false.
  const settings = _settings;
  const effectivelyOpen =
    settings?.is_open !== false && settings?.store_online !== false;
  if (!effectivelyOpen) {
    const closedScreen = document.getElementById('storeClosedScreen');
    const loginScreen  = document.getElementById('loginScreen');
    const msgEl        = document.getElementById('storeClosedMsg');
    const hoursEl      = document.getElementById('storeClosedHours');
    if (msgEl && settings?.closed_message)   msgEl.textContent = settings.closed_message;
    // operating_hours is a JSON object ({ days, open, close }) on this project, not a
    // string — interpolating it directly printed "Hours: [object Object]". Format it.
    const hrs = formatOperatingHours(settings?.operating_hours);
    if (hoursEl && hrs) hoursEl.textContent = `Hours: ${hrs}`;
    if (loginScreen)  loginScreen.style.display = 'none';
    if (closedScreen) closedScreen.hidden = false;
    // Stop boot — throw so the caller's boot sequence halts gracefully
    throw new Error('STORE_CLOSED');
  }
  return _settings;
}

export async function loadBanners() {
  try {
    const { data } = await sb().from('banners')
      .select('*').eq('is_active', true).order('sort_order');
    return data || [];
  } catch(_) { return []; }
}

export async function loadAnnouncements() {
  try {
    const { data } = await sb().from('announcements')
      .select('*').eq('is_active', true).order('created_at', { ascending: false });
    const now = Date.now();
    return (data || []).filter(a => !a.expires_at || new Date(a.expires_at).getTime() > now);
  } catch(_) { return []; }
}

// ── Render hero ─────────────────────────────────────────────
// Field-name compatibility: dashboard-v2 writes new column names
// (image_url, subtitle, button_text, link_url). Older rows still use the
// legacy names (media_url, description, cta_text, cta_link). We read both
// so neither side breaks during the transition.
export function renderHero(targetEl, banners) {
  if (!targetEl) return;
  const banner = banners?.[0];
  const url   = banner?.image_url || banner?.media_url || _settings?.topbar_banner_url || FALLBACK_HERO;
  const title = banner?.title    || _settings?.store_name || BRAND_NAME;
  const desc  = banner?.subtitle || banner?.description || 'Hand-picked. Discreetly delivered. Made for the moment.';
  const cta   = banner?.button_text || banner?.cta_text  || 'Shop the menu';

  // Style the hero word italic — split last word
  const words = title.split(' ');
  const last  = words.pop();
  const head  = words.join(' ');

  targetEl.innerHTML = `
    <img class="hero-img" src="${esc(url)}" alt="" loading="eager"/>
    <div class="hero-overlay"></div>
    <div class="hero-content">
      <span class="hero-eyebrow">Est. Manila · Curated Daily</span>
      <h1 class="hero-title">${esc(head)} <em>${esc(last)}</em></h1>
      <p class="hero-sub">${esc(desc)}</p>
      <div class="hero-actions">
        <button class="hero-cta" type="button" data-scroll-to="catNav">${esc(cta)} →</button>
        <span class="hero-scroll">Scroll
          <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </span>
      </div>
    </div>`;
  targetEl.querySelector('.hero-cta')?.addEventListener('click', () => {
    document.getElementById('catNavWrap')?.scrollIntoView({ behavior: 'smooth' });
  });
}

// ── Render announcement bar ─────────────────────────────────
export function renderAnnouncements(targetEl, anns) {
  if (!targetEl) return;
  if (!anns || !anns.length) {
    targetEl.style.display = 'none';
    targetEl.innerHTML = '';
    return;
  }
  targetEl.style.display = '';
  // Dashboard-v2 writes `message` (the single line of text). Older rows
  // still have `title`/`body`. Prefer `message` and fall back gracefully.
  const text = anns.map(a => {
    if (a.message) return a.message;
    const t = a.title ? `${a.title}` : '';
    const b = a.body  ? ` — ${a.body}` : '';
    return `${t}${b}`.trim();
  }).filter(Boolean).join('   ✦   ');
  if (!text) { targetEl.style.display = 'none'; targetEl.innerHTML = ''; return; }
  targetEl.innerHTML = `<div class="announce-marquee">${esc(text)}   ✦   ${esc(text)}</div>`;
}

// ── Render category banner block ────────────────────────────
import { FALLBACK_CATEGORY_BANNERS } from '../core/config.js?v=20260608-audit';
export function renderCategoryBanner(category, banner) {
  const url = banner?.image_url || banner?.media_url || FALLBACK_CATEGORY_BANNERS[category.name] || FALLBACK_CATEGORY_BANNERS['Flower'];
  const words = String(category.name || 'Selection').split(' ');
  const last = words.pop();
  const head = words.join(' ');
  return `<div class="cat-banner">
    <img src="${esc(url)}" alt="" loading="lazy"/>
    <div class="cat-banner-overlay">
      <div class="cat-banner-eyebrow">Collection · ${esc(category.emoji||'')}</div>
      <h2 class="cat-banner-title">${esc(head)}${head?' ':''}<em>${esc(last)}</em></h2>
      <div class="cat-banner-sub">${esc(category.description || 'Hand-picked, in-stock now.')}</div>
    </div>
  </div>`;
}

