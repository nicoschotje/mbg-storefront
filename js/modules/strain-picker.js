/* MBG Storefront v2 — Strain Picker (legacy has_variants entry point)
 *
 * Historically this rendered a radio-list bottom sheet. It now delegates to
 * the shared visual sheet in group-picker.js so has_variants=true parents
 * and group_name-grouped products show identical UI: hero image that swaps
 * on variant tap, strain badges, filter pills, sticky add-to-cart button.
 *
 * The legacy data shape is preserved: variants come from product_variants
 * (price_override, is_available) and the cart entry is still keyed by
 * <parent.id>_<variant.id> so existing in-flight carts don't double-up.
 */
import { sb } from '../core/supabase.js';
import { addToCart } from './cart.js?v=20260520-iphone-fix';
import { openGroupPicker, closeGroupPicker } from './group-picker.js?v=20260527-groups';

const STRAIN_ORDER = ['sativa', 'indica', 'hybrid', 'sativa hybrid', 'indica hybrid'];

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

function variantPrice(parent, v) {
  return v.price_override != null ? Number(v.price_override) || 0 : Number(parent.price) || 0;
}

function buildGroupFromParent(parent, variants) {
  const parentImg = parent.image_url || parent.image || '';
  // product_variants rows don't carry per-variant images or stock_qty —
  // fall back to the parent image and use is_available as the stock proxy
  // so the shared picker's in-stock checks work without special-casing.
  const products = variants.map(v => ({
    ...v,                                          // preserve every column from product_variants
    id:          v.id,
    name:        v.name || '',
    strain_type: v.strain_type || null,
    image_url:   v.image_url || parentImg,
    price:       variantPrice(parent, v),
    stock_qty:   v.is_available === false ? 0 : 1,
    _variant:    v,            // round-trip handle for the onAdd hook
  }));
  // Sort with the canonical strain order, then by name within each group.
  products.sort((a, b) => {
    const ai = STRAIN_ORDER.indexOf((a.strain_type || '').toLowerCase());
    const bi = STRAIN_ORDER.indexOf((b.strain_type || '').toLowerCase());
    const aRank = ai === -1 ? 99 : ai;
    const bRank = bi === -1 ? 99 : bi;
    if (aRank !== bRank) return aRank - bRank;
    return (a.name || '').localeCompare(b.name || '');
  });
  const prices = products.map(p => p.price);
  return {
    __type:       'group',
    id:           `parent:${parent.id}`,
    group_name:   parent.name || '',
    category:     parent.category || '',
    cover_image:  parentImg,
    emoji:        parent.emoji || '',
    products,
    min_price:        prices.length ? Math.min(...prices) : Number(parent.price) || 0,
    max_price:        prices.length ? Math.max(...prices) : Number(parent.price) || 0,
    has_any_in_stock: products.some(p => p.stock_qty > 0),
    has_strain_types: products.some(p => !!p.strain_type),
  };
}

export async function openStrainPicker(product) {
  if (!product?.id) return;
  const variants = await fetchVariants(product.id);
  const group = buildGroupFromParent(product, variants);
  openGroupPicker(group, {
    // Preserve the legacy cart shape — (real parent product, qty, variant
    // object that mirrors what the old radio picker dispatched) — so the
    // cart key stays `<parent.id>_<variant.id>` and existing entries match.
    onAdd: (sel) => {
      const v = sel?._variant;
      if (!v) return;
      addToCart(product, 1, {
        id:             v.id,
        name:           v.name,
        strain_type:    v.strain_type || null,
        price_override: v.price_override != null ? Number(v.price_override) : null,
      });
    },
  });
}

export { closeGroupPicker as closeStrainPicker };
