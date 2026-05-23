/* MBG Storefront v2 — Google Places delivery-address autocomplete
 * Philippines-only address suggestions for the checkout Street/Building field.
 * On selection it fills the five structured address fields and stores the
 * place's coordinates so checkout can include them in the place-order payload
 * and feed the distance-based delivery calculator. A `mbg:deliveryAddrChanged`
 * event is dispatched whenever the coordinates are picked or cleared so
 * checkout can re-quote, and `mbg:addrPicked` moves the Leaflet pin to match.
 *
 * The #coStreet field is created on demand (and re-rendered) by checkout.js,
 * so this module loads the Google Maps script lazily on the first focus of
 * that field — never on page load — and re-binds via event delegation each
 * time checkout rebuilds the form.
 */

const FIELD_ID = 'coStreet';
const COORDS_KEY = 'mbg_delivery_coords';
const GMAPS_KEY = 'AIzaSyDZ7UhB5kR5RjP7m_KEd9JZKvYFAa4iwF8';

let _selectedCoords = null;   // { lat, lng } once a place is picked
let _mapsPromise = null;      // single in-flight/loaded Google Maps JS promise
let _filling = false;         // true while we programmatically fill the fields

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

// ── Lazy Google Maps loader ─────────────────────────────────────────────────
// Injects the Maps JS API exactly once, only when first needed. The async
// loader calls the global callback below, which resolves the shared promise.
function loadGoogleMaps() {
  if (_mapsPromise) return _mapsPromise;
  _mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps?.places) { resolve(); return; }
    window.__mbgGmapsReady = () => resolve();
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://maps.googleapis.com/maps/api/js'
      + '?key=' + GMAPS_KEY
      + '&libraries=places&loading=async&callback=__mbgGmapsReady';
    s.onerror = () => {
      _mapsPromise = null;   // allow a retry on the next focus
      reject(new Error('Google Maps JS failed to load'));
    };
    document.head.appendChild(s);
  });
  return _mapsPromise;
}

// ── Bind Places autocomplete to the (re-rendered) #coStreet field ────────────
async function ensureAutocomplete(field) {
  if (!field || field.dataset.gAutocomplete === '1') return;
  field.dataset.gAutocomplete = '1';
  try {
    await loadGoogleMaps();
  } catch (e) {
    console.warn('[address]', e.message);
    field.dataset.gAutocomplete = '';   // let the next focus retry
    return;
  }
  // A checkout re-render replaces #coStreet, orphaning the previous instance's
  // dropdown; drop any stale .pac-container nodes before creating a fresh one.
  document.querySelectorAll('.pac-container').forEach(el => el.remove());

  const autocomplete = new google.maps.places.Autocomplete(field, {
    componentRestrictions: { country: 'ph' },
    fields: ['address_components', 'geometry'],
    types: ['address']
  });
  autocomplete.addListener('place_changed', () => onPlaceChanged(autocomplete, field));
}

// Lazy-load + bind only when the customer focuses the address field — i.e.
// after the checkout drawer has opened, never on page load. Event delegation
// re-binds automatically each time checkout re-renders the field.
document.addEventListener('focusin', (e) => {
  if (e.target?.id === FIELD_ID) ensureAutocomplete(e.target);
});

function onPlaceChanged(autocomplete, field) {
  const place = autocomplete.getPlace();
  if (!place || !place.address_components) return;

  let streetNumber = '';
  let route = '';
  let barangay = '';
  let city = '';
  let province = '';
  let postalCode = '';

  for (const component of place.address_components) {
    const types = component.types;
    if (types.includes('street_number')) streetNumber = component.long_name;
    if (types.includes('route')) route = component.long_name;
    // PH barangays surface as a sublocality (or neighbourhood) component.
    if (!barangay && (types.includes('sublocality_level_1') ||
                      types.includes('sublocality') ||
                      types.includes('neighborhood'))) {
      barangay = component.long_name;
    }
    if (types.includes('locality')) city = component.long_name;
    if (types.includes('administrative_area_level_2')) province = component.long_name;
    if (!province && types.includes('administrative_area_level_1')) province = component.long_name;
    if (types.includes('postal_code')) postalCode = component.long_name;
  }

  const street = [streetNumber, route].filter(Boolean).join(' ');

  // Fill the fields, then fire input events so any validation listeners run.
  // _filling guards the manual-edit listener below so these synthetic events
  // don't wipe the coordinates we're about to store.
  _filling = true;
  const filled = [];
  const set = (id, val, el) => {
    el = el || document.getElementById(id);
    if (el && val) { el.value = String(val); filled.push(el); }
  };
  set(FIELD_ID, street, field);
  set('coBarangay', barangay);
  set('coCity', city);
  set('coProvince', province);
  set('coPostal', postalCode);
  for (const el of filled) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  _filling = false;

  // Coordinates feed the distance-based delivery quote (read via
  // getSelectedCoords) and recentre the Leaflet pin.
  const loc = place.geometry?.location;
  const lat = loc ? loc.lat() : null;
  const lng = loc ? loc.lng() : null;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    storeCoords({ lat, lng });
    document.dispatchEvent(new CustomEvent('mbg:addrPicked', { detail: { lat, lng } }));
  } else {
    storeCoords(null);
  }
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
}

// Manually editing the street invalidates the coordinates of any earlier pick
// (and any stale coords left in localStorage from a previous order), so
// delivery falls back to an estimate until a new place is chosen. Skipped
// while we fill the fields programmatically above.
document.addEventListener('input', (e) => {
  if (e.target?.id !== FIELD_ID || _filling) return;
  storeCoords(null);
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
});

// The Leaflet map pin is the other source of coordinates — when the customer
// drags it, mirror the new position into the shared coords so that
// getSelectedCoords() stays the single source of truth.
document.addEventListener('mbg:mapPinMoved', (e) => {
  const lat = Number(e.detail?.lat);
  const lng = Number(e.detail?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    storeCoords({ lat, lng });
  }
});
