/* MBG Storefront v2 — Products module
 * FIX: productMatchesCat now checks category_id (UUID) first
 */
import { sb } from '../core/supabase.js';
import { esc, formatPrice, openOverlay, closeOverlay } from '../core/utils.js';
import { renderCategoryBanner } from './banners.js?v=20260518-mobile';
import { addToCart } from './cart.js?v=20260520-iphone-fix';
import { openRestockModal } from './restock.js?v=20260518-mobile';
import { openStrainPicker } from './strain-picker.js?v=20260526-variants';
import { openGroupPicker } from './group-picker.js?v=20260528-cart-label';
let _products = [];
let _categories = [];
let _groups = [];           // group entries derived from products.group_name
let _displayItems = [];     // mixed list of products + group entries used by the grid
let _activeCat = 'All';
let _searchQuery = '';

export function getProducts() { return _products; }
export function getGroups()   { return _groups; }
export function getCategories() { return _categories; }

export function setSearchQuery(q) {
  // Require at least 2 characters before filtering kicks in.
  const v = (q || '').toLowerCase().trim();
  _searchQuery = v.length >= 2 ? v : '';
}
export function getSearchQuery() { return _searchQuery; }

function applySearch(list) {
  if (!_searchQuery) return list;
  return list.filter(p => {
    if (p.__type === 'group') {
      if ((p.group_name || '').toLowerCase().includes(_searchQuery)) return true;
      return p.products.some(v =>
        (v.name || '').toLowerCase().includes(_searchQuery) ||
        (v.description || '').toLowerCase().includes(_searchQuery)
      );
    }
    return (p.name || '').toLowerCase().includes(_searchQuery) ||
      (p.description || '').toLowerCase().includes(_searchQuery);
  });
}

export async function loadCategories() {
  try {
    const { data } = await sb().from('categories')
      .select('*').eq('is_active', true).order('sort_order').order('name');
    _categories = (data || []).map(c => ({
      id: c.id, name: c.name, emoji: c.emoji || '', sort_order: c.sort_order ?? 0,
      description: c.description || ''
    }));
  } catch(_) { _categories = []; }
  return _categories;
}

// String coercion that never throws — many of the grouping/sort callbacks
// chain string methods on column values; if any column comes back as a
// number or boolean we still want the catalogue to render.
function s(v) { return v == null ? '' : String(v); }

// Rebuild the display list with a safety net: if grouping ever throws on
// unexpected data, log the actual error and fall back to a flat list so
// the catalogue still shows up.
function safeRebuildDisplay() {
  try {
    rebuildDisplay();
  } catch (err) {
    console.error('[products] grouping failed:', err);
    _groups = [];
    _displayItems = [..._products];
  }
}

