'use strict';
/* GIOLYNK - Notifications Module */
window.Notifications = {};

(function () {
  const db = () => window.Firebase.db;
  const auth = () => window.Firebase.auth;

  let unsubNotifs = null;

  Notifications.init = function () {
    document.addEventListener('pageChange', function (e) {
      if (e.detail.page === 'notifications') afterRender();
      else cleanup();
    });
  };

  Notifications.render = async function (params) {
    const user = Auth.getCurrentUser();
    if (!user) return '<div class="empty-state"><p>Not logged in</p></div>';

    return `
      <div id="notifications-page">
        <div class="section-header">
          <h2 class="section-title">Notifications</h2>
          <button class="section-action" id="mark-all-read-btn">Mark all read</button>
        </div>
        <div class="tabs" id="notif-tabs">
          <button class="tab active" data-tab="all">All</button>
          <button class="tab" data-tab="likes">Likes</button>
          <button class="tab" data-tab="comments">Comments</button>
          <button class="tab" data-tab="friends">Friends</button>
          <button class="tab" data-tab="system">System</button>
        </div>
        <div id="notif-list">
          ${'<div class="skeleton-card"><div class="skeleton skeleton-text" style="width:90%"></div><div class="skeleton skeleton-text short"></div></div>'.repeat(5)}
        </div>
      </div>`;
  };

  async function afterRender() {
    const user = Auth.getCurrentUser();
    if (!user) return;
    loadNotifications('all');

    const tabs = document.getElementById('notif-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        loadNotifications(tab.dataset.tab);
      });
    }

    const markAllBtn = document.getElementById('mark-all-read-btn');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', async function () {
        try {
          const user = auth().currentUser;
          const snap = await db().collection('notifications')
            .where('recipientId', '==', user.uid)
            .where('read', '==', false)
            .get();
          const batch = db().batch();
          snap.forEach(doc => batch.update(doc.ref, { read: true }));
          await batch.commit();
          updateBadge(0);
          Utils.showToast('All notifications marked as read', 'success');
          loadNotifications('all');
        } catch (err) {
          Utils.showToast('Failed to mark all read', 'error');
        }
      });
    }

    const list = document.getElementById('notif-list');
    if (list) {
      list.addEventListener('click', async function (e) {
        const item = e.target.closest('.notif-item');
        if (!item || !item.dataset.id) return;
        const notifId = item.dataset.id;
        try {
          await db().collection('notifications').doc(notifId).update({ read: true });
          item.classList.remove('unread');
        } catch (err) { /* silent */ }

        const target = item.dataset.targetType;
        const targetId = item.dataset.targetId;
        if (target === 'post') Router.navigate('post-detail', { postId: targetId });
        else if (target === 'user') Router.navigate('user-profile', { userId: targetId });
        else if (target === 'chat') Router.navigate('chat-view', { conversationId: targetId });
        else if (target === 'group') Router.navigate('group', { groupId: targetId });
        else if (target === 'competition') Router.navigate('competition-detail', { competitionId: targetId });
        else if (target === 'event') Router.navigate('event-detail', { eventId: targetId });
      });
    }
  }

  async function loadNotifications(filter) {
    const user = auth().currentUser;
    if (!user) return;
    const container = document.getElementById('notif-list');
    if (!container) return;

    try {
      let q = db().collection('notifications')
        .where('recipientId', '==', user.uid)
        .orderBy('createdAt', 'desc')
        .limit(50);

      if (filter === 'likes') q = db().collection('notifications').where('recipientId', '==', user.uid).where('type', '==', 'like').orderBy('createdAt', 'desc').limit(50);
      else if (filter === 'comments') q = db().collection('notifications').where('recipientId', '==', user.uid).where('type', '==', 'comment').orderBy('createdAt', 'desc').limit(50);
      else if (filter === 'friends') q = db().collection('notifications').where('recipientId', '==', user.uid).where('type', 'in', ['friend_request', 'friend_accepted']).orderBy('createdAt', 'desc').limit(50);
      else if (filter === 'system') q = db().collection('notifications').where('recipientId', '==', user.uid).where('type', 'in', ['system', 'achievement', 'level_up', 'competition', 'event']).orderBy('createdAt', 'desc').limit(50);

      const snap = await q.get();
      if (snap.empty) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔔</div><h3 class="empty-state-title">No notifications</h3><p class="empty-state-desc">When people interact with your content, you\'ll see it here.</p></div>';
        return;
      }

      let html = '';
      snap.forEach(doc => {
        const n = doc.data();
        html += Components.renderNotifItem({ id: doc.id, ...n });
      });
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3 class="empty-state-title">Error</h3><p class="empty-state-desc">Could not load notifications.</p></div>';
    }
  }

  function cleanup() {
    if (unsubNotifs) { unsubNotifs(); unsubNotifs = null; }
  }

  Notifications.updateBadge = async function () {
    const user = auth().currentUser;
    if (!user) return;
    try {
      const snap = await db().collection('notifications')
        .where('recipientId', '==', user.uid)
        .where('read', '==', false)
        .get();
      updateBadge(snap.size);
    } catch (err) { /* silent */ }
  };

  function updateBadge(count) {
    const badge = document.getElementById('notification-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  Notifications.createNotification = async function (recipientId, type, data) {
    try {
      await db().collection('notifications').add({
        recipientId,
        senderId: data.senderId || '',
        type,
        title: data.title || '',
        body: data.body || '',
        targetType: data.targetType || '',
        targetId: data.targetId || '',
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      Notifications.updateBadge();
    } catch (err) { /* silent - notifications are non-critical */ }
  };
})();