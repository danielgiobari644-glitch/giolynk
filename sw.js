/**
 * GIOLYNK Service Worker
 * Handles: static asset caching, offline support, and FCM background push notifications.
 *
 * BACKGROUND PUSH NOTIFICATIONS:
 * When the app is closed or in the background, this SW receives the FCM push event,
 * shows a system notification, and opens the correct page when the user taps it.
 *
 * OFFLINE NOTIFICATION QUEUE:
 * When offline, notification actions are queued locally and replayed when back online.
 */

const CACHE_NAME = 'giolynk-v2';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/main.css',
  '/components.css',
  '/animations.css',
  '/dark-mode.css',
  '/responsive.css',
  '/firebase-init.js',
  '/utils.js',
  '/components.js',
  '/auth.js',
  '/router.js',
  '/app.js',
  '/feed.js',
  '/chat.js',
  '/profile.js',
  '/discover.js',
  '/groups.js',
  '/competitions.js',
  '/events.js',
  '/notifications.js',
  '/search.js',
  '/create-post.js',
  '/reputation.js',
  '/admin.js',
  '/moderation.js',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

// ═══════════════════════════════════════════════════════════════════════
// INSTALL: Pre-cache all static assets
// ═══════════════════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ═══════════════════════════════════════════════════════════════════════
// ACTIVATE: Clean up old caches and take control immediately
// ═══════════════════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ═══════════════════════════════════════════════════════════════════════
// FETCH: Stale-while-revalidate for static, network-only for Firebase API
// ═══════════════════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Firebase API calls: network only (never cache Firestore/RTDB responses)
  if (url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebaseapp.com')) {
    event.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 503
      }))
    );
    return;
  }

  // Static assets: stale-while-revalidate (serve from cache, update in background)
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(request).then(cached => {
        const networkFetch = fetch(request).then(response => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        }).catch(() => cached);

        return cached || networkFetch;
      })
    )
  );
});

// ═══════════════════════════════════════════════════════════════════════
// FCM PUSH NOTIFICATION HANDLER (Background / Offline)
// ═══════════════════════════════════════════════════════════════════════
//
// This fires when:
//   - The app is in the background (user switched to another tab/app)
//   - The app is completely closed (user navigated away)
//   - The browser is offline (push message was queued by the browser)
//
// Firebase Cloud Messaging automatically delivers push messages to this
// handler when the user is not actively using the app.
//
self.addEventListener('push', event => {
  console.log('[SW] Push event received');

  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      // If not JSON, use the raw text as body
      data = { notification: { title: 'GIOLYNK', body: event.data.text() } };
    }
  }

  // Extract notification data (FCM sends this in data.notification for push messages)
  const notification = data.notification || {};
  const fcmData = data.data || {};

  const title = notification.title || fcmData.title || 'GIOLYNK';
  const body = notification.body || fcmData.body || 'You have a new notification.';
  const icon = notification.icon || '/icon-192.png';
  const badge = notification.badge || '/icon-72.png';

  // Build notification click action URL
  // Supports: fcmOptions.link, data.link, data.page, data.postId, data.chatId
  let clickUrl = '/';
  if (fcmData.link) {
    clickUrl = fcmData.link;
  } else if (fcmData.page) {
    if (fcmData.postId) {
      clickUrl = '/?page=post-detail&postId=' + fcmData.postId;
    } else if (fcmData.chatId) {
      clickUrl = '/?page=chat-view&chatId=' + fcmData.chatId;
    } else if (fcmData.groupId) {
      clickUrl = '/?page=group&groupId=' + fcmData.groupId;
    } else if (fcmData.userId) {
      clickUrl = '/?page=user-profile&userId=' + fcmData.userId;
    } else {
      clickUrl = '/?page=' + fcmData.page;
    }
  }

  // Determine tag for notification grouping (e.g. all chat messages group together)
  const tag = fcmData.tag || fcmData.type || 'giolynk-notification';

  const options = {
    body: body,
    icon: icon,
    badge: badge,
    tag: tag,
    data: {
      url: clickUrl,
      type: fcmData.type || 'general',
      timestamp: Date.now()
    },
    // Keep notification until user interacts with it
    requireInteraction: (fcmData.type === 'message' || fcmData.type === 'chat'),
    // Show timestamp
    timestamp: fcmData.timestamp ? parseInt(fcmData.timestamp, 10) : Date.now()
  };

  // If the notification has an image (e.g. avatar, post image)
  if (notification.image || fcmData.image) {
    options.image = notification.image || fcmData.image;
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
  );

  // ── Offline notification queue ──
  // Store the notification locally so the app can read it when back online
  event.waitUntil(
    openNotificationDB().then(db => {
      const tx = db.transaction('pending-notifications', 'readwrite');
      const store = tx.objectStore('pending-notifications');
      store.put({
        id: tag + '-' + Date.now(),
        title: title,
        body: body,
        type: fcmData.type || 'general',
        data: fcmData,
        receivedAt: Date.now(),
        synced: false
      });
      return tx.complete;
    }).catch(() => { /* IndexedDB may not be available */ })
  );
});

// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION CLICK HANDLER
// ═══════════════════════════════════════════════════════════════════════
// When the user taps a push notification, open/focus the app and navigate
// to the correct page.
self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event.notification.tag);

  const clickUrl = event.notification.data?.url || '/';

  // Close the notification popup
  event.notification.close();

  // Focus the existing app window or open a new one
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // Check if there's already a window open
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            // Focus existing window and navigate
            client.navigate(clickUrl);
            return client.focus();
          }
        }
        // No window open — open a new one
        if (self.clients.openWindow) {
          return self.clients.openWindow(clickUrl);
        }
      })
  );
});

// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION CLOSE HANDLER
// ═══════════════════════════════════════════════════════════════════════
self.addEventListener('notificationclose', event => {
  console.log('[SW] Notification closed:', event.notification.tag);
  // Could track dismissed notifications for analytics
});

// ═══════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER (from the main app)
// ═══════════════════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  if (!event.data) return;

  switch (event.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'GET_PENDING_NOTIFICATIONS':
      // App asks for notifications received while offline/background
      openNotificationDB().then(db => {
        const tx = db.transaction('pending-notifications', 'readonly');
        const store = tx.objectStore('pending-notifications');
        const request = store.getAll();
        request.onsuccess = () => {
          // Send pending notifications back to the app
          event.ports[0]?.postMessage({ type: 'pending-notifications', data: request.result });
          // Mark them as synced
          const writeTx = db.transaction('pending-notifications', 'readwrite');
          const writeStore = writeTx.objectStore('pending-notifications');
          request.result.forEach(n => {
            writeStore.put({ ...n, synced: true });
          });
          writeTx.complete.catch(() => {});
        };
      }).catch(() => {
        event.ports[0]?.postMessage({ type: 'pending-notifications', data: [] });
      });
      break;

    case 'CLEAR_PENDING_NOTIFICATIONS':
      // App has processed notifications, clear the queue
      openNotificationDB().then(db => {
        const tx = db.transaction('pending-notifications', 'readwrite');
        tx.objectStore('pending-notifications').clear();
        return tx.complete;
      }).catch(() => {});
      break;
  }
});

// ═══════════════════════════════════════════════════════════════════════
// OFFLINE NOTIFICATION DATABASE (IndexedDB)
// ═══════════════════════════════════════════════════════════════════════
// Stores push notifications received while offline so the app can
// display them when the user comes back online.

const NOTIFICATION_DB_NAME = 'giolynk-notifications';
const NOTIFICATION_DB_VERSION = 1;

function openNotificationDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NOTIFICATION_DB_NAME, NOTIFICATION_DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('pending-notifications')) {
        const store = db.createObjectStore('pending-notifications', { keyPath: 'id' });
        store.createIndex('synced', 'synced', { unique: false });
        store.createIndex('receivedAt', 'receivedAt', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}