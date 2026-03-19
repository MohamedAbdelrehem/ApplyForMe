const CACHE = 'fursa-v3';
const ASSETS = ['/', '/index.html', '/css/style.css', '/js/ai.js', '/js/app.js', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Handle Web Share Target — Android shares land here
  if (url.pathname === '/share-target') {
    const sharedUrl  = url.searchParams.get('url')  || '';
    const sharedText = url.searchParams.get('text') || '';
    // Pick the best value: prefer a URL, fall back to text (which may contain the URL)
    const best = sharedUrl || extractUrl(sharedText) || sharedText;
    // Redirect to home with the shared content as a query param
    const redirect = '/?shared=' + encodeURIComponent(best.trim());
    e.respondWith(Response.redirect(redirect, 302));
    return;
  }

  if (e.request.url.includes('/api/')) return;
  if (e.request.url.includes('/shortcuts/')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

function extractUrl(text) {
  const m = text && text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}