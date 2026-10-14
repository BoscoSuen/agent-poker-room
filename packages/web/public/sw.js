// Poker Garden service worker: cache the app shell; never cache API or engine traffic.
const VERSION = 'pg-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // network first, fall back to cached shell (offline / flaky mobile)
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(VERSION).then((cache) => cache.put('/index.html', c)); return r; }).catch(() => caches.match('/index.html')));
    return;
  }
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const c = r.clone(); caches.open(VERSION).then((cache) => cache.put(e.request, c)); return r; })));
  }
});
