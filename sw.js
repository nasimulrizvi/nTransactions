const CACHE_NAME = 'ntx-pwa-v3-sync-54';
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './favicon.svg',
  './favicon.png',
  './favicon-192.png',
  './favicon-maskable.png',
  './favicon-maskable-192.png'
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
const FCM_DB_VERSION = 4;
const FCM_DB_STORE = 'notifications';
const FCM_RECEIPT_STORE = 'notificationReceipts';
const FCM_META_STORE = 'meta';

function openFcmDb() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error('indexeddb_unavailable'));
    const req = indexedDB.open(FCM_DB_NAME, FCM_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FCM_DB_STORE)) {
        db.createObjectStore(FCM_DB_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FCM_RECEIPT_STORE)) {
        db.createObjectStore(FCM_RECEIPT_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(FCM_META_STORE)) {
        db.createObjectStore(FCM_META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb_open_failed'));
  });
}

function setActiveUid(uidValue) {
  return openFcmDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FCM_META_STORE, 'readwrite');
    tx.objectStore(FCM_META_STORE).put({ key: 'activeUid', value: String(uidValue || '') });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('indexeddb_write_failed')); };
  })).catch(() => {});
}

function getActiveUid() {
  return openFcmDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FCM_META_STORE, 'readonly');
    const req = tx.objectStore(FCM_META_STORE).get('activeUid');
    req.onsuccess = () => { const value = req.result && req.result.value; db.close(); resolve(String(value || '')); };
    req.onerror = () => { db.close(); reject(req.error || new Error('indexeddb_read_failed')); };
  })).catch(() => '');
}

function storeFcmNotification(item) {
  return openFcmDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FCM_DB_STORE, 'readwrite');
    const store = tx.objectStore(FCM_DB_STORE);
    const storageId = String(item && item.uid || '') + '::' + String(item && item.notificationId || '');
    store.put({ ...item, id: storageId });
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

function stableHash16(value) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function normalizeNotificationKind(kind, id) {
  const value = String(kind || '').trim().toLowerCase();
  const aliases = { bill_due: 'bill', bill_reminder: 'bill', loan_due: 'loan', loan_share: 'loan', pending_loan: 'loan', recurring_due: 'recurring', rec_due: 'recurring', push: 'app', message: 'app', fcm: 'app', pending_sms: 'sms' };
  if (aliases[value]) return aliases[value];
  if (['bill', 'loan', 'recurring', 'app', 'sms', 'admin', 'period'].includes(value)) return value;
  const rawId = String(id || '').trim().toLowerCase();
  if (rawId.startsWith('bill_due_')) return 'bill';
  if (rawId.startsWith('loan_due_') || rawId.startsWith('loan_share_') || rawId.startsWith('pending_loan_')) return 'loan';
  if (rawId.startsWith('rec_due_')) return 'recurring';
  if (rawId.startsWith('period_')) return 'period';
  if (rawId.startsWith('sms_') || rawId.startsWith('sms:') || rawId.startsWith('txn:') || rawId.startsWith('pending_sms') || rawId.startsWith('native_')) return 'sms';
  return 'app';
}

function notificationReceiptKey(kind, id) {
  const encode = value => encodeURIComponent(String(value || '').trim()).replace(/\./g, '%2E');
  return encode(normalizeNotificationKind(kind, id)) + '__' + encode(id).slice(0, 720);
}

function cleanNotificationId(value) {
  return String(value == null ? '' : value).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 720);
}

function storeFcmReceipt(item) {
  if (!item || !item.key || !item.notificationId) return Promise.resolve();
  return openFcmDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(FCM_RECEIPT_STORE, 'readwrite');
    tx.objectStore(FCM_RECEIPT_STORE).put(item);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error('indexeddb_write_failed')); };
  })).catch(() => {});
}

function queueNotificationReceipt(notification, source) {
  const data = notification && notification.data ? notification.data : {};
  const notificationId = cleanNotificationId(data.notificationId || data.id || notification && notification.tag || '');
  if (!notificationId) return Promise.resolve();
  const kind = normalizeNotificationKind(data.kind, notificationId);
  const uid = String(data.uid || data.userId || '').trim();
  if (!uid) return Promise.resolve();
  const receiptKey = notificationReceiptKey(kind, notificationId);
  return storeFcmReceipt({
    key: uid + '::' + receiptKey,
    receiptKey,
    uid,
    notificationId,
    kind,
    source: String(data.source || source || 'web_fcm').slice(0, 80),
    readAt: Date.now()
  });
}

