/* MBG Storefront v2 — Strain Picker bottom sheet
 *
 * Opens a slide-up sheet for a parent product (has_variants = true). The
 * customer picks one variant + a quantity, then we drop it into the cart
 * with a composite key so different strains coexist as separate cart lines.
 *
 * Reuses the existing .modal-backdrop / .modal-sheet animation pattern so
 * it matches the product modal's slide-up motion exactly.
 */
import { sb } from '../core/supabase.js';
import { esc, formatPrice, openOverlay, closeOverlay, showToast } from '../core/utils.js';
import { addToCart, MAX_QTY_PER_ITEM } from './cart.js?v=20260608-deepfix';

const STRAIN_META = {
  sativa: { emoji: '☀️', label: 'Sativa' },
  hybrid: { emoji: '⚖️', label: 'Hybrid' },
  indica: { emoji: '🌙', label: 'Indica' },
};
const STRAIN_ORDER = ['sativa', 'hybrid', 'indica'];

// In-memory cache so re-opening the same picker doesn't re-hit the network.
const _variantCache = {};

async function fetchVariants(parentId) {
  if (_variantCache[parentId]) return _variantCache[parentId];
  const { data, error } = await sb()
    .from('product_variants')
    .select('*')
    .eq('parent_product_id', parentId)
    .order('strain_type', { ascending: true })
    .order('sort_order',   { ascending: true });
  if (error) {
    console.warn('[strain-picker] failed to fetch variants', error);
    return [];
  }
  _variantCache[parentId] = data || [];
  return _variantCache[parentId];
}

export async function openStrainPicker(product) {
  if (!product?.id) return;

  let host = document.getElementById('strainSheet');
  if (!host) {
    host = document.createElement('div');
    host.id = 'strainSheet';
    host.className = 'strain-sheet-backdrop';
    document.body.appendChild(host);
  }

  // Show the sheet immediately with a loading state so the slide-up feels
  // instant even if the variant fetch takes a beat.
  host.innerHTML = `
    <div class="strain-sheet" role="dialog" aria-label="Choose strain">
      <div class="modal-handle" aria-hidden="true"></div>
      <button class="modal-close strain-sheet-close" aria-label="Close">×</button>
      <div class="strain-sheet-loading">Loading strains…</div>
    </div>`;
  requestAnimationFrame(() => host.classList.add('open'));
  openOverlay('strainSheet', () => closeStrainPicker());
  host.addEventListener('click', backdropHandler);
  host.querySelector('.strain-sheet-close')?.addEventListener('click', () => closeStrainPicker());

  const variants = await fetchVariants(product.id);
  renderSheet(host, product, variants);
}

function backdropHandler(e) {
  if (e.target.id === 'strainSheet') closeStrainPicker();
}

export function closeStrainPicker() {
  const host = document.getElementById('strainSheet');
  if (!host) return;
  host.classList.remove('open');
  closeOverlay('strainSheet');
  host.removeEventListener('click', backdropHandler);
  // Match the 0.32s slide-down before wiping the DOM so it animates out.
  setTimeout(() => { if (host && !host.classList.contains('open')) host.innerHTML = ''; }, 320);
}

