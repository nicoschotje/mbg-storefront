/* MBG Storefront — Service Worker
 *
 * Cache version key — BUMP THIS on every deploy so returning customers
 * drop their old cache and pull the latest files. The activate handler
 * below deletes every cache that doesn't match the current version.
 */
const CACHE_VERSION = 'mbg-storefront-v21';

// Install: take over immediately, don't wait for old tabs to close.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: delete any cache from a previous version, then claim clients.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Fetch: network-first for same-origin requests so customers always get
// the freshest HTML/JS/CSS. The cache is only a fallback for offline use.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let the network handle CDN/fonts

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Stash a copy so the page still works offline next time.
      const cache = await caches.open(CACHE_VERSION);
      cache.put(req, fresh.clone());
      return fresh;
    } catch (_) {
      const cached = await caches.match(req);
      if (cached) return cached;
      // Last resort for navigations: serve the cached app shell.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw _;
    }
  })());
});
