const CACHE_NAME = 'ntx-public-web-no-pwa-31';
const OLD_CACHE_PREFIXES = ['ntx-pwa-', 'ntx-public-web-no-pwa-'];

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter(key => OLD_CACHE_PREFIXES.some(prefix => key.startsWith(prefix)))
        .map(key => caches.delete(key)));
    } catch (e) { }
    try {
      await self.registration.unregister();
    } catch (e) { }
    try {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clientList.forEach(client => client.postMessage({ type: 'NTX_PUBLIC_PWA_DISABLED' }));
    } catch (e) { }
  })());
});
