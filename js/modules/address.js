/* MBG Storefront v2 — Delivery address autocomplete (Nominatim / OpenStreetMap)
 * Philippines-only address handling for the checkout Street/Building field.
 *
 * WHY THIS IS NOT GOOGLE PLACES ANYMORE
 * -------------------------------------
 * The old version used Google Places autocomplete. Google appends its dropdown
 * (".pac-container") to <body> and positions it against the *document*, so
 * inside our position:fixed, internally-scrolling checkout overlay the dropdown
 * floated detached in the middle of the screen — and on iPhone the on-screen
 * keyboard pushed it off-screen entirely. That was the "broken address on
 * iPhone" the owner reported.
 *
 * This version renders our OWN suggestion list (.addr-suggest) as a child of the
 * Street field, INSIDE the scrolling form. It scrolls with the form, sits
 * directly under the input, and is never affected by the keyboard — because it
 * is a normal in-flow element, not a fixed body-level popup. It also removes the
 * Google Maps dependency (and its hardcoded API key / billing), leaving a single
 * address provider: OpenStreetMap's Nominatim, which the app already uses for
 * the Leaflet map and reverse-geocoding.
 *
 * Two coordinate sources, both Nominatim:
 *   • Typing in #coStreet → search suggestions; tapping one fills the five
 *     structured fields and captures that place's coordinates.
 *   • Dragging the Leaflet map pin → reverse-geocode the new point and refill
 *     the same five fields.
 *
 * Either way the coordinates land in localStorage (read by getSelectedCoords())
 * so checkout can include them in the place-order payload and feed the
 * distance-based delivery calculator. `mbg:deliveryAddrChanged` re-quotes the
 * fee; `mbg:addrPicked` moves the Leaflet pin to match a picked suggestion.
 *
 * #coStreet is created on demand (and re-rendered) by checkout.js, so this
 * module binds via event delegation and (re)creates the suggestion list against
 * whichever #coStreet is currently in the DOM.
 */

const FIELD_ID = 'coStreet';
const COORDS_KEY = 'mbg_delivery_coords';

// Nominatim politeness: only search once the query is meaningful, debounce, and
// abort any in-flight request when the customer keeps typing.
const MIN_QUERY_LEN = 3;
const SEARCH_DEBOUNCE_MS = 350;

let _selectedCoords = null;   // { lat, lng } once a place is picked / pin dragged
let _filling = false;         // true while we programmatically fill the fields
let _searchTimer = null;      // debounce handle for the live search
let _searchAbort = null;      // AbortController for the in-flight search fetch
let _lastResults = [];        // latest Nominatim results, indexed by the list items

function storeCoords(coords) {
  _selectedCoords = coords;
  try {
    if (coords) localStorage.setItem(COORDS_KEY, JSON.stringify(coords));
    else localStorage.removeItem(COORDS_KEY);
  } catch(_) { /* private mode / quota — fall back to in-memory only */ }
}

export function getSelectedCoords() {
  try {
    const raw = localStorage.getItem(COORDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng)) {
        _selectedCoords = parsed;
        return parsed;
      }
    }
  } catch(_) { /* corrupted storage — fall through to in-memory */ }
  if (!_selectedCoords) {
    console.warn('[MBG] No coords stored — delivery will use flat fallback');
  }
  return _selectedCoords;
}

// Minimal HTML escaper — Nominatim's display_name is external text, so escape it
// before injecting into the suggestion list. (Kept local so this module stays
// self-contained and has no import-version coupling.)
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Map a Nominatim result onto the five structured fields ───────────────────
// Nominatim returns a flat `address` object (road, suburb, city, state, …),
// unlike Google's typed component array. PH barangays come through as
// suburb/neighbourhood/village/quarter, and the province is usually `state`.
function parseNominatim(result) {
  const a = result?.address || {};
  const houseStreet = [a.house_number, a.road].filter(Boolean).join(' ').trim();
  const street   = houseStreet || a.building || a.amenity || a.shop || result?.name || '';
  const barangay = a.suburb || a.neighbourhood || a.village || a.quarter
                 || a.city_district || a.residential || a.hamlet || '';
  const city     = a.city || a.town || a.municipality || a.county || '';
  const province = a.province || a.state || a.region || '';
  const postal   = a.postcode || '';
  const lat = Number(result?.lat);
  const lng = Number(result?.lon);
  return { street, barangay, city, province, postal, lat, lng };
}

// Writes the five fields and fires input events so any validation listeners run.
// `_filling` guards the manual-edit listener below so these synthetic events
// don't wipe the coordinates we're storing alongside, or kick off a new search.
// `streetEl` lets the caller pass the exact #coStreet node it is working with
// (checkout may be mid-re-render).
function setFields({ street, barangay, city, province, postal }, streetEl) {
  _filling = true;
  const filled = [];
  const set = (id, val, el) => {
    el = el || document.getElementById(id);
    if (el && val) { el.value = String(val); filled.push(el); }
  };
  set(FIELD_ID, street, streetEl);
  set('coBarangay', barangay);
  set('coCity', city);
  set('coProvince', province);
  set('coPostal', postal);
  for (const el of filled) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  _filling = false;
}

