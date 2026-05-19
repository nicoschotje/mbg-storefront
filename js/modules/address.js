/* MBG Storefront v2 — delivery-address autocomplete
 *
 * Primary path: Google Places (New) PlaceAutocompleteElement, restricted
 * to the Philippines. Fallback path: Nominatim (OpenStreetMap) typeahead.
 *
 * On init the module tries to load the Google Maps JS API. If that
 * succeeds the #coAddr textarea is silently enhanced with a Google
 * PlaceAutocompleteElement. If it fails (network error, missing key,
 * timeout — e.g. on deploy previews where the key's domain restriction
 * blocks loading) the module falls through to the existing Nominatim
 * implementation. The customer never sees an error either way.
 *
 * Downstream contract — unchanged regardless of which path runs:
 *   - getSelectedCoords() returns { lat, lng } or null
 *   - a bare `mbg:deliveryAddrChanged` CustomEvent fires whenever the
 *     coordinates are picked or cleared
 *
 * The #coAddr field is created on demand (and re-rendered) by checkout.js,
 * so this module listens at the document level rather than binding directly.
 */
import { esc } from '../core/utils.js?v=20260518-mobile';
import { loadGoogleMaps } from './gmaps-loader.js?v=20260519-gplaces';

const FIELD_ID = 'coAddr';
const MIN_CHARS = 3;

let _selectedCoords = null;   // { lat, lng } once a suggestion is picked
let _debounceTimer = null;
let _lastRequestAt = 0;
let _activeQuery = '';
let _dropdown = null;

export function getSelectedCoords() {
  return _selectedCoords;
}

function getField() {
  return document.getElementById(FIELD_ID);
}

function emitChanged() {
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
}

/* ───────────────────────── Nominatim fallback ───────────────────────── */

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
  if (!results.length) { hideSuggestions(); return; }
  const dd = ensureDropdown(field);
  const wasHidden = dd.hidden;
  dd.innerHTML = results.slice(0, 6).map(r =>
    `<li class="addr-suggest-item" role="option"
         data-lat="${esc(r.lat)}" data-lon="${esc(r.lon)}"
         data-name="${esc(r.display_name)}">${esc(r.display_name)}</li>`
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
  // See https://nominatim.org/release-docs/latest/api/Search/
  const url = 'https://nominatim.openstreetmap.org/search'
    + '?format=json&countrycodes=ph&limit=6&q=' + encodeURIComponent(query);
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

// Customer typing in the address field — schedule a debounced lookup.
// When the Google path is active the textarea is hidden, so this only
// fires on the Nominatim fallback path.
document.addEventListener('input', (e) => {
  if (e.target?.id !== FIELD_ID) return;
  // A manual edit invalidates the coordinates of any earlier selection.
  _selectedCoords = null;
  emitChanged();
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
    const field = getField();
    if (field) field.value = item.dataset.name || '';
    const lat = parseFloat(item.dataset.lat);
    const lon = parseFloat(item.dataset.lon);
    _selectedCoords = (Number.isFinite(lat) && Number.isFinite(lon))
      ? { lat, lng: lon }
      : null;
    _activeQuery = field ? field.value.trim() : '';
    hideSuggestions();
    emitChanged();
    return;
  }
  if (e.target?.id !== FIELD_ID && !e.target.closest?.('.addr-suggest')) {
    hideSuggestions();
  }
});

/* ─────────────────────── Google Places (primary) ────────────────────── */

let _gmaps = null;
let _placeEl = null;

// Pulls a numeric { lat, lng } out of whichever shape the Places API
// returns — the New API exposes place.location, older shapes nest it
// under place.geometry.location. Both expose lat/lng as either numbers
// or accessor functions.
function coordsFromPlace(place) {
  const loc = place?.location || place?.geometry?.location;
  if (!loc) return null;
  const lat = typeof loc.lat === 'function' ? loc.lat() : loc.lat;
  const lng = typeof loc.lng === 'function' ? loc.lng() : loc.lng;
  return (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null;
}

async function onGooglePlaceSelect(e) {
  try {
    const prediction = e.placePrediction;
    if (!prediction) return;
    const place = prediction.toPlace();
    await place.fetchFields({ fields: ['location', 'formattedAddress'] });
    const field = getField();
    if (field && place.formattedAddress) field.value = place.formattedAddress;
    _selectedCoords = coordsFromPlace(place);
    _activeQuery = field ? field.value.trim() : '';
  } catch (err) {
    console.warn('[address] Google place fetch failed', err);
    _selectedCoords = null;
  }
  emitChanged();
}

// Typing in the Google element invalidates any earlier selection and is
// mirrored back into the (hidden) #coAddr textarea so checkout.js still
// reads the address text from its existing selector.
function onGoogleInput(e) {
  const inner = e.composedPath?.()[0];
  const field = getField();
  if (field && inner && typeof inner.value === 'string') {
    field.value = inner.value;
  }
  _selectedCoords = null;
  emitChanged();
}

// Inserts a Google PlaceAutocompleteElement next to #coAddr and hides the
// plain textarea. Re-runs after checkout re-renders (which disconnects the
// previous element). Cheap to call repeatedly — early-returns when live.
function enhanceWithGoogle() {
  if (!_gmaps) return;
  const field = getField();
  if (!field) return;
  if (_placeEl && _placeEl.isConnected) return;

  let el;
  try {
    el = new _gmaps.places.PlaceAutocompleteElement({
      includedRegionCodes: ['ph'],
    });
  } catch (err) {
    // Construction failed — leave the textarea visible so the Nominatim
    // path keeps working. Never surface an error to the customer.
    console.warn('[address] PlaceAutocompleteElement unavailable', err);
    _gmaps = null;
    return;
  }

  el.className = 'addr-gplaces';
  el.style.width = '100%';
  hideSuggestions();
  field.style.display = 'none';
  field.insertAdjacentElement('afterend', el);
  el.addEventListener('gmp-select', onGooglePlaceSelect);
  el.addEventListener('input', onGoogleInput);
  _placeEl = el;
}

(function initGoogle() {
  loadGoogleMaps()
    .then((maps) => {
      _gmaps = maps;
      enhanceWithGoogle();
      // #coAddr is created/re-rendered on demand by checkout.js — re-enhance
      // whenever it reappears in the DOM.
      const observer = new MutationObserver(() => enhanceWithGoogle());
      observer.observe(document.body, { childList: true, subtree: true });
    })
    .catch((err) => {
      // Silent fallback — the Nominatim path above stays in effect.
      console.warn('[address] Google Maps unavailable, using Nominatim', err);
    });
})();