function renderSheet(host, product, variants) {
  // State held in closure — the sheet is rebuilt cheaply on each interaction
  // (tab change rebuilds the list; selection / qty changes patch in place).
  let selectedVariantId = null;
  let activeTab = 'all';
  let qty = 1;

  // Tabs only show strain types that actually have variants.
  const presentTypes = new Set(
    variants
      .map(v => (v.strain_type || '').toLowerCase())
      .filter(t => STRAIN_META[t])
  );
  const tabs = ['all', ...STRAIN_ORDER.filter(t => presentTypes.has(t))];

  // Flowers have strain-typed variants (sativa/hybrid/indica). Edibles, vapes,
  // concentrates use sizes/formats instead — for those we say "option" not "strain".
  const isFlower = presentTypes.size > 0;
  const pickerNoun = isFlower ? 'strain' : 'option';

  const img = product.image_url || product.image || '';

  function priceFor(variantId) {
    const v = variants.find(x => x.id === variantId);
    if (v && v.price_override != null) return Number(v.price_override) || 0;
    return Number(product.price) || 0;
  }

  function selectedVariant() {
    return variants.find(v => v.id === selectedVariantId) || null;
  }

  function renderTabs() {
    return `
      <div class="strain-tab-bar" role="tablist">
        ${tabs.map(t => {
          const label = t === 'all' ? 'All' : `${STRAIN_META[t].emoji} ${STRAIN_META[t].label}`;
          const active = t === activeTab ? ' active' : '';
          return `<button type="button" class="strain-tab${active}" data-tab="${esc(t)}" role="tab">${esc(label)}</button>`;
        }).join('')}
      </div>`;
  }

  function renderList() {
    // Filter by tab, then group by strain_type for the headers.
    const filtered = activeTab === 'all'
      ? variants
      : variants.filter(v => (v.strain_type || '').toLowerCase() === activeTab);

    if (!filtered.length) {
      return '<div class="strain-empty">No strains available right now.</div>';
    }

    // Group while preserving the strain-type order (sativa → hybrid → indica → null).
    const groups = {};
    for (const v of filtered) {
      const key = (v.strain_type || '').toLowerCase();
      const bucket = STRAIN_META[key] ? key : 'none';
      (groups[bucket] ||= []).push(v);
    }
    const orderedKeys = [...STRAIN_ORDER.filter(k => groups[k]), ...(groups.none ? ['none'] : [])];

    return orderedKeys.map(k => {
      const header = k === 'none'
        ? ''
        : `<div class="strain-group-header">${STRAIN_META[k].emoji} ${esc(STRAIN_META[k].label)}</div>`;
      const rows = groups[k].map(v => {
        const soldOut = v.is_available === false || (v.stock_qty != null && v.stock_qty <= 0);
        const selected = v.id === selectedVariantId ? ' selected' : '';
        return `
          <button type="button"
            class="strain-option${selected}${soldOut ? ' sold-out' : ''}"
            data-variant="${esc(v.id)}"
            ${soldOut ? 'disabled aria-disabled="true"' : ''}>
            <span class="strain-radio" aria-hidden="true"></span>
            <span class="strain-option-name">${esc(v.name)}</span>
            ${soldOut ? '<span class="strain-soldout-badge">SOLD OUT</span>' : ''}
          </button>`;
      }).join('');
      return `<div class="strain-group">${header}${rows}</div>`;
    }).join('');
  }

  function ctaPrice() {
    return priceFor(selectedVariantId) * qty;
  }

  function paint() {
    host.innerHTML = `
      <div class="strain-sheet" role="dialog" aria-label="Choose ${pickerNoun}">
        <div class="modal-handle" aria-hidden="true"></div>
        <button class="modal-close strain-sheet-close" aria-label="Close">×</button>
        <div class="strain-sheet-head">
          <div class="strain-sheet-thumb">
            ${img ? `<img src="${esc(img)}" alt=""/>` : `<div class="strain-sheet-fallback">${esc(product.emoji || '🌿')}</div>`}
          </div>
          <div class="strain-sheet-titles">
            <h3 class="strain-sheet-name">${esc(product.name)}</h3>
            <div class="strain-sheet-price">${esc(formatPrice(product.price))}</div>
          </div>
        </div>
        <div class="strain-sheet-body">
          <div class="strain-section-label">Choose ${pickerNoun}:</div>
          ${isFlower ? renderTabs() : ''}
          <div class="strain-list">${renderList()}</div>
        </div>
        <div class="strain-sheet-footer">
          <div class="strain-qty-row">
            <span class="strain-qty-label">Quantity</span>
            <div class="strain-qty-control">
              <button type="button" class="strain-qty-btn" data-delta="-1" aria-label="Decrease">−</button>
              <input type="number" class="strain-qty-input" inputmode="numeric"
                min="1" max="${maxQty()}" value="${qty}" aria-label="Quantity">
              <button type="button" class="strain-qty-btn" data-delta="1" aria-label="Increase">+</button>
            </div>
          </div>
          <button type="button" class="strain-add-btn${selectedVariantId ? '' : ' disabled'}"
            ${selectedVariantId ? '' : 'disabled'}>
            Add to Cart  ·  ${esc(formatPrice(ctaPrice()))}
          </button>
        </div>
      </div>`;

    wire();
  }

  // Max selectable qty: a stock-tracked variant caps at its remaining stock
  // (up to MAX_QTY_PER_ITEM per order); untracked variants keep the flat cap.
  function maxQty() {
    const sv = selectedVariant();
    if (sv && sv.stock_qty != null) return Math.max(1, Math.min(MAX_QTY_PER_ITEM, sv.stock_qty));
    return MAX_QTY_PER_ITEM;
  }

  function wire() {
    host.querySelector('.strain-sheet-close')?.addEventListener('click', () => closeStrainPicker());

    host.querySelectorAll('.strain-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        // If the currently selected variant was filtered out, drop selection
        // so the CTA accurately reflects what the customer can see/tap.
        const sv = selectedVariant();
        if (sv && activeTab !== 'all' && (sv.strain_type || '').toLowerCase() !== activeTab) {
          selectedVariantId = null;
        }
        paint();
      });
    });

    host.querySelectorAll('.strain-option').forEach(opt => {
      opt.addEventListener('click', () => {
        if (opt.classList.contains('sold-out')) return;
        selectedVariantId = opt.dataset.variant;
        qty = Math.min(qty, maxQty());   // don't carry a qty above the new variant's stock
        paint();
      });
    });

    host.querySelectorAll('.strain-qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.delta) || 0;
        qty = Math.min(maxQty(), Math.max(1, qty + delta));
        paint();
      });
    });

    // Typed quantity — clamp into [1, maxQty()] on blur/Enter. We update the
    // input value and CTA price IN PLACE rather than repaint()ing, so the
    // "Add to Cart" button isn't torn out from under a tap that follows editing.
    const qtyInput = host.querySelector('.strain-qty-input');
    const commitQty = () => {
      let v = parseInt(qtyInput.value, 10);
      if (!Number.isFinite(v) || v < 1) v = 1;
      qty = Math.min(maxQty(), Math.max(1, v));
      qtyInput.value = String(qty);
      const cta = host.querySelector('.strain-add-btn');
      if (cta && selectedVariantId) cta.textContent = `Add to Cart  ·  ${formatPrice(ctaPrice())}`;
    };
    qtyInput?.addEventListener('change', commitQty);

    host.querySelector('.strain-add-btn')?.addEventListener('click', () => {
      const v = selectedVariant();
      if (!v) return;
      addToCart(product, qty, {
        id: v.id,
        name: v.name,
        strain_type: v.strain_type || null,
        price_override: v.price_override != null ? Number(v.price_override) : null,
        // Carry the variant's own stock so the cart drawer can keep enforcing
        // min(100, stock) on this line after the sheet closes.
        stock_qty: v.stock_qty != null ? Number(v.stock_qty) : null,
      });
      closeStrainPicker();
    });
  }

  paint();
}
