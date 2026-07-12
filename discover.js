/**
 * GIOLYNK - Discover Module
 * Renders the discover/explore page with trending posts, explore grid,
 * suggested people, popular groups, and upcoming events.
 * Uses Firebase compat SDK via window.Firebase references.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _searchTimeout = null;
  let _activeSearchTab = 'all';
  let _searchResults = { all: [], people: [], posts: [], groups: [] };

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
   * Fetch a lightweight author object from the users collection.
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
          bio: d.bio || ''
        };
      }
    } catch (err) {
      console.warn('[Discover] Could not fetch author:', authorId, err);
    }
    return { displayName: 'Unknown', avatarUrl: null, username: '' };
  }

  /**
   * Fetch like UIDs for a post (from likes subcollection).
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
   * Enrich post data with author info and likes.
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
   * Load trending posts: most liked posts from the user's school in the last 7 days.
   */
  async function loadTrendingPosts() {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const snap = await window.Firebase.db
        .collection('posts')
        .where('schoolId', '==', user.schoolId)
        .where('createdAt', '>=', firebase.firestore.Timestamp.fromDate(sevenDaysAgo))
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();

      if (snap.empty) return [];

      // Firestore doesn't support ordering by subcollection count,
      // so we fetch likes for each post client-side and sort
      const postsWithLikes = [];
      for (const doc of snap.docs) {
        const post = await enrichPost(doc);
        postsWithLikes.push(post);
      }

      // Sort by like count descending, take top 10
      postsWithLikes.sort((a, b) => (b.likes?.length || 0) - (a.likes?.length || 0));
      return postsWithLikes.slice(0, 10);
    } catch (err) {
      console.error('[Discover] Error loading trending posts:', err);
      return [];
    }
  }

  /**
   * Load explore posts: posts with images from the user's school, random order.
   */
  async function loadExplorePosts() {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    try {
      // Firestore doesn't support random ordering, so we fetch recent posts
      // with images and shuffle client-side
      const snap = await window.Firebase.db
        .collection('posts')
        .where('schoolId', '==', user.schoolId)
        .where('imageUrl', '!=', null)
        .orderBy('createdAt', 'desc')
        .limit(40)
        .get();

      if (snap.empty) return [];

      const posts = [];
      for (const doc of snap.docs) {
        const data = doc.data();
        const author = await fetchAuthor(data.authorId);
        posts.push({
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
          author
        });
      }

      // Fisher-Yates shuffle
      for (let i = posts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [posts[i], posts[j]] = [posts[j], posts[i]];
      }

      return posts.slice(0, 20);
    } catch (err) {
      console.error('[Discover] Error loading explore posts:', err);
      return [];
    }
  }

  /**
   * Load suggested people: users from same school, excluding current user and friends.
   */
  async function loadSuggestedPeople() {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    try {
      // Get current user's friend list
      let friendIds = [];
      try {
        const userDoc = await window.Firebase.db.collection('users').doc(user.uid).get();
        if (userDoc.exists) {
          friendIds = userDoc.data().friends || [];
        }
      } catch (_) {}

      // Get outgoing friend requests
      let pendingIds = [];
      try {
        const sentSnap = await window.Firebase.db
          .collection('friendRequests')
          .where('fromUserId', '==', user.uid)
          .where('status', '==', 'pending')
          .get();
        pendingIds = sentSnap.docs.map(d => d.data().toUserId);
      } catch (_) {}

      // Get incoming friend requests (to avoid suggesting them)
      try {
        const recvSnap = await window.Firebase.db
          .collection('friendRequests')
          .where('toUserId', '==', user.uid)
          .where('status', '==', 'pending')
          .get();
        pendingIds = pendingIds.concat(recvSnap.docs.map(d => d.data().fromUserId));
      } catch (_) {}

      const excludeIds = [user.uid, ...friendIds, ...pendingIds];

      const snap = await window.Firebase.db
        .collection('users')
        .where('schoolId', '==', user.schoolId)
        .limit(20)
        .get();

      const users = [];
      for (const doc of snap.docs) {
        if (excludeIds.includes(doc.id)) continue;
        const d = doc.data();
        users.push({
          uid: doc.id,
          ...d
        });
        if (users.length >= 10) break;
      }

      return users;
    } catch (err) {
      console.error('[Discover] Error loading suggested people:', err);
      return [];
    }
  }

  /**
   * Load popular groups ordered by member count.
   */
  async function loadPopularGroups() {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    try {
      const snap = await window.Firebase.db
        .collection('groups')
        .where('schoolId', '==', user.schoolId)
        .orderBy('memberCount', 'desc')
        .limit(10)
        .get();

      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.error('[Discover] Error loading popular groups:', err);
      return [];
    }
  }

  /**
   * Load upcoming events where endDate >= now, ordered by startDate asc.
   */
  async function loadUpcomingEvents() {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    try {
      const now = firebase.firestore.Timestamp.now();

      const snap = await window.Firebase.db
        .collection('events')
        .where('schoolId', '==', user.schoolId)
        .where('endDate', '>=', now)
        .orderBy('startDate', 'asc')
        .limit(5)
        .get();

      return snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        startDate: doc.data().startDate?.toDate ? doc.data().startDate.toDate() : doc.data().startDate,
        endDate: doc.data().endDate?.toDate ? doc.data().endDate.toDate() : doc.data().endDate
      }));
    } catch (err) {
      console.error('[Discover] Error loading upcoming events:', err);
      return [];
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Search across posts, users, and groups.
   * Returns results grouped by type.
   */
  async function searchDiscover(query) {
    if (!query || !query.trim()) {
      _searchResults = { all: [], people: [], posts: [], groups: [] };
      return;
    }

    const term = query.trim().toLowerCase();
    const user = currentUser();
    if (!user) return;

    const results = { all: [], people: [], posts: [], groups: [] };

    // Search users (prefix match on displayName and username)
    try {
      // displayName search
      const nameEnd = term + '\uf8ff';
      const nameSnap = await window.Firebase.db
        .collection('users')
        .where('displayName', '>=', term)
        .where('displayName', '<=', nameEnd)
        .where('schoolId', '==', user.schoolId)
        .limit(10)
        .get();
      nameSnap.docs.forEach(doc => {
        const userData = { uid: doc.id, ...doc.data() };
        results.people.push(userData);
        results.all.push({ type: 'user', ...userData });
      });

      // Username search (if different from display name search)
      if (term.length >= 2) {
        const unameEnd = term + '\uf8ff';
        try {
          const unameSnap = await window.Firebase.db
            .collection('users')
            .where('username', '>=', term)
            .where('username', '<=', unameEnd)
            .where('schoolId', '==', user.schoolId)
            .limit(10)
            .get();
          unameSnap.docs.forEach(doc => {
            const userData = { uid: doc.id, ...doc.data() };
            if (!results.people.find(p => p.uid === userData.uid)) {
              results.people.push(userData);
              results.all.push({ type: 'user', ...userData });
            }
          });
        } catch (_) {
          // username index may not exist
        }
      }
    } catch (err) {
      console.warn('[Discover] User search error:', err);
    }

    // Search posts (content search)
    try {
      const postEnd = term + '\uf8ff';
      const postSnap = await window.Firebase.db
        .collection('posts')
        .where('schoolId', '==', user.schoolId)
        .where('content', '>=', term)
        .where('content', '<=', postEnd)
        .orderBy('content')
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();

      for (const doc of postSnap.docs) {
        const data = doc.data();
        const author = await fetchAuthor(data.authorId);
        const postData = {
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
          author
        };
        results.posts.push(postData);
        results.all.push({ type: 'post', ...postData });
      }
    } catch (err) {
      console.warn('[Discover] Post search error:', err);
    }

    // Search groups (name search)
    try {
      const groupEnd = term + '\uf8ff';
      const groupSnap = await window.Firebase.db
        .collection('groups')
        .where('schoolId', '==', user.schoolId)
        .where('name', '>=', term)
        .where('name', '<=', groupEnd)
        .orderBy('name')
        .limit(10)
        .get();

      groupSnap.docs.forEach(doc => {
        const groupData = { id: doc.id, ...doc.data() };
        results.groups.push(groupData);
        results.all.push({ type: 'group', ...groupData });
      });
    } catch (err) {
      console.warn('[Discover] Group search error:', err);
    }

    _searchResults = results;
  }

  /**
   * Render search results based on the active tab.
   */
  function renderSearchResults() {
    const container = document.getElementById('discover-search-results');
    if (!container) return;

    const key = _activeSearchTab === 'all' ? 'all' : _activeSearchTab;
    const items = _searchResults[key] || [];

    if (items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">🔍</span>
          <p>No results found</p>
        </div>`;
      return;
    }

    const util = u();
    const user = currentUser();

    if (_activeSearchTab === 'all') {
      const html = items.map(item => {
        if (item.type === 'user') {
          return c().renderUserItem(item, 'View', 'btn-outline');
        }
        if (item.type === 'post') {
          return c().renderPostCard(item, user);
        }
        if (item.type === 'group') {
          return c().renderGroupCard(item);
        }
        return '';
      }).join('');
      container.innerHTML = html;
    } else if (_activeSearchTab === 'people') {
      const html = items.map(userItem => c().renderUserItem(userItem, 'View', 'btn-outline')).join('');
      container.innerHTML = html;
    } else if (_activeSearchTab === 'posts') {
      const html = items.map(post => c().renderPostCard(post, user)).join('');
      container.innerHTML = html;
    } else if (_activeSearchTab === 'groups') {
      const html = items.map(group => c().renderGroupCard(group)).join('');
      container.innerHTML = html;
    }
  }

  // ── Section Renderers ─────────────────────────────────────────────────────

  /**
   * Render the trending posts horizontal scroll section.
   */
  function renderTrendingSection(posts) {
    const user = currentUser();
    if (posts.length === 0) return '';

    const util = u();
    const cardsHtml = posts.map(post => {
      const avatarHtml = post.author?.avatarUrl
        ? `<img src="${util.sanitizeHTML(post.author.avatarUrl)}" alt="" class="avatar avatar-sm">`
        : `<div class="avatar avatar-sm avatar-placeholder">${util.getInitials(post.author?.displayName)}</div>`;

      return `
        <div class="trending-post-card" data-post-id="${post.id}">
          <div class="trending-post-header">
            ${avatarHtml}
            <span class="trending-post-author">${util.sanitizeHTML(post.author?.displayName || 'Unknown')}</span>
            <span class="trending-post-likes">❤️ ${util.formatNumber(post.likes?.length || 0)}</span>
          </div>
          ${post.imageUrl ? `<div class="trending-post-image"><img src="${util.sanitizeHTML(post.imageUrl)}" alt="" loading="lazy"></div>` : ''}
          <p class="trending-post-text">${util.sanitizeHTML(util.truncate(post.content || '', 80))}</p>
        </div>`;
    }).join('');

    return `
      <section class="discover-section">
        <div class="section-header">
          <h2 class="section-title">🔥 Trending</h2>
        </div>
        <div class="horizontal-scroll" id="trending-scroll">
          ${cardsHtml}
        </div>
      </section>`;
  }

  /**
   * Render the explore grid (2-column masonry of image posts).
   */
  function renderExploreGrid(posts) {
    const util = u();
    if (posts.length === 0) return '';

    const cardsHtml = posts.map(post => {
      return `
        <div class="explore-grid-item" data-post-id="${post.id}">
          <img src="${util.sanitizeHTML(post.imageUrl)}" alt="" loading="lazy">
          <div class="explore-grid-overlay">
            <span>❤️ ${util.formatNumber(post.likes?.length || post.likeCount || 0)}</span>
            <span>💬 ${util.formatNumber(post.comments?.length || post.commentCount || 0)}</span>
          </div>
        </div>`;
    }).join('');

    return `
      <section class="discover-section">
        <div class="section-header">
          <h2 class="section-title">🌍 Explore</h2>
        </div>
        <div class="explore-grid">
          ${cardsHtml}
        </div>
      </section>`;
  }

  /**
   * Render suggested people horizontal scroll.
   */
  function renderSuggestedPeopleSection(users) {
    if (users.length === 0) return '';

    const util = u();
    const cardsHtml = users.map(userItem => {
      const avatarHtml = userItem.avatarUrl
        ? `<img src="${util.sanitizeHTML(userItem.avatarUrl)}" alt="" class="avatar">`
        : `<div class="avatar avatar-placeholder">${util.getInitials(userItem.displayName)}</div>`;

      return `
        <div class="suggested-person-card" data-user-id="${userItem.uid}">
          ${avatarHtml}
          <span class="suggested-person-name">${util.sanitizeHTML(userItem.displayName || 'Unknown')}</span>
          ${userItem.username ? `<span class="suggested-person-username">@${util.sanitizeHTML(userItem.username)}</span>` : ''}
          <button class="btn btn-sm btn-outline add-friend-btn" data-user-id="${userItem.uid}">Add</button>
        </div>`;
    }).join('');

    return `
      <section class="discover-section">
        <div class="section-header">
          <h2 class="section-title">👥 Suggested People</h2>
        </div>
        <div class="horizontal-scroll" id="suggested-people-scroll">
          ${cardsHtml}
        </div>
      </section>`;
  }

  /**
   * Render popular groups horizontal scroll.
   */
  function renderPopularGroupsSection(groups) {
    if (groups.length === 0) return '';

    const cardsHtml = groups.map(group => c().renderGroupCard(group)).join('');

    return `
      <section class="discover-section">
        <div class="section-header">
          <h2 class="section-title">📌 Popular Groups</h2>
        </div>
        <div class="horizontal-scroll" id="popular-groups-scroll">
          ${cardsHtml}
        </div>
      </section>`;
  }

  /**
   * Render upcoming events list.
   */
  function renderUpcomingEventsSection(events) {
    if (events.length === 0) return '';

    const cardsHtml = events.map(event => c().renderEventCard(event)).join('');

    return `
      <section class="discover-section">
        <div class="section-header">
          <h2 class="section-title">📅 Upcoming Events</h2>
        </div>
        <div class="events-list" id="upcoming-events-list">
          ${cardsHtml}
        </div>
      </section>`;
  }

  /**
   * Render the loading skeleton for the discover page.
   */
  function renderSkeleton() {
    return `
      <div class="discover-page">
        <div class="discover-search-bar">
          <div class="skeleton-line" style="width:100%;height:44px;border-radius:22px;"></div>
        </div>
        <section class="discover-section">
          <div class="skeleton-line" style="width:30%;height:24px;margin-bottom:12px;"></div>
          <div class="horizontal-scroll">
            ${Array(4).fill(`
              <div class="skeleton-card" style="min-width:180px;height:220px;border-radius:12px;"></div>
            `).join('')}
          </div>
        </section>
        <section class="discover-section">
          <div class="skeleton-line" style="width:30%;height:24px;margin-bottom:12px;"></div>
          <div class="explore-grid">
            ${Array(6).fill(`
              <div class="skeleton-card" style="height:180px;border-radius:8px;"></div>
            `).join('')}
          </div>
        </section>
        <section class="discover-section">
          <div class="skeleton-line" style="width:40%;height:24px;margin-bottom:12px;"></div>
          <div class="horizontal-scroll">
            ${Array(5).fill(`
              <div class="skeleton-card" style="min-width:120px;height:160px;border-radius:12px;flex-direction:column;align-items:center;gap:8px;">
                <div class="skeleton-avatar" style="width:48px;height:48px;"></div>
                <div class="skeleton-line" style="width:70%;height:14px;"></div>
              </div>
            `).join('')}
          </div>
        </section>
      </div>`;
  }

  // ── Main Render ───────────────────────────────────────────────────────────

  /**
   * Render the full discover page.
   * @param {Object} params - Route parameters.
   * @returns {Promise<string>} HTML string for the discover page.
   */
  async function render(params) {
    const user = currentUser();
    if (!user) {
      return `<div class="error-page"><p>Please sign in to discover content.</p></div>`;
    }

    // Return skeleton immediately, then load data and re-render
    const skeletonHtml = renderSkeleton();

    // Async data loading
    try {
      const [trending, explore, people, groups, events] = await Promise.all([
        loadTrendingPosts(),
        loadExplorePosts(),
        loadSuggestedPeople(),
        loadPopularGroups(),
        loadUpcomingEvents()
      ]);

      // Build the full page
      const util = u();
      let html = `
        <div class="discover-page" id="discover-page">
          <!-- Search Bar -->
          <div class="discover-search-bar">
            <div class="search-input-wrap">
              <span class="search-icon">🔍</span>
              <input type="text" id="discover-search-input" placeholder="Search people, posts, groups..." autocomplete="off">
              ${_searchResults.all.length > 0 ? `<button class="search-clear-btn hidden" id="discover-search-clear">&times;</button>` : '<button class="search-clear-btn hidden" id="discover-search-clear">&times;</button>'}
            </div>
          </div>

          <!-- Search Results (hidden by default) -->
          <div id="discover-search-container" class="hidden">
            <div class="search-tabs">
              <button class="search-tab ${_activeSearchTab === 'all' ? 'active' : ''}" data-search-tab="all">All</button>
              <button class="search-tab ${_activeSearchTab === 'people' ? 'active' : ''}" data-search-tab="people">People</button>
              <button class="search-tab ${_activeSearchTab === 'posts' ? 'active' : ''}" data-search-tab="posts">Posts</button>
              <button class="search-tab ${_activeSearchTab === 'groups' ? 'active' : ''}" data-search-tab="groups">Groups</button>
            </div>
            <div id="discover-search-results" class="search-results"></div>
          </div>

          <!-- Main Content (hidden during search) -->
          <div id="discover-main-content">
            ${renderTrendingSection(trending)}
            ${renderExploreGrid(explore)}
            ${renderSuggestedPeopleSection(people)}
            ${renderPopularGroupsSection(groups)}
            ${renderUpcomingEventsSection(events)}

            ${trending.length === 0 && explore.length === 0 && people.length === 0 && groups.length === 0 && events.length === 0
              ? `<div class="empty-state" style="padding:60px 20px;">
                   <span class="empty-icon">🧭</span>
                   <h3>Nothing to discover yet</h3>
                   <p>Join your school community and start connecting!</p>
                 </div>`
              : ''}
          </div>
        </div>`;

      return html;
    } catch (err) {
      console.error('[Discover] Error rendering discover page:', err);
      return `
        <div class="error-page">
          <h2>Something went wrong</h2>
          <p>Failed to load discover page.</p>
          <button class="btn btn-primary" onclick="window.Router.navigate('home')">Go Home</button>
        </div>`;
    }
  }

  /**
   * After render, attach event listeners and populate dynamic content.
   * Called after the page HTML is inserted into the DOM.
   */
  function afterRender() {
    // Search input
    const searchInput = document.getElementById('discover-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        const clearBtn = document.getElementById('discover-search-clear');
        if (clearBtn) clearBtn.classList.toggle('hidden', !query);

        clearTimeout(_searchTimeout);
        if (!query) {
          // Show main content, hide search results
          const searchContainer = document.getElementById('discover-search-container');
          const mainContent = document.getElementById('discover-main-content');
          if (searchContainer) searchContainer.classList.add('hidden');
          if (mainContent) mainContent.classList.remove('hidden');
          _searchResults = { all: [], people: [], posts: [], groups: [] };
          return;
        }

        _searchTimeout = setTimeout(async () => {
          const searchContainer = document.getElementById('discover-search-container');
          const mainContent = document.getElementById('discover-main-content');
          if (searchContainer) searchContainer.classList.remove('hidden');
          if (mainContent) mainContent.classList.add('hidden');

          // Show loading in search results
          const resultsContainer = document.getElementById('discover-search-results');
          if (resultsContainer) {
            resultsContainer.innerHTML = `<div class="loading-indicator"><span class="spinner"></span></div>`;
          }

          await searchDiscover(query);
          renderSearchResults();
        }, 400);
      });

      // Focus search if query param exists
      if (window.Router?.getParams()?.q) {
        searchInput.value = window.Router.getParams().q;
        searchInput.dispatchEvent(new Event('input'));
      }
    }

    // Search clear button
    const clearBtn = document.getElementById('discover-search-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        const searchInput = document.getElementById('discover-search-input');
        if (searchInput) {
          searchInput.value = '';
          searchInput.dispatchEvent(new Event('input'));
          searchInput.focus();
        }
      });
    }

    // Search tabs
    document.querySelectorAll('[data-search-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('[data-search-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _activeSearchTab = tab.dataset.searchTab;
        renderSearchResults();
      });
    });
  }

  // ── Event Delegation ──────────────────────────────────────────────────────

  function handleDiscoverClicks(e) {
    const target = e.target;

    // Post clicks
    const postCard = target.closest('[data-post-id]');
    if (postCard) {
      // Don't navigate if clicking on action buttons
      if (target.closest('.post-action-btn') || target.closest('.comment-action-btn')) return;
      const postId = postCard.dataset.postId;
      if (postId && window.Router) {
        window.Router.navigate('post-detail', { postId, _hash: `/post/${postId}` });
      }
      return;
    }

    // User clicks
    const userItem = target.closest('[data-user-id]');
    if (userItem) {
      // Don't navigate if clicking action buttons
      if (target.closest('.user-action-btn') || target.closest('.add-friend-btn')) return;
      const userId = userItem.dataset.userId;
      if (userId && window.Router) {
        window.Router.navigate('user-profile', { userId, _hash: `/user/${userId}` });
      }
      return;
    }

    // Group clicks
    const groupCard = target.closest('[data-group-id]');
    if (groupCard) {
      const groupId = groupCard.dataset.groupId;
      if (groupId && window.Router) {
        window.Router.navigate('group', { groupId, _hash: `/group/${groupId}` });
      }
      return;
    }

    // Event clicks
    const eventCard = target.closest('[data-event-id]');
    if (eventCard) {
      const eventId = eventCard.dataset.eventId;
      if (eventId && window.Router) {
        window.Router.navigate('event-detail', { eventId, _hash: `/event/${eventId}` });
      }
      return;
    }

    // Add friend button clicks
    const addFriendBtn = target.closest('.add-friend-btn');
    if (addFriendBtn) {
      const userId = addFriendBtn.dataset.userId;
      if (userId) {
        handleSendFriendRequest(userId, addFriendBtn);
      }
      return;
    }

    // Post author clicks (in trending section)
    const postAuthor = target.closest('.post-author[data-user-id]');
    if (postAuthor) {
      const userId = postAuthor.dataset.userId;
      if (userId && window.Router) {
        window.Router.navigate('user-profile', { userId, _hash: `/user/${userId}` });
      }
      return;
    }
  }

  /**
   * Handle sending a friend request from the discover page.
   */
  async function handleSendFriendRequest(toUserId, btnEl) {
    const user = currentUser();
    if (!user) return;

    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = 'Sending...';
    }

    try {
      await window.Firebase.db.collection('friendRequests').add({
        fromUserId: user.uid,
        toUserId: toUserId,
        status: 'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      if (btnEl) {
        btnEl.textContent = 'Sent';
        btnEl.classList.remove('btn-outline');
        btnEl.classList.add('btn-disabled');
      }
      u().showToast('Friend request sent!', 'success');
    } catch (err) {
      console.error('[Discover] Error sending friend request:', err);
      u().showToast('Failed to send friend request.', 'error');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = 'Add';
      }
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────

  function init() {
    // Listen for clicks on the discover page via delegation on the page-content area
    document.addEventListener('click', (e) => {
      // Only handle if we're on the discover page
      const discoverPage = document.getElementById('discover-page');
      if (!discoverPage || !discoverPage.contains(e.target)) return;

      handleDiscoverClicks(e);
    });

    // Re-attach listeners after page renders
    window.addEventListener('pageChange', (e) => {
      if (e.detail.page === 'discover') {
        afterRender();
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.Discover = {
    init,
    render,
    loadTrendingPosts,
    loadExplorePosts,
    loadSuggestedPeople,
    loadPopularGroups,
    loadUpcomingEvents,
    searchDiscover
  };
})();