// ── Inline suggestion list (.addr-suggest) ───────────────────────────────────
// Created lazily as a child of the Street field's .field wrapper (which is
// position:relative in CSS), so the list drops directly under the input and
// scrolls with the form. Re-created automatically after a checkout re-render.
function getSuggestBox(field) {
  const wrap = field.closest('.field') || field.parentElement;
  if (!wrap) return null;
  let box = wrap.querySelector('.addr-suggest');
  if (!box) {
    box = document.createElement('ul');
    box.className = 'addr-suggest';
    box.hidden = true;
    box.setAttribute('role', 'listbox');
    // pointerdown (not click) so selecting fires BEFORE the input's blur would
    // hide the list; preventDefault keeps focus on the field.
    box.addEventListener('pointerdown', (e) => {
      const item = e.target.closest('.addr-suggest-item');
      if (!item) return;
      e.preventDefault();
      const r = _lastResults[Number(item.dataset.idx)];
      if (r) selectSuggestion(r, field);
    });
    wrap.appendChild(box);
  }
  return box;
}

function hideSuggestions(field) {
  const wrap = field?.closest?.('.field');
  const box = wrap?.querySelector('.addr-suggest');
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

function renderSuggestions(field, results) {
  const box = getSuggestBox(field);
  if (!box) return;
  _lastResults = results;
  if (!results.length) {
    // Show a visible, non-clickable empty state instead of silently hiding —
    // "no results" previously felt like the field was broken.
    box.innerHTML = '<li class="addr-suggest-empty" aria-disabled="true">No matches — keep typing, or drop your pin on the map.</li>';
    box.hidden = false;
    return;
  }
  box.innerHTML = results.map((r, i) =>
    `<li class="addr-suggest-item" role="option" data-idx="${i}">${escapeHtml(r.display_name)}</li>`
  ).join('');
  box.hidden = false;
}

// Shows a non-clickable status row (lookup failed / rate-limited). Clears the
// cached results so a stray pointerdown can't select a stale suggestion.
function showSuggestMessage(field, msg) {
  const box = getSuggestBox(field);
  if (!box) return;
  _lastResults = [];
  box.innerHTML = `<li class="addr-suggest-empty" aria-disabled="true">${escapeHtml(msg)}</li>`;
  box.hidden = false;
}

// Live PH address search via Nominatim. Country-restricted, capped, abortable.
async function runSearch(field) {
  const q = field.value.trim();
  if (q.length < MIN_QUERY_LEN) { hideSuggestions(field); return; }

  if (_searchAbort) _searchAbort.abort();
  _searchAbort = new AbortController();

  try {
    // viewbox biases results toward the Philippines bounding box
    // (lon/lat: west,north,east,south) on top of countrycodes=ph, so local
    // streets rank above same-named places elsewhere.
    const url = 'https://nominatim.openstreetmap.org/search'
      + '?format=jsonv2&addressdetails=1&countrycodes=ph&limit=5&accept-language=en'
      + '&viewbox=116.9,21.1,126.6,4.5'
      + '&q=' + encodeURIComponent(q);
    const res = await fetch(url, { signal: _searchAbort.signal, headers: { 'Accept': 'application/json' } });
    // The field may have been re-rendered while the request was in flight —
    // re-resolve the live node before painting.
    const live = document.getElementById(FIELD_ID) || field;
    if (!res.ok) {
      showSuggestMessage(live, res.status === 429
        ? 'Too many lookups — wait a moment and try again.'
        : 'Address lookup failed — try again, or drop your pin on the map.');
      return;
    }
    const results = await res.json();
    renderSuggestions(live, Array.isArray(results) ? results : []);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.warn('[address] search failed', e);
      const live = document.getElementById(FIELD_ID) || field;
      showSuggestMessage(live, 'Address lookup failed — try again, or drop your pin on the map.');
    }
  }
}

// Customer tapped a suggestion: fill the fields, capture coords, move the pin.
function selectSuggestion(result, field) {
  const p = parseNominatim(result);
  setFields(p, field);
  hideSuggestions(field);

  if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
    storeCoords({ lat: p.lat, lng: p.lng });
    document.dispatchEvent(new CustomEvent('mbg:addrPicked', { detail: { lat: p.lat, lng: p.lng } }));
  } else {
    storeCoords(null);
  }
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
}

// ── Event wiring (delegated, survives checkout re-renders) ────────────────────

// Typing in the Street field: debounce a search, and treat the edit as
// invalidating any previously picked coordinates (delivery falls back to an
// estimate until a new suggestion is chosen). Skipped while we fill the fields
// programmatically (setFields sets _filling).
document.addEventListener('input', (e) => {
  if (e.target?.id !== FIELD_ID || _filling) return;
  storeCoords(null);
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
  clearTimeout(_searchTimer);
  const field = e.target;
  _searchTimer = setTimeout(() => runSearch(field), SEARCH_DEBOUNCE_MS);
});

// Leaving the field hides the list — but only after a short delay so a tap on a
// suggestion still registers (pointerdown above also guards this).
document.addEventListener('focusout', (e) => {
  if (e.target?.id !== FIELD_ID) return;
  setTimeout(() => hideSuggestions(e.target), 150);
});

// Tapping anywhere outside the Street field closes the list.
document.addEventListener('pointerdown', (e) => {
  if (e.target?.closest?.('.field')?.querySelector?.('#' + FIELD_ID)) return; // inside street field
  if (e.target?.id === FIELD_ID) return;
  const field = document.getElementById(FIELD_ID);
  if (field) hideSuggestions(field);
});

// The Leaflet map pin is the other source of coordinates — when the customer
// drags it, store the new position and reverse-geocode with Nominatim to refresh
// the five address fields. getSelectedCoords() stays the single source of truth.
document.addEventListener('mbg:mapPinMoved', async (e) => {
  const lat = Number(e.detail?.lat);
  const lng = Number(e.detail?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  storeCoords({ lat, lng });

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`
    );
    if (!res.ok) return;
    const data = await res.json();
    const p = parseNominatim(data);
    setFields(p, null);
    document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
  } catch (err) {
    console.warn('[address] reverse geocode failed', err);
  }
});
