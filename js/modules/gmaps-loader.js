/* MBG Storefront — Google Maps JS API loader
 *
 * Loads the Google Maps JS API once, on demand, using the modern inline
 * bootstrap loader (the importLibrary pattern) rather than the deprecated
 * callback URL parameter. The key comes from window.__MBG_ENV__, injected
 * at runtime by the /env.js Netlify Function.
 *
 * loadGoogleMaps() resolves with the google.maps namespace once the
 * 'places' and 'geocoding' libraries are imported, or rejects if the key
 * is missing, the network fails, or Google does not respond within 8s.
 */

const LOAD_TIMEOUT_MS = 8000;

let _promise = null;

export function loadGoogleMaps() {
  if (_promise) return _promise;

  _promise = new Promise((resolve, reject) => {
    const key = window.__MBG_ENV__?.GOOGLE_MAPS_API_KEY;
    if (!key) {
      reject(new Error('[gmaps] GOOGLE_MAPS_API_KEY missing — cannot load'));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('[gmaps] timed out after ' + LOAD_TIMEOUT_MS + 'ms'));
    }, LOAD_TIMEOUT_MS);

    // Modern inline bootstrap loader. Defines google.maps.importLibrary and
    // injects the bootstrap script tag. Adapted from Google's reference:
    // https://developers.google.com/maps/documentation/javascript/load-maps-js-api#dynamic-library-import
    try {
      (g => {
        let h, a, k, p = 'The Google Maps JavaScript API',
          c = 'google', l = 'importLibrary', q = '__ib__',
          m = document, b = window;
        b = b[c] || (b[c] = {});
        const d = b.maps || (b.maps = {}), r = new Set(),
          e = new URLSearchParams(),
          u = () => h || (h = new Promise(async (f, n) => {
            a = m.createElement('script');
            e.set('libraries', [...r] + '');
            for (k in g) {
              e.set(k.replace(/[A-Z]/g, t => '_' + t[0].toLowerCase()), g[k]);
            }
            e.set('callback', c + '.maps.' + q);
            a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
            d[q] = f;
            a.onerror = () => h = n(Error(p + ' could not load.'));
            a.nonce = m.querySelector('script[nonce]')?.nonce || '';
            m.head.append(a);
          }));
        d[l] ? console.warn(p + ' only loads once. Ignoring:', g)
          : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n));
      })({ key, v: 'weekly' });

      Promise.all([
        google.maps.importLibrary('places'),
        google.maps.importLibrary('geocoding'),
      ]).then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(google.maps);
      }).catch(err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('[gmaps] library import failed: ' + err.message));
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('[gmaps] bootstrap failed: ' + err.message));
    }
  });

  return _promise;
}
