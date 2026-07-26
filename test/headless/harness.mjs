/* Shared harness for the storefront headless mobile drive.
 *
 * Serves the real repo over a local static server, intercepts every CDN /
 * Supabase / edge-function URL (zero network, zero database), and exposes
 * a newPage(viewport) that boots the app against the fixture registry.
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildFixtures } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = join(REPO, path === '/' ? 'index.html' : path.slice(1));
      if (!file.startsWith(REPO) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function findChrome() {
  for (const p of [
    process.env.MBG_CHROME,
    '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ]) {
    if (p && existsSync(p)) return p;
  }
  throw new Error('No Chrome/Chromium executable found — set MBG_CHROME');
}

const STUB_SUPA = readFileSync(join(HERE, 'stub-supabase.mjs'), 'utf8');
const STUB_LEAFLET = readFileSync(join(HERE, 'stub-leaflet.js'), 'utf8');

const NOMINATIM_HITS = JSON.stringify([{
  display_name: '12 Sample St, Poblacion, Makati, Metro Manila, 1210, Philippines',
  lat: '14.5648', lon: '121.0300',
  address: { house_number: '12', road: 'Sample St', suburb: 'Poblacion', city: 'Makati', state: 'Metro Manila', postcode: '1210' },
}]);

export async function launchBrowser() {
  return chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
}

export async function newAppContext(browser, { width, height }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    serviceWorkers: 'block',
    isMobile: width < 800,
    hasTouch: width < 800,
    deviceScaleFactor: width < 800 ? 2 : 1,
  });

  // One catch-all route (same pattern as the dashboard suite): anything that
  // is not the local static server is stubbed or aborted — zero network.
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1')) return route.continue();
    if (url.includes('cdn.jsdelivr.net/npm/@supabase'))
      return route.fulfill({ contentType: 'text/javascript', body: STUB_SUPA });
    if (url.includes('leaflet') && url.endsWith('.js'))
      return route.fulfill({ contentType: 'text/javascript', body: STUB_LEAFLET });
    if (url.includes('leaflet') && url.endsWith('.css'))
      return route.fulfill({ contentType: 'text/css', body: '/* stub */' });
    if (url.includes('fonts.googleapis.com'))
      return route.fulfill({ contentType: 'text/css', body: '/* stub */' });
    if (url.includes('nominatim.openstreetmap.org/search'))
      return route.fulfill({ contentType: 'application/json', body: NOMINATIM_HITS });
    if (url.includes('nominatim.openstreetmap.org/reverse'))
      return route.fulfill({ contentType: 'application/json', body: '{"display_name":"12 Sample St, Makati"}' });
    if (url.includes('/functions/v1/place-order'))
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, order_number: 'MBG-1001', order_id: '33333333-3333-4333-8333-333333333333', total: 2520 }) });
    if (url.includes('/functions/v1/upload-receipt'))
      return route.fulfill({ contentType: 'application/json', body: '{"url":"https://stub.local/receipts/r1.png"}' });
    if (url.includes('/functions/v1/verify-payment'))
      return route.fulfill({ contentType: 'application/json', body: '{"status":"verified"}' });
    return route.abort();
  });

  await ctx.addInitScript(buildFixtures());
  await ctx.addInitScript(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
  });
  return ctx;
}

/* ── layout checks (run inside the page) ────────────────────────────── */

export const CHECKS_FN = () => {
  const vw = window.innerWidth;
  const findings = { hOverflow: [], tapTargets: [], overlaps: [] };
  const seen = new Set();

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    return true;
  };
  const inAllowedScroller = (el) =>
    !!el.closest('.cat-nav, .subcat-nav, .featured-scroll, .announce, .tbl-scroll');
  const isDecor = (el) =>
    !!el.closest('[aria-hidden="true"], .app-bg, .bg-orb, .grain-overlay, .hero-img, .cat-banner, .stub-map-pin');
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList.length) s += '.' + [...el.classList].slice(0, 3).join('.');
    const t = (el.textContent || '').trim().slice(0, 28);
    return t ? `${s} "${t}"` : s;
  };

  // 1. Horizontal overflow — any visible element crossing the viewport edge.
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || inAllowedScroller(el) || isDecor(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      // Skip elements fully hidden behind overflow:hidden ancestors.
      let clipped = false;
      let a = el.parentElement;
      while (a && a !== document.body) {
        const acs = getComputedStyle(a);
        if (/(hidden|auto|scroll|clip)/.test(acs.overflowX)) { clipped = true; break; }
        a = a.parentElement;
      }
      if (!clipped) {
        const key = sel(el);
        if (!seen.has(key)) { seen.add(key); findings.hOverflow.push({ el: key, left: Math.round(r.left), right: Math.round(r.right), vw }); }
      }
    }
  }
  const se = document.scrollingElement;
  if (se && se.scrollWidth > se.clientWidth + 1) {
    findings.hOverflow.push({ el: 'PAGE', scrollWidth: se.scrollWidth, clientWidth: se.clientWidth });
  }
  for (const ov of document.querySelectorAll('.checkout-screen.open, .tracking-screen.open, .wallet-screen.open')) {
    if (ov.scrollWidth > ov.clientWidth + 1) {
      findings.hOverflow.push({ el: sel(ov) + ' (overlay scroller)', scrollWidth: ov.scrollWidth, clientWidth: ov.clientWidth });
    }
  }

  // 2. Small tap targets on interactive elements.
  const interactive = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]')];
  const vis = interactive.filter((el) => visible(el) && !isDecor(el));
  for (const el of vis) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && (r.height < 38 || r.width < 38) && !(r.width > 100 && r.height >= 32)) {
      findings.tapTargets.push({ el: sel(el), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }

  // 3. Overlapping interactive elements (neither containing the other).
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i], b = vis[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (x > 4 && y > 4) findings.overlaps.push({ a: sel(a), b: sel(b), x: Math.round(x), y: Math.round(y) });
    }
  }
  return findings;
};
