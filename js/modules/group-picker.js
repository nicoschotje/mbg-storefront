/* MBG Storefront v2 — Group Picker bottom sheet (Phase 4)
 *
 * Opens for "grouped products" — distinct products that share the same
 * group_name. Unlike the legacy strain-picker (which reads from
 * product_variants for has_variants=true parents), every option here is a
 * real products-row with its own image, price, and stock. The top hero
 * image swaps to the selected variant's image_url so the customer sees
 * exactly what they're picking.
 *
 * Lives alongside the legacy openStrainPicker — neither calls the other.
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

function normStrain(s) { return (s || '').toLowerCase().trim(); }

function selectVerbForCategory(category) {
  return (category || '').toLowerCase() === 'edibles' ? 'flavor' : 'strain';
}

// options.onAdd(selectedProduct) lets callers override the cart payload. The
// legacy has_variants strain-picker uses this hook to keep the original
// (parent, variant) shape so cart keys stay stable across the two pickers.
export function openGroupPicker(group, options = {}) {
  if (!group?.products?.length) return;

  let host = document.getElementById('groupSheet');
  if (!host) {
    host = document.createElement('div');
    host.id = 'groupSheet';
    host.className = 'group-sheet-backdrop';
    document.body.appendChild(host);
  }

  requestAnimationFrame(() => host.classList.add('open'));
  openOverlay('groupSheet', () => closeGroupPicker());
  host.addEventListener('click', backdropHandler);

  renderSheet(host, group, options);
}

function backdropHandler(e) {
  if (e.target.id === 'groupSheet') closeGroupPicker();
}

export function closeGroupPicker() {
  const host = document.getElementById('groupSheet');
  if (!host) return;
  host.classList.remove('open');
  closeOverlay('groupSheet');
  host.removeEventListener('click', backdropHandler);
  setTimeout(() => { if (host && !host.classList.contains('open')) host.innerHTML = ''; }, 320);
}

function renderSheet(host, group, options = {}) {
  let selectedId = null;
  let activeFilter = 'all';
  const verb = selectVerbForCategory(group.category);

  // Filter pills only show strain types that actually appear in this group.
  const presentTypes = new Set(
    group.products
      .map(p => normStrain(p.strain_type))
      .filter(t => STRAIN_LABELS[t])
  );
  const filters = ['all', ...STRAIN_ORDER.filter(t => presentTypes.has(t))];
  const showFilters = group.has_strain_types;

  function selected() { return group.products.find(p => p.id === selectedId) || null; }

  function visibleProducts() {
    if (activeFilter === 'all') return group.products;
    return group.products.filter(p => normStrain(p.strain_type) === activeFilter);
  }

  function heroImage() {
    const sel = selected();
    if (sel && (sel.image_url || sel.image)) return sel.image_url || sel.image;
    return group.cover_image || '';
  }

  function priceText() {
    const sel = selected();
    if (sel) return formatPrice(Number(sel.price) || 0);
    return group.min_price === group.max_price
      ? formatPrice(group.min_price)
      : `${formatPrice(group.min_price)} – ${formatPrice(group.max_price)}`;
  }

  function ctaState() {
    const sel = selected();
    if (!sel) {
      return { disabled: true, label: `Select a ${verb} first` };
    }
    const stock = sel.stock_qty ?? sel.stock ?? null;
    const inStock = stock === null || stock > 0;
    if (!inStock) return { disabled: true, label: 'Out of Stock' };
    return { disabled: false, label: `Add to Cart · ${formatPrice(Number(sel.price) || 0)}` };
  }

  function renderFilterPills() {
    if (!showFilters) return '';
    return `<div class="group-filter-bar" role="tablist">
      ${filters.map(f => {
        const label = f === 'all' ? 'All' : STRAIN_LABELS[f];
        const active = f === activeFilter ? ' active' : '';
        return `<button type="button" class="group-filter-pill${active}" data-filter="${esc(f)}" role="tab">${esc(label)}</button>`;
      }).join('')}
    </div>`;
  }

  function variantRowHtml(p) {
    const img  = p.image_url || p.image || '';
    const st   = normStrain(p.strain_type);
    const stockVal = p.stock_qty ?? p.stock ?? null;
    const inStock  = stockVal === null || stockVal > 0;
    const isSelected = p.id === selectedId;
    const cls = `group-variant-row${isSelected ? ' selected' : ''}${inStock ? '' : ' sold-out'}`;
    const badge = STRAIN_LABELS[st]
      ? `<span class="group-strain-badge strain-${esc(st.replace(/\s+/g, '-'))}">${esc(STRAIN_LABELS[st])}</span>`
      : '';
    const thumb = img
      ? `<img src="${esc(img)}" alt="" loading="lazy"/>`
      : `<div class="group-variant-thumb-fallback">🌿</div>`;
    const stockTag = inStock ? '' : `<span class="group-variant-oos">Out of stock</span>`;
    const checkmark = isSelected ? `<span class="group-variant-check" aria-hidden="true">✓</span>` : '';
    return `<button type="button" class="${cls}" data-variant="${esc(p.id)}" ${inStock ? '' : 'disabled aria-disabled="true"'}>
      <span class="group-variant-thumb">${thumb}</span>
      <span class="group-variant-mid">
        <span class="group-variant-name">${esc(p.name || '')}</span>
        <span class="group-variant-meta">${badge}${stockTag}</span>
      </span>
      <span class="group-variant-right">
        <span class="group-variant-price">${esc(formatPrice(Number(p.price) || 0))}</span>
        ${checkmark}
      </span>
    </button>`;
  }

  function paint() {
    const sel = selected();
    const cta = ctaState();
    const heroSrc = heroImage();
    const list = visibleProducts();
    host.innerHTML = `
      <div class="group-sheet" role="dialog" aria-label="${esc(group.group_name)}">
        <div class="modal-handle" aria-hidden="true"></div>
        <button class="modal-close group-sheet-close" aria-label="Close">×</button>
        <div class="group-sheet-hero">
          ${heroSrc
            ? `<img class="group-sheet-hero-img" src="${esc(heroSrc)}" alt="${esc(group.group_name)}"/>`
            : `<div class="group-sheet-hero-fallback">${esc(group.emoji || '🌿')}</div>`}
        </div>
        <div class="group-sheet-titles">
          <h3 class="group-sheet-name">${esc(group.group_name)}</h3>
          <div class="group-sheet-price">${esc(priceText())}</div>
          ${sel ? `<div class="group-sheet-selected">Selected: ${esc(sel.name || '')}</div>` : ''}
        </div>
        <div class="group-sheet-body">
          ${renderFilterPills()}
          <div class="group-variant-list">
            ${list.length
              ? list.map(variantRowHtml).join('')
              : `<div class="group-empty">Nothing matches that filter.</div>`}
          </div>
        </div>
        <div class="group-sheet-footer">
          <button type="button" class="group-add-btn${cta.disabled ? ' disabled' : ''}" ${cta.disabled ? 'disabled' : ''}>
            ${esc(cta.label)}
          </button>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    host.querySelector('.group-sheet-close')?.addEventListener('click', () => closeGroupPicker());

    host.querySelectorAll('.group-filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.dataset.filter;
        // Keep the selection even if it's hidden by the new filter — the
        // bottom button still reflects what they picked.
        paint();
      });
    });

    host.querySelectorAll('.group-variant-row').forEach(row => {
      row.addEventListener('click', () => {
        if (row.classList.contains('sold-out')) return;
        selectedId = row.dataset.variant;
        paint();
      });
    });

    host.querySelector('.group-add-btn')?.addEventListener('click', () => {
      const sel = selected();
      if (!sel) return;
      const stock = sel.stock_qty ?? sel.stock ?? null;
      if (!(stock === null || stock > 0)) return;

      if (typeof options.onAdd === 'function') {
        options.onAdd(sel);
      } else {
        // Default: reuse the (product, qty, variant) shape so cart keys, qty
        // controls, and persistence all keep working. The synthetic "parent"
        // carries the group label + cover image; the variant carries the
        // selected product's identity, name, strain, and price override.
        const parent = {
          id:        group.id,                              // "group:<group_name>"
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

  paint();
}