export async function loadProducts() {
  try {
    // Fetch active products + available variants in parallel. Variants drive
    // both (a) the per-parent strain count badge and (b) the filter that
    // removes legacy "Parent — Strain" individual products from the grid
    // once a real parent (has_variants=true) takes over.
    const [productsRes, variantsRes] = await Promise.all([
      sb().from('products').select('*').eq('is_active', true),
      sb().from('product_variants').select('parent_product_id,is_available').eq('is_available', true)
    ]);
    const all = productsRes.data || [];
    const variants = variantsRes.data || [];

    // Derive group_name from "X — Y" product names if not returned by the API.
    // Guards against PostgREST schema-cache lag after migrations — select('*')
    // silently drops columns that aren't yet in the cache, so we compute it
    // from the name as a belt-and-suspenders fallback.
    for (const p of all) {
      if (!p.group_name) {
        const m = String(p.name || '').match(/^(.+?)\s—\s.+/);
        if (m) p.group_name = m[1].trim();
      }
    }

    // Active parent product names. A "parent" is has_variants=true AND active.
    const activeParentNames = new Set(
      all.filter(p => p.has_variants === true).map(p => p.name)
    );

    // New-model group names actually present in the data — used to hide a
    // stale has_variants=true parent of the same name so the new visual
    // group card supersedes the legacy radio-picker parent.
    const groupedNames = new Set(
      all
        .filter(p => p.has_variants !== true && s(p.group_name).trim())
        .map(p => s(p.group_name).trim())
    );

    // Tally available variant counts by parent_product_id for the badge.
    const variantCountByParent = {};
    for (const v of variants) {
      if (!v.parent_product_id) continue;
      variantCountByParent[v.parent_product_id] = (variantCountByParent[v.parent_product_id] || 0) + 1;
    }

    // Filter rules, in order:
    //  1. Hide a has_variants=true parent if a new-model group of the same
    //     name exists (new wins over legacy).
    //  2. Keep all other has_variants=true parents (they own their variants).
    //  3. Always keep products that carry a group_name — they get grouped
    //     into a single card by rebuildDisplay() below.
    //  4. Legacy purge: drop "Parent — Strain" rows whose parent is still
    //     an active has_variants=true product.
    const filtered = all.filter(p => {
      if (p.has_variants === true) {
        if (groupedNames.has(s(p.name).trim())) return false;
        return true;
      }
      const name = s(p.name);
      const m = /\s—\s/.test(name);
      if (!m) return true;
      const parentPart = name.split(/\s—\s/)[0].trim();
      const hasGroup = s(p.group_name).trim() !== '';
      // Purge ONLY if the legacy has_variants parent exists AND this product
      // has no group_name. group_name products belong to the new grouping
      // model — never remove them via the legacy "Parent — Variant" filter.
      return !(activeParentNames.has(parentPart) && !hasGroup);
    });

    // Attach the variant count so productCardHtml can render the strain badge
    // without an extra round-trip per card.
    for (const p of filtered) {
      if (p.has_variants === true) {
        p._variantCount = variantCountByParent[p.id] || 0;
      }
    }

    _products = filtered.sort((a, b) => {
      if (!!b.is_featured !== !!a.is_featured) return b.is_featured ? 1 : -1;
      if (!!b.is_hot_deal !== !!a.is_hot_deal) return b.is_hot_deal ? 1 : -1;
      return s(a.name).localeCompare(s(b.name));
    });
    safeRebuildDisplay();
    cacheProductsOffline(_products);
  } catch(e) {
    console.warn('[products] load failed, trying offline cache', e);
    _products = restoreProductsOffline();
    safeRebuildDisplay();
  }
  return _products;
}

// Splits _products into standalones + group entries. group_name groups products
// that share the same label into a single visual card; the bottom-sheet picker
// (group-picker.js) exposes the underlying variants. has_variants=true parents
// keep their legacy strain-picker path untouched.
function rebuildDisplay() {
  const groupMap = new Map();
  const standalone = [];
  for (const p of _products) {
    const gn = s(p.group_name).trim();
    if (gn && p.has_variants !== true) {
      let g = groupMap.get(gn);
      if (!g) {
        g = { __type: 'group', group_name: gn, products: [] };
        groupMap.set(gn, g);
      }
      g.products.push({ ...p });
    } else {
      standalone.push(p);
    }
  }
  _groups = [];
  for (const g of groupMap.values()) {
    g.products = g.products.filter(Boolean);   // null check — defend against stray null/undefined entries
    g.products.sort((a, b) => s(a && a.name).localeCompare(s(b && b.name)));
    const first = g.products[0] || {};
    const prices = g.products.map(p => Number(p.price) || 0);
    g.category    = s(first.category);
    g.category_id = first.category_id || null;
    g.cover_image = s(first.image_url || first.image);
    g.emoji       = s(first.emoji);
    g.min_price   = prices.length ? Math.min(...prices) : 0;
    g.max_price   = prices.length ? Math.max(...prices) : 0;
    g.has_any_in_stock  = g.products.some(p => {
      const stk = p.stock_qty ?? p.stock ?? null;
      return stk === null || Number(stk) > 0;
    });
    g.has_strain_types  = g.products.some(p => s(p.strain_type).trim() !== '');
    g.is_featured = g.products.some(p => !!p.is_featured);
    g.is_hot_deal = g.products.some(p => !!p.is_hot_deal);
    g.id          = `group:${gn}`;
    _groups.push(g);
  }
  _displayItems = [...standalone, ..._groups].sort((a, b) => {
    if (!!b.is_featured !== !!a.is_featured) return b.is_featured ? 1 : -1;
    if (!!b.is_hot_deal !== !!a.is_hot_deal) return b.is_hot_deal ? 1 : -1;
    const an = a.__type === 'group' ? a.group_name : a.name;
    const bn = b.__type === 'group' ? b.group_name : b.name;
    return s(an).localeCompare(s(bn));
  });
}

