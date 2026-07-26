/* window.L stub served in place of the Leaflet CDN script.
 *
 * Implements the surface js/modules/leaflet-map.js touches (L.map(el)
 * .setView/.on/.remove/.invalidateSize, L.tileLayer(...).addTo,
 * L.marker(...).addTo/.on/.getLatLng/.setLatLng) AND — critically —
 * reproduces Leaflet 1.9's REAL pane/control DOM and z-index scheme
 * (tile pane 200, overlay 400, marker 600, popup 700, controls 800,
 * corner containers 1000, all absolutely positioned inside a
 * position:relative .leaflet-container).
 *
 * Those z-indexes are what let a live map paint OVER the sticky
 * checkout CTA when nothing isolates the map's stacking context — a
 * blank placeholder map can never catch that class of bug.
 *
 * Exposes window.__LSTUB so a driver can simulate map taps/pin drags.
 */
(function () {
  // Verbatim subset of leaflet.css@1.9.4 — the positioning + z-index rules.
  var LEAFLET_CSS = [
    '.leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,',
    '.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas,',
    '.leaflet-zoom-box,.leaflet-image-layer,.leaflet-layer{position:absolute;left:0;top:0}',
    '.leaflet-container{overflow:hidden;position:relative;background:#ddd;outline-offset:1px}',
    '.leaflet-pane{z-index:400}',
    '.leaflet-tile-pane{z-index:200}',
    '.leaflet-overlay-pane{z-index:400}',
    '.leaflet-shadow-pane{z-index:500}',
    '.leaflet-marker-pane{z-index:600}',
    '.leaflet-tooltip-pane{z-index:650}',
    '.leaflet-popup-pane{z-index:700}',
    '.leaflet-map-pane canvas{z-index:100}',
    '.leaflet-map-pane svg{z-index:200}',
    '.leaflet-control{position:relative;z-index:800;pointer-events:auto}',
    '.leaflet-top,.leaflet-bottom{position:absolute;z-index:1000;pointer-events:none}',
    '.leaflet-top{top:0}.leaflet-left{left:0}.leaflet-bottom{bottom:0}.leaflet-right{right:0}',
    '.leaflet-control-zoom{margin:10px;border:2px solid rgba(0,0,0,0.2);border-radius:4px;background:#fff}',
    '.leaflet-control-zoom a{display:block;width:30px;height:30px;line-height:30px;text-align:center;',
    'text-decoration:none;color:#333;font:bold 18px "Lucida Console",Monaco,monospace}',
    '.leaflet-marker-icon{font-size:28px;line-height:1}',
  ].join('');

  function injectCSS() {
    if (document.getElementById('stub-leaflet-css')) return;
    var st = document.createElement('style');
    st.id = 'stub-leaflet-css';
    st.textContent = LEAFLET_CSS;
    document.head.appendChild(st);
  }

  function Map(el) {
    injectCSS();
    this._el = el;
    this._handlers = {};
    el.classList.add('leaflet-container');

    // Real Leaflet pane tree
    var mapPane = document.createElement('div');
    mapPane.className = 'leaflet-pane leaflet-map-pane';
    ['tile', 'overlay', 'shadow', 'marker', 'tooltip', 'popup'].forEach(function (n) {
      var p = document.createElement('div');
      p.className = 'leaflet-pane leaflet-' + n + '-pane';
      mapPane.appendChild(p);
    });
    el.appendChild(mapPane);
    this._panes = mapPane;

    // Tile backdrop with REAL pixel dimensions: Leaflet panes are 0x0
    // anchors — the 256px tile <img>s inside them are what actually paint
    // and hit-test across the map (and over anything with a lower
    // z-index). Sizing the tile container like the tile grid reproduces
    // that behavior faithfully.
    var tile = document.createElement('div');
    tile.style.background = 'linear-gradient(135deg,#cfd8c8,#aebfa8)';
    tile.className = 'leaflet-tile-container';
    mapPane.querySelector('.leaflet-tile-pane').appendChild(tile);
    this._tile = tile;
    this._sizeTiles();

    // Real control corner + zoom control (z-index 1000/800 path)
    var corner = document.createElement('div');
    corner.className = 'leaflet-top leaflet-left';
    var zoom = document.createElement('div');
    zoom.className = 'leaflet-control leaflet-control-zoom';
    zoom.innerHTML = '<a class="leaflet-control-zoom-in" href="#" aria-label="Zoom in">+</a>' +
      '<a class="leaflet-control-zoom-out" href="#" aria-label="Zoom out">−</a>';
    corner.appendChild(zoom);
    el.appendChild(corner);

    var cap = document.createElement('div');
    cap.textContent = 'Map (stub)';
    cap.style.cssText = 'position:absolute;left:6px;bottom:4px;font:11px sans-serif;color:#3a4a3a;opacity:.7;pointer-events:none;z-index:700;';
    el.appendChild(cap);

    var self = this;
    el.addEventListener('click', function (ev) {
      if (self._handlers.click) self._handlers.click({ latlng: { lat: 14.6, lng: 121.0 } });
      ev.preventDefault();
    });

    window.__LSTUB = window.__LSTUB || {};
    window.__LSTUB.map = this;
  }
  Map.prototype._sizeTiles = function () {
    // Like real Leaflet, tile pixels adopt the container's size when the
    // map (re)measures itself — the app calls invalidateSize() after the
    // checkout open animation, exactly when a real map paints its tiles.
    if (!this._tile || !this._el) return;
    var w = this._el.clientWidth, h = this._el.clientHeight;
    if (w > 0 && h > 0) { this._tile.style.width = w + 'px'; this._tile.style.height = h + 'px'; }
  };
  Map.prototype.setView = function (ll) { this._center = ll; return this; };
  Map.prototype.on = function (ev, fn) { this._handlers[ev] = fn; return this; };
  Map.prototype.remove = function () { if (this._el) { this._el.innerHTML = ''; this._el.classList.remove('leaflet-container'); } };
  Map.prototype.invalidateSize = function () { this._sizeTiles(); };
  Map.prototype.addLayer = function () { return this; };
  Map.prototype.fireClick = function (lat, lng) {
    if (this._handlers.click) this._handlers.click({ latlng: { lat: lat, lng: lng } });
  };

  function Marker(ll) {
    this._ll = { lat: ll[0], lng: ll[1] };
    this._handlers = {};
    window.__LSTUB = window.__LSTUB || {};
    window.__LSTUB.marker = this;
  }
  Marker.prototype.addTo = function (map) {
    var icon = document.createElement('div');
    icon.className = 'leaflet-marker-icon';
    icon.textContent = '📍';
    icon.style.cssText = 'left:50%;top:50%;transform:translate(-50%,-100%);';
    var pane = map._panes && map._panes.querySelector('.leaflet-marker-pane');
    if (pane) pane.appendChild(icon);
    this._icon = icon;
    return this;
  };
  Marker.prototype.on = function (ev, fn) { this._handlers[ev] = fn; return this; };
  Marker.prototype.getLatLng = function () { return this._ll; };
  Marker.prototype.setLatLng = function (ll) {
    this._ll = Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : ll;
    return this;
  };
  Marker.prototype.fireDragEnd = function (lat, lng) {
    this._ll = { lat: lat, lng: lng };
    if (this._handlers.dragend) this._handlers.dragend();
  };

  window.L = {
    map: function (el) { return new Map(el); },
    tileLayer: function () { return { addTo: function (m) { return m; } }; },
    marker: function (ll) { return new Marker(ll); },
  };
})();
