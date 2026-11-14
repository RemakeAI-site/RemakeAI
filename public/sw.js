const shell = 'studio-offline-v1';
self.addEventListener('install', event => event.waitUntil(caches.open(shell).then(cache => cache.add('/offline.html'))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('studio-offline-') && key !== shell).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && !url.pathname.startsWith('/api/') && event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  }
});