function cacheProductsOffline(arr) {
  try { localStorage.setItem('mg_products_cache_v3', JSON.stringify(arr)); } catch(_) {}
}
function restoreProductsOffline() {
  // Read the current cache key first; fall back to the previous one so a
  // schema-bump rename doesn't strand users with no cached catalogue on a
  // failed network load.
  try {
    const raw = localStorage.getItem('mg_products_cache_v3')
             || localStorage.getItem('mg_products_cache_v2');
    return raw ? JSON.parse(raw) : [];
  } catch(_) { return []; }
}

export function renderCategoryNav(targetEl, onChange) {
  if (!targetEl) return;
  const all = [{ name: 'All', emoji: '🌿' }, ..._categories];
  targetEl.innerHTML = all.map(c => {
    const active = c.name === _activeCat ? ' active' : '';
    return `<button type="button" class="cat-pill${active}" data-cat="${esc(c.name)}">${esc(c.emoji)} ${esc(c.name)}</button>`;
  }).join('');
  targetEl.querySelectorAll('.cat-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeCat = btn.dataset.cat;
      targetEl.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b===btn));
      onChange?.(_activeCat);
    });
  });
}

function renderItemCard(item, isWide=false) {
  return item.__type === 'group' ? groupCardHtml(item, isWide) : productCardHtml(item, isWide);
}

function findGroupByKey(key) { return _groups.find(g => g.id === key); }

export function renderProductSections(targetEl, banners = []) {
  if (!targetEl) return;
  if (!_displayItems.length) {
    targetEl.innerHTML = '<div class="empty">No products available right now. Please check back soon.</div>';
    return;
  }
  let html = '';
  const cats = _activeCat === 'All' ? _categories : _categories.filter(c => c.name === _activeCat);
  if (!cats.length) {
    html += '<div class="category-section" data-cat="All"><div class="product-grid">' + applySearch(_displayItems).map(p => renderItemCard(p)).join('') + '</div></div>';
  } else {
    cats.forEach(cat => {
      const list = applySearch(_displayItems.filter(p => productMatchesCat(p, cat)));
      if (!list.length && _activeCat === 'All') return;
      const isWide = /dab|concentr/i.test(cat.name);
      const banner = banners.find(b => b.category_name === cat.name) || null;
      const emptyMsg = _searchQuery ? 'No products found' : 'Nothing in this collection yet.';
      html += `<div class="category-section" data-cat="${esc(cat.name)}">${renderCategoryBanner(cat, banner)}<div class="product-grid${isWide?' product-grid-wide':''}">${list.map(p => renderItemCard(p, isWide)).join('') || `<div class="empty">${emptyMsg}</div>`}</div></div>`;
    });
  }
  if (!html && _searchQuery) {
    html = `<div class="empty">No products found</div>`;
  }
  targetEl.innerHTML = html;
  targetEl.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.product-add-btn') || e.target.closest('.notify-btn') || e.target.closest('.choose-strain-btn') || e.target.closest('.choose-group-btn')) return;
      if (card.dataset.group === '1') {
        const g = findGroupByKey(card.dataset.id);
        if (g && g.has_any_in_stock) openGroupPicker(g);
        return;
      }
      const p = _products.find(x => x.id === card.dataset.id);
      if (p && p.has_variants === true) { openStrainPicker(p); return; }
      openProductModal(card.dataset.id);
    });
  });
  targetEl.querySelectorAll('.product-add-btn').forEach(b => {
    b.addEventListener('click', (e) => { e.stopPropagation(); const p = _products.find(x => x.id === b.dataset.id); if (p) addToCart(p, 1); });
  });
  targetEl.querySelectorAll('.choose-strain-btn').forEach(b => {
    b.addEventListener('click', (e) => { e.stopPropagation(); const p = _products.find(x => x.id === b.dataset.id); if (p) openStrainPicker(p); });
  });
  targetEl.querySelectorAll('.choose-group-btn').forEach(b => {
    b.addEventListener('click', (e) => { e.stopPropagation(); const g = findGroupByKey(b.dataset.id); if (g) openGroupPicker(g); });
  });
  targetEl.querySelectorAll('.notify-btn').forEach(b => {
    b.addEventListener('click', (e) => { e.stopPropagation(); const p = _products.find(x => x.id === b.dataset.id); if (p) openRestockModal(p); });
  });
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    targetEl.querySelectorAll('.product-card').forEach(card => {
      const onMove = (e) => { const r = card.getBoundingClientRect(); const cx = e.clientX ?? e.touches?.[0]?.clientX; const cy = e.clientY ?? e.touches?.[0]?.clientY; if (cx == null || cy == null) return; const x = (cx - r.left) / r.width - 0.5; const y = (cy - r.top) / r.height - 0.5; card.style.setProperty('--tilt-x', (-y * 5).toFixed(2) + 'deg'); card.style.setProperty('--tilt-y', (x * 7).toFixed(2) + 'deg'); };
      const reset = () => { card.style.setProperty('--tilt-x', '0deg'); card.style.setProperty('--tilt-y', '0deg'); };
      card.addEventListener('pointermove', onMove); card.addEventListener('pointerleave', reset); card.addEventListener('pointercancel', reset); card.addEventListener('touchend', reset);
    });
  }
}

