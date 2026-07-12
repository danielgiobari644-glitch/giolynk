/**
 * GIOLYNK - Firebase Initialization
 * Initializes all Firebase services using the compat SDK.
 * Includes full FCM push notification support (foreground + background/offline).
 */
(function () {
  'use strict';

  // ── Firebase Configuration ─────────────────────────────────────────────
  const firebaseConfig = {
    apiKey: 'AIzaSyCJZ2v3MM3jgpG9T2KqlKSZUxVi4M6PebI',
    authDomain: 'giolynk.firebaseapp.com',
    projectId: 'giolynk',
    storageBucket: 'giolynk.firebasestorage.app',
    messagingSenderId: '227297163584',
    appId: '1:227297163584:web:09a694c6af38350155e2a5',
    measurementId: 'G-SF7PJSML66'
  };

  // Initialize Firebase app (compat SDK lives on window.firebase)
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }

  // Service references
  const auth = firebase.auth();
  const db = firebase.firestore();
  const rtdb = firebase.database();
  const messaging = firebase.messaging;

  // Expose services globally
  window.Firebase = {
    auth,
    db,
    rtdb,
    config: firebaseConfig
  };

  // ── FCM / Push Notification Setup ──────────────────────────────────────
  //
  // HOW TO GET YOUR VAPID KEY:
  //   1. Go to Firebase Console → GIOLYNK project → Project Settings → Cloud Messaging tab
  //   2. Scroll to "Web configuration" section
  //   3. Click the "three dots" menu next to "Web Push certificates"
  //   4. Select "Generate key pair" (if not already generated)
  //   5. Copy the "Key pair" value (a long base64 string starting with "B")
  //   6. Paste it below, replacing the PLACEHOLDER string
  //
  const VAPID_KEY = 'BPnwXIHLpZo5mLvbnAaVlXOTdBTQwS3UiXDR7EMBhSPrA6P1gJcix5A1ToNBxDuLFLiKsyzkFuYeFIuSCwYTxcE';

  /**
   * Request notification permission and register for FCM.
   * Returns the FCM token string, or null if denied/unavailable.
   * Also saves the token to the user's Firestore doc for server-side push.
   */
  async function requestNotificationPermission() {
    try {
      if (!('Notification' in window)) {
        console.warn('[FCM] Notifications not supported in this browser.');
        return null;
      }

      if (Notification.permission === 'denied') {
        console.warn('[FCM] Notification permission previously denied.');
        return null;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        console.warn('[FCM] Notification permission not granted:', permission);
        return null;
      }

      // Check if messaging is supported (Safari etc. may not support it)
      if (typeof messaging === 'undefined' || !messaging.isSupported()) {
        console.warn('[FCM] Firebase Messaging is not supported in this browser.');
        return null;
      }

      const messagingInstance = messaging();

      // Get or create the FCM registration token
      const token = await messagingInstance.getToken({ vapidKey: VAPID_KEY });
      console.log('[FCM] Token obtained successfully.');

      // Save to Firestore so cloud functions / admin SDK can send push to this device
      await saveFCMToken(token);

      // Listen for token refreshes (e.g. after clearing browser data)
      messagingInstance.onTokenRefresh(async () => {
        console.log('[FCM] Token refreshed.');
        try {
          const newToken = await messagingInstance.getToken({ vapidKey: VAPID_KEY });
          if (newToken) await saveFCMToken(newToken);
        } catch (err) {
          console.error('[FCM] Token refresh handler error:', err);
        }
      });

      // Listen for foreground messages (user is actively using the app)
      messagingInstance.onMessage((payload) => {
        console.log('[FCM] Foreground message received:', payload);
        handleForegroundMessage(payload);
      });

      return token;
    } catch (error) {
      console.error('[FCM] Error requesting notification permission:', error);
      return null;
    }
  }

  /**
   * Handle a push message received while the app is in the foreground.
   * Shows a toast notification inside the app (not a system notification).
   */
  function handleForegroundMessage(payload) {
    const title = payload.notification?.title || 'GIOLYNK';
    const body = payload.notification?.body || 'You have a new notification.';
    const link = payload.fcmOptions?.link || payload.data?.link || null;

    if (window.Utils && window.Utils.showToast) {
      // Show in-app toast
      window.Utils.showToast(body, 'info');
    } else {
      // Fallback: native notification (only if we have permission)
      if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/icon-192.png', badge: '/icon-72.png' });
      }
    }

    // Dispatch event so other modules can react (e.g. refresh notifications list)
    window.dispatchEvent(new CustomEvent('fcm:message', { detail: payload }));

    // If a link is provided, could auto-navigate:
    if (link && window.Router) {
      // Don't auto-navigate, just let user tap the toast
    }
  }

  /**
   * Save (or update) the FCM token in the user's Firestore document.
   * Also stores it in Realtime Database for the service worker to access offline.
   */
  async function saveFCMToken(token) {
    try {
      const user = auth.currentUser;
      if (!user) {
        console.warn('[FCM] No authenticated user – skipping token save.');
        return;
      }

      // Save to Firestore (primary)
      await db.collection('users').doc(user.uid).set(
        {
          fcmToken: token,
          fcmTokenUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      // Also save to Realtime Database (used by service worker for offline push)
      await rtdb.ref('fcmTokens/' + user.uid).set({
        token: token,
        updatedAt: firebase.database.ServerValue.TIMESTAMP,
        platform: 'web'
      });

      console.log('[FCM] Token saved to Firestore & Realtime Database.');
    } catch (error) {
      console.error('[FCM] Error saving token:', error);
    }
  }

  /**
   * Delete the current FCM token (called on sign-out).
   */
  async function deleteFCMToken() {
    try {
      if (typeof messaging === 'undefined' || !messaging.isSupported()) return;
      const messagingInstance = messaging();
      const currentToken = await messagingInstance.getToken({ vapidKey: VAPID_KEY });
      if (currentToken) {
        await messagingInstance.deleteToken(currentToken);

        // Clean up from Realtime Database
        const user = auth.currentUser;
        if (user) {
          await rtdb.ref('fcmTokens/' + user.uid).remove().catch(() => {});
        }

        console.log('[FCM] Token deleted.');
      }
    } catch (error) {
      console.error('[FCM] Error deleting token:', error);
    }
  }

  /**
   * Legacy foreground message listener (can be called manually).
   */
  function onForegroundMessage(callback) {
    try {
      if (typeof messaging === 'undefined' || !messaging.isSupported()) return;
      const messagingInstance = messaging();
      messagingInstance.onMessage((payload) => {
        if (typeof callback === 'function') {
          callback(payload);
        }
      });
    } catch (error) {
      console.error('[FCM] Error setting up foreground listener:', error);
    }
  }

  // Expose FCM helpers globally
  window.Firebase.requestNotificationPermission = requestNotificationPermission;
  window.Firebase.saveFCMToken = saveFCMToken;
  window.Firebase.deleteFCMToken = deleteFCMToken;
  window.Firebase.onForegroundMessage = onForegroundMessage;
  window.Firebase.VAPID_KEY = VAPID_KEY;
})();