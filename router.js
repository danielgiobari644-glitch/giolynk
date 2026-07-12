/**
 * GIOLYNK - SPA Router
 * Manages page navigation, history, bottom nav state, and page rendering.
 * Pages register their render functions via Router.registerPage().
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  const historyStack = [];
  let currentPage = null;
  let currentParams = {};
  let pageRenderers = {};   // { pageName: async (params) => htmlString }
  let isNavigating = false;

  // ── Default page list ─────────────────────────────────────────────────────
  const KNOWN_PAGES = [
    'home', 'discover', 'chats', 'profile', 'school', 'settings',
    'notifications', 'user-profile', 'post-detail', 'chat-view',
    'group', 'group-chat', 'competition-detail', 'event-detail',
    'create-competition', 'create-event', 'create-group', 'admin',
    'edit-profile', 'friends'
  ];

  // Pages shown in the bottom nav (maps to their nav button data-page)
  const BOTTOM_NAV_PAGES = new Set(['home', 'discover', 'chats', 'profile']);

  // ── Page title map ────────────────────────────────────────────────────────
  const PAGE_TITLES = {
    home:                'GIOLYNK',
    discover:            'Discover',
    chats:               'Chats',
    profile:             'Profile',
    school:              'School',
    settings:            'Settings',
    notifications:       'Notifications',
    'user-profile':      'Profile',
    'post-detail':       'Post',
    'chat-view':         'Chat',
    group:               'Group',
    'group-chat':        'Group Chat',
    'competition-detail':'Competition',
    'event-detail':      'Event',
    'create-competition':'New Competition',
    'create-event':      'New Event',
    'create-group':      'New Group',
    admin:               'Admin',
    'edit-profile':      'Edit Profile',
    friends:             'Friends'
  };

  // ── DOM references ────────────────────────────────────────────────────────
  let pageContent, bottomNav, pageTitle, createFab;

  function cacheDOM() {
    pageContent = document.getElementById('page-content');
    bottomNav   = document.getElementById('bottom-nav');
    pageTitle   = document.getElementById('page-title');
    createFab   = document.getElementById('create-fab');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function updateBottomNav(page) {
    if (!bottomNav) return;

    const navItems = bottomNav.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      const navPage = item.dataset.page;
      if (navPage && navPage === page) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Hide bottom nav on detail / inner pages
    const isMainPage = BOTTOM_NAV_PAGES.has(page);
    bottomNav.classList.toggle('hidden', !isMainPage);
  }

  function updateTopBarTitle(page) {
    if (!pageTitle) return;
    pageTitle.textContent = PAGE_TITLES[page] || 'GIOLYNK';
  }

  function updateFAB(page) {
    if (!createFab) return;
    // Show FAB only on feed-like pages where creating posts makes sense
    const fabPages = new Set(['home', 'discover', 'group']);
    createFab.classList.toggle('hidden', !fabPages.has(page));
  }

  /**
   * Insert HTML into #page-content and scroll to top.
   */
  function renderContent(html) {
    if (!pageContent) return;
    pageContent.innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  /**
   * Navigate to a page.
   * @param {string} page   – The page name (must be registered).
   * @param {Object} params – Optional page parameters (e.g. { userId, postId }).
   */
  async function navigate(page, params = {}) {
    if (isNavigating) return;
    if (!pageRenderers[page]) {
      console.warn(`[Router] No renderer registered for page "${page}".`);
      return;
    }

    isNavigating = true;

    try {
      // Push current page onto history (skip if same page)
      if (currentPage && currentPage !== page) {
        historyStack.push({ page: currentPage, params: currentParams });
      }

      // Update state
      currentPage = page;
      currentParams = params;

      // Update UI
      updateBottomNav(page);
      updateTopBarTitle(page);
      updateFAB(page);

      // Update browser URL (hash-based routing)
      const hash = params._hash || `/${page}`;
      if (!params._skipPush) {
        try {
          window.history.pushState({ page, params }, '', '#' + hash);
        } catch (_) {
          // ignore in environments without history support
        }
      }

      // Emit pre-change event
      window.dispatchEvent(new CustomEvent('page:beforeChange', {
        detail: { page, params, previousPage: historyStack.length > 0 ? historyStack[historyStack.length - 1].page : null }
      }));

      // Render page (supports async)
      const html = await pageRenderers[page](params);
      renderContent(html);

      // Emit post-change event
      window.dispatchEvent(new CustomEvent('pageChange', { detail: { page, params } }));
    } catch (err) {
      console.error(`[Router] Error navigating to "${page}":`, err);
      renderContent(`
        <div class="error-page">
          <h2>Something went wrong</h2>
          <p>${err.message || 'Failed to load page.'}</p>
          <button class="btn btn-primary" onclick="window.Router.navigate('home')">Go Home</button>
        </div>
      `);
    } finally {
      isNavigating = false;
    }
  }

  /**
   * Go back to the previous page in the history stack.
   * Falls back to 'home' if the stack is empty.
   */
  function goBack() {
    if (historyStack.length === 0) {
      navigate('home');
      return;
    }

    const prev = historyStack.pop();
    // Navigate without pushing to history again
    navigate(prev.page, { ...prev.params, _skipPush: true });
  }

  /**
   * Return the current page name.
   */
  function getCurrentPage() {
    return currentPage;
  }

  /**
   * Return the current page parameters.
   */
  function getParams() {
    return currentParams;
  }

  /**
   * Register a page renderer function.
   * @param {string}   name       – Page name.
   * @param {Function} renderFn   – async (params) => htmlString
   */
  function registerPage(name, renderFn) {
    if (typeof renderFn !== 'function') {
      console.error(`[Router] registerPage: renderFn must be a function for "${name}".`);
      return;
    }
    pageRenderers[name] = renderFn;
  }

  /**
   * Register multiple page renderers at once.
   * @param {Object} map – { pageName: renderFn, ... }
   */
  function registerPages(map) {
    Object.entries(map).forEach(([name, fn]) => registerPage(name, fn));
  }

  /**
   * Update the top bar title dynamically (e.g. a user's name on their profile).
   */
  function setPageTitle(title) {
    if (pageTitle) pageTitle.textContent = title;
  }

  // ── Popstate (browser back button) ────────────────────────────────────────

  function handlePopState(event) {
    // If we have history, go back using our stack
    if (historyStack.length > 0) {
      goBack();
      return;
    }

    // Otherwise, navigate to home
    navigate('home', { _skipPush: true });
  }

  // ── Bottom Nav Click Handler ──────────────────────────────────────────────

  function initBottomNav() {
    if (!bottomNav) return;

    bottomNav.addEventListener('click', (e) => {
      const navItem = e.target.closest('.nav-item');
      if (!navItem) return;

      const page = navItem.dataset.page;

      // The "create" button is special – it opens the create modal, not a page
      if (page === 'create') {
        window.dispatchEvent(new CustomEvent('openCreateModal'));
        return;
      }

      if (page && pageRenderers[page]) {
        // Reset history stack when switching main tabs
        historyStack.length = 0;
        navigate(page, { _skipPush: true });
      }
    });
  }

  // ── Initialization ────────────────────────────────────────────────────────

  function init() {
    cacheDOM();
    initBottomNav();

    // Listen for browser back button
    window.addEventListener('popstate', handlePopState);

    // Parse initial hash if present
    const initialHash = window.location.hash.replace('#', '').replace(/^\//, '');
    if (initialHash) {
      // Try to find a matching page
      const matchPage = KNOWN_PAGES.find(p => p === initialHash);
      if (matchPage) {
        // Deferred: wait for pages to be registered by app.js
        const waitForReady = setInterval(() => {
          if (pageRenderers[matchPage]) {
            clearInterval(waitForReady);
            navigate(matchPage, { _skipPush: true });
          }
        }, 100);
        // Safety: stop trying after 5 seconds
        setTimeout(() => clearInterval(waitForReady), 5000);
        return;
      }
    }

    // Default: navigate to home (deferred until page renderers are registered)
    const waitForHome = setInterval(() => {
      if (pageRenderers['home']) {
        clearInterval(waitForHome);
        navigate('home', { _skipPush: true });
      }
    }, 100);
    setTimeout(() => clearInterval(waitForHome), 5000);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.Router = {
    init,
    navigate,
    goBack,
    getCurrentPage,
    getParams,
    registerPage,
    registerPages,
    setPageTitle,
    KNOWN_PAGES,
    BOTTOM_NAV_PAGES
  };
})();