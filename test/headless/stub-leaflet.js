/* Minimal window.L stub served in place of the Leaflet CDN script.
 *
 * Implements exactly the surface js/modules/leaflet-map.js touches:
 * L.map(el).setView / on / remove / invalidateSize, L.tileLayer(...).addTo,
 * L.marker(...).addTo / on / getLatLng / setLatLng.
 *
 * Paints a visible placeholder + centre pin into the container so mobile
 * screenshots exercise the real layout box, and exposes window.__LSTUB so a
 * driver can simulate "tap the map" (the primary phone gesture).
 */
(function () {
  function Map(el) {
    this._el = el;
    this._handlers = {};
    el.style.background = 'linear-gradient(135deg,#cfd8c8,#aebfa8)';
    el.style.position = 'relative';
    const pin = document.createElement('div');
    pin.textContent = '📍';
    pin.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-100%);font-size:28px;pointer-events:none;';
    pin.className = 'stub-map-pin';
    el.appendChild(pin);
    const cap = document.createElement('div');
    cap.textContent = 'Map (stub)';
    cap.style.cssText =
      'position:absolute;left:6px;bottom:4px;font:11px sans-serif;color:#3a4a3a;opacity:.7;pointer-events:none;';
    el.appendChild(cap);
    window.__LSTUB = window.__LSTUB || {};
    window.__LSTUB.map = this;
  }
  Map.prototype.setView = function (ll) { this._center = ll; return this; };
  Map.prototype.on = function (ev, fn) { this._handlers[ev] = fn; return this; };
  Map.prototype.remove = function () { if (this._el) this._el.innerHTML = ''; };
  Map.prototype.invalidateSize = function () {};
  Map.prototype.addLayer = function () { return this; };
  Map.prototype.fireClick = function (lat, lng) {
    if (this._handlers.click) this._handlers.click({ latlng: { lat, lng } });
  };

  function Marker(ll) {
    this._ll = { lat: ll[0], lng: ll[1] };
    this._handlers = {};
    window.__LSTUB = window.__LSTUB || {};
    window.__LSTUB.marker = this;
  }
  Marker.prototype.addTo = function () { return this; };
  Marker.prototype.on = function (ev, fn) { this._handlers[ev] = fn; return this; };
  Marker.prototype.getLatLng = function () { return this._ll; };
  Marker.prototype.setLatLng = function (ll) {
    this._ll = Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : ll;
    return this;
  };
  Marker.prototype.fireDragEnd = function (lat, lng) {
    this._ll = { lat, lng };
    if (this._handlers.dragend) this._handlers.dragend();
  };

  window.L = {
    map: (el) => new Map(el),
    tileLayer: () => ({ addTo: (m) => m }),
    marker: (ll) => new Marker(ll),
  };
})();