function fcmNotificationItem(payload) {
  const data = payload && payload.data ? payload.data : {};
  const notification = payload && payload.notification ? payload.notification : {};
  const title = data.title || notification.title || 'nTransactions';
  const message = data.body || data.message || notification.body || 'You have a new nTransactions message.';
  const explicitId = cleanNotificationId(data.notificationId || data.id || (payload && payload.messageId) || '');
  const kind = normalizeNotificationKind(data.kind || data.type || data.subType, explicitId);
  const url = data.url || data.link || '';
  const uid = String(data.uid || data.userId || '').trim();
  const createdAt = String(data.createdAt || data.timestamp || data.sentAt || (payload && payload.sentTime) || '').trim();
  const id = explicitId || 'app:' + stableHash16([kind, title, message, url, createdAt].map(value => String(value || '').trim()).join('|'));
  const numericAt = Number(createdAt);
  const parsedAt = createdAt ? Date.parse(createdAt) : NaN;
  const at = Number.isFinite(numericAt) && numericAt > 0 ? numericAt : (Number.isFinite(parsedAt) ? parsedAt : Date.now());
  return {
    id,
    notificationId: id,
    uid,
    kind,
    title: String(title).slice(0, 90),
    message: String(message).slice(0, 360),
    url,
    at,
    createdAt,
    source: String(data.source || 'web_fcm').slice(0, 80)
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
  const receiptPromise = queueNotificationReceipt(event.notification, 'web_fcm_click');
  event.notification.close();
  const targetUrl = safeNotificationUrl(event.notification && event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : './index.html');
  const navigationPromise = clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
    const client = clientList.find(item => item.url && item.url.includes(self.location.origin));
    if (client) {
      try { if ('navigate' in client) await client.navigate(targetUrl); } catch (e) { }
      if ('focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
    return null;
  });
  event.waitUntil(Promise.all([receiptPromise, navigationPromise]));
});

self.addEventListener('notificationclose', event => {
  event.waitUntil(queueNotificationReceipt(event.notification, 'web_fcm_close'));
});

try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
  if (self.firebase && firebase.messaging) {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const messaging = firebase.messaging();
    messaging.onBackgroundMessage(payload => getActiveUid().then(activeUid => {
      const data = payload && payload.data ? payload.data : {};
      const payloadUid = String(data.uid || data.userId || '').trim();
      if (!activeUid || (payloadUid && payloadUid !== activeUid)) return;
      const notification = payload && payload.notification ? payload.notification : {};
      const title = data.title || notification.title || 'nTransactions';
      const body = data.body || data.message || notification.body || 'You have a new nTransactions message.';
      const targetUrl = safeNotificationUrl(data.url || data.link || './index.html');
      const item = fcmNotificationItem(payload || {});
      item.uid = payloadUid || activeUid;
      return storeFcmNotification(item).then(() => broadcastFcmNotification(item)).then(() => self.registration.showNotification(title, {
        body,
        icon: './favicon.png',
        badge: './favicon.png',
        tag: item.notificationId,
        data: { url: targetUrl, id: item.notificationId, notificationId: item.notificationId, kind: item.kind, source: item.source, uid: item.uid, userId: item.uid }
      }));
    }));
  }
} catch (e) {
  // Firebase Messaging is optional; cache/update behavior must keep working offline.
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' }))))
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
  if (event.data && event.data.type === 'NTX_SET_ACTIVE_UID') {
    const task = setActiveUid(event.data.uid || '');
    if (event.waitUntil) event.waitUntil(task);
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const canCache = url.origin === self.location.origin || url.origin === 'https://www.gstatic.com';
  if (!canCache || url.pathname.startsWith('/api/')) return;

  const networkFirstAsset = ['script', 'style', 'worker', 'manifest'].includes(request.destination)
    || /\.(?:js|mjs|css|json)$/i.test(url.pathname)
    || ['/manifest.json', '/version.json', '/app-version.json', '/release.json'].includes(url.pathname);

  const fetchAndRefresh = () => fetch(request, { cache: 'no-store' }).then(response => {
    if (response && (response.ok || response.type === 'opaque')) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  });

  if (request.mode === 'navigate' || networkFirstAsset) {
    event.respondWith(
      fetchAndRefresh()
        .then(response => {
          return response;
        })
        .catch(() => caches.match(request).then(cached => {
          if (cached) return cached;
          return request.mode === 'navigate' ? caches.match('./index.html') : Response.error();
        }))
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
