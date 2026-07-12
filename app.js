'use strict';
/* GIOLYNK - Main Application Entry Point */
(function () {
  const SPLASH_DURATION = 1200;

  async function boot() {
    // Show splash
    const splash = document.getElementById('splash-screen');
    await new Promise(r => setTimeout(r, SPLASH_DURATION));

    // Initialize Firebase
    if (window.Firebase) {
      // Firebase is ready from firebase-init.js
    }

    // Initialize all modules
    Auth.init();
    Router.init();
    Feed.init();
    Chat.init();
    Profile.init();
    Discover.init();
    Groups.init();
    Competitions.init();
    Events.init();
    Notifications.init();
    Search.init();
    CreatePost.init();
    Moderation.init();
    Admin.init();

    // Register all page routes
    Router.registerPages({
      'home': Feed.render,
      'discover': Discover.render,
      'chats': Chat.render,
      'profile': Profile.render,
      'user-profile': Profile.userProfileRender,
      'edit-profile': Profile.editProfileRender,
      'friends': Profile.friendsRender,
      'chat-view': Chat.renderChatView,
      'group-chat': Chat.renderGroupChatView,
      'group': Groups.renderGroupPage,
      'competition-detail': Competitions.renderCompetitionDetail,
      'create-competition': Competitions.renderCreateCompetition,
      'event-detail': Events.renderEventDetail,
      'create-event': Events.renderCreateEvent,
      'notifications': Notifications.render,
      'admin': Admin.render,
      'school': renderSchoolPage,
      'settings': renderSettingsPage,
      'post-detail': renderPostDetail,
      'create-group': Groups.renderCreateGroup
    });

    // Setup global event listeners
    setupGlobalListeners();

    // Setup theme
    setupTheme();

    // Setup PWA
    registerServiceWorker();

    // Auth will handle showing the right screen
    // Fade out splash
    splash?.classList.add('fade-out');
    setTimeout(() => { if (splash) splash.style.display = 'none'; }, 500);
  }

  function setupGlobalListeners() {
    // Search button
    document.getElementById('search-btn')?.addEventListener('click', () => {
      document.getElementById('search-overlay')?.classList.remove('hidden');
      setTimeout(() => document.getElementById('global-search-input')?.focus(), 100);
    });

    // Notification button
    document.getElementById('notification-btn')?.addEventListener('click', () => {
      Router.navigate('notifications');
    });

    // Image viewer close
    document.getElementById('close-viewer')?.addEventListener('click', () => {
      document.getElementById('image-viewer')?.classList.add('hidden');
    });

    // Image viewer click outside
    document.getElementById('image-viewer')?.addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.getElementById('image-viewer')?.classList.add('hidden');
        document.getElementById('search-overlay')?.classList.add('hidden');
        document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
      }
    });

    // Online/offline
    window.addEventListener('online', () => Utils.showToast('Back online', 'success'));
    window.addEventListener('offline', () => Utils.showToast('You are offline', 'warning'));

    // Listen for auth ready to navigate
    document.addEventListener('auth:ready', function (e) {
      const user = e.detail.user || e.detail;
      // Setup presence
      if (window.Chat && Chat.setupPresence) Chat.setupPresence();
      // Update notification badge
      Notifications.updateBadge();
      // Listen for unread chat counts
      if (window.Chat && Chat.listenForUnreadCounts) Chat.listenForUnreadCounts();
      // Navigate to home
      Router.navigate('home');
      // Daily login XP
      if (user && typeof user === 'object') awardDailyLogin(user.uid); else if (typeof user === 'string') awardDailyLogin(user);
    });

    document.addEventListener('auth:onboardingRequired', function () {
      document.getElementById('auth-container')?.classList.add('hidden');
      document.getElementById('onboarding-container')?.classList.remove('hidden');
      initOnboarding();
    });

    document.addEventListener('auth:showLogin', function () {
      document.getElementById('app-shell')?.classList.add('hidden');
      document.getElementById('onboarding-container')?.classList.add('hidden');
      document.getElementById('auth-container')?.classList.remove('hidden');
    });

    document.addEventListener('auth:showApp', function () {
      document.getElementById('auth-container')?.classList.add('hidden');
      document.getElementById('onboarding-container')?.classList.add('hidden');
      document.getElementById('app-shell')?.classList.remove('hidden');
    });
  }

  async function awardDailyLogin(userId) {
    try {
      const today = new Date().toDateString();
      const userDoc = await window.Firebase.db.collection('users').doc(userId).get();
      const user = userDoc.data();
      if (user.lastLoginDate !== today) {
        await window.Firebase.db.collection('users').doc(userId).update({
          lastLoginDate: today,
          loginStreak: (user.loginStreak || 0) + 1
        });
        if (window.Reputation) Reputation.awardXP(userId, 2, 'daily_login');
      }
    } catch (err) { /* silent */ }
  }

  function setupTheme() {
    const saved = localStorage.getItem('giolynk_theme') || 'light';
    document.body.dataset.theme = saved;
    updateThemeIcon(saved);

    document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
      const current = document.body.dataset.theme;
      const next = current === 'light' ? 'dark' : 'light';
      document.body.dataset.theme = next;
      localStorage.setItem('giolynk_theme', next);
      updateThemeIcon(next);
      document.getElementById('theme-color-meta')?.setAttribute('content', next === 'dark' ? '#0a1628' : '#00897B');
    });
  }

  function updateThemeIcon(theme) {
    const lightIcon = document.querySelector('.theme-icon-light');
    const darkIcon = document.querySelector('.theme-icon-dark');
    if (theme === 'dark') {
      lightIcon?.classList.remove('hidden');
      darkIcon?.classList.add('hidden');
    } else {
      lightIcon?.classList.add('hidden');
      darkIcon?.classList.remove('hidden');
    }
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js?v=3').catch(() => { /* SW registration failed, app still works */ });
    }
  }

  // =============================================
  // Onboarding
  // =============================================
  let onboardingStep = 1;

  function initOnboarding() {
    onboardingStep = 1;
    updateOnboardingUI();
    loadInterests();

    document.getElementById('onboard-next-1')?.addEventListener('click', async function () {
      const username = document.getElementById('onboard-username')?.value?.trim();
      if (!username) { Utils.showToast('Please enter a username', 'warning'); return; }

      // Check availability
      try {
        const snap = await window.Firebase.db.collection('users').where('username', '==', username).limit(1).get();
        if (!snap.empty) { Utils.showToast('Username is taken', 'error'); return; }
      } catch (err) { /* continue */ }

      onboardingStep = 2;
      updateOnboardingUI();
    });

    document.getElementById('onboard-skip-2')?.addEventListener('click', () => {
      onboardingStep = 3;
      updateOnboardingUI();
    });

    document.getElementById('onboard-finish')?.addEventListener('click', async function () {
      const user = window.Firebase.auth.currentUser;
      if (!user) return;

      const selectedInterests = [];
      document.querySelectorAll('.interest-chip.selected').forEach(chip => {
        selectedInterests.push(chip.dataset.interest);
      });

      try {
        const updateData = {
          isOnboarded: true,
          interests: selectedInterests,
          bio: document.getElementById('onboard-bio')?.value?.trim() || '',
          username: document.getElementById('onboard-username')?.value?.trim() || user.uid.substring(0, 10)
        };

        // Handle avatar
        const avatarPreview = document.getElementById('avatar-preview');
        const avatarImg = avatarPreview?.querySelector('img');
        if (avatarImg) {
          updateData.avatarUrl = avatarImg.src;
        }

        await window.Firebase.db.collection('users').doc(user.uid).update(updateData);

        // Welcome achievement
        if (window.Reputation) {
          Reputation.awardXP(user.uid, 20, 'post_created'); // Onboarding bonus
        }

        document.dispatchEvent(new CustomEvent('auth:ready', {
          detail: { user: { ...Auth.getCurrentUser(), ...updateData } }
        }));
      } catch (err) {
        Utils.showToast('Failed to complete onboarding', 'error');
      }
    });

    // Avatar upload
    document.getElementById('change-avatar-btn')?.addEventListener('click', () => {
      document.getElementById('avatar-input')?.click();
    });

    document.getElementById('avatar-input')?.addEventListener('change', async function () {
      const file = this.files[0];
      if (!file) return;
      try {
        const compressed = await Utils.compressImage(file, 400, 0.8);
        const preview = document.getElementById('avatar-preview');
        if (preview) preview.innerHTML = '<img src="' + compressed + '" alt="Avatar">';
      } catch (err) { Utils.showToast('Failed to process image', 'error'); }
    });

    // Bio char count
    document.getElementById('onboard-bio')?.addEventListener('input', function () {
      document.getElementById('bio-count').textContent = this.value.length;
    });

    // Join tabs
    document.querySelectorAll('.join-tab').forEach(tab => {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.join-tab').forEach(t => t.classList.remove('active'));
        this.classList.add('active');
        document.querySelectorAll('.join-method').forEach(m => m.classList.remove('active'));
        document.getElementById('join-' + this.dataset.method)?.classList.add('active');
      });
    });

    // Join by code
    document.getElementById('join-by-code-btn')?.addEventListener('click', () => joinByCode());

    // School search
    document.getElementById('school-search-input')?.addEventListener('input', Utils.debounce(function () {
      searchSchools(this.value.trim());
    }, 300));

    // Create school
    document.getElementById('create-school-btn')?.addEventListener('click', createSchool);

    // Onboard skip step 3
    document.getElementById('onboard-skip-3')?.addEventListener('click', async () => {
      const user = window.Firebase.auth.currentUser;
      if (user) {
        await window.Firebase.db.collection('users').doc(user.uid).update({ isOnboarded: true });
        document.dispatchEvent(new CustomEvent('auth:ready', {
          detail: { user: Auth.getCurrentUser() }
        }));
      }
    });
  }

  function updateOnboardingUI() {
    for (let i = 1; i <= 3; i++) {
      const step = document.getElementById('onboard-step-' + i);
      if (step) step.classList.toggle('hidden', i !== onboardingStep);
    }

    document.querySelectorAll('.progress-step').forEach((el, idx) => {
      el.classList.toggle('active', idx + 1 === onboardingStep);
      el.classList.toggle('done', idx + 1 < onboardingStep);
    });

    document.querySelectorAll('.progress-fill').forEach((el, idx) => {
      el.classList.toggle('done', idx + 1 < onboardingStep);
    });
  }

  function loadInterests() {
    const interests = [
      'Technology', 'Sports', 'Music', 'Gaming', 'Art', 'Photography',
      'Science', 'Literature', 'Movies', 'Cooking', 'Travel', 'Fitness',
      'Fashion', 'Comedy', 'DIY', 'Politics', 'Business', 'Education',
      'Dance', 'Anime', 'Memes', 'Food', 'Nature', 'Coding'
    ];

    const grid = document.getElementById('interests-grid');
    if (!grid) return;
    grid.innerHTML = interests.map(i =>
      '<div class="interest-chip" data-interest="' + i + '">' + i + '</div>'
    ).join('');

    grid.addEventListener('click', function (e) {
      const chip = e.target.closest('.interest-chip');
      if (chip) chip.classList.toggle('selected');
    });
  }

  async function joinByCode() {
    const code = document.getElementById('school-code-input')?.value?.trim().toUpperCase();
    if (!code) { Utils.showToast('Enter a school code', 'warning'); return; }

    try {
      const snap = await window.Firebase.db.collection('schools').where('joinCode', '==', code).limit(1).get();
      if (snap.empty) { Utils.showToast('Invalid school code', 'error'); return; }

      const school = snap.docs[0];
      const schoolData = school.data();

      if (schoolData.maxMembers > 0 && (schoolData.memberCount || 0) >= schoolData.maxMembers) {
        Utils.showToast('School is full', 'error');
        return;
      }

      const user = window.Firebase.auth.currentUser;
      await window.Firebase.db.collection('users').doc(user.uid).update({
        schoolId: school.id,
        schoolName: schoolData.name
      });

      await window.Firebase.db.collection('schools').doc(school.id).update({
        memberCount: firebase.firestore.FieldValue.increment(1)
      });

      Utils.showToast('Joined ' + schoolData.name + '!', 'success');
      onboardingStep = 3;
      updateOnboardingUI();
    } catch (err) {
      Utils.showToast('Failed to join school', 'error');
    }
  }

  async function searchSchools(query) {
    const results = document.getElementById('school-search-results');
    if (!results || query.length < 2) { if (results) results.innerHTML = ''; return; }

    try {
      const snap = await window.Firebase.db.collection('schools')
        .orderBy('name').startAt(query).endAt(query + '\uf8ff').limit(10).get();

      if (snap.empty) { results.innerHTML = '<p style="padding:12px;color:var(--text-tertiary);font-size:14px">No schools found</p>'; return; }

      results.innerHTML = snap.docs.map(doc => {
        const s = doc.data();
        return '<div class="user-item" data-school-id="' + doc.id + '">'
          + '<div class="group-avatar-placeholder">🏫</div>'
          + '<div class="user-info"><span class="user-name">' + Utils.sanitizeHTML(s.name) + '</span>'
          + '<span class="user-handle">' + (s.location || '') + ' · ' + (s.memberCount || 0) + ' members</span></div>'
          + '<button class="btn btn-sm btn-primary join-school-btn" data-id="' + doc.id + '" data-name="' + Utils.sanitizeHTML(s.name) + '">Join</button>'
          + '</div>';
      }).join('');

      results.querySelectorAll('.join-school-btn').forEach(btn => {
        btn.addEventListener('click', async function (e) {
          e.stopPropagation();
          const schoolId = this.dataset.id;
          const schoolName = this.dataset.name;
          const user = window.Firebase.auth.currentUser;
          try {
            await window.Firebase.db.collection('users').doc(user.uid).update({ schoolId, schoolName });
            await window.Firebase.db.collection('schools').doc(schoolId).update({ memberCount: firebase.firestore.FieldValue.increment(1) });
            Utils.showToast('Joined ' + schoolName, 'success');
            onboardingStep = 3;
            updateOnboardingUI();
          } catch (err) { Utils.showToast('Failed to join', 'error'); }
        });
      });
    } catch (err) {
      results.innerHTML = '<p style="padding:12px;color:var(--text-tertiary);font-size:14px">Search failed</p>';
    }
  }

  async function createSchool() {
    const name = document.getElementById('create-school-name')?.value?.trim();
    const type = document.getElementById('create-school-type')?.value;
    const location = document.getElementById('create-school-location')?.value?.trim();

    if (!name) { Utils.showToast('Enter school name', 'warning'); return; }

    const user = window.Firebase.auth.currentUser;
    const code = 'GIOLYNK-' + Math.random().toString(36).substring(2, 6).toUpperCase();

    try {
      const schoolRef = await window.Firebase.db.collection('schools').add({
        name,
        type,
        location,
        joinCode: code,
        ownerId: user.uid,
        admins: [user.uid],
        memberCount: 1,
        maxMembers: 0,
        allowMemberPosts: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        description: '',
        schoolAvatarUrl: null
      });

      await window.Firebase.db.collection('users').doc(user.uid).update({
        schoolId: schoolRef.id,
        schoolName: name,
        role: 'owner'
      });

      Utils.showToast('School created! Code: ' + code, 'success');
      onboardingStep = 3;
      updateOnboardingUI();
    } catch (err) {
      Utils.showToast('Failed to create school', 'error');
    }
  }

  // =============================================
  // School Page
  // =============================================
  async function renderSchoolPage(params) {
    const user = Auth.getCurrentUser();
    if (!user?.schoolId) return '<div class="empty-state"><p>Join a school first</p></div>';

    const schoolDoc = await window.Firebase.db.collection('schools').doc(user.schoolId).get();
    const school = schoolDoc.exists ? schoolDoc.data() : { name: 'Unknown' };

    return `
      <div id="school-page">
        <div class="profile-cover" style="height:120px;background:linear-gradient(135deg,var(--primary),var(--accent))">
          <div style="position:absolute;bottom:16px;left:16px;color:white">
            <h2 style="font-size:22px;font-weight:800">${Utils.sanitizeHTML(school.name)}</h2>
            <p style="font-size:13px;opacity:0.85">${Utils.sanitizeHTML(school.location || '')} · ${Utils.formatNumber(school.memberCount || 0)} members</p>
          </div>
        </div>
        <div style="padding:8px 16px;display:flex;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-secondary)">
          <span style="background:var(--bg-tertiary);padding:4px 12px;border-radius:20px">Code: ${school.joinCode || 'N/A'}</span>
          <button class="btn btn-sm btn-outline" onclick="Utils.copyToClipboard('${school.joinCode || ''}').then(()=>Utils.showToast('Code copied!','success'))">Copy Code</button>
        </div>
        <div class="tabs" id="school-tabs">
          <button class="tab active" data-tab="feed">Feed</button>
          <button class="tab" data-tab="members">Members</button>
          <button class="tab" data-tab="groups">Groups</button>
          <button class="tab" data-tab="competitions">Competitions</button>
          <button class="tab" data-tab="events">Events</button>
          <button class="tab" data-tab="leaderboard">Leaderboard</button>
          ${['owner','admin','co-admin'].includes(user.role) ? '<button class="tab" data-tab="admin">Admin</button>' : ''}
        </div>
        <div id="school-content"></div>
      </div>`;
  }

  // =============================================
  // Settings Page
  // =============================================
  function renderSettingsPage(params) {
    const user = Auth.getCurrentUser();
    return `
      <div id="settings-page" style="padding-bottom:32px">
        <div class="settings-group">
          <div class="settings-group-title">Account</div>
          <div class="settings-item" data-action="edit-profile">
            <span class="settings-icon">👤</span>
            <span class="settings-label">Edit Profile</span>
            <span class="settings-chevron">›</span>
          </div>
          <div class="settings-item" data-action="friends">
            <span class="settings-icon">👥</span>
            <span class="settings-label">Friends</span>
            <span class="settings-value">${user?.friendsCount || 0}</span>
            <span class="settings-chevron">›</span>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">School</div>
          <div class="settings-item" data-action="school">
            <span class="settings-icon">🏫</span>
            <span class="settings-label">My School</span>
            <span class="settings-value">${Utils.truncate(user?.schoolName || 'Not joined', 20)}</span>
            <span class="settings-chevron">›</span>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Preferences</div>
          <div class="settings-item" id="settings-theme-toggle">
            <span class="settings-icon">🌙</span>
            <span class="settings-label">Dark Mode</span>
            <label class="toggle-label" style="margin:0">
              <input type="checkbox" id="settings-dark-toggle" ${document.body.dataset.theme === 'dark' ? 'checked' : ''}>
              <span class="toggle-switch"></span>
            </label>
          </div>
          <div class="settings-item" data-action="notifications">
            <span class="settings-icon">🔔</span>
            <span class="settings-label">Notifications</span>
            <span class="settings-chevron">›</span>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">About</div>
          <div class="settings-item"><span class="settings-icon">ℹ️</span><span class="settings-label">GIOLYNK v1.0.0</span></div>
          <div class="settings-item"><span class="settings-icon">📄</span><span class="settings-label">Terms of Service</span></div>
          <div class="settings-item"><span class="settings-icon">🔒</span><span class="settings-label">Privacy Policy</span></div>
        </div>
        <div class="settings-group">
          <div class="settings-item danger" id="logout-btn">
            <span class="settings-icon">🚪</span>
            <span class="settings-label">Sign Out</span>
          </div>
        </div>
      </div>`;
  }

  // =============================================
  // Post Detail Page
  // =============================================
  async function renderPostDetail(params) {
    if (!params?.postId) return '<div class="empty-state"><p>Post not found</p></div>';

    try {
      const doc = await window.Firebase.db.collection('posts').doc(params.postId).get();
      if (!doc.exists) return '<div class="empty-state"><p>Post not found</p></div>';

      const post = { id: doc.id, ...doc.data() };
      const authorDoc = await window.Firebase.db.collection('users').doc(post.authorId).get();
      const author = authorDoc.exists ? { id: authorDoc.id, ...authorDoc.data() } : null;
      const fullPost = { ...post, author };

      // Load comments
      const commentsSnap = await window.Firebase.db.collection('comments')
        .where('postId', '==', params.postId)
        .orderBy('createdAt', 'asc')
        .limit(50)
        .get();

      let commentsHtml = '';
      const comments = [];
      commentsSnap.forEach(d => comments.push({ id: d.id, ...d.data() }));

      // Fetch comment authors
      for (const c of comments) {
        const cAuthor = await window.Firebase.db.collection('users').doc(c.authorId).get();
        c.author = cAuthor.exists ? { id: cAuthor.id, ...cAuthor.data() } : null;
        commentsHtml += Components.renderComment(c, Auth.getCurrentUser()?.uid, 0);
      }

      return `
        <div id="post-detail-page">
          <div id="post-detail-content">${Components.renderPostCard(fullPost, Auth.getCurrentUser()?.uid)}</div>
          <div class="comments-section">
            <div class="comments-header">
              <h4>${comments.length} Comments</h4>
            </div>
            <div id="post-comments">${commentsHtml || '<p style="text-align:center;color:var(--text-tertiary);font-size:14px;padding:16px">No comments yet</p>'}</div>
            <div class="comment-input-wrap">
              <div class="post-avatar-placeholder" style="width:32px;height:32px;font-size:12px">${Utils.getInitials(Auth.getCurrentUser()?.displayName || 'U')}</div>
              <input type="text" id="comment-input" placeholder="Add a comment...">
              <button id="post-comment-btn">Post</button>
            </div>
          </div>
        </div>`;
    } catch (err) {
      return '<div class="empty-state"><p>Failed to load post</p></div>';
    }
  }

  // =============================================
  // Settings event binding (after render)
  // =============================================
  document.addEventListener('pageChange', function (e) {
    if (e.detail.page === 'settings') {
      document.querySelectorAll('#settings-page .settings-item[data-action]').forEach(item => {
        item.addEventListener('click', function () {
          const action = this.dataset.action;
          if (action === 'edit-profile') Router.navigate('edit-profile');
          else if (action === 'friends') Router.navigate('friends');
          else if (action === 'school') Router.navigate('school');
          else if (action === 'notifications') Router.navigate('notifications');
        });
      });

      document.getElementById('logout-btn')?.addEventListener('click', () => {
        Utils.showConfirm('Sign Out', 'Are you sure you want to sign out?').then(ok => {
          if (ok) Auth.signOut();
        });
      });

      document.getElementById('settings-dark-toggle')?.addEventListener('change', function () {
        const next = this.checked ? 'dark' : 'light';
        document.body.dataset.theme = next;
        localStorage.setItem('giolynk_theme', next);
        updateThemeIcon(next);
      });
    }

    if (e.detail.page === 'school') {
      const user = Auth.getCurrentUser();
      const tabs = document.getElementById('school-tabs');
      const content = document.getElementById('school-content');

      const loadSchoolTab = async (tab) => {
        if (!content) return;
        content.innerHTML = '<div style="padding:32px;text-align:center"><span class="spinner" style="display:inline-block;width:24px;height:24px;border:3px solid var(--surface-border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.6s linear infinite"></span></div>';

        if (tab === 'feed') {
          Router.navigate('home');
          return;
        } else if (tab === 'members') {
          const snap = await window.Firebase.db.collection('users').where('schoolId', '==', user.schoolId).limit(50).get();
          content.innerHTML = snap.docs.map(d => Components.renderUserItem({ id: d.id, ...d.data() }, 'View', 'follow')).join('') || '<div class="empty-state"><p>No members</p></div>';
        } else if (tab === 'groups') {
          const snap = await window.Firebase.db.collection('groups').where('schoolId', '==', user.schoolId).limit(20).get();
          content.innerHTML = snap.docs.map(d => Components.renderGroupCard({ id: d.id, ...d.data() })).join('') || '<div class="empty-state"><p>No groups yet</p></div>';
        } else if (tab === 'competitions') {
          const snap = await window.Firebase.db.collection('competitions').where('schoolId', '==', user.schoolId).orderBy('createdAt', 'desc').limit(20).get();
          content.innerHTML = snap.docs.map(d => Components.renderCompetitionCard({ id: d.id, ...d.data() })).join('') || '<div class="empty-state"><p>No competitions</p></div>';
        } else if (tab === 'events') {
          const snap = await window.Firebase.db.collection('events').where('schoolId', '==', user.schoolId).orderBy('startDate', 'asc').limit(20).get();
          content.innerHTML = snap.docs.map(d => Components.renderEventCard({ id: d.id, ...d.data() })).join('') || '<div class="empty-state"><p>No events</p></div>';
        } else if (tab === 'leaderboard') {
          if (window.Reputation) {
            const leaders = await Reputation.getLeaderboard(user.schoolId, 20);
            content.innerHTML = '<div style="padding:16px">' + leaders.map((l, i) =>
              '<div class="user-item" style="border-radius:12px;background:var(--surface);margin-bottom:4px">'
              + '<span style="font-weight:800;width:28px;text-align:center;color:' + (i < 3 ? 'var(--warning-dark)' : 'var(--text-tertiary)') + '">' + (i + 1) + '</span>'
              + '<div class="post-avatar-placeholder">' + Utils.getInitials(l.displayName || 'U') + '</div>'
              + '<div class="user-info"><span class="user-name">' + Utils.sanitizeHTML(l.displayName || 'Unknown') + '</span>'
              + '<span class="user-handle">Level ' + (l.level || 1) + ' · ' + (l.xp || 0) + ' XP</span></div>'
              + '<span style="font-weight:700;color:var(--warning-dark)">💰 ' + (l.coins || 0) + '</span></div>'
            ).join('') + '</div>' || '<div class="empty-state"><p>No leaderboard data</p></div>';
          }
        } else if (tab === 'admin') {
          Router.navigate('admin');
        }
      };

      tabs?.addEventListener('click', function (e) {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        this.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        loadSchoolTab(tab.dataset.tab);
      });

      loadSchoolTab('feed');
    }

    // Post detail: comment submission
    if (e.detail.page === 'post-detail') {
      document.getElementById('post-comment-btn')?.addEventListener('click', async function () {
        const input = document.getElementById('comment-input');
        const text = input?.value?.trim();
        if (!text) return;

        const user = Auth.getCurrentUser();
        try {
          await window.Firebase.db.collection('comments').add({
            postId: e.detail.params.postId,
            authorId: user.uid,
            text: Utils.sanitizeHTML(text),
            parentId: null,
            likes: 0,
            replyCount: 0,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            deleted: false
          });

          await window.Firebase.db.collection('posts').doc(e.detail.params.postId).update({
            commentCount: firebase.firestore.FieldValue.increment(1)
          });

          input.value = '';
          if (window.Reputation) Reputation.awardXP(user.uid, 2, 'comment_added');
          Utils.showToast('Comment added', 'success');

          // Reload
          Router.navigate('post-detail', { postId: e.detail.params.postId });
        } catch (err) {
          Utils.showToast('Failed to comment', 'error');
        }
      });
    }
  });

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();