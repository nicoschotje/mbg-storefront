/* MBG Storefront v2 — Google Places + Google Geocoder delivery address
 * Philippines-only address handling for the checkout Street/Building field.
 *
 * Two address/coordinate sources, both via the Google Maps JS API:
 *   • Places Autocomplete on #coStreet — picking a suggestion fills the five
 *     structured fields and captures the place geometry.
 *   • Reverse geocoding on map-pin drag — dragging the Leaflet pin stores the
 *     new coords and refills the same five fields from the geocoded result.
 *
 * Either way the coordinates land in localStorage (the single source read by
 * getSelectedCoords()) so checkout can include them in the place-order payload
 * and feed the distance-based delivery calculator. A `mbg:deliveryAddrChanged`
 * event is dispatched whenever the address/coords change so checkout can
 * re-quote, and `mbg:addrPicked` moves the Leaflet pin to match a pick.
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
let _geocoder = null;         // lazily created google.maps.Geocoder instance
let _autocomplete = null;     // current google.maps.places.Autocomplete instance
let _autocompleteInput = null; // the input element _autocomplete is bound to

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

// ── Shared address-component parser ──────────────────────────────────────────
// Maps a Google `address_components` array onto the five structured fields and
// fires input events so any validation listeners run. _filling guards the
// manual-edit listener below so these synthetic events don't wipe the
// coordinates being stored alongside. `streetEl` lets the autocomplete pass
// the exact #coStreet node it bound to (it may be mid-re-render).
function fillAddressFields(components, streetEl, lat, lng) {
  let streetNumber = '';
  let route = '';
  let city = '';
  let province = '';
  let postalCode = '';

  for (const component of components) {
    const types = component.types;
    if (types.includes('street_number')) streetNumber = component.long_name;
    if (types.includes('route')) route = component.long_name;
    if (types.includes('locality')) city = component.long_name;
    if (types.includes('administrative_area_level_2')) province = component.long_name;
    if (!province && types.includes('administrative_area_level_1')) province = component.long_name;
    if (types.includes('postal_code')) postalCode = component.long_name;
  }

  const street = [streetNumber, route].filter(Boolean).join(' ');

  _filling = true;
  const filled = [];
  const set = (id, val, el) => {
    el = el || document.getElementById(id);
    if (el && val) { el.value = String(val); filled.push(el); }
  };
  set(FIELD_ID, street, streetEl);
  set('coCity', city);
  set('coProvince', province);
  set('coPostal', postalCode);
  for (const el of filled) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  _filling = false;

  // Google rarely returns the barangay for PH addresses. If the field is still
  // empty and we have the place coordinates, backfill it from a Nominatim
  // reverse geocode (which does expose barangay-level data).
  const bgyEl = document.getElementById('coBarangay');
  if (bgyEl && !bgyEl.value.trim() && Number.isFinite(lat) && Number.isFinite(lng)) {
    backfillBarangayFromNominatim(lat, lng, bgyEl);
  }
}

// Reverse-geocodes lat/lng via Nominatim purely to obtain the barangay that
// Google Places omits for the Philippines. Only writes #coBarangay if it's
// still empty when the response lands, so it never clobbers manual input.
async function backfillBarangayFromNominatim(lat, lng, bgyEl) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`
    );
    if (!res.ok) return;
    const data = await res.json();
    const a = data?.address || {};
    const barangay = a.suburb || a.neighbourhood || a.village || a.quarter || a.residential;
    if (barangay && !bgyEl.value.trim()) {
      bgyEl.value = barangay;
      bgyEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch (e) {
    console.warn('[address] barangay reverse-geocode failed', e);
  }
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
  // Reuse an autocomplete that's still bound to a connected input; only build a
  // fresh one after a checkout re-render has replaced #coStreet.
  if (_autocomplete && _autocompleteInput && _autocompleteInput.isConnected) {
    return;
  }

  _autocomplete = new google.maps.places.Autocomplete(field, {
    componentRestrictions: { country: 'ph' },
    fields: ['address_components', 'geometry']
  });
  _autocompleteInput = field;
  _autocomplete.addListener('place_changed', () => onPlaceChanged(_autocomplete, field));
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

  // Coordinates feed the distance-based delivery quote (read via
  // getSelectedCoords), recentre the Leaflet pin, and drive the Nominatim
  // barangay backfill inside fillAddressFields.
  const loc = place.geometry?.location;
  const lat = loc ? loc.lat() : null;
  const lng = loc ? loc.lng() : null;

  fillAddressFields(place.address_components, field, lat, lng);

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
// drags it, store the new position and reverse-geocode it with the Google
// Geocoder to refresh the five address fields. getSelectedCoords() stays the
// single source of truth.
document.addEventListener('mbg:mapPinMoved', (e) => {
  const lat = Number(e.detail?.lat);
  const lng = Number(e.detail?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  storeCoords({ lat, lng });

  // Reverse-geocode only once the Maps script is available.
  if (!window.google?.maps?.Geocoder) return;
  _geocoder = _geocoder || new google.maps.Geocoder();
  _geocoder.geocode({ location: { lat, lng } }, (results, status) => {
    if (status !== 'OK' || !results || !results[0]) return;
    fillAddressFields(results[0].address_components, null, lat, lng);
    document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
  });
});
