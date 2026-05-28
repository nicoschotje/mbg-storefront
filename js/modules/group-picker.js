/* MBG Storefront v2 — Group Picker bottom sheet (Phase 4)
 *
 * Slide-up sheet for products that share a group_name. Uses partial DOM
 * mutation (per the agreed spec) so taps swap the hero image, price line,
 * "Selected:" text, and CTA without rebuilding the variant list.
 *
 * Public API: openGroupPicker(group, options?) — options.onAdd(selected)
 * lets the legacy has_variants strain-picker hand-off the cart payload
 * with the original parent product so cart keys stay stable.
 */
import { esc, formatPrice, openOverlay, closeOverlay } from '../core/utils.js';
import { addToCart } from './cart.js?v=20260520-iphone-fix';

const STRAIN_LABELS = {
  'sativa':        'Sativa',
  'indica':        'Indica',
  'hybrid':        'Hybrid',
  'sativa hybrid': 'Sativa Hybrid',
  'indica hybrid': 'Indica Hybrid',
};
const STRAIN_ORDER = ['sativa', 'indica', 'hybrid', 'sativa hybrid', 'indica hybrid'];

function normStrain(s) { return String(s == null ? '' : s).toLowerCase().trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' '); }
function strainSlug(s) { return normStrain(s).replace(/\s+/g, '-'); }
function titleCase(s) {
  return (s || '').split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

function pickVerb(category) {
  return (category || '').toLowerCase() === 'edibles' ? 'flavor' : 'strain';
}

function priceRangeText(min, max) {
  return min === max
    ? formatPrice(min)
    : `${formatPrice(min)} – ${formatPrice(max)}`;
}

export function openGroupPicker(group, options = {}) {
  if (!group?.products?.length) return;

  let host = document.getElementById('group-picker-overlay');
  if (!host) {
    host = document.createElement('div');
    host.id = 'group-picker-overlay';
    document.body.appendChild(host);
  }
  renderSheet(host, group, options);
  requestAnimationFrame(() => host.classList.add('open'));
  openOverlay('group-picker-overlay', () => closeGroupPicker());
  host.addEventListener('click', backdropHandler);
}

function backdropHandler(e) {
  if (e.target.id === 'group-picker-overlay') closeGroupPicker();
}

export function closeGroupPicker() {
  const host = document.getElementById('group-picker-overlay');
  if (!host) return;
  host.classList.remove('open');
  closeOverlay('group-picker-overlay');
  host.removeEventListener('click', backdropHandler);
  setTimeout(() => { if (host && !host.classList.contains('open')) host.innerHTML = ''; }, 320);
}

function renderSheet(host, group, options) {
  const verb = pickVerb(group.category);

  // Build filter pills from the strain_type values that actually appear on
  // the products. Use the slug form (dash-separated) for the filter key so
  // it matches the variant row's data-strain attribute exactly. Canonical
  // 5 sort first in their fixed order; anything else follows alphabetically,
  // so legitimate data is never dropped just because it isn't in the
  // allowlist.
  const STRAIN_SLUG_ORDER = STRAIN_ORDER.map(t => t.replace(/\s+/g, '-'));
  const presentSlugsOrdered = [];
  const seen = new Set();
  for (const p of group.products) {
    const slug = strainSlug(p.strain_type);
    const norm = normStrain(p.strain_type);
    if (!norm || seen.has(slug)) continue;
    seen.add(slug);
    presentSlugsOrdered.push({ slug, norm });
  }
  presentSlugsOrdered.sort((a, b) => {
    const ai = STRAIN_SLUG_ORDER.indexOf(a.slug);
    const bi = STRAIN_SLUG_ORDER.indexOf(b.slug);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.norm.localeCompare(b.norm);
  });
  const filterOrder = [{ slug: 'all', norm: 'all' }, ...presentSlugsOrdered];
  const showFilters = presentSlugsOrdered.length > 0;

  const initialPrice = priceRangeText(group.min_price, group.max_price);

  host.innerHTML = `
    <div id="group-picker-sheet" role="dialog" aria-label="${esc(group.group_name)}">
      <button type="button" id="group-picker-close" aria-label="Close">×</button>
      ${group.cover_image
        ? `<img id="group-picker-image" src="${esc(group.cover_image)}" alt="${esc(group.group_name)}"/>`
        : `<div id="group-picker-image" class="group-picker-image-fallback">${esc(group.emoji || '🌿')}</div>`}
      <h2 id="group-picker-title">${esc(group.group_name)}</h2>
      <p id="group-picker-price">${esc(initialPrice)}</p>
      <p id="group-picker-selected" style="display:none"></p>
      ${showFilters ? `
      <div id="group-picker-filters" class="group-picker-filter-pills" role="tablist">
        ${filterOrder.map(({ slug, norm }) => {
          const label = slug === 'all'
            ? 'All'
            : (STRAIN_LABELS[norm] || titleCase(norm));
          const active = slug === 'all' ? ' active' : '';
          return `<button type="button" class="filter-pill${active}" data-filter="${esc(slug)}" role="tab">${esc(label)}</button>`;
        }).join('')}
      </div>` : ''}
      <div id="group-picker-list">
        ${group.products.map(p => variantRowHtml(p)).join('')}
      </div>
      <button type="button" id="group-picker-cta" disabled>Select a ${verb} first</button>
    </div>`;

  wire(host, group, options, verb);
}

function variantRowHtml(p) {
  const stockVal = p.stock_qty ?? p.stock ?? null;
  const inStock  = stockVal === null || Number(stockVal) > 0;
  const img = p.image_url || p.image || '';
  // Badge appears for any non-empty strain_type. Canonical 5 strain values
  // pick up their colour via `.strain-<slug>` rules in components.css; any
  // other value still renders with the neutral .group-strain-badge style.
  const st   = normStrain(p.strain_type);
  const slug = strainSlug(p.strain_type);
  const badge = st
    ? `<span class="variant-badge group-strain-badge strain-${esc(slug)}">${esc(STRAIN_LABELS[st] || titleCase(st))}</span>`
    : '';
  const oosTag = inStock ? '' : `<span class="variant-oos">Out of stock</span>`;
  const cls = `variant-row${inStock ? '' : ' out-of-stock'}`;
  const thumb = img
    ? `<img src="${esc(img)}" class="variant-thumb" alt="" loading="lazy"/>`
    : `<div class="variant-thumb variant-thumb-fallback">🌿</div>`;
  return `<div class="${cls}" data-id="${esc(p.id)}" data-instock="${inStock ? '1' : '0'}" data-strain="${esc(strainSlug(p.strain_type))}" data-price="${Number(p.price) || 0}" data-name="${esc(p.name || '')}" data-image="${esc(img)}" data-strain-type="${esc(p.strain_type || '')}">
    ${thumb}
    <div class="variant-info">
      <span class="variant-name">${esc(p.name || '')}</span>
      ${badge}${oosTag}
    </div>
    <span class="variant-price">${esc(formatPrice(Number(p.price) || 0))}</span>
  </div>`;
}

function wire(host, group, options, verb) {
  const imageEl    = host.querySelector('#group-picker-image');
  const priceEl    = host.querySelector('#group-picker-price');
  const selectedEl = host.querySelector('#group-picker-selected');
  const ctaEl      = host.querySelector('#group-picker-cta');
  const listEl     = host.querySelector('#group-picker-list');

  let selectedId = null;

  host.querySelector('#group-picker-close')?.addEventListener('click', () => closeGroupPicker());

  // Filter pills — show/hide variant rows via display:none, per spec.
  host.querySelectorAll('#group-picker-filters .filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      host.querySelectorAll('#group-picker-filters .filter-pill').forEach(p => p.classList.toggle('active', p === pill));
      const filter = pill.dataset.filter;
      listEl.querySelectorAll('.variant-row').forEach(row => {
        const show = filter === 'all' || row.dataset.strain === filter;
        row.style.display = show ? '' : 'none';
      });
    });
  });

  function applySelection(row) {
    selectedId = row.dataset.id;
    const name  = row.dataset.name;
    const price = Number(row.dataset.price) || 0;
    const img   = row.dataset.image || group.cover_image || '';
    const inStock = row.dataset.instock === '1';

    // Swap hero image.
    if (imageEl) {
      if (imageEl.tagName === 'IMG') {
        imageEl.src = img || group.cover_image || '';
      } else if (img || group.cover_image) {
        // Replace fallback div with a real <img> the first time a variant is picked.
        const newImg = document.createElement('img');
        newImg.id = 'group-picker-image';
        newImg.alt = group.group_name || '';
        newImg.src = img || group.cover_image || '';
        imageEl.replaceWith(newImg);
      }
    }
    priceEl.textContent = formatPrice(price);
    selectedEl.textContent = `Selected: ${name}`;
    selectedEl.style.display = '';

    // Toggle .selected on rows.
    listEl.querySelectorAll('.variant-row').forEach(r => r.classList.toggle('selected', r === row));

    // CTA state.
    if (!inStock) {
      ctaEl.textContent = 'Out of Stock';
      ctaEl.disabled = true;
    } else {
      ctaEl.textContent = `Add to Cart · ${formatPrice(price)}`;
      ctaEl.disabled = false;
    }
  }

  listEl.querySelectorAll('.variant-row').forEach(row => {
    row.addEventListener('click', () => {
      if (row.dataset.instock !== '1') return;
      applySelection(row);
    });
  });

  ctaEl.addEventListener('click', () => {
    if (ctaEl.disabled || !selectedId) return;
    const sel = group.products.find(p => p.id === selectedId);
    if (!sel) return;
    const stock = sel.stock_qty ?? sel.stock ?? null;
    if (!(stock === null || stock > 0)) return;

    if (typeof options.onAdd === 'function') {
      options.onAdd(sel);
    } else {
      // Default: reuse the (product, qty, variant) cart shape so existing
      // cart keys, qty controls, and persistence keep working.
      const parent = {
        id:        group.id,
        name:      group.group_name,
        image_url: sel.image_url || sel.image || group.cover_image || '',
        emoji:     group.emoji || '',
        price:     Number(sel.price) || 0,
        category:  group.category || '',
      };
      const variant = {
        id:             sel.id,
        name:           sel.name || '',
        strain_type:    sel.strain_type || null,
        price_override: Number(sel.price) || 0,
      };
      addToCart(parent, 1, variant);
    }
    closeGroupPicker();
  });
}
