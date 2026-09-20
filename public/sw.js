/* Namoo Reader Installable / Offline Shell (ADR-0001).
 * Precaches the minimal reading shell only. APIs and non-shell assets stay network-only.
 * Bump SHELL_CACHE (and versioned asset URLs below) whenever shell files change.
 */
const SHELL_CACHE = 'namoo-shell-v1-42f83bbe0790-fc9fb02c7629-155a40f466a1-35039b1e8ab8-a9a83d7ad66b';
const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/styles.css?v=35039b1e8ab8',
  '/lucide-icons.js?v=a9a83d7ad66b',
  '/workspace-navigation.js?v=155a40f466a1',
  '/app.js?v=42f83bbe0790',
  '/periodicals.js?v=fc9fb02c7629',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key.startsWith('namoo-shell-') && key !== SHELL_CACHE)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!isSameOrigin(url)) return;
  if (isApiRequest(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => response)
        .catch(() => caches.match('/').then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request);
    })
  );
});
