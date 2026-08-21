const CACHE_NAME = 'ntx-pwa-v2-1-android-32';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './favicon.png',
  './favicon-maskable.png'
];

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAc8XTvYXDVVjH7xih564tK_VFbJ44Vsgw",
  authDomain: "ntransactions.firebaseapp.com",
  databaseURL: "https://ntransactions-default-rtdb.firebaseio.com",
  projectId: "ntransactions",
  messagingSenderId: "1014134005291",
  appId: "1:1014134005291:web:6ad9f92ec329fe0ca4d46e",
  measurementId: "G-EKSSK3KY23"
};

const FCM_DB_NAME = 'ntx-notifications-db';
const FCM_DB_STORE = 'notifications';

function openFcmDb() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error('indexeddb_unavailable'));
    const req = indexedDB.open(FCM_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FCM_DB_STORE)) {
        db.createObjectStore(FCM_DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb_open_failed'));
  });
}

function storeFcmNotification(item) {
  return openFcmDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FCM_DB_STORE, 'readwrite');
    const store = tx.objectStore(FCM_DB_STORE);
    store.put(item);
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const all = Array.isArray(allReq.result) ? allReq.result : [];
      all.sort((a, b) => Number(b.at || 0) - Number(a.at || 0)).slice(50).forEach(old => {
        if (old && old.id) store.delete(old.id);
      });
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('indexeddb_write_failed')); };
  })).catch(() => {});
}

function broadcastFcmNotification(item) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    clientList.forEach(client => client.postMessage({ type: 'NTX_FCM_NOTIFICATION', notification: item }));
  }).catch(() => {});
}

function fcmNotificationItem(payload) {
  const data = payload && payload.data ? payload.data : {};
  const notification = payload && payload.notification ? payload.notification : {};
  const title = data.title || notification.title || 'nTransactions';
  const message = data.body || data.message || notification.body || 'You have a new nTransactions message.';
  const at = Date.now();
  const rawId = data.id || (payload && payload.messageId) || `${title}_${message}_${at}`;
  const id = String(rawId).replace(/[^\w.-]/g, '_') || ('web_fcm_' + at);
  return {
    id,
    title: String(title).slice(0, 90),
    message: String(message).slice(0, 360),
    url: data.url || data.link || '',
    at,
    source: 'web_fcm'
  };
}

function safeNotificationUrl(value) {
  try {
    const url = new URL(value || './index.html', self.location.origin);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch (e) { }
  return './index.html';
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = safeNotificationUrl(event.notification && event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : './index.html');
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client && client.url.includes(self.location.origin)) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
      return null;
    })
  );
});

try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
  if (self.firebase && firebase.messaging) {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const messaging = firebase.messaging();
    messaging.onBackgroundMessage(payload => {
      const data = payload && payload.data ? payload.data : {};
      const notification = payload && payload.notification ? payload.notification : {};
      const title = data.title || notification.title || 'nTransactions';
      const body = data.body || data.message || notification.body || 'You have a new nTransactions message.';
      const targetUrl = safeNotificationUrl(data.url || data.link || './index.html');
      const item = fcmNotificationItem(payload || {});
      storeFcmNotification(item).then(() => broadcastFcmNotification(item));
      self.registration.showNotification(title, {
        body,
        icon: './favicon.png',
        badge: './favicon.png',
        data: { url: targetUrl }
      });
    });
  }
} catch (e) {
  // Firebase Messaging is optional; cache/update behavior must keep working offline.
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const canCache = url.origin === self.location.origin || url.origin === 'https://www.gstatic.com';
  const isReleaseMeta = ['/version.json', '/app-version.json', '/release.json'].includes(url.pathname);
  if (!canCache || url.pathname.startsWith('/api/') || isReleaseMeta) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            if (url.pathname === '/' || url.pathname.endsWith('/index.html')) {
              cache.put('./index.html', copy);
            } else {
              cache.put(request, copy);
            }
          });
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      });
    })
  );
});
