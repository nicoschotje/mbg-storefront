/* Mobile-journey regression suite — drives the REAL storefront (index.html +
 * js/) in headless Chromium against the stub Supabase client (zero network,
 * zero database) and asserts the full customer journey stays usable on
 * phones: login → browse → variants → cart → checkout → quote → receipt →
 * place order → confirmation → My Orders + ETA.
 *
 * Layout assertions at every step:
 *   - no page-level horizontal overflow;
 *   - no horizontal overflow inside the open overlay scroller;
 *   - key controls visible and ≥ 36px tap height.
 *
 * Viewports: 320 (smallest supported), 390 (common phone), 1280 (desktop).
 * Run: bash test/headless/run.sh
 */
import { startServer, launchBrowser, newAppContext } from './harness.mjs';

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
];

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const results = [];
function t(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '! FAIL'}  ${name}${ok ? '' : `  — ${detail}`}`);
}

async function noHOverflow(page, label, vw) {
  const r = await page.evaluate(() => {
    const se = document.scrollingElement;
    const out = { page: se.scrollWidth - se.clientWidth };
    for (const ov of document.querySelectorAll('.checkout-screen.open, .tracking-screen.open')) {
      out.overlay = Math.max(out.overlay || 0, ov.scrollWidth - ov.clientWidth);
    }
    return out;
  });
  t(`${label}: no page h-overflow @${vw}`, r.page <= 1, `scrollWidth exceeds viewport by ${r.page}px`);
  if (r.overlay !== undefined) {
    t(`${label}: no overlay h-overflow @${vw}`, r.overlay <= 1, `overlay scrolls sideways by ${r.overlay}px`);
  }
}

async function tapHeight(page, sel, min, label, vw) {
  const h = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? Math.round(el.getBoundingClientRect().height) : -1;
  }, sel);
  t(`${label} @${vw}`, h >= min, `${sel} height ${h}px < ${min}px`);
}

const srv = await startServer();
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await launchBrowser();

for (const vp of VIEWPORTS) {
  const vw = vp.width;
  const mobile = vw < 800;
  console.log(`── viewport ${vw} ──`);
  const ctx = await newAppContext(browser, vp);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  // 1. Login
  await page.waitForSelector('#loginScreen', { state: 'visible' });
  await noHOverflow(page, 'login', vw);
  await page.fill('#loginPhone', '09170000001');
  await page.fill('#loginPin', '1234');
  await page.click('#loginSubmitBtn');
  await page.waitForSelector('.product-card', { state: 'visible' });
  t(`login completes @${vw}`, true);

  // 2. Home: header fits, category nav reachable
  await page.waitForTimeout(400);
  await noHOverflow(page, 'home', vw);
  const catCount = await page.locator('.cat-pill').count();
  t(`category nav renders (${catCount} pills) @${vw}`, catCount >= 5);

  // 3. Category filter works
  await page.click('.cat-pill:has-text("Edibles")');
  await page.waitForTimeout(250);
  const cats = await page.locator('.category-section').count();
  t(`category filter narrows sections @${vw}`, cats === 1, `${cats} sections`);
  await page.click('.cat-pill[data-cat="All"]');
  await page.waitForTimeout(250);

  // 4. Variant strain sheet
  await page.click('.choose-strain-btn[data-id="p3"]');
  await page.waitForSelector('.strain-sheet-backdrop.open .strain-option', { state: 'visible' });
  await noHOverflow(page, 'strain-sheet', vw);
  await tapHeight(page, '.strain-qty-btn', 36, 'strain qty button ≥36px', vw);
  await page.click('.strain-option[data-variant="v1"]');
  await page.click('.strain-add-btn');
  await page.waitForTimeout(300);

  // 5. Cart
  await page.click('.product-add-btn[data-id="p1"]');
  await page.click(mobile ? '#bnCartTab' : '#cartBtnHeader');
  await page.waitForSelector('#cartDrawer.open', { state: 'visible' });
  await page.waitForTimeout(400);
  await noHOverflow(page, 'cart', vw);
  await tapHeight(page, '.cart-qty .qb', 36, 'cart qty button ≥36px', vw);
  const rows = await page.locator('.cart-row').count();
  t(`cart rows render @${vw}`, rows === 2, `${rows} rows`);

  // 6. Checkout: fields, zone select, quote
  await page.click('#cartCheckoutBtn');
  await page.waitForSelector('#checkoutScreen.open', { state: 'visible' });
  await page.waitForSelector('#coStreet');
  await page.fill('#coName', 'Test Customer').catch(() => {});
  await page.fill('#coPhone', '09170000001').catch(() => {});
  await page.fill('#coStreet', '12 Sample St');
  await page.fill('#coBarangay', 'Poblacion');
  await page.fill('#coCity', 'Makati');
  await page.fill('#coProvince', 'Metro Manila');
  await page.evaluate(() => {
    localStorage.setItem('mbg_delivery_coords', JSON.stringify({ lat: 14.5648, lng: 121.03 }));
    document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
  });
  await page.waitForSelector('#placeOrderBtn:not([disabled])');
  await page.waitForTimeout(400);
  await noHOverflow(page, 'checkout', vw);

  // The delivery-zone <select> must span the form width, not its longest
  // option (which forced sideways scrolling before the fix).
  const zone = await page.evaluate(() => {
    const el = document.querySelector('#coZoneSelect');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), vw: window.innerWidth };
  });
  if (zone) {
    t(`zone select stays inside viewport @${vw}`, zone.right <= zone.vw, `right edge ${zone.right} > ${zone.vw}`);
    t(`zone select ≥44px tall @${vw}`, zone.h >= 44, `${zone.h}px`);
  }
  const feeTotal = await page.evaluate(() => ({
    fee: document.querySelector('#coDeliveryFee')?.textContent?.trim(),
    total: document.querySelector('#coTotal')?.textContent?.trim(),
  }));
  t(`delivery fee shown (${feeTotal.fee}) @${vw}`, /120/.test(feeTotal.fee || ''));
  // v1 House Blend ₱950 + Blue Dream ₱1,200 + fee ₱120 = ₱2,270
  t(`total shown (${feeTotal.total}) @${vw}`, /2,270/.test(feeTotal.total || ''));

  // Map pin control present + tall enough to tap
  const mapBox = await page.evaluate(() => {
    const el = document.querySelector('#addr-map');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  t(`address map renders (${mapBox?.w}×${mapBox?.h}) @${vw}`, !!mapBox && mapBox.h >= 180 && mapBox.w > 200);

  // 7. Receipt + place order
  await page.setInputFiles('#receiptFile', { name: 'r.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await page.waitForTimeout(200);
  const btnH = await page.evaluate(() => Math.round(document.querySelector('#placeOrderBtn').getBoundingClientRect().height));
  t(`place-order button ≥48px @${vw}`, btnH >= 48, `${btnH}px`);
  await page.click('#placeOrderBtn');
  await page.waitForSelector('#successScreen.open', { state: 'visible' });
  await page.waitForTimeout(400);
  await noHOverflow(page, 'success', vw);
  const num = await page.locator('.success-num').textContent();
  t(`confirmation shows order number @${vw}`, /MBG-1001/.test(num || ''), num || '');

  // 8. My Orders + ETA
  await page.click('#successTrack');
  await page.waitForSelector('#trackingScreen.open', { state: 'visible' });
  await page.waitForSelector('.ord-card', { state: 'visible' });
  await page.waitForTimeout(400);
  await noHOverflow(page, 'orders', vw);
  const eta = await page.locator('.ord-eta .ord-note-body').first().textContent().catch(() => '');
  t(`ETA visible on Orders @${vw}`, /25–35/.test(eta || ''), eta || 'no ETA block');
  const badge = await page.locator('.ord-card .ord-badge').first().textContent();
  t(`status badge readable @${vw}`, (badge || '').length > 0);

  await ctx.close();
}

await browser.close();
srv.close();

const fails = results.filter(r => !r.ok);
console.log(`\nStorefront mobile drive: ${results.length - fails.length}/${results.length} passed`);
if (fails.length) process.exit(1);