// FIX: Match by category_id (UUID) first — this is how the dashboard saves products.
function productMatchesCat(p, cat) {
  if (p.category_id && cat.id && p.category_id === cat.id) return true;
  const pcat = (p.category || p.category_name || '').toLowerCase();
  return pcat !== '' && pcat === String(cat.name).toLowerCase();
}

export function chooseLabelForCategory(category) {
  const c = (category || '').toLowerCase();
  if (c === 'vape' || c === 'flowers') return 'Choose Strain';
  if (c === 'edibles') return 'Choose Flavor';
  return 'Choose Option';
}

function priceRangeText(min, max) {
  return min === max ? formatPrice(min) : `${formatPrice(min)} – ${formatPrice(max)}`;
}

function groupCardHtml(g, isWide=false) {
  const img   = g.cover_image || '';
  const count = g.products.length;
  const subtitle = g.has_strain_types
    ? `${count} strain${count === 1 ? '' : 's'} available`
    : `${count} option${count === 1 ? '' : 's'} available`;
  const outOfStock = !g.has_any_in_stock;
  const btn = outOfStock
    ? `<button type="button" class="choose-group-btn" data-id="${esc(g.id)}" disabled>Out of Stock</button>`
    : `<button type="button" class="choose-group-btn" data-id="${esc(g.id)}">${esc(chooseLabelForCategory(g.category))}</button>`;
  return `<article class="product-card product-card-group${isWide?' product-card-wide':''}${outOfStock?' product-card-oos':''}" data-id="${esc(g.id)}" data-group="1"><div class="product-img-wrap">${img ? `<img src="${esc(img)}" alt="${esc(g.group_name)}" loading="lazy"/>` : `<div class="product-img-placeholder">${esc(g.emoji || '🌿')}</div>`}<span class="price-badge">${esc(priceRangeText(g.min_price, g.max_price))}</span></div><div class="product-info"><h3 class="product-name">${esc(g.group_name)}</h3><div class="product-sub group-sub">${esc(subtitle)}</div><div class="product-footer">${btn}</div></div></article>`;
}

function productCardHtml(p, isWide=false) {
  const img = p.image_url || p.image || '';
  const type = p.type || p.strain_type || p.category || '';
  const name = p.name || 'Untitled';
  const hasVariants = p.has_variants === true;
  const variantCount = Number(p._variantCount) || 0;
  // Parent-with-variants cards short-circuit the stock check — a parent is a
  // virtual grouping row whose own stock_qty stays 0; the real stock lives
  // on the individual variants. Stock only gates the +Add / Notify Me path
  // for plain (non-variant) products.
  let footer;
  if (hasVariants) {
    footer = `<span class="variant-count-pill">${variantCount} strain${variantCount === 1 ? '' : 's'} available</span>
       <button type="button" class="choose-strain-btn" data-id="${esc(p.id)}">Choose Strain</button>`;
  } else {
    const stock = p.stock_qty ?? p.stock ?? null;
    const inStock = stock === null || stock > 0;
    footer = inStock
      ? `<button type="button" class="product-add-btn" data-id="${esc(p.id)}">+ Add</button>`
      : `<button type="button" class="notify-btn" data-id="${esc(p.id)}">Notify Me</button>`;
  }
  return `<article class="product-card${isWide?' product-card-wide':''}${hasVariants?' product-card-variants':''}" data-id="${esc(p.id)}"><div class="product-img-wrap">${img ? `<img src="${esc(img)}" alt="${esc(name)}" loading="lazy"/>` : `<div class="product-img-placeholder">${esc(p.emoji || '🌿')}</div>`}${type ? `<span class="type-chip">${esc(type)}</span>` : ''}<span class="price-badge">${esc(formatPrice(p.price))}</span></div><div class="product-info"><h3 class="product-name">${esc(name)}</h3>${p.subtitle ? `<div class="product-sub">${esc(p.subtitle)}</div>` : ''}<div class="product-footer">${footer}</div></div></article>`;
}

