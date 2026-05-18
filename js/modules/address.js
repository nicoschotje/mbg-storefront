/* MBG Storefront v2 — Nominatim delivery-address autocomplete
 * Philippines-only address suggestions for the checkout address field.
 * On selection it stores the suggestion's coordinates so checkout can
 * include them in the place-order payload. Zone-based pricing is untouched.
 *
 * The #coAddr field is created on demand (and re-rendered) by checkout.js,
 * so this module listens at the document level rather than binding directly.
 */
import { esc } from '../core/utils.js?v=20260518-supabase-repoint';

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
  dd.innerHTML = results.slice(0, 6).map(r =>
    `<li class="addr-suggest-item" role="option"
         data-lat="${esc(r.lat)}" data-lon="${esc(r.lon)}"
         data-name="${esc(r.display_name)}">${esc(r.display_name)}</li>`
  ).join('');
  dd.hidden = false;
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
document.addEventListener('input', (e) => {
  if (e.target?.id !== FIELD_ID) return;
  // A manual edit invalidates the coordinates of any earlier selection.
  _selectedCoords = null;
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
    return;
  }
  if (e.target?.id !== FIELD_ID && !e.target.closest?.('.addr-suggest')) {
    hideSuggestions();
  }
});
