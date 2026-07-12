/**
 * GIOLYNK - Profile Module
 * Renders user profile, edit-profile, and friends pages.
 * Uses Firebase compat SDK via window.Firebase references.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _activeTab = 'posts';
  let _editAvatarDataUrl = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function currentUser() {
    return window.Auth && window.Auth.getCurrentUser();
  }

  /**
   * XP thresholds per reputation level.
   */
  const LEVEL_THRESHOLDS = [0, 100, 300, 600, 1000, 1500, 2200, 3000, 4000, 5200, 6600, 8200, 10000, 12500, 15500, 19000, 23000, 28000, 34000, 42000];

  function getLevelInfo(level, xp) {
    const currentThreshold = LEVEL_THRESHOLDS[Math.min(level - 1, LEVEL_THRESHOLDS.length - 1)] || 0;
    const nextThreshold = LEVEL_THRESHOLDS[Math.min(level, LEVEL_THRESHOLDS.length - 1)] || (currentThreshold + 1000);
    const progress = nextThreshold > currentThreshold
      ? Math.min(((xp - currentThreshold) / (nextThreshold - currentThreshold)) * 100, 100)
      : 100;
    const xpToNext = Math.max(nextThreshold - xp, 0);
    return { currentThreshold, nextThreshold, progress: Math.round(progress), xpToNext };
  }

  /**
   * Default badge catalog.
   */
  const DEFAULT_BADGES = [
    { id: 'first_post',    name: 'First Post',       icon: '\uD83D\uDCDD', description: 'Created your first post' },
    { id: 'social',        name: 'Social Butterfly',  icon: '\uD83E\uDD8D', description: 'Made 10 friends' },
    { id: 'helpful',       name: 'Helpful',           icon: '\uD83C\uDF1F', description: 'Got 50 likes on a post' },
    { id: 'active',        name: 'Active User',       icon: '\uD83D\uDD25', description: 'Logged in 7 days in a row' },
    { id: 'early_adopter', name: 'Early Adopter',     icon: '\uD83D\uDE80', description: 'Joined in the first month' },
    { id: 'commenter',     name: 'Chatterbox',        icon: '\uD83D\uDCAC', description: 'Wrote 100 comments' },
    { id: 'poll_master',   name: 'Poll Master',       icon: '\uD83D\uDCCA', description: 'Created 10 polls' },
    { id: 'legend',        name: 'Legend',            icon: '\uD83C\uDFC6', description: 'Reached level 20' }
  ];

  /**
   * Default achievements.
   */
  const DEFAULT_ACHIEVEMENTS = [
    { id: 'week_streak',    name: '7-Day Streak',      icon: '\uD83D\uDD25', description: 'Active for 7 consecutive days', xpReward: 50 },
    { id: 'month_streak',   name: '30-Day Streak',     icon: '\u2B50',      description: 'Active for 30 consecutive days', xpReward: 200 },
    { id: 'posts_10',       name: '10 Posts',           icon: '\u270D\uFE0F', description: 'Published 10 posts', xpReward: 100 },
    { id: 'posts_50',       name: '50 Posts',           icon: '\uD83D\uDCDD', description: 'Published 50 posts', xpReward: 500 },
    { id: 'likes_100',      name: '100 Likes Received', icon: '\u2764\uFE0F', description: 'Your posts got 100 likes total', xpReward: 150 },
    { id: 'friends_5',      name: '5 Friends',          icon: '\uD83E\uDD1D', description: 'Made 5 friends', xpReward: 75 },
    { id: 'friends_25',     name: '25 Friends',         icon: '\uD83C\uDF89', description: 'Made 25 friends', xpReward: 300 },
    { id: 'top_post',       name: 'Top Post',           icon: '\uD83C\uDF1F', description: 'A post got 100+ likes', xpReward: 500 }
  ];

  // ── Data Loaders ──────────────────────────────────────────────────────────

  /**
   * Fetch a user profile from Firestore, including school name.
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async function loadUserProfile(userId) {
    try {
      const doc = await window.Firebase.db.collection('users').doc(userId).get();
      if (!doc.exists) return null;

      const data = doc.data();
      let schoolName = '';

      if (data.schoolId) {
        try {
          const schoolDoc = await window.Firebase.db.collection('schools').doc(data.schoolId).get();
          if (schoolDoc.exists) {
            schoolName = schoolDoc.data().name || '';
          }
        } catch (_) {}
      }

      return {
        uid: doc.id,
        ...data,
        schoolName
      };
    } catch (err) {
      console.error('[Profile] loadUserProfile error:', err);
      return null;
    }
  }

  /**
   * Load a user's posts.
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async function loadUserPosts(userId) {
    try {
      const snap = await window.Firebase.db
        .collection('posts')
        .where('authorId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();

      const posts = [];
      for (const doc of snap.docs) {
        const data = doc.data();
        const author = {
          uid: userId,
          displayName: data.authorName || '',
          avatarUrl: data.authorAvatar || null
        };

        let likes = [];
        let savedBy = [];
        const me = currentUser();

        try {
          const likesSnap = await window.Firebase.db
            .collection('posts').doc(doc.id).collection('likes').limit(200).get();
          likes = likesSnap.docs.map(l => l.id);
        } catch (_) {}

        try {
          const savedDoc = await window.Firebase.db
            .collection('posts').doc(doc.id).collection('savedPosts').doc(me?.uid || '').get();
          if (savedDoc.exists) savedBy = [me.uid];
        } catch (_) {}

        posts.push({
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
          author,
          likes,
          savedBy
        });
      }
      return posts;
    } catch (err) {
      console.error('[Profile] loadUserPosts error:', err);
      return [];
    }
  }

  /**
   * Load saved post IDs and then fetch those posts.
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async function loadSavedPosts(userId) {
    try {
      const savedSnap = await window.Firebase.db
        .collection('users').doc(userId).collection('savedPosts')
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();

      const posts = [];
      const me = currentUser();

      for (const savedDoc of savedSnap.docs) {
        const savedData = savedDoc.data();
        const postId = savedData.postId;
        if (!postId) continue;

        try {
          const postDoc = await window.Firebase.db.collection('posts').doc(postId).get();
          if (!postDoc.exists) continue;

          const data = postDoc.data();
          const author = await fetchAuthor(data.authorId);

          let likes = [];
          try {
            const likesSnap = await window.Firebase.db
              .collection('posts').doc(postId).collection('likes').limit(200).get();
            likes = likesSnap.docs.map(l => l.id);
          } catch (_) {}

          posts.push({
            id: postDoc.id,
            ...data,
            createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
            author,
            likes,
            savedBy: [userId]
          });
        } catch (_) {
          // Post may have been deleted
        }
      }
      return posts;
    } catch (err) {
      console.error('[Profile] loadSavedPosts error:', err);
      return [];
    }
  }

  /**
   * Fetch author data for a post.
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
          username: d.username || ''
        };
      }
    } catch (_) {}
    return { displayName: 'Unknown', avatarUrl: null };
  }

  /**
   * Load badges for a user.
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async function loadBadges(userId) {
    try {
      const doc = await window.Firebase.db.collection('users').doc(userId).get();
      if (!doc.exists) return DEFAULT_BADGES.map(b => ({ ...b, earned: false }));

      const userBadges = doc.data().badges || [];
      return DEFAULT_BADGES.map(badge => ({
        ...badge,
        earned: userBadges.includes(badge.id)
      }));
    } catch (err) {
      console.error('[Profile] loadBadges error:', err);
      return [];
    }
  }

  /**
   * Load achievements for a user.
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async function loadAchievements(userId) {
    try {
      const doc = await window.Firebase.db.collection('users').doc(userId).get();
      if (!doc.exists) return DEFAULT_ACHIEVEMENTS.map(a => ({ ...a, completed: false }));

      const userAchievements = doc.data().achievements || [];
      return DEFAULT_ACHIEVEMENTS.map(ach => ({
        ...ach,
        completed: userAchievements.includes(ach.id)
      }));
    } catch (err) {
      console.error('[Profile] loadAchievements error:', err);
      return [];
    }
  }

  /**
   * Check friendship status between current user and another user.
   * @param {string} otherUserId
   * @returns {Promise<string>} 'none' | 'friends' | 'sent' | 'received'
   */
  async function checkFriendshipStatus(otherUserId) {
    const me = currentUser();
    if (!me || otherUserId === me.uid) return 'none';

    try {
      // Check if they are friends
      const friendDoc = await window.Firebase.db
        .collection('users').doc(me.uid).collection('friends').doc(otherUserId).get();
      if (friendDoc.exists) return 'friends';

      // Check if we sent a request
      const sentDoc = await window.Firebase.db
        .collection('friendRequests')
        .where('fromId', '==', me.uid)
        .where('toId', '==', otherUserId)
        .where('status', '==', 'pending')
        .limit(1)
        .get();
      if (!sentDoc.empty) return 'sent';

      // Check if we received a request
      const receivedDoc = await window.Firebase.db
        .collection('friendRequests')
        .where('fromId', '==', otherUserId)
        .where('toId', '==', me.uid)
        .where('status', '==', 'pending')
        .limit(1)
        .get();
      if (!receivedDoc.empty) return 'received';

      return 'none';
    } catch (err) {
      console.error('[Profile] checkFriendshipStatus error:', err);
      return 'none';
    }
  }

  // ── Profile Renderers ─────────────────────────────────────────────────────

  /**
   * Render the current user's profile.
   * @param {Object} user
   * @returns {string} HTML
   */
  function renderOwnProfile(user) {
    const u = Utils;
    const levelInfo = getLevelInfo(user.level || 1, user.xp || 0);
    const displayName = user.displayName || '';
    const username = user.username ? `@${u.sanitizeHTML(user.username)}` : '';
    const bio = user.bio || 'No bio yet.';

    const avatarHtml = user.avatarUrl
      ? `<img src="${u.sanitizeHTML(user.avatarUrl)}" alt="${u.sanitizeHTML(displayName)}" class="profile-avatar">`
      : `<div class="profile-avatar avatar-placeholder">${u.getInitials(displayName)}</div>`;

    const coverStyle = user.coverUrl
      ? `background-image: url('${u.sanitizeHTML(user.coverUrl)}');`
      : 'background: linear-gradient(135deg, #00897B 0%, #4DB6AC 50%, #FFA040 100%);';

    return `
      <div class="profile-page">
        <div class="profile-cover" style="${coverStyle}">
          <div class="profile-avatar-wrapper">
            ${avatarHtml}
          </div>
        </div>

        <div class="profile-info">
          <h2 class="profile-name">${u.sanitizeHTML(displayName)}</h2>
          ${username ? `<span class="profile-username">${username}</span>` : ''}
          ${user.schoolName ? `<span class="profile-school">\uD83C\uDFEB ${u.sanitizeHTML(user.schoolName)}</span>` : ''}
          <p class="profile-bio">${u.sanitizeHTML(bio)}</p>
        </div>

        <div class="profile-stats">
          <div class="stat-item" data-tab="posts">
            <span class="stat-value">${u.formatNumber(user.postsCount || 0)}</span>
            <span class="stat-label">Posts</span>
          </div>
          <div class="stat-item" data-navigate="friends">
            <span class="stat-value">${u.formatNumber(user.friendsCount || 0)}</span>
            <span class="stat-label">Friends</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">Lv.${user.level || 1}</span>
            <span class="stat-label">Reputation</span>
          </div>
        </div>

        <div class="profile-actions">
          <button class="btn btn-primary btn-full" id="edit-profile-btn">\u270F\uFE0F Edit Profile</button>
          <button class="btn btn-outline btn-full" id="friends-btn">\uD83D\uDC65 Friends</button>
        </div>

        <!-- Reputation Bar -->
        <div class="reputation-section">
          <div class="rep-header">
            <span class="rep-level">Level ${user.level || 1}</span>
            <span class="rep-xp">${u.formatNumber(user.xp || 0)} XP</span>
          </div>
          <div class="rep-bar">
            <div class="rep-bar-fill" style="width:${levelInfo.progress}%"></div>
          </div>
          <span class="rep-hint">${levelInfo.xpToNext} XP to next level \u2022 \uD83D\uDCB0 ${u.formatNumber(user.coins || 0)} coins</span>
        </div>

        <!-- Badges Row -->
        <div class="badges-section">
          <h3 class="section-title">Badges</h3>
          <div class="badges-row" id="profile-badges">
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
          </div>
        </div>

        <!-- Tabs -->
        <div class="profile-tabs">
          <button class="profile-tab active" data-tab="posts">Posts</button>
          <button class="profile-tab" data-tab="saved">Saved</button>
          <button class="profile-tab" data-tab="badges">Badges</button>
          <button class="profile-tab" data-tab="achievements">Achievements</button>
        </div>

        <div class="profile-tab-content" id="profile-tab-content">
          <!-- Tab content loaded dynamically -->
          ${Components.renderSkeletonPost()}
          ${Components.renderSkeletonPost()}
        </div>
      </div>`;
  }

  /**
   * Render another user's profile.
   * @param {Object} user
   * @param {string} currentUserId
   * @param {string} friendStatus
   * @returns {string} HTML
   */
  function renderOtherProfile(user, currentUserId, friendStatus) {
    const u = Utils;
    const levelInfo = getLevelInfo(user.level || 1, user.xp || 0);
    const displayName = user.displayName || '';
    const username = user.username ? `@${u.sanitizeHTML(user.username)}` : '';
    const bio = user.bio || 'No bio yet.';

    const avatarHtml = user.avatarUrl
      ? `<img src="${u.sanitizeHTML(user.avatarUrl)}" alt="${u.sanitizeHTML(displayName)}" class="profile-avatar">`
      : `<div class="profile-avatar avatar-placeholder">${u.getInitials(displayName)}</div>`;

    const coverStyle = user.coverUrl
      ? `background-image: url('${u.sanitizeHTML(user.coverUrl)}');`
      : 'background: linear-gradient(135deg, #00897B 0%, #4DB6AC 50%, #FFA040 100%);';

    // Action buttons based on friendship status
    let actionsHtml = '';
    switch (friendStatus) {
      case 'friends':
        actionsHtml = `
          <button class="btn btn-outline btn-full" id="message-user-btn" data-user-id="${user.uid}">\uD83D\uDCAC Message</button>
          <button class="btn btn-ghost btn-full" id="remove-friend-btn" data-user-id="${user.uid}">\u274C Remove Friend</button>`;
        break;
      case 'sent':
        actionsHtml = `
          <button class="btn btn-outline btn-full" id="message-user-btn" data-user-id="${user.uid}">\uD83D\uDCAC Message</button>
          <button class="btn btn-ghost btn-full" id="cancel-request-btn" data-user-id="${user.uid}" disabled>\u23F3 Request Sent</button>`;
        break;
      case 'received':
        actionsHtml = `
          <button class="btn btn-primary btn-full" id="accept-friend-btn" data-user-id="${user.uid}">\u2705 Accept Request</button>
          <button class="btn btn-ghost btn-full" id="decline-friend-btn" data-user-id="${user.uid}">\u274C Decline</button>`;
        break;
      default:
        actionsHtml = `
          <button class="btn btn-primary btn-full" id="add-friend-btn" data-user-id="${user.uid}">\uD83E\uDD1D Add Friend</button>
          <button class="btn btn-outline btn-full" id="message-user-btn" data-user-id="${user.uid}">\uD83D\uDCAC Message</button>`;
    }

    return `
      <div class="profile-page">
        <div class="profile-cover" style="${coverStyle}">
          <div class="profile-avatar-wrapper">
            ${avatarHtml}
          </div>
        </div>

        <div class="profile-info">
          <h2 class="profile-name">${u.sanitizeHTML(displayName)}</h2>
          ${username ? `<span class="profile-username">${username}</span>` : ''}
          ${user.schoolName ? `<span class="profile-school">\uD83C\uDFEB ${u.sanitizeHTML(user.schoolName)}</span>` : ''}
          <p class="profile-bio">${u.sanitizeHTML(bio)}</p>
        </div>

        <div class="profile-stats">
          <div class="stat-item" data-tab="posts">
            <span class="stat-value">${u.formatNumber(user.postsCount || 0)}</span>
            <span class="stat-label">Posts</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${u.formatNumber(user.friendsCount || 0)}</span>
            <span class="stat-label">Friends</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">Lv.${user.level || 1}</span>
            <span class="stat-label">Reputation</span>
          </div>
        </div>

        <div class="profile-actions">
          ${actionsHtml}
        </div>

        <!-- Reputation Bar -->
        <div class="reputation-section">
          <div class="rep-header">
            <span class="rep-level">Level ${user.level || 1}</span>
            <span class="rep-xp">${u.formatNumber(user.xp || 0)} XP</span>
          </div>
          <div class="rep-bar">
            <div class="rep-bar-fill" style="width:${levelInfo.progress}%"></div>
          </div>
          <span class="rep-hint">\uD83D\uDCB0 ${u.formatNumber(user.coins || 0)} coins</span>
        </div>

        <!-- Badges Row -->
        <div class="badges-section">
          <h3 class="section-title">Badges</h3>
          <div class="badges-row" id="profile-badges">
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
            <div class="skeleton-badge"></div>
          </div>
        </div>

        <!-- Tabs -->
        <div class="profile-tabs">
          <button class="profile-tab active" data-tab="posts">Posts</button>
          <button class="profile-tab" data-tab="badges">Badges</button>
          <button class="profile-tab" data-tab="achievements">Achievements</button>
        </div>

        <div class="profile-tab-content" id="profile-tab-content">
          ${Components.renderSkeletonPost()}
          ${Components.renderSkeletonPost()}
        </div>
      </div>`;
  }

  // ── Tab Content Renderers ─────────────────────────────────────────────────

  async function loadTabContent(userId, tab) {
    const container = document.getElementById('profile-tab-content');
    if (!container) return;

    container.innerHTML = `
      <div class="tab-loading">
        <span class="spinner"></span>
      </div>`;

    try {
      switch (tab) {
        case 'posts': {
          const posts = await loadUserPosts(userId);
          const me = currentUser();
          if (posts.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No posts yet.</p></div>`;
          } else {
            container.innerHTML = posts.map(p => Components.renderPostCard(p, me)).join('');
            // Re-bind feed events on these posts
            if (window.Feed && window.Feed.bindPostEvents) {
              window.Feed.bindPostEvents();
            }
          }
          break;
        }
        case 'saved': {
          const posts = await loadSavedPosts(userId);
          const me = currentUser();
          if (posts.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No saved posts.</p></div>`;
          } else {
            container.innerHTML = posts.map(p => Components.renderPostCard(p, me)).join('');
            if (window.Feed && window.Feed.bindPostEvents) {
              window.Feed.bindPostEvents();
            }
          }
          break;
        }
        case 'badges': {
          const badges = await loadBadges(userId);
          if (badges.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No badges yet.</p></div>`;
          } else {
            container.innerHTML = `<div class="badges-grid">${badges.map(b => Components.renderBadge(b)).join('')}</div>`;
          }
          break;
        }
        case 'achievements': {
          const achievements = await loadAchievements(userId);
          if (achievements.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No achievements yet.</p></div>`;
          } else {
            container.innerHTML = achievements.map(a => {
              const completedClass = a.completed ? 'achievement-completed' : 'achievement-locked';
              return `
                <div class="achievement-item ${completedClass}" data-achievement-id="${a.id}">
                  <div class="achievement-icon">${a.icon}</div>
                  <div class="achievement-info">
                    <span class="achievement-name">${Utils.sanitizeHTML(a.name)}</span>
                    <span class="achievement-desc">${Utils.sanitizeHTML(a.description)}</span>
                    <span class="achievement-reward">+${a.xpReward} XP</span>
                  </div>
                  ${a.completed ? '<span class="achievement-done">\u2705</span>' : '<span class="achievement-locked-icon">\uD83D\uDD12</span>'}
                </div>`;
            }).join('');
          }
          break;
        }
      }
    } catch (err) {
      console.error('[Profile] Error loading tab content:', err);
      container.innerHTML = `<div class="empty-state"><p>Failed to load content.</p></div>`;
    }
  }

  /**
   * Load badges row (top section, just the icons).
   */
  async function loadBadgesRow(userId) {
    const container = document.getElementById('profile-badges');
    if (!container) return;

    try {
      const badges = await loadBadges(userId);
      const earnedBadges = badges.filter(b => b.earned);

      if (earnedBadges.length === 0) {
        container.innerHTML = `<span class="no-badges-text">No badges earned yet</span>`;
      } else {
        container.innerHTML = earnedBadges.map(b => `
          <div class="badge-circle" title="${Utils.sanitizeHTML(b.name)}: ${Utils.sanitizeHTML(b.description)}">
            <span class="badge-circle-icon">${b.icon}</span>
          </div>
        `).join('');
      }
    } catch (err) {
      console.error('[Profile] Error loading badges row:', err);
    }
  }

  // ── Action Handlers ───────────────────────────────────────────────────────

  function handleEditProfile() {
    Router.navigate('edit-profile');
  }

  /**
   * Send a friend request.
   */
  async function handleAddFriend(otherUserId) {
    const me = currentUser();
    if (!me || otherUserId === me.uid) return;

    try {
      await window.Firebase.db.collection('friendRequests').add({
        fromId: me.uid,
        toId: otherUserId,
        fromName: me.displayName || me.firstName || 'Someone',
        toName: '',
        status: 'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      Utils.showToast('Friend request sent!', 'success');

      // Update button UI
      const addBtn = document.getElementById('add-friend-btn');
      if (addBtn) {
        addBtn.textContent = '\u23F3 Request Sent';
        addBtn.disabled = true;
        addBtn.className = 'btn btn-ghost btn-full';
        addBtn.id = 'cancel-request-btn';
        addBtn.dataset.userId = otherUserId;
      }

      // Create notification
      const otherUser = await loadUserProfile(otherUserId);
      if (otherUser) {
        await window.Firebase.db.collection('notifications').add({
          type: 'friend_request',
          recipientId: otherUserId,
          actorId: me.uid,
          actorName: me.displayName || me.firstName || 'Someone',
          read: false,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[Profile] handleAddFriend error:', err);
      Utils.showToast('Failed to send friend request.', 'error');
    }
  }

  /**
   * Remove a friend.
   */
  async function handleRemoveFriend(otherUserId) {
    const me = currentUser();
    if (!me) return;

    const confirmed = await Utils.showConfirm(
      'Remove Friend',
      'Are you sure you want to remove this person from your friends?'
    );
    if (!confirmed) return;

    try {
      // Remove from both sides
      const batch = window.Firebase.db.batch();
      batch.delete(window.Firebase.db.collection('users').doc(me.uid).collection('friends').doc(otherUserId));
      batch.delete(window.Firebase.db.collection('users').doc(otherUserId).collection('friends').doc(me.uid));

      // Update friendsCount on both docs
      batch.update(window.Firebase.db.collection('users').doc(me.uid), {
        friendsCount: firebase.firestore.FieldValue.increment(-1)
      });
      batch.update(window.Firebase.db.collection('users').doc(otherUserId), {
        friendsCount: firebase.firestore.FieldValue.increment(-1)
      });

      await batch.commit();

      Utils.showToast('Friend removed.', 'info');

      // Refresh the profile page
      Router.navigate('user-profile', { userId: otherUserId }, true);
    } catch (err) {
      console.error('[Profile] handleRemoveFriend error:', err);
      Utils.showToast('Failed to remove friend.', 'error');
    }
  }

  /**
   * Accept a friend request.
   */
  async function handleAcceptFriend(requestId, fromUserId) {
    const me = currentUser();
    if (!me) return;

    try {
      const batch = window.Firebase.db.batch();

      // Add to both friends subcollections
      batch.set(window.Firebase.db.collection('users').doc(me.uid).collection('friends').doc(fromUserId), {
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      batch.set(window.Firebase.db.collection('users').doc(fromUserId).collection('friends').doc(me.uid), {
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Update request status
      batch.update(window.Firebase.db.collection('friendRequests').doc(requestId), {
        status: 'accepted',
        respondedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Increment friends count
      batch.update(window.Firebase.db.collection('users').doc(me.uid), {
        friendsCount: firebase.firestore.FieldValue.increment(1)
      });
      batch.update(window.Firebase.db.collection('users').doc(fromUserId), {
        friendsCount: firebase.firestore.FieldValue.increment(1)
      });

      await batch.commit();

      Utils.showToast('Friend request accepted!', 'success');
    } catch (err) {
      console.error('[Profile] handleAcceptFriend error:', err);
      Utils.showToast('Failed to accept request.', 'error');
    }
  }

  /**
   * Decline a friend request.
   */
  async function handleDeclineFriend(requestId) {
    try {
      await window.Firebase.db.collection('friendRequests').doc(requestId).update({
        status: 'declined',
        respondedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      Utils.showToast('Friend request declined.', 'info');
    } catch (err) {
      console.error('[Profile] handleDeclineFriend error:', err);
      Utils.showToast('Failed to decline request.', 'error');
    }
  }

  /**
   * Cancel a sent friend request.
   */
  async function handleCancelRequest(otherUserId) {
    const me = currentUser();
    if (!me) return;

    try {
      const snap = await window.Firebase.db
        .collection('friendRequests')
        .where('fromId', '==', me.uid)
        .where('toId', '==', otherUserId)
        .where('status', '==', 'pending')
        .limit(1)
        .get();

      if (!snap.empty) {
        await snap.docs[0].ref.update({
          status: 'cancelled',
          respondedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        Utils.showToast('Friend request cancelled.', 'info');
      }
    } catch (err) {
      console.error('[Profile] handleCancelRequest error:', err);
      Utils.showToast('Failed to cancel request.', 'error');
    }
  }

  /**
   * Message a user: check for existing conversation, navigate to it or create new.
   */
  async function handleMessage(otherUserId) {
    const me = currentUser();
    if (!me) return;

    try {
      // Look for an existing 1-on-1 conversation
      const convSnap = await window.Firebase.db
        .collection('conversations')
        .where('participants', 'array-contains', me.uid)
        .get();

      let existingConvId = null;
      for (const doc of convSnap.docs) {
        const data = doc.data();
        if (data.participants && data.participants.includes(otherUserId) && !data.isGroup) {
          existingConvId = doc.id;
          break;
        }
      }

      if (existingConvId) {
        Router.navigate('chat-view', { conversationId: existingConvId });
      } else {
        // Create a new conversation
        const otherUser = await loadUserProfile(otherUserId);
        const convRef = await window.Firebase.db.collection('conversations').add({
          participants: [me.uid, otherUserId],
          isGroup: false,
          lastMessage: null,
          unreadCount: 0,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        Router.navigate('chat-view', { conversationId: convRef.id });
      }
    } catch (err) {
      console.error('[Profile] handleMessage error:', err);
      Utils.showToast('Failed to open conversation.', 'error');
    }
  }

  // ── Edit Profile Render ───────────────────────────────────────────────────

  /**
   * Render the edit profile page.
   * @param {Object} params
   * @returns {Promise<string>}
   */
  async function editProfileRender(params) {
    const me = currentUser();
    if (!me) return '<div class="empty-state"><p>Please sign in.</p></div>';

    // Load fresh user data
    const user = await loadUserProfile(me.uid) || me;

    const avatarPreview = _editAvatarDataUrl || user.avatarUrl || '';
    const avatarHtml = avatarPreview
      ? `<img src="${Utils.sanitizeHTML(avatarPreview)}" alt="Avatar" class="edit-avatar-preview">`
      : `<div class="edit-avatar-preview avatar-placeholder">${Utils.getInitials(user.displayName)}</div>`;

    return `
      <div class="edit-profile-page">
        <div class="edit-avatar-section">
          ${avatarHtml}
          <div class="edit-avatar-actions">
            <button class="btn btn-outline btn-sm" id="change-avatar-btn">\uD83D\uDDBC\uFE0F Change Photo</button>
            <input type="file" id="edit-avatar-input" accept="image/*" class="hidden">
          </div>
          <div class="form-group" style="margin-top:12px;">
            <label for="edit-avatar-url">Or paste image URL</label>
            <input type="url" id="edit-avatar-url" placeholder="https://example.com/avatar.jpg" value="${Utils.sanitizeHTML(user.avatarUrl || '')}">
          </div>
        </div>

        <form id="edit-profile-form" class="edit-profile-form">
          <div class="form-row">
            <div class="form-group">
              <label for="edit-firstname">First Name</label>
              <input type="text" id="edit-firstname" value="${Utils.sanitizeHTML(user.firstName || '')}" required>
            </div>
            <div class="form-group">
              <label for="edit-lastname">Last Name</label>
              <input type="text" id="edit-lastname" value="${Utils.sanitizeHTML(user.lastName || '')}" required>
            </div>
          </div>

          <div class="form-group">
            <label for="edit-username">Username</label>
            <input type="text" id="edit-username" value="${Utils.sanitizeHTML(user.username || '')}" placeholder="Choose a unique username">
            <span class="form-hint" id="edit-username-hint"></span>
          </div>

          <div class="form-group">
            <label for="edit-bio">Bio</label>
            <textarea id="edit-bio" rows="3" maxlength="200" placeholder="Tell us about yourself...">${Utils.sanitizeHTML(user.bio || '')}</textarea>
            <span class="char-count"><span id="edit-bio-count">${(user.bio || '').length}</span>/200</span>
          </div>

          <button type="submit" class="btn btn-primary btn-full" id="save-profile-btn">
            <span class="btn-text">Save Changes</span>
            <span class="btn-loader hidden"><span class="spinner"></span></span>
          </button>
        </form>
      </div>`;
  }

  /**
   * Bind events for the edit profile page.
   */
  function bindEditProfileEvents() {
    // Avatar file upload
    const changeAvatarBtn = document.getElementById('change-avatar-btn');
    const avatarInput = document.getElementById('edit-avatar-input');
    const avatarUrlInput = document.getElementById('edit-avatar-url');

    if (changeAvatarBtn && avatarInput) {
      changeAvatarBtn.addEventListener('click', () => avatarInput.click());

      avatarInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
          Utils.showToast('Please select an image file.', 'warning');
          return;
        }

        try {
          const dataUrl = await Utils.compressImage(file, 400, 0.8);
          _editAvatarDataUrl = dataUrl;

          // Update preview
          const preview = document.querySelector('.edit-avatar-preview');
          if (preview) {
            preview.outerHTML = `<img src="${dataUrl}" alt="Avatar" class="edit-avatar-preview">`;
          }

          // Clear URL input since we're using file
          if (avatarUrlInput) avatarUrlInput.value = '';
        } catch (err) {
          console.error('[Profile] Error compressing avatar:', err);
          Utils.showToast('Failed to process image.', 'error');
        }
      });
    }

    // URL input clears file data
    if (avatarUrlInput) {
      avatarUrlInput.addEventListener('input', () => {
        const url = avatarUrlInput.value.trim();
        if (url) {
          _editAvatarDataUrl = null;
          const preview = document.querySelector('.edit-avatar-preview');
          if (preview) {
            preview.outerHTML = `<img src="${Utils.sanitizeHTML(url)}" alt="Avatar" class="edit-avatar-preview" onerror="this.outerHTML='<div class=\\'edit-avatar-preview avatar-placeholder\\'>?</div>'">`;
          }
        }
      });
    }

    // Bio character count
    const bioInput = document.getElementById('edit-bio');
    const bioCount = document.getElementById('edit-bio-count');
    if (bioInput && bioCount) {
      bioInput.addEventListener('input', () => {
        bioCount.textContent = bioInput.value.length;
      });
    }

    // Username availability check (debounced)
    const usernameInput = document.getElementById('edit-username');
    const usernameHint = document.getElementById('edit-username-hint');
    if (usernameInput && usernameHint) {
      usernameInput.addEventListener('input', Utils.debounce(async () => {
        const val = usernameInput.value.trim().toLowerCase();
        if (!val || val.length < 3) {
          usernameHint.textContent = val ? 'Username must be at least 3 characters.' : '';
          usernameHint.style.color = '';
          return;
        }

        // Validate format
        if (!/^[a-z0-9._]+$/.test(val)) {
          usernameHint.textContent = 'Only lowercase letters, numbers, dots, and underscores.';
          usernameHint.style.color = '#e74c3c';
          return;
        }

        try {
          const snap = await window.Firebase.db
            .collection('users')
            .where('username', '==', val)
            .limit(1)
            .get();

          const me = currentUser();
          const taken = !snap.empty && snap.docs[0].id !== me.uid;

          if (taken) {
            usernameHint.textContent = 'Username is already taken.';
            usernameHint.style.color = '#e74c3c';
          } else {
            usernameHint.textContent = 'Username is available!';
            usernameHint.style.color = '#2ecc71';
          }
        } catch (_) {
          usernameHint.textContent = '';
        }
      }, 500));
    }

    // Form submit
    const form = document.getElementById('edit-profile-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const saveBtn = document.getElementById('save-profile-btn');
        if (saveBtn) {
          saveBtn.disabled = true;
          const textEl = saveBtn.querySelector('.btn-text');
          const loaderEl = saveBtn.querySelector('.btn-loader');
          if (textEl) textEl.classList.add('hidden');
          if (loaderEl) loaderEl.classList.remove('hidden');
        }

        const firstName = document.getElementById('edit-firstname')?.value.trim();
        const lastName = document.getElementById('edit-lastname')?.value.trim();
        const username = document.getElementById('edit-username')?.value.trim().toLowerCase();
        const bio = document.getElementById('edit-bio')?.value.trim();
        const avatarUrl = avatarUrlInput?.value.trim() || null;

        // Determine final avatar
        let finalAvatarUrl = avatarUrl;
        if (_editAvatarDataUrl) {
          finalAvatarUrl = _editAvatarDataUrl;
        }

        // Validation
        if (!firstName || !lastName) {
          Utils.showToast('First and last name are required.', 'warning');
          if (saveBtn) {
            saveBtn.disabled = false;
            const textEl = saveBtn.querySelector('.btn-text');
            const loaderEl = saveBtn.querySelector('.btn-loader');
            if (textEl) textEl.classList.remove('hidden');
            if (loaderEl) loaderEl.classList.add('hidden');
          }
          return;
        }

        const me = currentUser();
        try {
          const updateData = {
            firstName,
            lastName,
            displayName: `${firstName} ${lastName}`,
            bio,
            avatarUrl: finalAvatarUrl
          };

          if (username && username.length >= 3) {
            updateData.username = username;
          }

          await window.Firebase.db.collection('users').doc(me.uid).update(updateData);

          // Update local user cache
          const updatedUser = { ...me, ...updateData };
          if (Auth.setCurrentUser) Auth.setCurrentUser(updatedUser);

          // Clear the edit avatar state
          _editAvatarDataUrl = null;

          Utils.showToast('Profile updated!', 'success');
          Router.navigate('profile');
        } catch (err) {
          console.error('[Profile] Error saving profile:', err);
          Utils.showToast('Failed to save profile.', 'error');

          if (saveBtn) {
            saveBtn.disabled = false;
            const textEl = saveBtn.querySelector('.btn-text');
            const loaderEl = saveBtn.querySelector('.btn-loader');
            if (textEl) textEl.classList.remove('hidden');
            if (loaderEl) loaderEl.classList.add('hidden');
          }
        }
      });
    }
  }

  // ── Friends Render ────────────────────────────────────────────────────────

  /**
   * Render the friends list page.
   * @param {Object} params
   * @returns {Promise<string>}
   */
  async function friendsRender(params) {
    const me = currentUser();
    if (!me) return '<div class="empty-state"><p>Please sign in.</p></div>';

    return `
      <div class="friends-page">
        <div class="friends-tabs">
          <button class="friends-tab active" data-ftab="friends">Friends (${Utils.formatNumber(me.friendsCount || 0)})</button>
          <button class="friends-tab" data-ftab="requests">Requests</button>
          <button class="friends-tab" data-ftab="sent">Sent</button>
        </div>

        <div class="friends-content" id="friends-content">
          <div class="tab-loading"><span class="spinner"></span></div>
        </div>
      </div>`;
  }

  /**
   * Bind events and load friends data.
   */
  function bindFriendsEvents() {
    const tabContainer = document.querySelector('.friends-tabs');
    if (!tabContainer) return;

    tabContainer.addEventListener('click', async (e) => {
      const tab = e.target.closest('.friends-tab');
      if (!tab) return;

      tabContainer.querySelectorAll('.friends-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const ftab = tab.dataset.ftab;
      await loadFriendsTab(ftab);
    });

    // Load initial tab
    loadFriendsTab('friends');
  }

  async function loadFriendsTab(tab) {
    const container = document.getElementById('friends-content');
    if (!container) return;

    const me = currentUser();
    if (!me) return;

    container.innerHTML = '<div class="tab-loading"><span class="spinner"></span></div>';

    try {
      switch (tab) {
        case 'friends': {
          const friendsSnap = await window.Firebase.db
            .collection('users').doc(me.uid).collection('friends')
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

          if (friendsSnap.empty) {
            container.innerHTML = `<div class="empty-state"><p>No friends yet. Add some!</p></div>`;
            return;
          }

          const friends = [];
          for (const doc of friendsSnap.docs) {
            const friendDoc = await window.Firebase.db.collection('users').doc(doc.id).get();
            if (friendDoc.exists) {
              friends.push({ uid: friendDoc.id, ...friendDoc.data() });
            }
          }

          if (friends.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No friends found.</p></div>`;
          } else {
            container.innerHTML = `<div class="friends-list">${friends.map(f => Components.renderUserItem(f, 'Message', 'btn-outline')).join('')}</div>`;
            bindFriendsListEvents(tab);
          }
          break;
        }

        case 'requests': {
          const requestsSnap = await window.Firebase.db
            .collection('friendRequests')
            .where('toId', '==', me.uid)
            .where('status', '==', 'pending')
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

          if (requestsSnap.empty) {
            container.innerHTML = `<div class="empty-state"><p>No pending requests.</p></div>`;
            return;
          }

          const requests = [];
          for (const doc of requestsSnap.docs) {
            const data = doc.data();
            const userDoc = await window.Firebase.db.collection('users').doc(data.fromId).get();
            if (userDoc.exists) {
              requests.push({
                requestId: doc.id,
                uid: userDoc.id,
                ...userDoc.data(),
                requestCreatedAt: data.createdAt
              });
            }
          }

          if (requests.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No pending requests.</p></div>`;
          } else {
            container.innerHTML = requests.map(r => {
              const avatarHtml = r.avatarUrl
                ? `<img src="${Utils.sanitizeHTML(r.avatarUrl)}" alt="" class="avatar">`
                : `<div class="avatar avatar-placeholder">${Utils.getInitials(r.displayName)}</div>`;
              return `
                <div class="user-item" data-user-id="${r.uid}">
                  ${avatarHtml}
                  <div class="user-item-info">
                    <span class="user-item-name">${Utils.sanitizeHTML(r.displayName || 'Unknown')}</span>
                    ${r.username ? `<span class="user-item-username">@${Utils.sanitizeHTML(r.username)}</span>` : ''}
                  </div>
                  <div class="friend-request-actions">
                    <button class="btn btn-sm btn-primary accept-friend-btn" data-request-id="${r.requestId}" data-from-id="${r.uid}">\u2705</button>
                    <button class="btn btn-sm btn-ghost decline-friend-btn" data-request-id="${r.requestId}">\u274C</button>
                  </div>
                </div>`;
            }).join('');
            bindFriendsListEvents(tab);
          }
          break;
        }

        case 'sent': {
          const sentSnap = await window.Firebase.db
            .collection('friendRequests')
            .where('fromId', '==', me.uid)
            .where('status', '==', 'pending')
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

          if (sentSnap.empty) {
            container.innerHTML = `<div class="empty-state"><p>No sent requests.</p></div>`;
            return;
          }

          const sent = [];
          for (const doc of sentSnap.docs) {
            const data = doc.data();
            const userDoc = await window.Firebase.db.collection('users').doc(data.toId).get();
            if (userDoc.exists) {
              sent.push({
                requestId: doc.id,
                uid: userDoc.id,
                ...userDoc.data(),
                toId: data.toId
              });
            }
          }

          if (sent.length === 0) {
            container.innerHTML = `<div class="empty-state"><p>No sent requests.</p></div>`;
          } else {
            container.innerHTML = sent.map(s => {
              const avatarHtml = s.avatarUrl
                ? `<img src="${Utils.sanitizeHTML(s.avatarUrl)}" alt="" class="avatar">`
                : `<div class="avatar avatar-placeholder">${Utils.getInitials(s.displayName)}</div>`;
              return `
                <div class="user-item" data-user-id="${s.uid}">
                  ${avatarHtml}
                  <div class="user-item-info">
                    <span class="user-item-name">${Utils.sanitizeHTML(s.displayName || 'Unknown')}</span>
                    ${s.username ? `<span class="user-item-username">@${Utils.sanitizeHTML(s.username)}</span>` : ''}
                  </div>
                  <button class="btn btn-sm btn-ghost cancel-request-btn" data-user-id="${s.uid}">Cancel</button>
                </div>`;
            }).join('');
            bindFriendsListEvents(tab);
          }
          break;
        }
      }
    } catch (err) {
      console.error('[Profile] Error loading friends tab:', err);
      container.innerHTML = `<div class="empty-state"><p>Failed to load.</p></div>`;
    }
  }

  /**
   * Bind events inside friends list items.
   */
  function bindFriendsListEvents(tab) {
    const container = document.getElementById('friends-content');
    if (!container) return;

    container.addEventListener('click', async (e) => {
      // Accept friend request
      const acceptBtn = e.target.closest('.accept-friend-btn');
      if (acceptBtn) {
        const requestId = acceptBtn.dataset.requestId;
        const fromId = acceptBtn.dataset.fromId;
        if (requestId && fromId) {
          acceptBtn.disabled = true;
          acceptBtn.textContent = '...';
          await handleAcceptFriend(requestId, fromId);
          // Reload tab
          await loadFriendsTab(tab);
        }
        return;
      }

      // Decline friend request
      const declineBtn = e.target.closest('.decline-friend-btn');
      if (declineBtn) {
        const requestId = declineBtn.dataset.requestId;
        if (requestId) {
          declineBtn.disabled = true;
          await handleDeclineFriend(requestId);
          await loadFriendsTab(tab);
        }
        return;
      }

      // Cancel sent request
      const cancelBtn = e.target.closest('.cancel-request-btn');
      if (cancelBtn) {
        const userId = cancelBtn.dataset.userId;
        if (userId) {
          cancelBtn.disabled = true;
          cancelBtn.textContent = '...';
          await handleCancelRequest(userId);
          await loadFriendsTab(tab);
        }
        return;
      }

      // Click on user item (navigate to profile)
      const userItem = e.target.closest('.user-item');
      if (userItem && !e.target.closest('button')) {
        const userId = userItem.dataset.userId;
        if (userId) {
          const me = currentUser();
          if (me && userId === me.uid) {
            Router.navigate('profile');
          } else {
            Router.navigate('user-profile', { userId });
          }
        }
        return;
      }

      // Message button on friends list
      const msgBtn = e.target.closest('.user-action-btn');
      if (msgBtn && msgBtn.textContent.trim() === 'Message') {
        const userId = msgBtn.dataset.userId;
        if (userId) {
          handleMessage(userId);
        }
        return;
      }
    });
  }

  // ── Profile Page Event Binding ────────────────────────────────────────────

  /**
   * Bind all events on the profile page.
   */
  function bindProfileEvents(viewingUserId) {
    const me = currentUser();

    // Tab switching
    document.querySelectorAll('.profile-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _activeTab = tab.dataset.tab;
        const targetId = viewingUserId || (me ? me.uid : null);
        if (targetId) {
          loadTabContent(targetId, _activeTab);
        }
      });
    });

    // Stats: clicking Posts navigates to posts tab
    document.querySelectorAll('.stat-item[data-tab]').forEach(stat => {
      stat.addEventListener('click', () => {
        const tabName = stat.dataset.tab;
        document.querySelectorAll('.profile-tab').forEach(t => {
          t.classList.toggle('active', t.dataset.tab === tabName);
        });
        _activeTab = tabName;
        const targetId = viewingUserId || (me ? me.uid : null);
        if (targetId) {
          loadTabContent(targetId, _activeTab);
        }
      });
    });

    // Stats: clicking Friends navigates to friends page
    document.querySelectorAll('.stat-item[data-navigate]').forEach(stat => {
      stat.addEventListener('click', () => {
        const page = stat.dataset.navigate;
        Router.navigate(page);
      });
    });

    if (!viewingUserId || (me && viewingUserId === me.uid)) {
      // Own profile events
      const editBtn = document.getElementById('edit-profile-btn');
      if (editBtn) editBtn.addEventListener('click', handleEditProfile);

      const friendsBtn = document.getElementById('friends-btn');
      if (friendsBtn) friendsBtn.addEventListener('click', () => Router.navigate('friends'));
    } else {
      // Other user profile events
      const addFriendBtn = document.getElementById('add-friend-btn');
      if (addFriendBtn) {
        addFriendBtn.addEventListener('click', () => handleAddFriend(viewingUserId));
      }

      const removeFriendBtn = document.getElementById('remove-friend-btn');
      if (removeFriendBtn) {
        removeFriendBtn.addEventListener('click', () => handleRemoveFriend(viewingUserId));
      }

      const acceptFriendBtn = document.getElementById('accept-friend-btn');
      if (acceptFriendBtn) {
        acceptFriendBtn.addEventListener('click', async () => {
          acceptFriendBtn.disabled = true;
          acceptFriendBtn.textContent = '...';
          // Find the pending request
          try {
            const snap = await window.Firebase.db
              .collection('friendRequests')
              .where('fromId', '==', viewingUserId)
              .where('toId', '==', me.uid)
              .where('status', '==', 'pending')
              .limit(1)
              .get();
            if (!snap.empty) {
              await handleAcceptFriend(snap.docs[0].id, viewingUserId);
              Router.navigate('user-profile', { userId: viewingUserId }, true);
            }
          } catch (err) {
            console.error('[Profile] Error accepting friend:', err);
          }
        });
      }

      const declineFriendBtn = document.getElementById('decline-friend-btn');
      if (declineFriendBtn) {
        declineFriendBtn.addEventListener('click', async () => {
          try {
            const snap = await window.Firebase.db
              .collection('friendRequests')
              .where('fromId', '==', viewingUserId)
              .where('toId', '==', me.uid)
              .where('status', '==', 'pending')
              .limit(1)
              .get();
            if (!snap.empty) {
              await handleDeclineFriend(snap.docs[0].id);
              Router.navigate('user-profile', { userId: viewingUserId }, true);
            }
          } catch (err) {
            console.error('[Profile] Error declining friend:', err);
          }
        });
      }

      const cancelRequestBtn = document.getElementById('cancel-request-btn');
      if (cancelRequestBtn) {
        cancelRequestBtn.addEventListener('click', async () => {
          cancelRequestBtn.disabled = true;
          cancelRequestBtn.textContent = '...';
          await handleCancelRequest(viewingUserId);
          Router.navigate('user-profile', { userId: viewingUserId }, true);
        });
      }

      const messageBtns = document.querySelectorAll('#message-user-btn');
      messageBtns.forEach(btn => {
        btn.addEventListener('click', () => handleMessage(viewingUserId));
      });
    }

    // Load initial tab content
    const targetId = viewingUserId || (me ? me.uid : null);
    if (targetId) {
      loadTabContent(targetId, 'posts');
      loadBadgesRow(targetId);
    }
  }

  // ── Main Render ────────────────────────────────────────────────────────────

  /**
   * Render the profile page (own or another user's).
   * @param {Object} params - { userId? }
   * @returns {Promise<string>}
   */
  async function render(params) {
    const me = currentUser();
    if (!me) return '<div class="empty-state"><p>Please sign in.</p></div>';

    const userId = params?.userId;

    if (userId && userId !== me.uid) {
      // Load other user's profile
      const user = await loadUserProfile(userId);
      if (!user) {
        return `
          <div class="empty-state">
            <h3>User Not Found</h3>
            <p>This user may have been removed or doesn't exist.</p>
            <button class="btn btn-primary" onclick="window.Router.navigate('home')">Go Home</button>
          </div>`;
      }

      const friendStatus = await checkFriendshipStatus(userId);
      const html = renderOtherProfile(user, me.uid, friendStatus);

      // Update page title
      Router.setPageTitle(user.displayName || 'Profile');

      // Return a wrapper that triggers event binding after render
      return `
        <div class="profile-wrapper" data-viewing-user="${userId}">
          ${html}
        </div>`;
    }

    // Own profile
    const user = await loadUserProfile(me.uid) || me;
    return `
      <div class="profile-wrapper" data-viewing-user="">
        ${renderOwnProfile(user)}
      </div>`;
  }

  /**
   * Alias for render when viewing another user's profile.
   * @param {Object} params - { userId }
   * @returns {Promise<string>}
   */
  async function userProfileRender(params) {
    return render(params);
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  /**
   * Initialize the profile module.
   */
  function init() {
    // Listen for page changes to bind events after render
    window.addEventListener('pageChange', (e) => {
      const { page, params } = e.detail;

      if (page === 'profile' || page === 'user-profile') {
        const wrapper = document.querySelector('.profile-wrapper');
        if (wrapper) {
          const viewingUserId = wrapper.dataset.viewingUser || null;
          bindProfileEvents(viewingUserId || undefined);
        }
      }

      if (page === 'edit-profile') {
        bindEditProfileEvents();
      }

      if (page === 'friends') {
        bindFriendsEvents();
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.Profile = {
    init,
    render,
    userProfileRender,
    editProfileRender,
    friendsRender,
    loadUserProfile,
    renderOwnProfile,
    renderOtherProfile,
    loadUserPosts,
    loadSavedPosts,
    loadBadges,
    loadAchievements,
    handleEditProfile,
    handleAddFriend,
    handleRemoveFriend,
    handleMessage,
    checkFriendshipStatus,
    handleAcceptFriend,
    handleDeclineFriend,
    handleCancelRequest,
    getLevelInfo
  };
})();