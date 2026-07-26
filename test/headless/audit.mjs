/* Mobile-journey AUDIT — drives the full customer journey at several
 * viewport widths, screenshots every step, and records layout findings
 * (horizontal overflow, small tap targets, overlapping controls).
 *
 * Output: <outdir>/<width>/<step>.png + findings.json
 * Run: MBG_CHROME=/opt/pw-browsers/chromium node test/headless/audit.mjs <outdir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, launchBrowser, newAppContext, CHECKS_FN } from './harness.mjs';

const OUT = process.argv[2] || 'audit-out';
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1280, height: 900 },
];

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const srv = await startServer();
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await launchBrowser();
const allFindings = {};

for (const vp of VIEWPORTS) {
  const label = String(vp.width);
  const dir = join(OUT, label);
  mkdirSync(dir, { recursive: true });
  const ctx = await newAppContext(browser, vp);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const F = (allFindings[label] = {});

  const snap = async (step, opts = {}) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(dir, `${step}.png`), ...opts });
    F[step] = await page.evaluate(CHECKS_FN);
  };
  const snapEl = async (step, selector) => {
    await page.waitForTimeout(400);
    const el = page.locator(selector).first();
    try { await el.screenshot({ path: join(dir, `${step}.png`) }); } catch (e) { console.log(`  [${label}] el-shot ${step} failed: ${e.message.split('\n')[0]}`); }
    F[step] = await page.evaluate(CHECKS_FN);
  };

  console.log(`── viewport ${label} ──`);
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  // 1. Login screen
  await page.waitForSelector('#loginScreen', { state: 'visible' });
  await snap('01-login');
  await page.fill('#loginPhone', '09170000001');
  await page.fill('#loginPin', '1234');
  await page.click('#loginSubmitBtn');

  // 2. Home
  await page.waitForSelector('.product-card', { state: 'visible' });
  await snap('02-home-top');
  await page.evaluate(() => window.scrollTo(0, 700));
  await snap('03-home-products');

  // 3. Category tap (Edibles)
  await page.click('.cat-pill:has-text("Edibles")').catch(() => {});
  await snap('04-category');
  await page.click('.cat-pill[data-cat="All"]').catch(() => {});
  await page.waitForTimeout(200);

  // 4. Product modal (long-name product)
  await page.evaluate(() => window.scrollTo(0, 0));
  const longCard = page.locator('.product-card[data-id="p2"]');
  if (await longCard.count()) {
    await longCard.first().click();
    await page.waitForSelector('.modal-backdrop.open .modal-sheet', { state: 'visible' }).catch(() => {});
    await snap('05-product-modal');
    await page.click('.modal-backdrop.open .modal-close').catch(() => {});
  }

  // 5. Strain sheet (variants product)
  const strainBtn = page.locator('.choose-strain-btn[data-id="p3"]');
  if (await strainBtn.count()) {
    await strainBtn.first().click();
    await page.waitForSelector('.strain-sheet-backdrop.open', { state: 'visible' }).catch(() => {});
    await page.waitForSelector('.strain-option', { state: 'visible' }).catch(() => {});
    await snap('06-strain-sheet');
    // add one variant to the bag via the sheet
    await page.click('.strain-option[data-variant="v1"]').catch(() => {});
    await page.click('.strain-add-btn').catch(() => {});
    await page.waitForTimeout(300);
  }

  // 6. Add simple products, open cart
  await page.click('.product-add-btn[data-id="p1"]');
  await page.click('.product-add-btn[data-id="p2"]').catch(() => {});
  const cartTab = vp.width < 800 ? '#bnCartTab' : '#cartBtnHeader';
  await page.click(cartTab);
  await page.waitForSelector('#cartDrawer.open', { state: 'visible' });
  await snap('07-cart');

  // 7. Checkout
  await page.click('#cartCheckoutBtn');
  await page.waitForSelector('#checkoutScreen.open', { state: 'visible' });
  await page.waitForSelector('#coStreet');
  await page.fill('#coName', 'Test Customer').catch(() => {});
  await page.fill('#coPhone', '09170000001').catch(() => {});
  await page.fill('#coStreet', '12 Sample St');
  await page.fill('#coBarangay', 'Poblacion');
  await page.fill('#coCity', 'Makati');
  await page.fill('#coProvince', 'Metro Manila');
  await page.fill('#coPostal', '1210').catch(() => {});
  // place the pin (map tap equivalent) → coords → quote
  await page.evaluate(() => {
    localStorage.setItem('mbg_delivery_coords', JSON.stringify({ lat: 14.5648, lng: 121.03 }));
    document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
  });
  await page.waitForSelector('#placeOrderBtn:not([disabled])', { timeout: 10000 });
  await snap('08-checkout-top');
  await snapEl('09-checkout-full', '#checkoutScreen .checkout-inner');

  // 8. Receipt upload + place order
  await page.setInputFiles('#receiptFile', { name: 'r.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const el = document.querySelector('#payInfoBox');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await snap('10-payment');
  await page.click('#placeOrderBtn');
  await page.waitForSelector('#successScreen.open', { state: 'visible' });
  await snap('11-success');

  // 9. My Orders
  await page.click('#successTrack');
  await page.waitForSelector('#trackingScreen.open', { state: 'visible' });
  await page.waitForSelector('.ord-card', { state: 'visible' });
  await snap('12-orders');
  await snapEl('13-orders-full', '#trackingScreen .tracking-inner');

  await ctx.close();
}

writeFileSync(join(OUT, 'findings.json'), JSON.stringify(allFindings, null, 2));

// Console summary of non-empty findings
for (const [vpLabel, steps] of Object.entries(allFindings)) {
  for (const [step, f] of Object.entries(steps)) {
    const n = f.hOverflow.length + f.overlaps.length;
    if (n || f.tapTargets.length) {
      console.log(`\n[${vpLabel}] ${step}: overflow=${f.hOverflow.length} overlaps=${f.overlaps.length} smallTaps=${f.tapTargets.length}`);
      f.hOverflow.slice(0, 6).forEach(o => console.log('   OVF ', JSON.stringify(o)));
      f.overlaps.slice(0, 6).forEach(o => console.log('   OVL ', JSON.stringify(o)));
      f.tapTargets.slice(0, 8).forEach(o => console.log('   TAP ', JSON.stringify(o)));
    }
  }
}

await browser.close();
srv.close();
console.log('\nAudit complete →', OUT);
