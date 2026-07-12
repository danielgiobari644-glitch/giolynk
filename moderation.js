'use strict';
/* GIOLYNK - Moderation Module */
window.Moderation = {};

(function () {
  const db = () => window.Firebase.db;
  const auth = () => window.Firebase.auth;

  Moderation.init = function () {
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-action="report"]');
      if (!btn) return;
      const type = btn.dataset.type;
      const id = btn.dataset.id;
      if (type && id) showReportDialog(type, id);
    });
  };

  function showReportDialog(type, id) {
    const reasons = [
      { value: 'spam', label: 'Spam' },
      { value: 'inappropriate', label: 'Inappropriate Content' },
      { value: 'harassment', label: 'Harassment' },
      { value: 'false_info', label: 'False Information' },
      { value: 'other', label: 'Other' }
    ];

    const modal = document.getElementById('confirm-dialog');
    const title = document.getElementById('confirm-title');
    const message = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    title.textContent = 'Report Content';
    message.innerHTML = '<div style="text-align:left;margin-bottom:12px">'
      + reasons.map(r => '<label class="checkbox-label" style="margin-bottom:8px;display:flex;align-items:center;gap:8px">'
      + '<input type="radio" name="report-reason" value="' + r.value + '" ' + (r.value === 'spam' ? 'checked' : '') + '> ' + r.label + '</label>').join('')
      + '</div><textarea id="report-description" placeholder="Additional details (optional)" rows="2" style="width:100%;padding:8px;border:1px solid var(--surface-border);border-radius:8px;resize:none"></textarea>';

    okBtn.textContent = 'Submit Report';
    okBtn.className = 'btn btn-danger';
    modal.classList.remove('hidden');

    const cleanup = () => {
      modal.classList.add('hidden');
      okBtn.replaceWith(okBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    };

    cancelBtn.onclick = cleanup;

    okBtn.onclick = async function () {
      const reason = modal.querySelector('input[name="report-reason"]:checked')?.value || 'other';
      const description = document.getElementById('report-description')?.value?.trim() || '';
      const user = auth().currentUser;
      if (!user) return;

      try {
        await db().collection('reports').add({
          targetType: type,
          targetId: id,
          reporterId: user.uid,
          reporterName: user.displayName || 'Anonymous',
          reason,
          description,
          schoolId: user.schoolId || '',
          status: 'pending',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        Utils.showToast('Report submitted', 'success');
      } catch (err) {
        Utils.showToast('Failed to submit report', 'error');
      }
      cleanup();
    };
  }

  Moderation.canModerate = function (user) {
    if (!user) return false;
    return ['owner', 'admin', 'co-admin', 'moderator'].includes(user.role);
  };

  Moderation.deleteContent = async function (type, id, schoolId) {
    const confirmed = await Utils.showConfirm('Delete Content', 'Are you sure you want to delete this content? This cannot be undone.');
    if (!confirmed) return false;

    try {
      if (type === 'post') {
        const postRef = db().collection('posts').doc(id);
        const subs = ['likes', 'comments', 'savedPosts', 'pollVotes', 'reports'];
        const batch = db().batch();
        for (const sub of subs) {
          const snap = await postRef.collection(sub).get();
          snap.forEach(d => batch.delete(d.ref));
        }
        batch.delete(postRef);
        await batch.commit();
      } else if (type === 'comment') {
        await db().collection('comments').doc(id).delete();
      }
      Utils.showToast('Content deleted', 'success');
      return true;
    } catch (err) {
      Utils.showToast('Failed to delete', 'error');
      return false;
    }
  };

  Moderation.warnUser = async function (userId, reason) {
    try {
      await Notifications.createNotification(userId, 'system', {
        senderId: 'system',
        title: 'Content Warning',
        body: 'Your content was flagged: ' + reason + '. Please review our community guidelines.',
        targetType: 'user',
        targetId: userId
      });
      Utils.showToast('Warning sent', 'success');
    } catch (err) {
      Utils.showToast('Failed to send warning', 'error');
    }
  };
})();