/* MBG Storefront v2 — Nominatim delivery-address autocomplete
 * Philippines-only address suggestions for the checkout Street/Building field.
 * On selection it stores the suggestion's coordinates so checkout can
 * include them in the place-order payload and feed the distance-based
 * delivery calculator. A `mbg:deliveryAddrChanged` event is dispatched
 * whenever the coordinates are picked or cleared so checkout can re-quote.
 *
 * The #coStreet field is created on demand (and re-rendered) by checkout.js,
 * so this module listens at the document level rather than binding directly.
 */
import { esc } from '../core/utils.js?v=20260520-polish';

const FIELD_ID = 'coStreet';
const MIN_CHARS = 3;

let _selectedCoords = null;   // { lat, lng } once a suggestion is picked
let _debounceTimer = null;
let _lastRequestAt = 0;
let _activeQuery = '';
let _dropdown = null;
let _lastResults = [];        // raw Nominatim results backing the dropdown

export function getSelectedCoords() {
  return _selectedCoords;
}

// Populates the structured address fields from a Nominatim `address` object.
// Shared by the autocomplete pick and the map pin's reverse-geocode. Only
// fields with a resolved value are written, so a partial result never wipes
// what the customer already typed.
export function applyNominatimAddress(address, displayName) {
  const a = address || {};
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val) el.value = String(val);
  };
  const street = [a.house_number, a.road || a.building || a.amenity || a.neighbourhood]
    .filter(Boolean).join(' ')
    || (displayName ? displayName.split(',')[0].trim() : '');
  set('coStreet',   street);
  set('coBarangay', a.suburb || a.neighbourhood || a.village || a.quarter);
  set('coCity',     a.city || a.town || a.municipality);

  // PH Nominatim often files the province under state_district/region/county.
  const province = a.state || a.state_district || a.region || a.county || '';
  set('coProvince', province);

  // Postcode: prefer structured field, then scrape a 4-digit code from
  // the display_name (PH ZIPs are 4 digits, often appear like "Makati 1220").
  let postcode = a.postcode || '';
  if (!postcode && displayName) {
    const m = displayName.match(/\b\d{4}\b/);
    if (m) postcode = m[0];
  }
  set('coPostal', postcode);
}

function getField() {
  return document.getElementById(FIELD_ID);
}

// Rebuilds the dropdown if checkout re-rendered (which wipes the old node).
function ensureDropdown(field) {
  if (_dropdown && _dropdown.isConnected) return _dropdown;
  const dd = document.createElement('ul');
  dd.className = 'addr-suggest';
  dd.setAttribute('role', 'listbox');
  dd.hidden = true;
  field.insertAdjacentElement('afterend', dd);
  _dropdown = dd;
  return dd;
}

function hideSuggestions() {
  if (_dropdown) { _dropdown.hidden = true; _dropdown.innerHTML = ''; }
}

function renderSuggestions(results) {
  const field = getField();
  if (!field) return;
  _lastResults = results;
  if (!results.length) { hideSuggestions(); return; }
  const dd = ensureDropdown(field);
  const wasHidden = dd.hidden;
  dd.innerHTML = results.slice(0, 6).map((r, i) =>
    `<li class="addr-suggest-item" role="option" data-idx="${i}">${esc(r.display_name)}</li>`
  ).join('');
  dd.hidden = false;
  // On iOS the on-screen keyboard can hide the dropdown when the address
  // field sits low in the form. When the list first appears, bring the
  // field toward the top so the suggestions below it stay visible.
  if (wasHidden) {
    field.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

async function runSearch(query) {
  // Nominatim fair use: max 1 req/sec; web apps identify via the browser's
  // automatic Referer header (a custom User-Agent cannot be set from fetch).
  // addressdetails=1 returns the structured parts used to fill the form.
  // See https://nominatim.org/release-docs/latest/api/Search/
  const url = 'https://nominatim.openstreetmap.org/search'
    + '?format=json&addressdetails=1&countrycodes=ph&limit=6&q=' + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('nominatim ' + res.status);
    const data = await res.json();
    // Drop stale responses if the customer kept typing.
    if (query !== _activeQuery) return;
    renderSuggestions(Array.isArray(data) ? data : []);
  } catch (e) {
    console.warn('[address] Nominatim lookup failed', e);
    hideSuggestions();
  }
}

function scheduleSearch(query) {
  clearTimeout(_debounceTimer);
  const sinceLast = Date.now() - _lastRequestAt;
  // 500ms debounce after typing stops, and never closer than 1s to the
  // previous request — a strict 1 req/sec ceiling on the public API.
  const wait = Math.max(500, 1000 - sinceLast);
  _debounceTimer = setTimeout(() => {
    _lastRequestAt = Date.now();
    runSearch(query);
  }, wait);
}

// Customer typing in the Street/Building field — schedule a debounced lookup.
document.addEventListener('input', (e) => {
  if (e.target?.id !== FIELD_ID) return;
  // A manual edit invalidates the coordinates of any earlier selection.
  _selectedCoords = null;
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
  const q = e.target.value.trim();
  _activeQuery = q;
  if (q.length < MIN_CHARS) {
    clearTimeout(_debounceTimer);
    hideSuggestions();
    return;
  }
  scheduleSearch(q);
});

// Suggestion selection + tap-outside-to-close.
document.addEventListener('click', (e) => {
  const item = e.target.closest?.('.addr-suggest-item');
  if (item) {
    const r = _lastResults[Number(item.dataset.idx)];
    if (r) {
      // Fill the Street/Building field plus Barangay/City/Province/Postal.
      applyNominatimAddress(r.address, r.display_name);
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      _selectedCoords = (Number.isFinite(lat) && Number.isFinite(lon))
        ? { lat, lng: lon }
        : null;
      if (_selectedCoords) {
        // Tell the Leaflet map to move + recentre its pin on the pick.
        document.dispatchEvent(new CustomEvent('mbg:addrPicked', {
          detail: { lat, lng: lon }
        }));
      }
    }
    const field = getField();
    _activeQuery = field ? field.value.trim() : '';
    hideSuggestions();
    document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
    return;
  }
  if (e.target?.id !== FIELD_ID && !e.target.closest?.('.addr-suggest')) {
    hideSuggestions();
  }
});

// The Leaflet map pin is the other source of coordinates — when the customer
// drags it, mirror the new position into the shared coords so that
// getSelectedCoords() stays the single source of truth.
document.addEventListener('mbg:mapPinMoved', (e) => {
  const lat = Number(e.detail?.lat);
  const lng = Number(e.detail?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    _selectedCoords = { lat, lng };
  }
});
