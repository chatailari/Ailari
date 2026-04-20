const CACHE_NAME = 'ailari-v2';
const BASE = '/Ailari';
const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/icons/icon-192.png',
  BASE + '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(ASSETS).catch(err => console.log('Cache parcial:', err))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('api.groq.com') || url.includes('googleapis.com') ||
      url.includes('inference.ai.azure.com') || url.includes('fonts.gstatic.com')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        if (e.request.headers.get('accept')?.includes('text/html'))
          return caches.match(BASE + '/index.html');
      })
    )
  );
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
