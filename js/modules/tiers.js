/* MBG Storefront v2 — Customer Tier display
 *
 * Schema: customer_tiers keys on `customer_phone` (text) — there is no
 * `customer_id` column. Tier is an integer (1=Seedling .. 5=Diamond).
 * If the SELECT errors or no row exists, we silently degrade.
 */
import { sb } from '../core/supabase.js';
import { esc } from '../core/utils.js';
import { getSession, getAuthPhone } from '../core/auth.js?v=20260520-polish';

const TIER_META = {
  1: { name: 'Seedling', color: '#94a3b8' },
  2: { name: 'Bronze',   color: '#b87333' },
  3: { name: 'Silver',   color: '#c0c0c0' },
  4: { name: 'Gold',     color: '#C8A038' },
  5: { name: 'Diamond',  color: '#7dd3fc' }
};

let _tier = null;

export async function loadTier() {
  const sess  = getSession();
  const phone = sess?.phone || getAuthPhone();
  if (!phone) { _tier = null; return null; }

  try {
    const { data, error } = await sb().from('customer_tiers')
      .select('*')
      .eq('customer_phone', phone)
      .maybeSingle();
    if (error) throw error;
    _tier = data || null;
  } catch(e) {
    _tier = null;
  }
  return _tier;
}

export function getTier() { return _tier; }

export function renderTierBadge(targetEl) {
  if (!targetEl) return;
  const sess = getSession();
  if (!sess) { targetEl.innerHTML = ''; targetEl.style.display = 'none'; return; }

  if (!_tier) {
    // Plain name pill while we have no tier data
    targetEl.style.display = '';
    targetEl.innerHTML = `<span class="tier-pill tier-default">
      <span class="tier-dot"></span>
      <span class="tier-name">${esc(sess.display_name || 'You')}</span>
    </span>`;
    return;
  }

  const meta  = TIER_META[Number(_tier.tier)] || { name: 'Member', color: '#C8A038' };
  const label = _tier.tier_name || meta.name;
  const color = _tier.color || _tier.badge_color || meta.color;

  targetEl.style.display = '';
  targetEl.innerHTML = `<span class="tier-pill" style="--tier-color:${esc(color)}">
    <span class="tier-dot"></span>
    <span class="tier-name">${esc(label)}</span>
  </span>`;
}

