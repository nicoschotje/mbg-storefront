/* MBG Storefront v2 — Checkout address map (Leaflet + OpenStreetMap)
 *
 * Renders a small map with a single draggable pin inside the checkout
 * #addr-map container, visible from the start of checkout. Dragging the
 * pin updates the stored delivery coordinates, while picking a Google
 * Places autocomplete suggestion moves the pin to match.
 *
 * The pin's position is mirrored into address.js (the single source of
 * truth for getSelectedCoords()) via the `mbg:mapPinMoved` event, and a
 * `mbg:deliveryAddrChanged` event re-quotes the delivery fee.
 *
 * Leaflet itself is loaded from the jsDelivr CDN in index.html, exposing
 * the global `L`.
 */
import { getSelectedCoords } from './address.js?v=20260520-polish';
import { getStoreSettings } from './banners.js?v=20260518-mobile';

// Fallback centre (Manila) used only when store coords are missing.
const MANILA = { lat: 14.5995, lng: 120.9842 };

let _map = null;
let _marker = null;

// Initialise (or re-initialise) the map. Called on every checkout render —
// a re-render replaces the #addr-map node, so the old instance is dropped.
export function initAddressMap() {
  const el = document.getElementById('addr-map');
  if (!el || typeof L === 'undefined') return;

  if (_map) { _map.remove(); _map = null; _marker = null; }

  const center = resolveCenter();
  const zoom = center.fromPick ? 16 : 13;

  _map = L.map(el).setView([center.lat, center.lng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(_map);

  _marker = L.marker([center.lat, center.lng], { draggable: true }).addTo(_map);
  _marker.on('dragend', onMarkerDragEnd);

  // The checkout panel animates open after render — recompute tile layout
  // once the container has its final size, or tiles render grey.
  setTimeout(() => { if (_map) _map.invalidateSize(); }, 250);
}

// Prefer a previously picked/dragged location (survives a checkout
// re-render); otherwise the store pickup point; otherwise Manila.
function resolveCenter() {
  const sel = getSelectedCoords();
  if (sel && Number.isFinite(sel.lat) && Number.isFinite(sel.lng)) {
    return { lat: sel.lat, lng: sel.lng, fromPick: true };
  }
  const ss = getStoreSettings();
  const lat = Number(ss?.store_lat);
  const lng = Number(ss?.store_lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng, fromPick: false };
  }
  return { lat: MANILA.lat, lng: MANILA.lng, fromPick: false };
}

function onMarkerDragEnd() {
  const { lat, lng } = _marker.getLatLng();
  // Update the shared coords + re-quote the delivery fee immediately.
  document.dispatchEvent(new CustomEvent('mbg:mapPinMoved', { detail: { lat, lng } }));
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
}

// A Google Places autocomplete pick on #coStreet — move + recentre the pin.
document.addEventListener('mbg:addrPicked', (e) => {
  const lat = Number(e.detail?.lat);
  const lng = Number(e.detail?.lng);
  if (!_map || !_marker || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  _marker.setLatLng([lat, lng]);
  _map.setView([lat, lng], 16);
});
