'use strict';
/* GIOLYNK - Admin Module */
window.Admin = {};

(function () {
  const db = () => window.Firebase.db;
  const auth = () => window.Firebase.auth;

  Admin.init = function () {
    document.addEventListener('pageChange', function (e) {
      if (e.detail.page === 'admin') afterRender();
    });
  };

  Admin.render = async function (params) {
    const user = Auth.getCurrentUser();
    if (!user) return '';
    if (!['owner', 'admin', 'co-admin'].includes(user.role)) {
      return '<div class="empty-state"><div class="empty-state-icon">🔒</div><h3 class="empty-state-title">Access Denied</h3><p class="empty-state-desc">You do not have admin privileges.</p></div>';
    }

    const stats = await loadStats(user.schoolId);
    return `
      <div id="admin-page">
        <div class="section-header"><h2 class="section-title">Admin Dashboard</h2></div>
        <div class="stats-grid" id="admin-stats-grid">
          <div class="stat-card"><div class="stat-card-icon">👥</div><div class="stat-card-value">${Utils.formatNumber(stats.members || 0)}</div><div class="stat-card-label">Members</div></div>
          <div class="stat-card"><div class="stat-card-icon">📝</div><div class="stat-card-value">${Utils.formatNumber(stats.posts || 0)}</div><div class="stat-card-label">Posts</div></div>
          <div class="stat-card"><div class="stat-card-icon">👥</div><div class="stat-card-value">${Utils.formatNumber(stats.groups || 0)}</div><div class="stat-card-label">Groups</div></div>
          <div class="stat-card"><div class="stat-card-icon">📢</div><div class="stat-card-value">${Utils.formatNumber(stats.reports || 0)}</div><div class="stat-card-label">Reports</div></div>
        </div>

        <div class="tabs" id="admin-tabs">
          <button class="tab active" data-tab="overview">Overview</button>
          <button class="tab" data-tab="members">Members</button>
          <button class="tab" data-tab="reports">Reports</button>
          <button class="tab" data-tab="settings">School Settings</button>
        </div>
        <div id="admin-content"></div>
      </div>`;
  };

  async function afterRender() {
    loadTab('overview');
    document.getElementById('admin-tabs')?.addEventListener('click', function (e) {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      this.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      loadTab(tab.dataset.tab);
    });
  }

  async function loadTab(tab) {
    const container = document.getElementById('admin-content');
    if (!container) return;

    if (tab === 'overview') {
      const user = Auth.getCurrentUser();
      const recentPosts = await loadRecentPosts(user.schoolId);
      container.innerHTML = '<div class="section-header"><h3 class="section-title">Recent Posts</h3></div>' +
        (recentPosts.length ? recentPosts.map(p => '<div style="padding:12px;border-bottom:1px solid var(--surface-border)"><p style="font-size:14px">' + Utils.truncate(Utils.sanitizeHTML(p.content || '(media)'), 100) + '</p><span style="font-size:12px;color:var(--text-tertiary)">' + Utils.formatTimeAgo(p.createdAt) + ' · ' + (p.likeCount || 0) + ' likes</span></div>').join('') : '<div class="empty-state"><p>No posts yet</p></div>');
    } else if (tab === 'members') {
      const user = Auth.getCurrentUser();
      container.innerHTML = '<div class="section-header"><h3 class="section-title">Members</h3></div><div id="admin-members-list"></div>';
      const list = document.getElementById('admin-members-list');
      const snap = await db().collection('users').where('schoolId', '==', user.schoolId).orderBy('createdAt', 'desc').limit(50).get();
      let html = '';
      snap.forEach(doc => {
        const u = doc.data();
        const roles = ['owner', 'admin', 'co-admin', 'moderator', 'student'];
        html += '<div class="user-item" data-uid="' + doc.id + '">'
          + '<div class="post-avatar-placeholder">' + Utils.getInitials(u.displayName || 'U') + '</div>'
          + '<div class="user-info"><span class="user-name">' + Utils.sanitizeHTML(u.displayName || 'Unknown') + '</span>'
          + '<span class="user-handle">@' + (u.username || doc.id.substring(0, 8)) + ' · ' + (u.role || 'student') + '</span></div>'
          + (user.role === 'owner' || user.role === 'admin' ? '<select class="admin-role-select" data-uid="' + doc.id + '" style="padding:4px 8px;border-radius:8px;border:1px solid var(--surface-border);font-size:12px">'
          + roles.map(r => '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>').join('')
          + '</select>' : '')
          + '</div>';
      });
      list.innerHTML = html || '<div class="empty-state"><p>No members</p></div>';

      list.querySelectorAll('.admin-role-select').forEach(sel => {
        sel.addEventListener('change', async function () {
          const uid = this.dataset.uid;
          const newRole = this.value;
          try {
            await db().collection('users').doc(uid).update({ role: newRole });
            Utils.showToast('Role updated to ' + newRole, 'success');
          } catch (err) { Utils.showToast('Failed to update role', 'error'); }
        });
      });
    } else if (tab === 'reports') {
      container.innerHTML = '<div class="section-header"><h3 class="section-title">Reports</h3></div><div id="admin-reports-list"></div>';
      const list = document.getElementById('admin-reports-list');
      const snap = await db().collection('reports').where('schoolId', '==', Auth.getCurrentUser().schoolId).orderBy('createdAt', 'desc').limit(30).get();
      if (snap.empty) { list.innerHTML = '<div class="empty-state"><p>No reports</p></div>'; return; }
      let html = '';
      snap.forEach(doc => {
        const r = doc.data();
        html += '<div class="card report-card"><div class="report-reason">' + (r.reason || 'Unknown') + '</div>'
          + '<div class="report-content">' + Utils.truncate(Utils.sanitizeHTML(r.description || r.content || ''), 150) + '</div>'
          + '<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px">' + Utils.formatTimeAgo(r.createdAt) + ' · By ' + (r.reporterName || 'Anonymous') + ' · Status: ' + (r.status || 'pending') + '</div>'
          + '<div class="report-actions">'
          + '<button class="btn btn-sm btn-ghost" onclick="Admin.resolveReport(\'' + doc.id + '\', \'dismissed\')">Dismiss</button>'
          + '<button class="btn btn-sm btn-outline" onclick="Admin.resolveReport(\'' + doc.id + '\', \'resolved\')">Resolve</button>'
          + '<button class="btn btn-sm btn-danger" onclick="Admin.resolveReport(\'' + doc.id + '\', \'banned\')">Ban User</button>'
          + '</div></div>';
      });
      list.innerHTML = html;
    } else if (tab === 'settings') {
      const user = Auth.getCurrentUser();
      const schoolDoc = await db().collection('schools').doc(user.schoolId).get();
      const school = schoolDoc.exists ? schoolDoc.data() : {};
      container.innerHTML = '<div style="padding:16px">'
        + '<div class="form-group"><label>School Name</label><input type="text" id="admin-school-name" value="' + Utils.sanitizeHTML(school.name || '') + '"></div>'
        + '<div class="form-group"><label>Description</label><textarea id="admin-school-desc" rows="3">' + Utils.sanitizeHTML(school.description || '') + '</textarea></div>'
        + '<div class="form-group"><label>Join Code</label><div style="display:flex;gap:8px"><input type="text" id="admin-school-code" value="' + (school.joinCode || '') + '" readonly style="flex:1"><button class="btn btn-sm btn-outline" id="regenerate-code-btn">Regenerate</button></div></div>'
        + '<div class="form-group"><label>Max Members (0 = unlimited)</label><input type="number" id="admin-max-members" value="' + (school.maxMembers || 0) + '"></div>'
        + '<div class="form-group"><label>Allow Member Posts</label><label class="checkbox-label"><input type="checkbox" id="admin-allow-posts" ' + (school.allowMemberPosts !== false ? 'checked' : '') + '><span class="toggle-switch"></span></label></div>'
        + '<button class="btn btn-primary btn-full" id="save-school-settings">Save Settings</button>'
        + '</div>';

      document.getElementById('regenerate-code-btn')?.addEventListener('click', async function () {
        const code = 'GIOLYNK-' + Math.random().toString(36).substring(2, 6).toUpperCase();
        document.getElementById('admin-school-code').value = code;
        try {
          await db().collection('schools').doc(user.schoolId).update({ joinCode: code });
          Utils.showToast('Code regenerated: ' + code, 'success');
        } catch (err) { Utils.showToast('Failed', 'error'); }
      });

      document.getElementById('save-school-settings')?.addEventListener('click', async function () {
        try {
          await db().collection('schools').doc(user.schoolId).update({
            name: document.getElementById('admin-school-name').value.trim(),
            description: document.getElementById('admin-school-desc').value.trim(),
            maxMembers: parseInt(document.getElementById('admin-max-members').value) || 0,
            allowMemberPosts: document.getElementById('admin-allow-posts').checked
          });
          Utils.showToast('Settings saved', 'success');
        } catch (err) { Utils.showToast('Failed to save', 'error'); }
      });
    }
  }

  async function loadStats(schoolId) {
    try {
      const membersSnap = await db().collection('users').where('schoolId', '==', schoolId).get();
      const postsSnap = await db().collection('posts').where('schoolId', '==', schoolId).get();
      const groupsSnap = await db().collection('groups').where('schoolId', '==', schoolId).get();
      const reportsSnap = await db().collection('reports').where('schoolId', '==', schoolId).where('status', '==', 'pending').get();
      return { members: membersSnap.size, posts: postsSnap.size, groups: groupsSnap.size, reports: reportsSnap.size };
    } catch (err) {
      return { members: 0, posts: 0, groups: 0, reports: 0 };
    }
  }

  async function loadRecentPosts(schoolId) {
    try {
      const snap = await db().collection('posts').where('schoolId', '==', schoolId).orderBy('createdAt', 'desc').limit(10).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) { return []; }
  }

  Admin.resolveReport = async function (reportId, action) {
    try {
      const reportRef = db().collection('reports').doc(reportId);
      const reportSnap = await reportRef.get();
      const report = reportSnap.data();

      if (action === 'banned' && report.reportedUserId) {
        await db().collection('users').doc(report.reportedUserId).update({ role: 'banned' });
      }

      await reportRef.update({ status: action, resolvedAt: firebase.firestore.FieldValue.serverTimestamp() });
      Utils.showToast('Report ' + action, 'success');
      loadTab('reports');
    } catch (err) {
      Utils.showToast('Failed to resolve report', 'error');
    }
  };
})();