/**
 * GIOLYNK - Groups Module
 * Renders groups list page and individual group pages.
 * Handles joining, leaving, creating, and managing groups.
 * Uses Firebase compat SDK via window.Firebase references.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _activeTab = 'my-groups';     // 'my-groups' | 'discover' | 'create'
  let _groupTab = 'posts';          // 'posts' | 'members' | 'media'
  let _groupData = null;            // Cached group doc for the detail page
  let _groupMembers = [];           // Cached member list
  let _isMember = false;            // Whether current user is a member
  let _isAdmin = false;             // Whether current user is an admin
  let _searchTimeout = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function currentUser() {
    return window.Auth && window.Auth.getCurrentUser();
  }

  function u() {
    return window.Utils || {};
  }

  function c() {
    return window.Components || {};
  }

  /**
   * Fetch a lightweight author object.
   */
  async function fetchAuthor(authorId) {
    if (!authorId) return {};
    try {
      const doc = await window.Firebase.db.collection('users').doc(authorId).get();
      if (doc.exists) {
        const d = doc.data();
        return {
          uid: doc.id,
          displayName: d.displayName || '',
          avatarUrl: d.avatarUrl || null,
          username: d.username || '',
          role: d.role || 'student'
        };
      }
    } catch (err) {
      console.warn('[Groups] Could not fetch author:', authorId, err);
    }
    return { displayName: 'Unknown', avatarUrl: null, username: '' };
  }

  /**
   * Fetch like UIDs for a post.
   */
  async function fetchLikes(postId) {
    try {
      const snap = await window.Firebase.db
        .collection('posts').doc(postId).collection('likes')
        .limit(200).get();
      return snap.docs.map(l => l.id);
    } catch (_) {
      return [];
    }
  }

  /**
   * Enrich a post document with author and likes.
   */
  async function enrichPost(doc) {
    const data = doc.data();
    const author = await fetchAuthor(data.authorId);
    const likes = await fetchLikes(doc.id);

    return {
      id: doc.id,
      ...data,
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
      author,
      likes
    };
  }

  // ── Data Loaders ──────────────────────────────────────────────────────────

  /**
   * Load groups the current user has joined.
   */
  async function loadMyGroups() {
    const user = currentUser();
    if (!user) return [];

    try {
      const snap = await window.Firebase.db
        .collection('groups')
        .where('members', 'array-contains', user.uid)
        .orderBy('memberCount', 'desc')
        .get();

      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.error('[Groups] Error loading my groups:', err);
      return [];
    }
  }

  /**
   * Load groups from same school that user hasn't joined.
   */
  async function loadDiscoverGroups() {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    try {
      const snap = await window.Firebase.db
        .collection('groups')
        .where('schoolId', '==', user.schoolId)
        .orderBy('memberCount', 'desc')
        .limit(50)
        .get();

      // Get user's joined group IDs to filter out
      let joinedIds = new Set();
      try {
        const mySnap = await window.Firebase.db
          .collection('groups')
          .where('members', 'array-contains', user.uid)
          .get();
        mySnap.docs.forEach(doc => joinedIds.add(doc.id));
      } catch (_) {}

      return snap.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(g => !joinedIds.has(g.id));
    } catch (err) {
      console.error('[Groups] Error loading discover groups:', err);
      return [];
    }
  }

  /**
   * Load posts for a specific group.
   */
  async function loadGroupPosts(groupId) {
    if (!groupId) return [];

    try {
      const snap = await window.Firebase.db
        .collection('posts')
        .where('groupId', '==', groupId)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();

      const posts = [];
      for (const doc of snap.docs) {
        posts.push(await enrichPost(doc));
      }
      return posts;
    } catch (err) {
      console.error('[Groups] Error loading group posts:', err);
      return [];
    }
  }

  /**
   * Load all members of a group and fetch their user docs.
   */
  async function loadGroupMembers(groupId) {
    if (!groupId) return [];

    try {
      const groupDoc = await window.Firebase.db.collection('groups').doc(groupId).get();
      if (!groupDoc.exists) return [];

      const memberIds = groupDoc.data().members || [];
      const adminIds = groupDoc.data().admins || [];

      if (memberIds.length === 0) return [];

      // Batch fetch user docs (Firestore allows max 10 per batch get)
      const members = [];
      for (let i = 0; i < memberIds.length; i += 10) {
        const batch = memberIds.slice(i, i + 10);
        const snaps = await Promise.all(
          batch.map(uid => window.Firebase.db.collection('users').doc(uid).get())
        );
        snaps.forEach(doc => {
          if (doc.exists) {
            const d = doc.data();
            members.push({
              uid: doc.id,
              ...d,
              isAdmin: adminIds.includes(doc.id),
              isCreator: groupDoc.data().createdBy === doc.id
            });
          }
        });
      }

      // Sort: creator first, then admins, then regular members
      members.sort((a, b) => {
        if (a.isCreator) return -1;
        if (b.isCreator) return 1;
        if (a.isAdmin && !b.isAdmin) return -1;
        if (!a.isAdmin && b.isAdmin) return 1;
        return (a.displayName || '').localeCompare(b.displayName || '');
      });

      return members;
    } catch (err) {
      console.error('[Groups] Error loading group members:', err);
      return [];
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Join a group: add currentUserId to members, increment memberCount.
   */
  async function handleJoinGroup(groupId) {
    const user = currentUser();
    if (!user || !groupId) return;

    try {
      await window.Firebase.db.collection('groups').doc(groupId).update({
        members: firebase.firestore.FieldValue.arrayUnion(user.uid),
        memberCount: firebase.firestore.FieldValue.increment(1)
      });

      _isMember = true;
      u().showToast('Joined group!', 'success');

      // Re-render group page
      if (window.Router && window.Router.getCurrentPage() === 'group') {
        const params = window.Router.getParams();
        const html = await renderGroupPage(params);
        document.getElementById('page-content').innerHTML = html;
        afterGroupPageRender(params);
      }
    } catch (err) {
      console.error('[Groups] Error joining group:', err);
      u().showToast('Failed to join group.', 'error');
    }
  }

  /**
   * Leave a group: remove currentUserId from members, decrement memberCount,
   * and remove from group chat membership.
   */
  async function handleLeaveGroup(groupId) {
    const user = currentUser();
    if (!user || !groupId) return;

    const confirmed = await u().showConfirm('Leave Group', 'Are you sure you want to leave this group?');
    if (!confirmed) return;

    try {
      await window.Firebase.db.collection('groups').doc(groupId).update({
        members: firebase.firestore.FieldValue.arrayRemove(user.uid),
        memberCount: firebase.firestore.FieldValue.increment(-1)
      });

      // Remove user from group conversation members if it exists
      try {
        const convSnap = await window.Firebase.db
          .collection('conversations')
          .where('groupId', '==', groupId)
          .limit(1)
          .get();

        if (!convSnap.empty) {
          const convId = convSnap.docs[0].id;
          await window.Firebase.db.collection('conversations').doc(convId).update({
            members: firebase.firestore.FieldValue.arrayRemove(user.uid),
            memberCount: firebase.firestore.FieldValue.increment(-1)
          });
        }
      } catch (_) {
        // Conversation may not exist – ignore
      }

      _isMember = false;
      u().showToast('Left group.', 'info');

      // Re-render group page
      if (window.Router && window.Router.getCurrentPage() === 'group') {
        const params = window.Router.getParams();
        const html = await renderGroupPage(params);
        document.getElementById('page-content').innerHTML = html;
        afterGroupPageRender(params);
      }
    } catch (err) {
      console.error('[Groups] Error leaving group:', err);
      u().showToast('Failed to leave group.', 'error');
    }
  }

  /**
   * Create a new group and its associated conversation.
   */
  async function handleCreateGroup(data) {
    const user = currentUser();
    if (!user) return null;

    if (!data.name || !data.name.trim()) {
      u().showToast('Group name is required.', 'warning');
      return null;
    }

    const name = data.name.trim();
    const description = (data.description || '').trim();
    const avatarUrl = data.avatarUrl || null;

    // Compress avatar if provided as base64
    let groupAvatarUrl = avatarUrl;
    if (avatarUrl && avatarUrl.startsWith('data:')) {
      try {
        groupAvatarUrl = await u().compressImage(
          /* file is already a data URL – skip compress if it's small enough */
          avatarUrl, 400, 0.8
        );
      } catch (_) {
        groupAvatarUrl = avatarUrl;
      }
    }

    try {
      const groupId = u().generateId();

      const groupDoc = {
        id: groupId,
        name,
        description,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: user.uid,
        schoolId: user.schoolId || null,
        members: [user.uid],
        memberCount: 1,
        admins: [user.uid],
        groupAvatarUrl: groupAvatarUrl,
        isPublic: true
      };

      await window.Firebase.db.collection('groups').doc(groupId).set(groupDoc);

      // Create group conversation
      const convId = u().generateId();
      await window.Firebase.db.collection('conversations').doc(convId).set({
        id: convId,
        isGroup: true,
        groupId: groupId,
        name: name,
        avatarUrl: groupAvatarUrl,
        members: [user.uid],
        memberCount: 1,
        createdBy: user.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastMessage: null,
        lastMessageAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Update the group doc with the conversation ID
      await window.Firebase.db.collection('groups').doc(groupId).update({
        conversationId: convId
      });

      u().showToast('Group created successfully!', 'success');
      return { id: groupId, ...groupDoc };
    } catch (err) {
      console.error('[Groups] Error creating group:', err);
      u().showToast('Failed to create group.', 'error');
      return null;
    }
  }

  /**
   * Delete a group (admin only).
   */
  async function handleDeleteGroup(groupId) {
    const user = currentUser();
    if (!user || !groupId) return;

    const confirmed = await u().showConfirm(
      'Delete Group',
      'This action cannot be undone. All posts and data will be permanently deleted.'
    );
    if (!confirmed) return;

    try {
      // Delete the group document
      await window.Firebase.db.collection('groups').doc(groupId).delete();

      // Delete associated conversation
      try {
        const convSnap = await window.Firebase.db
          .collection('conversations')
          .where('groupId', '==', groupId)
          .limit(1)
          .get();

        for (const doc of convSnap.docs) {
          await window.Firebase.db.collection('conversations').doc(doc.id).delete();
          // Delete messages subcollection
          const msgsSnap = await window.Firebase.db
            .collection('conversations').doc(doc.id).collection('messages')
            .get();
          const batch = window.Firebase.db.batch();
          msgsSnap.docs.forEach(m => batch.delete(m.ref));
          if (!msgsSnap.empty) await batch.commit();
        }
      } catch (_) {}

      u().showToast('Group deleted.', 'info');

      // Navigate back to groups list
      if (window.Router) {
        window.Router.navigate('groups', { _hash: '/groups' });
      }
    } catch (err) {
      console.error('[Groups] Error deleting group:', err);
      u().showToast('Failed to delete group.', 'error');
    }
  }

  /**
   * Remove a member from a group (admin only).
   */
  async function handleRemoveMember(groupId, userId) {
    const user = currentUser();
    if (!user || !groupId || !userId) return;

    if (userId === user.uid) {
      u().showToast("You can't remove yourself.", 'warning');
      return;
    }

    const confirmed = await u().showConfirm('Remove Member', 'Are you sure you want to remove this member?');
    if (!confirmed) return;

    try {
      await window.Firebase.db.collection('groups').doc(groupId).update({
        members: firebase.firestore.FieldValue.arrayRemove(userId),
        memberCount: firebase.firestore.FieldValue.increment(-1)
      });

      // Remove from admins if they were one
      try {
        await window.Firebase.db.collection('groups').doc(groupId).update({
          admins: firebase.firestore.FieldValue.arrayRemove(userId)
        });
      } catch (_) {}

      u().showToast('Member removed.', 'info');

      // Re-render the group page
      if (window.Router && window.Router.getCurrentPage() === 'group') {
        const params = window.Router.getParams();
        const html = await renderGroupPage(params);
        document.getElementById('page-content').innerHTML = html;
        afterGroupPageRender(params);
      }
    } catch (err) {
      console.error('[Groups] Error removing member:', err);
      u().showToast('Failed to remove member.', 'error');
    }
  }

  /**
   * Promote a member to admin (admin only).
   */
  async function handlePromoteMember(groupId, userId) {
    const user = currentUser();
    if (!user || !groupId || !userId) return;

    try {
      await window.Firebase.db.collection('groups').doc(groupId).update({
        admins: firebase.firestore.FieldValue.arrayUnion(userId)
      });

      u().showToast('Member promoted to admin!', 'success');

      // Re-render the group page
      if (window.Router && window.Router.getCurrentPage() === 'group') {
        const params = window.Router.getParams();
        const html = await renderGroupPage(params);
        document.getElementById('page-content').innerHTML = html;
        afterGroupPageRender(params);
      }
    } catch (err) {
      console.error('[Groups] Error promoting member:', err);
      u().showToast('Failed to promote member.', 'error');
    }
  }

  // ── Groups List Page Render ────────────────────────────────────────────────

  /**
   * Render the groups list page (My Groups / Discover / Create tabs).
   * @param {Object} params - Route parameters.
   * @returns {Promise<string>} HTML string.
   */
  async function render(params) {
    const user = currentUser();
    if (!user) {
      return `<div class="error-page"><p>Please sign in to view groups.</p></div>`;
    }

    const util = u();
    const activeTab = params?.tab || _activeTab;

    let tabContentHtml = '';

    if (activeTab === 'my-groups') {
      tabContentHtml = `
        <div id="my-groups-list" class="groups-list">
          <div class="loading-indicator"><span class="spinner"></span></div>
        </div>`;
    } else if (activeTab === 'discover') {
      tabContentHtml = `
        <div id="discover-groups-list" class="groups-list">
          <div class="loading-indicator"><span class="spinner"></span></div>
        </div>`;
    } else if (activeTab === 'create') {
      tabContentHtml = renderCreateTab();
    }

    const html = `
      <div class="groups-page" id="groups-page">
        <!-- Search Bar -->
        <div class="groups-search-bar">
          <div class="search-input-wrap">
            <span class="search-icon">🔍</span>
            <input type="text" id="groups-search-input" placeholder="Search groups..." autocomplete="off">
            <button class="search-clear-btn hidden" id="groups-search-clear">&times;</button>
          </div>
        </div>

        <!-- Tabs -->
        <div class="groups-tabs">
          <button class="groups-tab ${activeTab === 'my-groups' ? 'active' : ''}" data-groups-tab="my-groups">
            My Groups
          </button>
          <button class="groups-tab ${activeTab === 'discover' ? 'active' : ''}" data-groups-tab="discover">
            Discover
          </button>
          <button class="groups-tab ${activeTab === 'create' ? 'active' : ''}" data-groups-tab="create">
            Create
          </button>
        </div>

        <!-- Tab Content -->
        <div class="groups-tab-content">
          ${tabContentHtml}
        </div>
      </div>`;

    return html;
  }

  /**
   * Render the "Create Group" tab form.
   */
  function renderCreateTab() {
    const util = u();
    return `
      <div class="create-group-form" id="create-group-form">
        <div class="form-group">
          <label for="group-name-input">Group Name *</label>
          <input type="text" id="group-name-input" placeholder="e.g. Photography Club" maxlength="60" required>
        </div>
        <div class="form-group">
          <label for="group-desc-input">Description</label>
          <textarea id="group-desc-input" placeholder="What's this group about?" maxlength="500" rows="3"></textarea>
          <span class="char-count"><span id="group-desc-count">0</span>/500</span>
        </div>
        <div class="form-group">
          <label>Group Avatar</label>
          <div class="avatar-upload" id="group-avatar-upload">
            <div class="avatar-preview" id="group-avatar-preview">
              <span class="avatar-placeholder">📷</span>
            </div>
            <button type="button" class="btn btn-outline btn-sm" id="group-avatar-btn">Choose Photo</button>
            <input type="file" id="group-avatar-input" accept="image/*" class="hidden">
          </div>
        </div>
        <button class="btn btn-primary btn-full" id="create-group-submit-btn">
          <span class="btn-text">Create Group</span>
          <span class="btn-loader hidden"><span class="spinner"></span></span>
        </button>
      </div>`;
  }

  // ── Group Detail Page Render ───────────────────────────────────────────────

  /**
   * Render a single group page.
   * @param {Object} params - Must include groupId.
   * @returns {Promise<string>} HTML string.
   */
  async function renderGroupPage(params) {
    const user = currentUser();
    if (!user) {
      return `<div class="error-page"><p>Please sign in to view this group.</p></div>`;
    }

    const groupId = params?.groupId;
    if (!groupId) {
      return `<div class="error-page"><h2>Group not found</h2>
        <button class="btn btn-primary" onclick="window.Router.navigate('groups')">Browse Groups</button></div>`;
    }

    const util = u();
    const db = window.Firebase.db;

    // Fetch group doc
    let groupDoc;
    try {
      const doc = await db.collection('groups').doc(groupId).get();
      if (!doc.exists) {
        return `<div class="error-page"><h2>Group not found</h2>
          <button class="btn btn-primary" onclick="window.Router.navigate('groups')">Browse Groups</button></div>`;
      }
      groupDoc = { id: doc.id, ...doc.data() };
      _groupData = groupDoc;
    } catch (err) {
      console.error('[Groups] Error fetching group:', err);
      return `<div class="error-page"><h2>Something went wrong</h2>
        <p>Failed to load group.</p>
        <button class="btn btn-primary" onclick="window.Router.navigate('groups')">Browse Groups</button></div>`;
    }

    // Determine membership and admin status
    _isMember = (groupDoc.members || []).includes(user.uid);
    _isAdmin = (groupDoc.admins || []).includes(user.uid);
    const isCreator = groupDoc.createdBy === user.uid;

    // Set active tab from params
    _groupTab = params?.tab || 'posts';

    // Render group header
    const avatarHtml = groupDoc.groupAvatarUrl
      ? `<img src="${util.sanitizeHTML(groupDoc.groupAvatarUrl)}" alt="" class="group-page-avatar">`
      : `<div class="group-page-avatar avatar-placeholder">${util.getInitials(groupDoc.name)}</div>`;

    // Action buttons
    let actionButtonsHtml = '';
    if (_isMember) {
      actionButtonsHtml = `
        <button class="btn btn-ghost" id="leave-group-btn">Leave Group</button>
        <button class="btn btn-outline" id="share-group-btn">Share</button>`;
    } else {
      actionButtonsHtml = `
        <button class="btn btn-primary" id="join-group-btn">Join Group</button>
        <button class="btn btn-outline" id="share-group-btn">Share</button>`;
    }

    // Admin section
    let adminSectionHtml = '';
    if (_isAdmin || isCreator) {
      adminSectionHtml = `
        <div class="admin-section">
          <button class="btn btn-outline btn-sm" id="edit-group-btn">Edit Group</button>
          <button class="btn btn-outline btn-sm" id="manage-members-btn">Manage Members</button>
          ${isCreator ? `<button class="btn btn-danger btn-sm" id="delete-group-btn">Delete Group</button>` : ''}
        </div>`;
    }

    // Tab content (loading state)
    let tabContentHtml = '<div class="loading-indicator"><span class="spinner"></span></div>';

    const html = `
      <div class="group-page" id="group-page" data-group-id="${groupId}">
        <!-- Group Header -->
        <div class="group-page-header">
          <div class="group-page-header-top">
            ${avatarHtml}
            <div class="group-page-info">
              <h1 class="group-page-name">${util.sanitizeHTML(groupDoc.name || 'Untitled Group')}</h1>
              <div class="group-page-meta">
                <span>👥 ${util.formatNumber(groupDoc.memberCount || 0)} members</span>
                <span>•</span>
                <span>${groupDoc.isPublic !== false ? '🌐 Public' : '🔒 Private'}</span>
              </div>
            </div>
          </div>
          ${groupDoc.description ? `<p class="group-page-description">${util.sanitizeHTML(groupDoc.description)}</p>` : ''}
          <div class="group-page-actions">
            ${actionButtonsHtml}
          </div>
          ${adminSectionHtml}
        </div>

        <!-- Tabs -->
        <div class="group-page-tabs">
          <button class="group-tab ${_groupTab === 'posts' ? 'active' : ''}" data-group-tab="posts">Posts</button>
          <button class="group-tab ${_groupTab === 'members' ? 'active' : ''}" data-group-tab="members">Members</button>
          <button class="group-tab ${_groupTab === 'media' ? 'active' : ''}" data-group-tab="media">Media</button>
        </div>

        <!-- Tab Content -->
        <div class="group-tab-content" id="group-tab-content">
          ${tabContentHtml}
        </div>
      </div>`;

    return html;
  }

  // ── Tab Content Renderers (called after main render) ───────────────────────

  /**
   * Load and render group posts tab.
   */
  async function renderGroupPostsTab(groupId) {
    const container = document.getElementById('group-tab-content');
    if (!container) return;

    const user = currentUser();
    const posts = await loadGroupPosts(groupId);

    if (posts.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <span class="empty-icon">📝</span>
          <h3>No posts yet</h3>
          <p>Be the first to post in this group!</p>
        </div>`;
      return;
    }

    container.innerHTML = posts.map(post => c().renderPostCard(post, user)).join('');
  }

  /**
   * Load and render group members tab.
   */
  async function renderGroupMembersTab(groupId) {
    const container = document.getElementById('group-tab-content');
    if (!container) return;

    const members = await loadGroupMembers(groupId);
    _groupMembers = members;

    if (members.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <span class="empty-icon">👥</span>
          <h3>No members yet</h3>
        </div>`;
      return;
    }

    const util = u();
    const html = members.map(member => {
      const avatarHtml = member.avatarUrl
        ? `<img src="${util.sanitizeHTML(member.avatarUrl)}" alt="" class="avatar">`
        : `<div class="avatar avatar-placeholder">${util.getInitials(member.displayName)}</div>`;

      const roleBadge = member.isCreator
        ? '<span class="role-badge role-creator">Creator</span>'
        : member.isAdmin
          ? '<span class="role-badge role-admin">Admin</span>'
          : '<span class="role-badge role-member">Member</span>';

      return `
        <div class="member-item" data-user-id="${member.uid}">
          ${avatarHtml}
          <div class="member-info">
            <span class="member-name">${util.sanitizeHTML(member.displayName || 'Unknown')}</span>
            ${member.username ? `<span class="member-username">@${util.sanitizeHTML(member.username)}</span>` : ''}
            ${roleBadge}
          </div>
          ${renderMemberActions(member)}
        </div>`;
    }).join('');

    container.innerHTML = `<div class="members-list">${html}</div>`;
  }

  /**
   * Render admin action buttons for a group member.
   */
  function renderMemberActions(member) {
    if (!_isAdmin && _groupData?.createdBy !== currentUser()?.uid) return '';
    if (member.uid === currentUser()?.uid) return '';

    let actions = '';

    if (member.isCreator) {
      // Can't do anything to the creator
      return '';
    }

    if (!member.isAdmin) {
      actions += `<button class="btn btn-outline btn-sm promote-member-btn" data-user-id="${member.uid}" title="Promote to admin">⬆️ Promote</button>`;
    }

    actions += `<button class="btn btn-danger btn-sm remove-member-btn" data-user-id="${member.uid}" title="Remove member">✕</button>`;

    return `<div class="member-actions">${actions}</div>`;
  }

  /**
   * Load and render group media tab (grid of images from posts).
   */
  async function renderGroupMediaTab(groupId) {
    const container = document.getElementById('group-tab-content');
    if (!container) return;

    try {
      const snap = await window.Firebase.db
        .collection('posts')
        .where('groupId', '==', groupId)
        .where('imageUrl', '!=', null)
        .orderBy('createdAt', 'desc')
        .limit(30)
        .get();

      if (snap.empty) {
        container.innerHTML = `
          <div class="empty-state" style="padding:40px 20px;">
            <span class="empty-icon">🖼️</span>
            <h3>No media yet</h3>
            <p>Photos posted in this group will appear here.</p>
          </div>`;
        return;
      }

      const util = u();
      const html = snap.docs.map(doc => {
        const data = doc.data();
        return `
          <div class="explore-grid-item" data-post-id="${doc.id}">
            <img src="${util.sanitizeHTML(data.imageUrl)}" alt="" loading="lazy"
                 onclick="window.openImageViewer && window.openImageViewer('${util.sanitizeHTML(data.imageUrl)}')">
          </div>`;
      }).join('');

      container.innerHTML = `<div class="explore-grid">${html}</div>`;
    } catch (err) {
      console.error('[Groups] Error loading group media:', err);
      container.innerHTML = `<div class="error-page"><p>Failed to load media.</p></div>`;
    }
  }

  // ── After-Render Hooks ─────────────────────────────────────────────────────

  /**
   * Attach listeners after groups list page renders.
   */
  function afterRender(params) {
    const activeTab = params?.tab || _activeTab;

    // Tab switching
    document.querySelectorAll('[data-groups-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        _activeTab = tab.dataset.groupsTab;
        // Update active state
        document.querySelectorAll('[data-groups-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Render the tab content
        const contentEl = document.querySelector('.groups-tab-content');
        if (!contentEl) return;

        if (_activeTab === 'my-groups') {
          contentEl.innerHTML = '<div class="loading-indicator"><span class="spinner"></span></div>';
          loadAndRenderMyGroups();
        } else if (_activeTab === 'discover') {
          contentEl.innerHTML = '<div class="loading-indicator"><span class="spinner"></span></div>';
          loadAndRenderDiscoverGroups();
        } else if (_activeTab === 'create') {
          contentEl.innerHTML = renderCreateTab();
          initCreateForm();
        }
      });
    });

    // Load initial tab data
    if (activeTab === 'my-groups') {
      loadAndRenderMyGroups();
    } else if (activeTab === 'discover') {
      loadAndRenderDiscoverGroups();
    } else if (activeTab === 'create') {
      initCreateForm();
    }

    // Search input
    const searchInput = document.getElementById('groups-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        const clearBtn = document.getElementById('groups-search-clear');
        if (clearBtn) clearBtn.classList.toggle('hidden', !query);

        clearTimeout(_searchTimeout);
        _searchTimeout = setTimeout(() => {
          filterGroupsList(query);
        }, 300);
      });
    }

    const clearBtn = document.getElementById('groups-search-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        const searchInput = document.getElementById('groups-search-input');
        if (searchInput) {
          searchInput.value = '';
          searchInput.dispatchEvent(new Event('input'));
        }
      });
    }
  }

  /**
   * Attach listeners after group detail page renders.
   */
  function afterGroupPageRender(params) {
    const groupId = params?.groupId;
    if (!groupId) return;

    // Join / Leave buttons
    const joinBtn = document.getElementById('join-group-btn');
    if (joinBtn) {
      joinBtn.addEventListener('click', () => handleJoinGroup(groupId));
    }

    const leaveBtn = document.getElementById('leave-group-btn');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', () => handleLeaveGroup(groupId));
    }

    // Share button
    const shareBtn = document.getElementById('share-group-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const url = `${window.location.origin}${window.location.pathname}#/group/${groupId}`;
        const ok = await u().copyToClipboard(url);
        if (ok) {
          u().showToast('Group link copied!', 'success');
        }
      });
    }

    // Admin buttons
    const deleteBtn = document.getElementById('delete-group-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => handleDeleteGroup(groupId));
    }

    // Tab switching
    document.querySelectorAll('[data-group-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        _groupTab = tab.dataset.groupTab;
        document.querySelectorAll('[data-group-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const container = document.getElementById('group-tab-content');
        if (!container) return;
        container.innerHTML = '<div class="loading-indicator"><span class="spinner"></span></div>';

        if (_groupTab === 'posts') {
          renderGroupPostsTab(groupId);
        } else if (_groupTab === 'members') {
          renderGroupMembersTab(groupId);
        } else if (_groupTab === 'media') {
          renderGroupMediaTab(groupId);
        }
      });
    });

    // Load initial tab
    const container = document.getElementById('group-tab-content');
    if (container) {
      container.innerHTML = '<div class="loading-indicator"><span class="spinner"></span></div>';

      if (_groupTab === 'posts') {
        renderGroupPostsTab(groupId);
      } else if (_groupTab === 'members') {
        renderGroupMembersTab(groupId);
      } else if (_groupTab === 'media') {
        renderGroupMediaTab(groupId);
      }
    }
  }

  // ── Groups List Helpers ────────────────────────────────────────────────────

  /**
   * Load and render my groups into the list.
   */
  async function loadAndRenderMyGroups() {
    const container = document.getElementById('my-groups-list');
    if (!container) return;

    const groups = await loadMyGroups();

    if (groups.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <span class="empty-icon">👥</span>
          <h3>No groups yet</h3>
          <p>Discover and join groups, or create your own!</p>
          <button class="btn btn-primary" id="go-to-discover-groups-btn">Discover Groups</button>
        </div>`;

      const discoverBtn = document.getElementById('go-to-discover-groups-btn');
      if (discoverBtn) {
        discoverBtn.addEventListener('click', () => {
          const tab = document.querySelector('[data-groups-tab="discover"]');
          if (tab) tab.click();
        });
      }
      return;
    }

    container.innerHTML = groups.map(g => c().renderGroupCard(g)).join('');
  }

  /**
   * Load and render discover groups into the list.
   */
  async function loadAndRenderDiscoverGroups() {
    const container = document.getElementById('discover-groups-list');
    if (!container) return;

    const groups = await loadDiscoverGroups();

    if (groups.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <span class="empty-icon">🔍</span>
          <h3>No new groups to discover</h3>
          <p>You've joined all available groups or none exist yet.</p>
          <button class="btn btn-primary" id="go-to-create-group-btn">Create a Group</button>
        </div>`;

      const createBtn = document.getElementById('go-to-create-group-btn');
      if (createBtn) {
        createBtn.addEventListener('click', () => {
          const tab = document.querySelector('[data-groups-tab="create"]');
          if (tab) tab.click();
        });
      }
      return;
    }

    container.innerHTML = groups.map(g => c().renderGroupCard(g)).join('');
  }

  /**
   * Filter the currently visible groups list by search query.
   */
  function filterGroupsList(query) {
    const listId = _activeTab === 'my-groups' ? 'my-groups-list' : 'discover-groups-list';
    const container = document.getElementById(listId);
    if (!container) return;

    const cards = container.querySelectorAll('.group-card');
    cards.forEach(card => {
      const name = (card.querySelector('.group-name')?.textContent || '').toLowerCase();
      const desc = (card.querySelector('.group-desc')?.textContent || '').toLowerCase();
      const matches = !query || name.includes(query) || desc.includes(query);
      card.style.display = matches ? '' : 'none';
    });
  }

  // ── Create Group Form ──────────────────────────────────────────────────────

  /**
   * Initialize the create group form listeners.
   */
  function initCreateForm() {
    const nameInput = document.getElementById('group-name-input');
    const descInput = document.getElementById('group-desc-input');
    const descCount = document.getElementById('group-desc-count');
    const avatarBtn = document.getElementById('group-avatar-btn');
    const avatarInput = document.getElementById('group-avatar-input');
    const avatarPreview = document.getElementById('group-avatar-preview');
    const submitBtn = document.getElementById('create-group-submit-btn');
    const form = document.getElementById('create-group-form');

    if (!form) return;

    // Description char count
    if (descInput && descCount) {
      descInput.addEventListener('input', () => {
        descCount.textContent = descInput.value.length;
      });
    }

    // Avatar upload
    if (avatarBtn && avatarInput) {
      avatarBtn.addEventListener('click', () => avatarInput.click());

      avatarInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
          const base64 = await u().compressImage(file, 400, 0.8);
          if (avatarPreview) {
            avatarPreview.innerHTML = `<img src="${base64}" alt="Group avatar" class="avatar-preview-img">`;
          }
          // Store the base64 data for submission
          avatarPreview.dataset.avatarData = base64;
          u().showToast('Photo selected!', 'success');
        } catch (err) {
          u().showToast('Failed to process image.', 'error');
        }
      });
    }

    // Submit
    if (submitBtn) {
      submitBtn.addEventListener('click', async (e) => {
        e.preventDefault();

        if (!nameInput?.value.trim()) {
          u().showToast('Please enter a group name.', 'warning');
          nameInput?.focus();
          return;
        }

        submitBtn.disabled = true;
        const textEl = submitBtn.querySelector('.btn-text');
        const loaderEl = submitBtn.querySelector('.btn-loader');
        if (textEl) textEl.classList.add('hidden');
        if (loaderEl) loaderEl.classList.remove('hidden');

        const avatarData = avatarPreview?.dataset?.avatarData || null;

        const result = await handleCreateGroup({
          name: nameInput.value,
          description: descInput?.value || '',
          avatarUrl: avatarData
        });

        submitBtn.disabled = false;
        if (textEl) textEl.classList.remove('hidden');
        if (loaderEl) loaderEl.classList.add('hidden');

        if (result) {
          // Navigate to the new group page
          if (window.Router) {
            window.Router.navigate('group', {
              groupId: result.id,
              _hash: `/group/${result.id}`
            });
          }
        }
      });
    }
  }

  // ── Event Delegation ──────────────────────────────────────────────────────

  function handleGroupsClicks(e) {
    const target = e.target;

    // Group card clicks
    const groupCard = target.closest('.group-card[data-group-id]');
    if (groupCard) {
      const groupId = groupCard.dataset.groupId;
      if (groupId && window.Router) {
        window.Router.navigate('group', { groupId, _hash: `/group/${groupId}` });
      }
      return;
    }

    // Member clicks -> navigate to user profile
    const memberItem = target.closest('.member-item[data-user-id]');
    if (memberItem && !target.closest('.member-actions')) {
      const userId = memberItem.dataset.userId;
      if (userId && window.Router) {
        window.Router.navigate('user-profile', { userId, _hash: `/user/${userId}` });
      }
      return;
    }

    // Post clicks within group page
    const postCard = target.closest('.post-card[data-post-id]');
    if (postCard) {
      if (target.closest('.post-action-btn') || target.closest('.comment-action-btn')) return;
      const postId = postCard.dataset.postId;
      if (postId && window.Router) {
        window.Router.navigate('post-detail', { postId, _hash: `/post/${postId}` });
      }
      return;
    }

    // Promote member button
    const promoteBtn = target.closest('.promote-member-btn');
    if (promoteBtn) {
      const groupId = _groupData?.id;
      const userId = promoteBtn.dataset.userId;
      if (groupId && userId) {
        handlePromoteMember(groupId, userId);
      }
      return;
    }

    // Remove member button
    const removeBtn = target.closest('.remove-member-btn');
    if (removeBtn) {
      const groupId = _groupData?.id;
      const userId = removeBtn.dataset.userId;
      if (groupId && userId) {
        handleRemoveMember(groupId, userId);
      }
      return;
    }

    // Post author clicks
    const postAuthor = target.closest('.post-author[data-user-id]');
    if (postAuthor) {
      const userId = postAuthor.dataset.userId;
      if (userId && window.Router) {
        window.Router.navigate('user-profile', { userId, _hash: `/user/${userId}` });
      }
      return;
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────

  function init() {
    // Listen for clicks within groups pages via delegation
    document.addEventListener('click', (e) => {
      const groupsPage = document.getElementById('groups-page');
      const groupPage = document.getElementById('group-page');

      if ((groupsPage && groupsPage.contains(e.target)) ||
          (groupPage && groupPage.contains(e.target))) {
        handleGroupsClicks(e);
      }
    });

    // After page renders, attach specific listeners
    window.addEventListener('pageChange', (e) => {
      if (e.detail.page === 'groups') {
        afterRender(e.detail.params);
      } else if (e.detail.page === 'group') {
        afterGroupPageRender(e.detail.params);
      } else if (e.detail.page === 'create-group') {
        afterCreateGroupPageRender();
      }
    });
  }

  // ── Standalone Create Group Page Handler ──────────────────────────────────

  function afterCreateGroupPageRender() {
    const form = document.getElementById('create-group-form');
    if (!form) return;

    const descInput = document.getElementById('cg-desc');
    const descCount = document.getElementById('cg-desc-count');
    if (descInput && descCount) {
      descInput.addEventListener('input', () => { descCount.textContent = descInput.value.length; });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('cg-name')?.value?.trim();
      if (!name) { u().showToast('Enter a group name', 'warning'); return; }

      const btn = document.getElementById('cg-submit-btn');
      if (btn) btn.disabled = true;

      let avatarUrl = null;
      const avatarFile = document.getElementById('cg-avatar')?.files?.[0];
      if (avatarFile) {
        try { avatarUrl = await u().compressImage(avatarFile, 400, 0.8); } catch (_) {}
      }

      const result = await handleCreateGroup({
        name,
        description: descInput?.value || '',
        avatarUrl
      });

      if (btn) btn.disabled = false;
      if (result) Router.navigate('group', { groupId: result });
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Render the "Create Group" page as a standalone route.
   */
  async function renderCreateGroup() {
    return `
      <div id="create-group-page" style="padding:16px">
        <h2 style="font-size:20px;font-weight:700;margin-bottom:20px">Create a Group</h2>
        <form id="create-group-form" style="display:flex;flex-direction:column;gap:14px">
          <div class="form-group">
            <label>Group Name</label>
            <input type="text" id="cg-name" placeholder="e.g. Study Group" required>
          </div>
          <div class="form-group">
            <label>Description</label>
            <textarea id="cg-desc" placeholder="What's this group about?" rows="3" maxlength="300"></textarea>
            <span class="char-count"><span id="cg-desc-count">0</span>/300</span>
          </div>
          <div class="form-group">
            <label>Cover Image (optional)</label>
            <input type="file" id="cg-avatar" accept="image/*" style="font-size:14px">
          </div>
          <button type="submit" class="btn btn-primary btn-full" id="cg-submit-btn">
            <span class="btn-text">Create Group</span>
            <span class="btn-loader hidden"><span class="spinner"></span></span>
          </button>
        </form>
      </div>`;
  }

  window.Groups = {
    init,
    render,
    renderGroupPage,
    renderCreateGroup,
    loadMyGroups,
    loadDiscoverGroups,
    loadGroupPosts,
    loadGroupMembers,
    handleJoinGroup,
    handleLeaveGroup,
    handleCreateGroup,
    handleDeleteGroup,
    handleRemoveMember,
    handlePromoteMember
  };
})();