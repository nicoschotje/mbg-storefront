/* MBG Storefront v2 — Checkout address map (Leaflet + OpenStreetMap)
 *
 * Renders a small map with a single pin inside the checkout #addr-map
 * container. The customer can place their pin three ways:
 *   • tap anywhere on the map  (map click → pin moves there)
 *   • drag the pin             (dragend → pin settles)
 *   • "📍 Use my location"     (gesture-gated geolocation)
 * Picking a Nominatim address suggestion also moves the pin to match.
 *
 * The pin's position is mirrored into address.js (the single source of truth
 * for getSelectedCoords()) via the `mbg:mapPinMoved` event, and a
 * `mbg:deliveryAddrChanged` event re-quotes the delivery fee.
 *
 * Leaflet itself is loaded from the jsDelivr CDN in index.html (deferred),
 * exposing the global `L`. Because that load can lag on a slow mobile link, we
 * retry briefly instead of silently leaving a blank box.
 */
import { getSelectedCoords } from './address.js?v=20260608-deepfix';
import { getStoreSettings } from './banners.js?v=20260608-deepfix';
import { showToast } from '../core/utils.js?v=20260520-polish';

// Fallback centre (Manila) used only when store coords are missing.
const MANILA = { lat: 14.5995, lng: 120.9842 };

let _map = null;
let _marker = null;

// Initialise (or re-initialise) the map. Called on every checkout render — a
// re-render replaces the #addr-map node, so the old instance is dropped. If
// Leaflet hasn't finished loading yet (deferred CDN script on a slow link),
// retry a handful of times before giving up with a graceful fallback message.
export function initAddressMap(attempt = 0) {
  const el = document.getElementById('addr-map');
  if (!el) return;

  if (typeof L === 'undefined') {
    if (attempt < 25) { setTimeout(() => initAddressMap(attempt + 1), 150); return; }
    el.innerHTML = '<div class="map-fallback">Map couldn’t load — you can still type your address above.</div>';
    return;
  }

  if (_map) { _map.remove(); _map = null; _marker = null; }

  const center = resolveCenter();
  const zoom = center.fromPick ? 16 : 13;

  _map = L.map(el).setView([center.lat, center.lng], zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(_map);

  _marker = L.marker([center.lat, center.lng], { draggable: true }).addTo(_map);
  _marker.on('dragend', () => {
    const { lat, lng } = _marker.getLatLng();
    placePin(lat, lng);
  });

  // Tap anywhere on the map to drop/move the pin. This is the primary way to
  // place a pin on a phone — before this, dragging the tiny default marker was
  // the ONLY option, which is exactly the "can't put their pin" complaint.
  _map.on('click', (e) => placePin(e.latlng.lat, e.latlng.lng));

  wireLocateButton();
  scheduleInvalidate();
}

// Move the pin and broadcast the new coordinates (the single source of truth
// lives in address.js). Does not recentre — that would fight the customer's
// own panning of the map.
function placePin(lat, lng) {
  if (!_marker || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  _marker.setLatLng([lat, lng]);
  document.dispatchEvent(new CustomEvent('mbg:mapPinMoved', { detail: { lat, lng } }));
  document.dispatchEvent(new CustomEvent('mbg:deliveryAddrChanged'));
}

// "Use my location" — geolocation is gesture-gated (only runs from a real tap),
// which keeps iOS Safari happy and avoids an unsolicited permission prompt at
// page load. On success: recentre + drop the pin. On failure: tell the customer
// to tap the map instead, so they're never stuck.
function wireLocateButton() {
  const btn = document.getElementById('addrLocateBtn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) { showToast('Location isn’t available — tap the map to drop your pin.'); return; }
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        if (_map) _map.setView([latitude, longitude], 16);
        placePin(latitude, longitude);
        btn.disabled = false; btn.textContent = original;
      },
      () => {
        btn.disabled = false; btn.textContent = original;
        showToast('Couldn’t get your location — tap the map to drop your pin.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

// The checkout panel animates open AFTER render, so the map container may still
// be 0×0 (or hidden) when Leaflet first measures it — that paints grey tiles.
// Recompute the layout a few times and again when the open transition ends.
function scheduleInvalidate() {
  [60, 250, 600].forEach(t => setTimeout(() => { if (_map) _map.invalidateSize(); }, t));
  const host = document.getElementById('checkoutScreen');
  if (host) host.addEventListener('transitionend', () => { if (_map) _map.invalidateSize(); }, { once: true });
}

// Prefer a previously picked/dragged location (survives a checkout re-render);
// otherwise the store pickup point; otherwise Manila.
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

// An address suggestion pick on #coStreet — move + recentre the pin.
document.addEventListener('mbg:addrPicked', (e) => {
  const lat = Number(e.detail?.lat);
  const lng = Number(e.detail?.lng);
  if (!_map || !_marker || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  _marker.setLatLng([lat, lng]);
  _map.setView([lat, lng], 16);
});