export function openProductModal(productId) {
  const p = _products.find(x => x.id === productId);
  if (!p) return;
  if (p.has_variants === true) { openStrainPicker(p); return; }
  const stock = p.stock_qty ?? p.stock ?? null;
  const inStock = stock === null || stock > 0;
  const img = p.image_url || p.image || '';
  let host = document.getElementById('productModal');
  if (!host) { host = document.createElement('div'); host.id = 'productModal'; host.className = 'modal-backdrop'; document.body.appendChild(host); }
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const effects = p.effects && typeof p.effects === 'object' ? p.effects : null;
  host.innerHTML = `<div class="modal-sheet" role="dialog" aria-label="${esc(p.name)}"><div class="modal-handle" aria-hidden="true"></div><button class="modal-close" aria-label="Close">×</button><div class="modal-image">${img ? `<img src="${esc(img)}" alt="${esc(p.name)}"/>` : `<div class="modal-image-fallback">${esc(p.emoji||'🌿')}</div>`}<span class="price-badge price-badge-lg">${esc(formatPrice(p.price))}</span></div><div class="modal-body">${p.type ? `<div class="modal-type">${esc(p.type)}</div>` : ''}<h2 class="modal-title">${esc(p.name)}</h2>${p.description ? `<p class="modal-desc">${esc(p.description)}</p>` : ''}${effects ? `<div class="effect-stats">${Object.entries(effects).slice(0,4).map(([k,v]) => `<div class="effect-stat"><span>${esc(k)}</span><div class="bar"><div class="fill" style="width:${Math.min(100,Number(v)||0)}%"></div></div></div>`).join('')}</div>` : ''}${variants.length ? `<div class="variant-row">${variants.map((v,i)=>`<button type="button" class="variant-pill${i===0?' active':''}" data-variant="${esc(v.name||v)}">${esc(v.name||v)}</button>`).join('')}</div>` : ''}</div><div class="modal-cta-bar">${inStock ? `<button type="button" class="cta-add-bag" data-id="${esc(p.id)}">Add to Bag · ${esc(formatPrice(p.price))}</button>` : `<button type="button" class="cta-notify" data-id="${esc(p.id)}">Notify Me When Back</button>`}</div></div>`;
  requestAnimationFrame(() => host.classList.add('open'));
  openOverlay('productModal', closeProductModal);
  const close = () => closeProductModal();
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
  host.querySelector('.modal-close')?.addEventListener('click', close);
  host.querySelector('.cta-add-bag')?.addEventListener('click', () => { addToCart(p, 1); close(); });
  host.querySelector('.cta-notify')?.addEventListener('click', () => { close(); openRestockModal(p); });
  host.querySelectorAll('.variant-pill').forEach(b => { b.addEventListener('click', () => { host.querySelectorAll('.variant-pill').forEach(x => x.classList.remove('active')); b.classList.add('active'); }); });
}

export function closeProductModal() {
  const host = document.getElementById('productModal');
  if (!host) return;
  host.classList.remove('open');
  closeOverlay('productModal');
  setTimeout(() => { if (host && !host.classList.contains('open')) host.innerHTML = ''; }, 280);
}

// ── Featured products horizontal scroll ─────────────────────
export function renderFeaturedSection(wrapEl, scrollEl, products) {
  if (!wrapEl || !scrollEl) return;
  const featured = (products || []).filter(p => p.is_featured);
  if (!featured.length) { wrapEl.hidden = true; return; }
  scrollEl.innerHTML = featured.map(p => {
    const name = p.name || 'Untitled';
    const img  = p.image_url || p.image || '';
    const media = img
      ? `<img src="${esc(img)}" alt="${esc(name)}" loading="lazy" decoding="async"/>`
      : `<div class="featured-card-fallback">${esc(p.emoji || '🌿')}</div>`;
    return `
      <div class="featured-card" data-id="${esc(p.id)}" role="button" tabindex="0" aria-label="${esc(name)}">
        ${media}
        <div class="featured-card-body">
          <div class="featured-card-name">${esc(name)}</div>
          <div class="featured-card-price">${esc(formatPrice(p.price))}</div>
        </div>
      </div>`;
  }).join('');
  scrollEl.querySelectorAll('.featured-card').forEach(card => {
    const handler = () => openProductModal(card.dataset.id);
    card.addEventListener('click', handler);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  });
  wrapEl.hidden = false;
}
