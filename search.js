'use strict';
/* GIOLYNK - Search Module */
window.Search = {};

(function () {
  const db = () => window.Firebase.db;
  const auth = () => window.Firebase.auth;
  let searchTimeout = null;

  Search.init = function () {
    const input = document.getElementById('global-search-input');
    if (input) {
      input.addEventListener('input', function () {
        clearTimeout(searchTimeout);
        const q = input.value.trim();
        if (q.length < 2) {
          const results = document.getElementById('search-results');
          if (results) results.innerHTML = '';
          return;
        }
        searchTimeout = setTimeout(() => performSearch(q, 'all'), 300);
      });
    }

    document.querySelectorAll('.search-tab').forEach(tab => {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.search-tab').forEach(t => t.classList.remove('active'));
        this.classList.add('active');
        const input = document.getElementById('global-search-input');
        if (input && input.value.trim().length >= 2) {
          performSearch(input.value.trim(), this.dataset.tab);
        }
      });
    });

    document.getElementById('close-search')?.addEventListener('click', () => {
      document.getElementById('search-overlay').classList.add('hidden');
      const input = document.getElementById('global-search-input');
      if (input) input.value = '';
    });
  };

  async function performSearch(query, tab) {
    const results = document.getElementById('search-results');
    if (!results) return;
    const q = query.toLowerCase();
    let html = '';

    try {
      if (tab === 'all' || tab === 'people') {
        html += '<h3 class="section-title" style="padding:8px 0 4px">People</h3>';
        const usersSnap = await db().collection('users')
          .where('schoolId', '==', Auth.getCurrentUser()?.schoolId || '')
          .limit(20).get();
        let usersHtml = '';
        usersSnap.forEach(doc => {
          const u = doc.data();
          const match = (u.displayName || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q);
          if (match && doc.id !== auth().currentUser?.uid) {
            usersHtml += Components.renderUserItem({ id: doc.id, ...u }, 'View', 'follow');
          }
        });
        html += usersHtml || '<p style="padding:8px;color:var(--text-tertiary);font-size:14px">No people found</p>';
      }

      if (tab === 'all' || tab === 'posts') {
        html += '<h3 class="section-title" style="padding:16px 0 4px">Posts</h3>';
        const postsSnap = await db().collection('posts')
          .where('schoolId', '==', Auth.getCurrentUser()?.schoolId || '')
          .orderBy('createdAt', 'desc').limit(30).get();
        let postsHtml = '';
        postsSnap.forEach(doc => {
          const p = doc.data();
          const match = (p.content || '').toLowerCase().includes(q);
          if (match) {
            postsHtml += '<div class="card" style="padding:12px;margin-bottom:8px;cursor:pointer" data-post-id="' + doc.id + '">'
              + '<p style="font-size:14px">' + Utils.truncate(Utils.sanitizeHTML(p.content || ''), 120) + '</p>'
              + '<span style="font-size:12px;color:var(--text-tertiary)">' + Utils.formatTimeAgo(p.createdAt) + '</span></div>';
          }
        });
        html += postsHtml || '<p style="padding:8px;color:var(--text-tertiary);font-size:14px">No posts found</p>';
      }

      if (tab === 'all' || tab === 'groups') {
        html += '<h3 class="section-title" style="padding:16px 0 4px">Groups</h3>';
        const groupsSnap = await db().collection('groups')
          .where('schoolId', '==', Auth.getCurrentUser()?.schoolId || '')
          .limit(20).get();
        let groupsHtml = '';
        groupsSnap.forEach(doc => {
          const g = doc.data();
          if ((g.name || '').toLowerCase().includes(q)) {
            groupsHtml += Components.renderGroupCard({ id: doc.id, ...g });
          }
        });
        html += groupsHtml || '<p style="padding:8px;color:var(--text-tertiary);font-size:14px">No groups found</p>';
      }

      if (!html.trim()) {
        html = '<div class="empty-state" style="padding:48px 16px"><div class="empty-state-icon">🔍</div><h3 class="empty-state-title">No results</h3><p class="empty-state-desc">Try a different search term</p></div>';
      }

      results.innerHTML = html;

      results.querySelectorAll('[data-post-id]').forEach(el => {
        el.addEventListener('click', () => Router.navigate('post-detail', { postId: el.dataset.postId }));
      });
      results.querySelectorAll('[data-user-id]').forEach(el => {
        el.addEventListener('click', () => Router.navigate('user-profile', { userId: el.dataset.userId }));
      });
      results.querySelectorAll('[data-group-id]').forEach(el => {
        el.addEventListener('click', () => Router.navigate('group', { groupId: el.dataset.groupId }));
      });

    } catch (err) {
      results.innerHTML = '<div class="empty-state"><p style="color:var(--danger)">Search failed</p></div>';
    }
  }
})();