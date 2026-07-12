/**
 * GIOLYNK - Chat Module
 * Handles the entire chat/messaging system.
 * Firestore for conversation metadata and messages.
 * Realtime Database for typing indicators, presence, and seen status.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _conversationsCache = [];
  let _activeTab = 'all';           // 'all' | 'unread' | 'groups'
  let _searchQuery = '';
  let _listeners = [];              // active Firestore / RTDB unsubscribers
  let _messageListeners = [];       // per-conversation message listeners
  let _typingTimeout = null;
  let _isNearBottom = true;         // track scroll position for auto-scroll
  let _oldestMessageDoc = null;     // for paginating older messages
  let _isLoadingMore = false;
  let _hasMoreMessages = true;
  let _replyingTo = null;           // { messageId, text, senderName }
  let _emojiPickerOpen = false;
  let _currentUserDoc = null;
  let _conversationsFetched = false;

  // Common emojis for the quick-pick grid
  const EMOJI_GRID = [
    '😀','😂','🥹','😍','🥰','😎','🤩','🥳',
    '😢','😤','😡','🤔','🤫','😴','🤮','💀',
    '❤️','🔥','👍','👎','👏','🙏','💪','✌️',
    '🎉','🎊','💯','⭐','🌈','🌹','🍕','🎵'
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────

  function currentUser() {
    return window.Firebase.auth.currentUser;
  }

  function currentUserId() {
    const u = currentUser();
    return u ? u.uid : null;
  }

  function currentUserProfile() {
    return _currentUserDoc;
  }

  /**
   * Fetch the current user's Firestore profile if not yet cached.
   * @returns {Promise<Object|null>}
   */
  async function ensureCurrentUserDoc() {
    if (_currentUserDoc) return _currentUserDoc;
    const uid = currentUserId();
    if (!uid) return null;
    try {
      const doc = await window.Firebase.db.collection('users').doc(uid).get();
      if (doc.exists) {
        _currentUserDoc = { uid: doc.id, ...doc.data() };
      }
    } catch (err) {
      console.error('[Chat] Failed to load current user profile:', err);
    }
    return _currentUserDoc;
  }

  /**
   * Convert a Firestore timestamp / Date to a JS Date.
   */
  function toDate(val) {
    if (!val) return null;
    if (val && typeof val.toDate === 'function') return val.toDate();
    if (val instanceof Date) return val;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Check if two dates fall on the same calendar day.
   */
  function isSameDay(d1, d2) {
    if (!d1 || !d2) return false;
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
  }

  /**
   * Check if a date is "today".
   */
  function isToday(d) {
    return isSameDay(d, new Date());
  }

  /**
   * Check if a date is "yesterday".
   */
  function isYesterday(d) {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return isSameDay(d, y);
  }

  /**
   * Register a cleanup function so listeners can be torn down later.
   */
  function addListener(unsub) {
    if (typeof unsub === 'function') {
      _listeners.push(unsub);
    }
  }

  /**
   * Unsubscribe all active listeners.
   */
  function unsubscribeAll() {
    _listeners.forEach(fn => { try { fn(); } catch (_) {} });
    _listeners = [];
    _messageListeners.forEach(fn => { try { fn(); } catch (_) {} });
    _messageListeners = [];
  }

  /**
   * Render a date divider string.
   */
  function renderDateDivider(date) {
    const d = toDate(date);
    if (!d) return '';
    let label;
    if (isToday(d)) label = 'Today';
    else if (isYesterday(d)) label = 'Yesterday';
    else label = Utils.formatDate(d);
    return `<div class="date-divider"><span>${Utils.sanitizeHTML(label)}</span></div>`;
  }

  // ── Conversation List Page ────────────────────────────────────────────────

  /**
   * render() – Returns a Promise resolving to the chats list page HTML.
   * @param {Object} params
   * @returns {Promise<string>}
   */
  async function render(params) {
    const user = currentUser();
    if (!user) {
      return `<div class="empty-state"><p>Please sign in to view chats.</p></div>`;
    }

    await ensureCurrentUserDoc();

    const skeletonCount = 6;
    const skeletons = Array(skeletonCount).fill(Components.renderSkeletonChat()).join('');

    const html = `
      <div class="chat-list-page">
        <div class="chat-search-bar">
          <div class="search-input-wrap">
            <span class="search-icon">🔍</span>
            <input type="text" id="chat-search-input" placeholder="Search conversations..." autocomplete="off">
            <button class="search-clear-btn hidden" id="chat-search-clear">&times;</button>
          </div>
        </div>

        <div class="chat-tabs">
          <button class="chat-tab ${_activeTab === 'all' ? 'active' : ''}" data-tab="all">All</button>
          <button class="chat-tab ${_activeTab === 'unread' ? 'active' : ''}" data-tab="unread">Unread</button>
          <button class="chat-tab ${_activeTab === 'groups' ? 'active' : ''}" data-tab="groups">Groups</button>
        </div>

        <div id="chat-list" class="chat-list">
          ${skeletons}
        </div>

        <button class="fab" id="new-chat-fab" aria-label="New message" title="New message">✉️</button>
      </div>
    `;

    // Defer data loading until after DOM insertion
    setTimeout(() => {
      bindChatListEvents();
      loadConversations();
      listenForUnreadCounts();
      setupPresence();
    }, 0);

    return html;
  }

  /**
   * Bind event listeners for the chats list page.
   */
  function bindChatListEvents() {
    const searchInput = document.getElementById('chat-search-input');
    const searchClear = document.getElementById('chat-search-clear');
    const tabsContainer = document.querySelector('.chat-tabs');
    const fab = document.getElementById('new-chat-fab');

    if (searchInput) {
      searchInput.addEventListener('input', Utils.debounce(function () {
        _searchQuery = this.value.trim().toLowerCase();
        if (_searchQuery) {
          searchClear && searchClear.classList.remove('hidden');
        } else {
          searchClear && searchClear.classList.add('hidden');
        }
        renderConversationList(_conversationsCache);
      }, 250));
    }

    if (searchClear) {
      searchClear.addEventListener('click', () => {
        if (searchInput) {
          searchInput.value = '';
          _searchQuery = '';
          searchClear.classList.add('hidden');
          renderConversationList(_conversationsCache);
        }
      });
    }

    if (tabsContainer) {
      tabsContainer.addEventListener('click', (e) => {
        const tab = e.target.closest('.chat-tab');
        if (!tab) return;
        _activeTab = tab.dataset.tab;
        tabsContainer.querySelectorAll('.chat-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderConversationList(_conversationsCache);
      });
    }

    if (fab) {
      fab.addEventListener('click', () => startNewChat());
    }
  }

  // ── Load Conversations ────────────────────────────────────────────────────

  /**
   * Fetch conversations from Firestore where currentUser is a participant.
   */
  async function loadConversations() {
    const uid = currentUserId();
    if (!uid) return;

    try {
      const snap = await window.Firebase.db
        .collection('conversations')
        .where('participants', 'array-contains', uid)
        .orderBy('lastMessageAt', 'desc')
        .get();

      const conversations = [];

      for (const doc of snap.docs) {
        const data = doc.data();
        const conv = {
          id: doc.id,
          ...data,
          lastMessageAt: toDate(data.lastMessageAt)
        };

        // Fetch last message
        try {
          const msgSnap = await window.Firebase.db
            .collection('conversations')
            .doc(doc.id)
            .collection('messages')
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();

          if (!msgSnap.empty) {
            const msgDoc = msgSnap.docs[0];
            const msgData = msgDoc.data();
            conv.lastMessage = {
              id: msgDoc.id,
              ...msgData,
              createdAt: toDate(msgData.createdAt)
            };
          }
        } catch (err) {
          console.warn(`[Chat] Failed to fetch last message for ${doc.id}:`, err);
        }

        // Fetch unread count from Realtime Database
        try {
          const unreadSnap = await window.Firebase.rtdb
            .ref(`/unread/${uid}/${doc.id}`)
            .once('value');
          conv.unreadCount = unreadSnap.val() || 0;
        } catch (err) {
          conv.unreadCount = 0;
        }

        // For 1-on-1, fetch the other user's profile
        if (!data.isGroup) {
          const otherUserId = (data.participants || []).find(p => p !== uid);
          if (otherUserId) {
            try {
              const userDoc = await window.Firebase.db.collection('users').doc(otherUserId).get();
              if (userDoc.exists) {
                conv.otherUser = { uid: userDoc.id, ...userDoc.data() };
              }
            } catch (_) {}
          }
        }

        conversations.push(conv);
      }

      _conversationsCache = conversations;
      _conversationsFetched = true;
      renderConversationList(conversations);
    } catch (err) {
      console.error('[Chat] loadConversations error:', err);
      const list = document.getElementById('chat-list');
      if (list) {
        list.innerHTML = `
          <div class="empty-state">
            <p>Failed to load conversations.</p>
            <button class="btn btn-outline btn-sm" onclick="Chat.loadConversations()">Retry</button>
          </div>`;
      }
    }
  }

  // ── Render Conversation List ──────────────────────────────────────────────

  /**
   * Render conversation list items, applying current tab and search filters.
   * @param {Array} conversations
   */
  function renderConversationList(conversations) {
    const list = document.getElementById('chat-list');
    if (!list) return;

    let filtered = conversations;

    // Tab filter
    if (_activeTab === 'unread') {
      filtered = filtered.filter(c => (c.unreadCount || 0) > 0);
    } else if (_activeTab === 'groups') {
      filtered = filtered.filter(c => c.isGroup === true);
    }

    // Search filter
    if (_searchQuery) {
      filtered = filtered.filter(c => {
        const name = c.isGroup
          ? (c.name || '').toLowerCase()
          : ((c.otherUser && c.otherUser.displayName) || '').toLowerCase();
        const username = (!c.isGroup && c.otherUser && c.otherUser.username)
          ? c.otherUser.username.toLowerCase() : '';
        return name.includes(_searchQuery) || username.includes(_searchQuery);
      });
    }

    if (filtered.length === 0) {
      const emptyMsg = _searchQuery
        ? 'No conversations found.'
        : _activeTab === 'unread'
          ? 'No unread messages.'
          : _activeTab === 'groups'
            ? 'No group chats yet.'
            : 'No conversations yet.';
      list.innerHTML = `
        <div class="empty-state">
          <p>${Utils.sanitizeHTML(emptyMsg)}</p>
          ${!_searchQuery && _activeTab === 'all'
            ? '<button class="btn btn-primary btn-sm" onclick="Chat.startNewChat()">Start a Chat</button>'
            : ''}
        </div>`;
      return;
    }

    const me = currentUserProfile();
    list.innerHTML = filtered.map(conv => Components.renderChatItem(conv, me)).join('');

    // Click handler to navigate to chat-view
    list.querySelectorAll('.chat-item').forEach(el => {
      el.addEventListener('click', () => {
        const convId = el.dataset.chatId;
        if (convId) {
          Router.navigate('chat-view', { conversationId: convId });
        }
      });
    });
  }

  // ── Search Conversations ──────────────────────────────────────────────────

  /**
   * Filter conversations by name/username of the other participant.
   * @param {string} query
   */
  function searchConversations(query) {
    _searchQuery = (query || '').trim().toLowerCase();
    renderConversationList(_conversationsCache);
  }

  // ── Chat View Page ────────────────────────────────────────────────────────

  /**
   * renderChatView() – Returns a Promise resolving to HTML for a single chat view.
   * @param {Object} params  – Must include conversationId.
   * @returns {Promise<string>}
   */
  async function renderChatView(params) {
    const { conversationId } = params;
    if (!conversationId) {
      return `<div class="empty-state"><p>Conversation not found.</p></div>`;
    }

    const uid = currentUserId();
    if (!uid) {
      return `<div class="empty-state"><p>Please sign in.</p></div>`;
    }

    await ensureCurrentUserDoc();

    // Fetch conversation metadata
    let convData;
    try {
      const doc = await window.Firebase.db.collection('conversations').doc(conversationId).get();
      if (!doc.exists) {
        return `<div class="empty-state"><p>Conversation not found.</p></div>`;
      }
      convData = { id: doc.id, ...doc.data() };
    } catch (err) {
      console.error('[Chat] Failed to load conversation:', err);
      return `<div class="empty-state"><p>Failed to load conversation.</p></div>`;
    }

    // Determine header info
    const isGroup = convData.isGroup === true;
    let displayName = 'Unknown';
    let avatarUrl = '';
    let memberCount = '';

    if (isGroup) {
      displayName = convData.name || 'Group Chat';
      avatarUrl = convData.groupAvatarUrl || '';
      const count = (convData.participants || []).length;
      memberCount = `${count} member${count !== 1 ? 's' : ''}`;
    } else {
      const otherUid = (convData.participants || []).find(p => p !== uid);
      if (otherUid) {
        try {
          const userDoc = await window.Firebase.db.collection('users').doc(otherUid).get();
          if (userDoc.exists) {
            const ud = userDoc.data();
            displayName = ud.displayName || 'Unknown';
            avatarUrl = ud.avatarUrl || '';
          }
        } catch (_) {}
      }
    }

    const avatarHtml = avatarUrl
      ? `<img src="${Utils.sanitizeHTML(avatarUrl)}" alt="" class="avatar">`
      : `<div class="avatar avatar-placeholder">${Utils.getInitials(displayName)}</div>`;

    const subLabel = isGroup ? memberCount : '<span class="presence-label" id="chat-presence-label">offline</span>';

    const html = `
      <div class="chat-view-page" data-conversation-id="${conversationId}">
        <div class="chat-header">
          <button class="btn-back" id="chat-back-btn" aria-label="Back">←</button>
          <div class="chat-header-user" id="chat-header-info">
            ${avatarHtml}
            <div class="chat-header-details">
              <span class="chat-header-name">${Utils.sanitizeHTML(displayName)}</span>
              <span class="chat-header-sub">${subLabel}</span>
            </div>
          </div>
          ${isGroup ? `<button class="icon-btn" id="chat-group-settings-btn" aria-label="Group settings">⚙️</button>` : ''}
          <button class="icon-btn" id="chat-more-btn" aria-label="More options">⋮</button>
        </div>

        <div class="reply-bar hidden" id="reply-bar">
          <div class="reply-bar-content">
            <span class="reply-bar-name" id="reply-bar-name"></span>
            <span class="reply-bar-text" id="reply-bar-text"></span>
          </div>
          <button class="reply-bar-close" id="reply-bar-close" aria-label="Cancel reply">&times;</button>
        </div>

        <div id="messages-container" class="messages-container">
          <div class="messages-loading">
            <div class="loader-bar"></div>
          </div>
        </div>

        <div class="typing-indicator hidden" id="typing-indicator">
          <span class="typing-dots"><span></span><span></span><span></span></span>
          <span class="typing-text" id="typing-text">typing...</span>
        </div>

        <div class="emoji-picker hidden" id="emoji-picker">
          <div class="emoji-grid">
            ${EMOJI_GRID.map(e => `<button class="emoji-btn" data-emoji="${e}">${e}</button>`).join('')}
          </div>
        </div>

        <div class="chat-input-bar">
          <button class="chat-input-btn" id="emoji-toggle-btn" aria-label="Emoji">😊</button>
          <label class="chat-input-btn" id="attachment-btn" aria-label="Attach image">
            📎
            <input type="file" id="chat-image-input" accept="image/*" class="hidden">
          </label>
          <textarea
            id="chat-message-input"
            class="chat-message-input"
            placeholder="Message..."
            rows="1"
            autocomplete="off"
          ></textarea>
          <button class="chat-send-btn disabled" id="chat-send-btn" aria-label="Send">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    // Defer binding until DOM is ready
    setTimeout(() => {
      bindChatViewEvents(conversationId, convData);
      loadMessages(conversationId);
      listenForMessages(conversationId);
      listenForTyping(conversationId);
      if (!isGroup) {
        const otherUid = (convData.participants || []).find(p => p !== uid);
        if (otherUid) listenForPresence(otherUid);
      }
      markAsSeen(conversationId);
    }, 0);

    return html;
  }

  // ── Group Chat View ───────────────────────────────────────────────────────

  /**
   * renderGroupChatView() – Similar to renderChatView but with group-specific UI.
   * @param {Object} params  – Must include conversationId.
   * @returns {Promise<string>}
   */
  async function renderGroupChatView(params) {
    // Group chat view reuses the same layout as chat-view with extra group settings
    return renderChatView(params);
  }

  // ── Chat View Event Binding ───────────────────────────────────────────────

  /**
   * Bind all event listeners for a chat view.
   */
  function bindChatViewEvents(conversationId, convData) {
    const page = document.querySelector('.chat-view-page');
    if (!page) return;

    // Back button
    const backBtn = page.querySelector('#chat-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', () => Router.goBack());
    }

    // Send button
    const sendBtn = page.querySelector('#chat-send-btn');
    const input = page.querySelector('#chat-message-input');

    if (sendBtn && input) {
      // Auto-expand textarea
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        sendBtn.classList.toggle('disabled', !input.value.trim());
        setTyping(conversationId);
      });

      // Send on Enter, newline on Shift+Enter
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const text = input.value.trim();
          if (text) {
            sendMessage(conversationId, text, 'text');
            input.value = '';
            input.style.height = 'auto';
            sendBtn.classList.add('disabled');
            clearReply();
          }
        }
      });

      // Send button click
      sendBtn.addEventListener('click', () => {
        const text = input.value.trim();
        if (text) {
          sendMessage(conversationId, text, 'text');
          input.value = '';
          input.style.height = 'auto';
          sendBtn.classList.add('disabled');
          clearReply();
          input.focus();
        }
      });
    }

    // Emoji toggle
    const emojiBtn = page.querySelector('#emoji-toggle-btn');
    const emojiPicker = page.querySelector('#emoji-picker');
    if (emojiBtn && emojiPicker) {
      emojiBtn.addEventListener('click', () => {
        _emojiPickerOpen = !_emojiPickerOpen;
        emojiPicker.classList.toggle('hidden', !_emojiPickerOpen);
        emojiBtn.textContent = _emojiPickerOpen ? '🔒' : '😊';
      });

      emojiPicker.addEventListener('click', (e) => {
        const btn = e.target.closest('.emoji-btn');
        if (btn && input) {
          input.value += btn.dataset.emoji;
          input.dispatchEvent(new Event('input'));
          input.focus();
        }
      });
    }

    // Image attachment
    const imageInput = page.querySelector('#chat-image-input');
    if (imageInput) {
      imageInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          handleImageSend(conversationId, file);
          imageInput.value = '';
        }
      });
    }

    // Reply bar
    const replyClose = page.querySelector('#reply-bar-close');
    if (replyClose) {
      replyClose.addEventListener('click', clearReply);
    }

    // More options (context menu for selected message)
    const moreBtn = page.querySelector('#chat-more-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        showChatContextMenu(conversationId, convData);
      });
    }

    // Group settings button
    const groupSettingsBtn = page.querySelector('#chat-group-settings-btn');
    if (groupSettingsBtn) {
      groupSettingsBtn.addEventListener('click', () => {
        showGroupSettings(conversationId, convData);
      });
    }

    // Scroll handling: load more on scroll up, track near-bottom
    const container = page.querySelector('#messages-container');
    if (container) {
      container.addEventListener('scroll', Utils.throttle(() => {
        _isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
        if (container.scrollTop < 80 && _hasMoreMessages && !_isLoadingMore) {
          loadMoreMessages(conversationId);
        }
      }, 200));
    }

    // Close emoji picker when tapping outside
    document.addEventListener('click', (e) => {
      if (_emojiPickerOpen && emojiPicker && !emojiPicker.contains(e.target) && e.target !== emojiBtn) {
        _emojiPickerOpen = false;
        emojiPicker.classList.add('hidden');
        if (emojiBtn) emojiBtn.textContent = '😊';
      }
    });
  }

  // ── Load Messages ─────────────────────────────────────────────────────────

  /**
   * Fetch initial messages from Firestore and render them with date dividers.
   * @param {string} conversationId
   */
  async function loadMessages(conversationId) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    const uid = currentUserId();
    if (!uid) return;

    try {
      const snap = await window.Firebase.db
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();

      if (snap.empty) {
        container.innerHTML = `<div class="empty-state"><p>No messages yet. Say hi! 👋</p></div>`;
        _hasMoreMessages = false;
        return;
      }

      // Store oldest doc for pagination
      const docs = snap.docs;
      _oldestMessageDoc = docs[docs.length - 1];
      _hasMoreMessages = docs.length >= 50;

      // Reverse to get ascending order
      const messages = [];
      docs.reverse().forEach(doc => {
        const data = doc.data();
        messages.push({
          id: doc.id,
          ...data,
          createdAt: toDate(data.createdAt)
        });
      });

      renderMessagesList(container, messages, uid);

      // Mark unread messages as seen
      markAsSeen(conversationId);

      // Scroll to bottom
      scrollToBottom(container);
    } catch (err) {
      console.error('[Chat] loadMessages error:', err);
      container.innerHTML = `<div class="empty-state"><p>Failed to load messages.</p></div>`;
    }
  }

  /**
   * Render an array of message objects into a container with date dividers.
   * @param {HTMLElement} container
   * @param {Array} messages
   * @param {string} uid  – Current user ID
   */
  function renderMessagesList(container, messages, uid) {
    let html = '';
    let lastDate = null;

    messages.forEach(msg => {
      const msgDate = toDate(msg.createdAt);

      // Skip deleted messages for rendering (show "deleted" placeholder)
      if (msg.deleted === true) {
        const isMine = msg.senderId === uid;
        html += `
          <div class="message-bubble message-${isMine ? 'mine' : 'theirs'} message-deleted" data-message-id="${msg.id}">
            <p class="message-text message-deleted-text"><em>Message deleted</em></p>
          </div>`;
        lastDate = msgDate;
        return;
      }

      // Date divider
      if (msgDate && (!lastDate || !isSameDay(lastDate, msgDate))) {
        html += renderDateDivider(msgDate);
      }
      lastDate = msgDate;

      const isMine = msg.senderId === uid;
      html += renderSingleMessage(msg, isMine);
    });

    container.innerHTML = html;

    // Bind long-press / context menu on messages
    bindMessageActions(container, uid);
  }

  /**
   * Render a single message bubble (with reply reference and reactions).
   */
  function renderSingleMessage(msg, isMine) {
    const u = Utils;
    const side = isMine ? 'mine' : 'theirs';

    // Content
    let contentHtml = '';
    if (msg.type === 'image' && msg.text) {
      contentHtml = `<img src="${u.sanitizeHTML(msg.text)}" alt="Image" class="message-image" loading="lazy" onclick="window.openImageViewer && window.openImageViewer('${msg.text}')">`;
    } else {
      contentHtml = `<p class="message-text">${u.sanitizeHTML(msg.text || '')}</p>`;
    }

    // Reply reference
    let replyHtml = '';
    if (msg.replyTo) {
      const replyName = msg.replyTo.senderName || 'Unknown';
      const replyText = u.truncate(msg.replyTo.text || '', 50);
      replyHtml = `
        <div class="message-reply-ref">
          <span class="reply-ref-name">${u.sanitizeHTML(replyName)}</span>
          <span class="reply-ref-text">${u.sanitizeHTML(replyText)}</span>
        </div>`;
    }

    // Sender name (for groups)
    const senderName = !isMine && msg.senderName
      ? `<span class="message-sender">${u.sanitizeHTML(msg.senderName)}</span>`
      : '';

    // Status indicator
    let statusHtml = '';
    if (isMine) {
      if (msg.status === 'read' || msg.read) {
        statusHtml = '<span class="message-status read">✓✓</span>';
      } else if (msg.status === 'delivered') {
        statusHtml = '<span class="message-status delivered">✓✓</span>';
      } else {
        statusHtml = '<span class="message-status">✓</span>';
      }
    }

    // Edited indicator
    const editedHtml = msg.edited ? '<span class="message-edited">(edited)</span>' : '';

    // Reactions
    let reactionsHtml = '';
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
      const reactionEntries = Object.entries(msg.reactions);
      const reactionStr = reactionEntries
        .filter(([, users]) => users && users.length > 0)
        .map(([emoji, users]) => {
          const uids = currentUserId();
          const isMine = users.includes(uids);
          return `<span class="message-reaction ${isMine ? 'mine' : ''}" data-emoji="${emoji}">${emoji} ${users.length > 1 ? users.length : ''}</span>`;
        }).join('');
      if (reactionStr) {
        reactionsHtml = `<div class="message-reactions">${reactionStr}</div>`;
      }
    }

    return `
      <div class="message-bubble message-${side}" data-message-id="${msg.id}" data-sender-id="${msg.senderId}">
        ${senderName}
        ${replyHtml}
        ${contentHtml}
        <span class="message-meta">
          <span class="message-time">${u.formatTime(msg.createdAt)}</span>
          ${editedHtml}
          ${statusHtml}
        </span>
        ${reactionsHtml}
      </div>`;
  }

  /**
   * Bind context menu actions on message bubbles (long-press or click).
   */
  function bindMessageActions(container, uid) {
    container.querySelectorAll('.message-bubble').forEach(bubble => {
      let pressTimer = null;

      const showMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const msgId = bubble.dataset.messageId;
        const senderId = bubble.dataset.senderId;
        if (msgId) {
          showMessageContextMenu(e, msgId, senderId === uid, bubble);
        }
      };

      // Long press for mobile
      bubble.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => {
          showMenu(new Event('contextmenu'));
        }, 500);
      }, { passive: true });

      bubble.addEventListener('touchend', () => clearTimeout(pressTimer));
      bubble.addEventListener('touchmove', () => clearTimeout(pressTimer));

      // Right-click for desktop
      bubble.addEventListener('contextmenu', showMenu);
    });
  }

  // ── Load More Messages (Scroll Up) ────────────────────────────────────────

  /**
   * Load older messages when user scrolls to the top.
   * @param {string} conversationId
   */
  async function loadMoreMessages(conversationId) {
    if (_isLoadingMore || !_hasMoreMessages || !_oldestMessageDoc) return;

    _isLoadingMore = true;
    const container = document.getElementById('messages-container');
    if (!container) { _isLoadingMore = false; return; }

    const uid = currentUserId();
    if (!uid) { _isLoadingMore = false; return; }

    try {
      const snap = await window.Firebase.db
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .startAfter(_oldestMessageDoc)
        .limit(30)
        .get();

      if (snap.empty) {
        _hasMoreMessages = false;
        _isLoadingMore = false;
        return;
      }

      const docs = snap.docs;
      _oldestMessageDoc = docs[docs.length - 1];
      if (docs.length < 30) _hasMoreMessages = false;

      // Reverse for ascending order
      const messages = [];
      docs.reverse().forEach(doc => {
        const data = doc.data();
        messages.push({
          id: doc.id,
          ...data,
          createdAt: toDate(data.createdAt)
        });
      });

      // Prepend messages, preserving current scroll position
      const prevScrollHeight = container.scrollHeight;

      let html = '';
      let lastDate = null;

      // Determine the date of the first existing message for divider continuity
      const existingFirst = container.querySelector('.message-bubble, .date-divider');
      let existingFirstDate = null;
      if (existingFirst) {
        if (existingFirst.classList.contains('date-divider')) {
          // Parse approximate date from the divider text – skip
        } else {
          // We don't easily know; just include all date dividers
        }
      }

      messages.forEach(msg => {
        const msgDate = toDate(msg.createdAt);

        if (msg.deleted === true) {
          const isMine = msg.senderId === uid;
          html += `
            <div class="message-bubble message-${isMine ? 'mine' : 'theirs'} message-deleted" data-message-id="${msg.id}">
              <p class="message-text message-deleted-text"><em>Message deleted</em></p>
            </div>`;
          lastDate = msgDate;
          return;
        }

        if (msgDate && (!lastDate || !isSameDay(lastDate, msgDate))) {
          html += renderDateDivider(msgDate);
        }
        lastDate = msgDate;

        const isMine = msg.senderId === uid;
        html += renderSingleMessage(msg, isMine);
      });

      container.insertAdjacentHTML('afterbegin', html);

      // Adjust scroll to maintain position
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = newScrollHeight - prevScrollHeight;

      // Re-bind message actions
      bindMessageActions(container, uid);
    } catch (err) {
      console.error('[Chat] loadMoreMessages error:', err);
    } finally {
      _isLoadingMore = false;
    }
  }

  // ── Send Message ──────────────────────────────────────────────────────────

  /**
   * Create a message document in Firestore and update conversation metadata.
   * @param {string} conversationId
   * @param {string} text
   * @param {string} type  – 'text' or 'image'
   */
  async function sendMessage(conversationId, text, type = 'text') {
    const uid = currentUserId();
    if (!uid) return;

    const me = currentUserProfile();
    const senderName = me ? (me.displayName || me.firstName || '') : '';

    // Build message data
    const messageData = {
      senderId: uid,
      senderName,
      text,
      type,
      createdAt: window.Firebase.db.FieldValue.serverTimestamp(),
      edited: false,
      deleted: false,
      replyTo: _replyingTo || null,
      reactions: {},
      status: 'sent'
    };

    try {
      // Add message to Firestore
      const msgRef = await window.Firebase.db
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .add(messageData);

      // Update conversation's lastMessage and lastMessageAt
      await window.Firebase.db.collection('conversations').doc(conversationId).update({
        lastMessage: {
          senderId: uid,
          text: type === 'image' ? '📷 Photo' : Utils.truncate(text, 60),
          type
        },
        lastMessageAt: window.Firebase.db.FieldValue.serverTimestamp()
      });

      // Increment unread count for other participants
      const convDoc = await window.Firebase.db.collection('conversations').doc(conversationId).get();
      if (convDoc.exists) {
        const conv = convDoc.data();
        const recipients = (conv.participants || []).filter(p => p !== uid);
        const updates = {};
        recipients.forEach(recipientId => {
          updates[`/unread/${recipientId}/${conversationId}`] = window.Firebase.rtdb.ServerValue.increment(1);
        });
        if (Object.keys(updates).length > 0) {
          await window.Firebase.rtdb.ref().update(updates);
        }
      }

      // Listen for write confirmation then mark as delivered
      const unsub = msgRef.onSnapshot((doc) => {
        if (doc.exists) {
          const data = doc.data();
          // Once the server timestamp is set, we know it was persisted
          if (data.createdAt && toDate(data.createdAt)) {
            msgRef.update({ status: 'delivered' }).catch(() => {});
            unsub();
          }
        }
      });

      // Listen for seen updates on this message
      listenForSeenStatus(conversationId, msgRef.id, uid);
    } catch (err) {
      console.error('[Chat] sendMessage error:', err);
      Utils.showToast('Failed to send message.', 'error');
    }
  }

  // ── Listen for Messages (Realtime) ────────────────────────────────────────

  /**
   * Set up a Firestore realtime listener on messages for a conversation.
   * @param {string} conversationId
   */
  function listenForMessages(conversationId) {
    const uid = currentUserId();
    if (!uid) return;

    const unsub = window.Firebase.db
      .collection('conversations')
      .doc(conversationId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limitToLast(1)
      .onSnapshot((snap) => {
        snap.docChanges().forEach(change => {
          if (change.type === 'added') {
            const msg = {
              id: change.doc.id,
              ...change.doc.data(),
              createdAt: toDate(change.doc.data().createdAt)
            };

            // Avoid duplicates (the sender already appended via sendMessage flow)
            const container = document.getElementById('messages-container');
            if (!container) return;

            const existingEl = container.querySelector(`[data-message-id="${msg.id}"]`);
            if (existingEl) {
              // Update status if this is our message
              if (msg.senderId === uid) {
                const statusEl = existingEl.querySelector('.message-status');
                if (statusEl && msg.status) {
                  statusEl.className = 'message-status';
                  if (msg.status === 'read') statusEl.classList.add('read');
                  else if (msg.status === 'delivered') statusEl.classList.add('delivered');
                }
              }
              return;
            }

            // Check date divider
            const lastBubble = container.querySelector('.message-bubble:last-of-type, .date-divider:last-of-type');
            const msgDate = toDate(msg.createdAt);
            let needsDivider = true;
            if (lastBubble) {
              // Approximate: if the last message element is a date divider, check its text
              const lastDateDiv = container.querySelector('.date-divider:last-of-type');
              if (lastDateDiv && msgDate && isToday(msgDate)) {
                const text = lastDateDiv.textContent.trim();
                if (text === 'Today') needsDivider = false;
              } else if (msgDate && isToday(msgDate)) {
                // No divider yet for today
                needsDivider = true;
              }
            }

            const isMine = msg.senderId === uid;
            const msgHtml = renderSingleMessage(msg, isMine);

            // Remove empty state if present
            const emptyState = container.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            // Remove loading indicator if present
            const loading = container.querySelector('.messages-loading');
            if (loading) loading.remove();

            if (needsDivider && msgDate) {
              container.insertAdjacentHTML('beforeend', renderDateDivider(msgDate));
            }

            container.insertAdjacentHTML('beforeend', msgHtml);

            // Re-bind new message actions
            bindMessageActions(container, uid);

            // Auto-scroll if near bottom
            if (_isNearBottom || msg.senderId === uid) {
              scrollToBottom(container);
            }

            // Mark as seen
            if (msg.senderId !== uid) {
              markAsSeen(conversationId);
            }
          }

          if (change.type === 'modified') {
            const msg = {
              id: change.doc.id,
              ...change.doc.data(),
              createdAt: toDate(change.doc.data().createdAt)
            };
            const container = document.getElementById('messages-container');
            if (!container) return;

            const existingEl = container.querySelector(`[data-message-id="${msg.id}"]`);
            if (existingEl) {
              // Re-render the single message
              const isMine = msg.senderId === uid;
              existingEl.outerHTML = renderSingleMessage(msg, isMine);
            }
          }
        });
      }, (err) => {
        console.error('[Chat] listenForMessages error:', err);
      });

    _messageListeners.push(unsub);
  }

  // ── Listen for Seen Status ────────────────────────────────────────────────

  /**
   * Listen for seen updates on a specific message to update status to 'read'.
   */
  function listenForSeenStatus(conversationId, messageId, senderId) {
    // Watch the seen path in RTDB – when the recipient reads, mark as read
    const seenRef = window.Firebase.rtdb.ref(`/seen/${conversationId}`);
    const unsub = seenRef.on('value', (snap) => {
      const data = snap.val();
      if (!data) return;
      // If any other user has a seen timestamp after message send, mark read
      const container = document.getElementById('messages-container');
      if (!container) return;
      const el = container.querySelector(`[data-message-id="${messageId}"]`);
      if (!el) return;
      const statusEl = el.querySelector('.message-status');
      if (statusEl) {
        statusEl.className = 'message-status read';
      }
    });
    addListener(unsub);
  }

  // ── Typing Indicators ─────────────────────────────────────────────────────

  /**
   * Listen for typing status from other users in a conversation.
   * @param {string} conversationId
   */
  function listenForTyping(conversationId) {
    const uid = currentUserId();
    if (!uid) return;

    const typingRef = window.Firebase.rtdb.ref(`/typing/${conversationId}`);
    const unsub = typingRef.on('value', (snap) => {
      const data = snap.val();
      if (!data) {
        hideTypingIndicator();
        return;
      }

      const typingUsers = Object.keys(data).filter(key => key !== uid);
      if (typingUsers.length === 0) {
        hideTypingIndicator();
        return;
      }

      // Check if typing is recent (within 4 seconds)
      const now = Date.now();
      const active = typingUsers.filter(u => {
        const ts = data[u];
        return ts && (now - ts) < 4000;
      });

      if (active.length > 0) {
        showTypingIndicator(active.length > 1 ? 'Several people are typing...' : 'typing...');
      } else {
        hideTypingIndicator();
      }
    });
    addListener(unsub);
  }

  /**
   * Set the current user's typing status in Realtime Database with debounce (3s timeout).
   * @param {string} conversationId
   */
  function setTyping(conversationId) {
    const uid = currentUserId();
    if (!uid) return;

    if (_typingTimeout) clearTimeout(_typingTimeout);

    window.Firebase.rtdb.ref(`/typing/${conversationId}/${uid}`)
      .set(firebase.database.ServerValue.TIMESTAMP)
      .catch(() => {});

    _typingTimeout = setTimeout(() => {
      window.Firebase.rtdb.ref(`/typing/${conversationId}/${uid}`)
        .remove()
        .catch(() => {});
      _typingTimeout = null;
    }, 3000);
  }

  function showTypingIndicator(text) {
    const indicator = document.getElementById('typing-indicator');
    const textEl = document.getElementById('typing-text');
    if (indicator) {
      if (textEl) textEl.textContent = text;
      indicator.classList.remove('hidden');
    }
  }

  function hideTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.classList.add('hidden');
  }

  // ── Seen / Unread ─────────────────────────────────────────────────────────

  /**
   * Mark all messages in a conversation as seen by the current user.
   * @param {string} conversationId
   */
  async function markAsSeen(conversationId) {
    const uid = currentUserId();
    if (!uid) return;

    try {
      // Set seen timestamp
      await window.Firebase.rtdb.ref(`/seen/${conversationId}/${uid}`)
        .set(firebase.database.ServerValue.TIMESTAMP);

      // Clear unread count for this conversation
      await window.Firebase.rtdb.ref(`/unread/${uid}/${conversationId}`)
        .set(0);
    } catch (err) {
      console.warn('[Chat] markAsSeen error:', err);
    }
  }

  // ── Presence ──────────────────────────────────────────────────────────────

  /**
   * Set up Realtime Database presence for the current user.
   * On connect, set online. On disconnect, remove.
   */
  function setupPresence() {
    const uid = currentUserId();
    if (!uid) return;

    const presenceRef = window.Firebase.rtdb.ref(`/presence/${uid}`);

    window.Firebase.rtdb.ref('.info/connected').on('value', (snap) => {
      if (snap.val() === true) {
        presenceRef.onDisconnect().remove();
        presenceRef.set(true).catch(() => {});
      }
    });
  }

  /**
   * Listen for a specific user's online/offline presence.
   * @param {string} userId
   */
  function listenForPresence(userId) {
    const presenceRef = window.Firebase.rtdb.ref(`/presence/${userId}`);
    const unsub = presenceRef.on('value', (snap) => {
      const isOnline = snap.val() === true;
      const label = document.getElementById('chat-presence-label');
      if (label) {
        label.textContent = isOnline ? 'online' : 'offline';
        label.classList.toggle('online', isOnline);
      }
    });
    addListener(unsub);
  }

  // ── Unread Count Listener ─────────────────────────────────────────────────

  /**
   * Listen for total unread count changes and update the chats nav badge.
   */
  function listenForUnreadCounts() {
    const uid = currentUserId();
    if (!uid) return;

    const unreadRef = window.Firebase.rtdb.ref(`/unread/${uid}`);
    const unsub = unreadRef.on('value', (snap) => {
      const data = snap.val();
      let total = 0;
      if (data) {
        Object.values(data).forEach(count => {
          total += (typeof count === 'number' ? count : 0);
        });
      }

      // Update nav badge
      const badge = document.getElementById('chat-badge');
      if (badge) {
        if (total > 0) {
          badge.textContent = total > 99 ? '99+' : total;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }

      // Also update individual conversation unread counts in the cached list
      if (data && _conversationsFetched) {
        _conversationsCache.forEach(conv => {
          const count = data[conv.id];
          conv.unreadCount = (typeof count === 'number' ? count : 0);
        });
        // Only re-render if on the chats page
        if (Router.getCurrentPage() === 'chats') {
          renderConversationList(_conversationsCache);
        }
      }
    });
    addListener(unsub);
  }

  // ── Image Send ────────────────────────────────────────────────────────────

  /**
   * Compress an image and send it as a message.
   * @param {string} conversationId
   * @param {File} file
   */
  async function handleImageSend(conversationId, file) {
    if (!file || !file.type.startsWith('image/')) {
      Utils.showToast('Please select an image file.', 'warning');
      return;
    }

    Utils.showToast('Sending image...', 'info', 2000);

    try {
      const base64 = await Utils.compressImage(file, 1200, 0.7);
      await sendMessage(conversationId, base64, 'image');
    } catch (err) {
      console.error('[Chat] handleImageSend error:', err);
      Utils.showToast('Failed to send image.', 'error');
    }
  }

  // ── Message Actions ───────────────────────────────────────────────────────

  /**
   * Soft-delete a message (set deleted: true).
   * @param {string} conversationId
   * @param {string} messageId
   */
  async function handleDeleteMessage(conversationId, messageId) {
    const confirmed = await Utils.showConfirm('Delete Message', 'Are you sure you want to delete this message? This cannot be undone.');
    if (!confirmed) return;

    try {
      await window.Firebase.db
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .doc(messageId)
        .update({ deleted: true, text: '', type: 'text' });

      // Also update reactions
      const container = document.getElementById('messages-container');
      if (container) {
        const el = container.querySelector(`[data-message-id="${messageId}"]`);
        if (el) {
          el.classList.add('message-deleted');
          el.innerHTML = '<p class="message-text message-deleted-text"><em>Message deleted</em></p>';
        }
      }
    } catch (err) {
      console.error('[Chat] handleDeleteMessage error:', err);
      Utils.showToast('Failed to delete message.', 'error');
    }
  }

  /**
   * Edit an existing message.
   * @param {string} conversationId
   * @param {string} messageId
   * @param {string} newText
   */
  async function handleEditMessage(conversationId, messageId, newText) {
    if (!newText || !newText.trim()) {
      Utils.showToast('Message cannot be empty.', 'warning');
      return;
    }

    try {
      await window.Firebase.db
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .doc(messageId)
        .update({
          text: newText.trim(),
          edited: true
        });
    } catch (err) {
      console.error('[Chat] handleEditMessage error:', err);
      Utils.showToast('Failed to edit message.', 'error');
    }
  }

  /**
   * Set up a reply to a specific message.
   * @param {string} conversationId
   * @param {string} messageId
   * @param {string} text
   */
  function handleReply(conversationId, messageId, text) {
    const uid = currentUserId();
    const container = document.getElementById('messages-container');
    if (!container) return;

    const el = container.querySelector(`[data-message-id="${messageId}"]`);
    const senderName = el ? (el.querySelector('.message-sender')?.textContent || 'Unknown') : 'Unknown';

    _replyingTo = {
      messageId,
      text: Utils.truncate(text || '', 80),
      senderName
    };

    // Show reply bar
    const replyBar = document.getElementById('reply-bar');
    const replyNameEl = document.getElementById('reply-bar-name');
    const replyTextEl = document.getElementById('reply-bar-text');
    if (replyBar) {
      replyBar.classList.remove('hidden');
      if (replyNameEl) replyNameEl.textContent = `Replying to ${senderName}`;
      if (replyTextEl) replyTextEl.textContent = Utils.truncate(text || '', 80);
    }

    // Focus input
    const input = document.getElementById('chat-message-input');
    if (input) input.focus();
  }

  /**
   * Clear the reply-to state.
   */
  function clearReply() {
    _replyingTo = null;
    const replyBar = document.getElementById('reply-bar');
    if (replyBar) replyBar.classList.add('hidden');
  }

  /**
   * Toggle a reaction on a message.
   * @param {string} conversationId
   * @param {string} messageId
   * @param {string} emoji
   */
  async function handleReaction(conversationId, messageId, emoji) {
    const uid = currentUserId();
    if (!uid) return;

    try {
      const msgRef = window.Firebase.db
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .doc(messageId);

      const doc = await msgRef.get();
      if (!doc.exists) return;

      const data = doc.data();
      const reactions = data.reactions || {};

      // Check if user already reacted with this emoji
      if (reactions[emoji] && reactions[emoji].includes(uid)) {
        // Remove reaction
        reactions[emoji] = reactions[emoji].filter(id => id !== uid);
        if (reactions[emoji].length === 0) {
          delete reactions[emoji];
        }
      } else {
        // Remove any existing reaction from this user on a different emoji
        Object.keys(reactions).forEach(key => {
          if (reactions[key]) {
            reactions[key] = reactions[key].filter(id => id !== uid);
            if (reactions[key].length === 0) delete reactions[key];
          }
        });
        // Add new reaction
        if (!reactions[emoji]) reactions[emoji] = [];
        reactions[emoji].push(uid);
      }

      await msgRef.update({ reactions });
    } catch (err) {
      console.error('[Chat] handleReaction error:', err);
    }
  }

  /**
   * Forward a message to another conversation.
   * @param {string} conversationId
   * @param {string} messageId
   */
  async function handleForward(conversationId, messageId) {
    // Fetch the message
    try {
      const msgDoc = await window.Firebase.db
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .doc(messageId)
        .get();

      if (!msgDoc.exists) {
        Utils.showToast('Message not found.', 'error');
        return;
      }

      const msgData = msgDoc.data();
      if (msgData.deleted) {
        Utils.showToast('Cannot forward a deleted message.', 'warning');
        return;
      }

      // Build conversation picker UI
      const forwardableConvs = _conversationsCache.filter(c => c.id !== conversationId);
      if (forwardableConvs.length === 0) {
        Utils.showToast('No other conversations to forward to.', 'info');
        return;
      }

      let optionsHtml = forwardableConvs.map(c => {
        const name = c.isGroup
          ? (c.name || 'Group Chat')
          : ((c.otherUser && c.otherUser.displayName) || 'Unknown');
        return `<button class="forward-option" data-conv-id="${c.id}">${Utils.sanitizeHTML(name)}</button>`;
      }).join('');

      const overlay = document.createElement('div');
      overlay.className = 'modal';
      overlay.innerHTML = `
        <div class="modal-backdrop"></div>
        <div class="modal-content forward-modal">
          <div class="modal-header">
            <h3>Forward Message</h3>
            <button class="modal-close" id="forward-modal-close">&times;</button>
          </div>
          <div class="modal-body">
            <p class="forward-preview">${Utils.sanitizeHTML(Utils.truncate(msgData.text || '📷 Image', 100))}</p>
            <div class="forward-list">${optionsHtml}</div>
          </div>
        </div>`;

      document.body.appendChild(overlay);
      overlay.classList.remove('hidden');

      const close = () => overlay.remove();
      overlay.querySelector('#forward-modal-close').addEventListener('click', close);
      overlay.querySelector('.modal-backdrop').addEventListener('click', close);

      overlay.querySelectorAll('.forward-option').forEach(btn => {
        btn.addEventListener('click', async () => {
          const targetConvId = btn.dataset.convId;
          close();

          const text = msgData.type === 'image' ? msgData.text : msgData.text;
          const type = msgData.type || 'text';
          await sendMessage(targetConvId, text, type);
          Utils.showToast('Message forwarded.', 'success');
        });
      });
    } catch (err) {
      console.error('[Chat] handleForward error:', err);
      Utils.showToast('Failed to forward message.', 'error');
    }
  }

  // ── Context Menus ─────────────────────────────────────────────────────────

  /**
   * Show context menu for a message bubble.
   */
  function showMessageContextMenu(event, messageId, isOwn, bubbleEl) {
    // Remove any existing context menu
    const existing = document.querySelector('.message-context-menu');
    if (existing) existing.remove();

    const msgText = bubbleEl.querySelector('.message-text')?.textContent || '';

    const menuItems = [];

    if (isOwn) {
      menuItems.push({ label: '✏️ Edit', action: () => showEditDialog(messageId, msgText) });
      menuItems.push({ label: '🗑️ Delete', action: () => {
        const convId = document.querySelector('.chat-view-page')?.dataset.conversationId;
        if (convId) handleDeleteMessage(convId, messageId);
      }});
    }

    menuItems.push({ label: '↩️ Reply', action: () => {
      const convId = document.querySelector('.chat-view-page')?.dataset.conversationId;
      if (convId) handleReply(convId, messageId, msgText);
    }});

    menuItems.push({ label: '↗️ Forward', action: () => {
      const convId = document.querySelector('.chat-view-page')?.dataset.conversationId;
      if (convId) handleForward(convId, messageId);
    }});

    menuItems.push({ label: '😀 React', action: () => showReactionPicker(messageId) });

    if (!isOwn) {
      menuItems.push({ label: '📋 Copy', action: () => {
        Utils.copyToClipboard(msgText).then(() => Utils.showToast('Copied!', 'success'));
      }});
    }

    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    menu.innerHTML = menuItems.map((item, i) =>
      `<button class="context-menu-item" data-idx="${i}">${item.label}</button>`
    ).join('');

    document.body.appendChild(menu);

    // Position the menu
    let x, y;
    if (event.clientX && event.clientY) {
      x = event.clientX;
      y = event.clientY;
    } else {
      const rect = bubbleEl.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top;
    }

    // Ensure menu stays in viewport
    const menuRect = menu.getBoundingClientRect();
    if (x + menuRect.width > window.innerWidth) x = window.innerWidth - menuRect.width - 8;
    if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;

    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Bind actions
    menu.querySelectorAll('.context-menu-item').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        menu.remove();
        menuItems[idx].action();
      });
    });

    // Close on outside tap
    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
        document.removeEventListener('touchstart', closeHandler);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeHandler);
      document.addEventListener('touchstart', closeHandler);
    }, 10);
  }

  /**
   * Show an inline edit dialog for a message.
   */
  function showEditDialog(messageId, currentText) {
    const existing = document.querySelector('.message-context-menu');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content">
        <div class="modal-header">
          <h3>Edit Message</h3>
          <button class="modal-close" id="edit-modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <textarea id="edit-message-input" rows="3" class="chat-message-input">${Utils.sanitizeHTML(currentText)}</textarea>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="edit-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="edit-save-btn">Save</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.remove('hidden');

    const close = () => overlay.remove();
    overlay.querySelector('#edit-modal-close').addEventListener('click', close);
    overlay.querySelector('#edit-cancel-btn').addEventListener('click', close);
    overlay.querySelector('.modal-backdrop').addEventListener('click', close);

    const convId = document.querySelector('.chat-view-page')?.dataset.conversationId;
    overlay.querySelector('#edit-save-btn').addEventListener('click', () => {
      const newText = overlay.querySelector('#edit-message-input').value;
      if (convId) {
        handleEditMessage(convId, messageId, newText);
      }
      close();
    });

    const input = overlay.querySelector('#edit-message-input');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  /**
   * Show a quick emoji reaction picker anchored to a message.
   */
  function showReactionPicker(messageId) {
    const existing = document.querySelector('.reaction-picker-popup');
    if (existing) existing.remove();

    const quickEmojis = ['❤️', '😂', '😍', '😮', '😢', '😡', '👍', '👎'];

    const picker = document.createElement('div');
    picker.className = 'reaction-picker-popup';
    picker.innerHTML = quickEmojis.map(e =>
      `<button class="reaction-pick-btn" data-emoji="${e}">${e}</button>`
    ).join('');

    document.body.appendChild(picker);

    // Position near center of screen
    picker.style.left = '50%';
    picker.style.bottom = '80px';
    picker.style.transform = 'translateX(-50%)';

    picker.querySelectorAll('.reaction-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const convId = document.querySelector('.chat-view-page')?.dataset.conversationId;
        if (convId) {
          handleReaction(convId, messageId, btn.dataset.emoji);
        }
        picker.remove();
      });
    });

    const closeHandler = (e) => {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('click', closeHandler);
        document.removeEventListener('touchstart', closeHandler);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeHandler);
      document.addEventListener('touchstart', closeHandler);
    }, 10);
  }

  /**
   * Show the chat header "more options" context menu.
   */
  function showChatContextMenu(conversationId, convData) {
    const existing = document.querySelector('.message-context-menu');
    if (existing) existing.remove();

    const items = [];

    if (convData.isGroup) {
      items.push({ label: '👥 Group Info', action: () => showGroupSettings(conversationId, convData) });
    }

    items.push({ label: '🔍 Search in Chat', action: () => Utils.showToast('Search in chat coming soon.', 'info') });
    items.push({ label: '🔇 Mute', action: () => Utils.showToast('Mute coming soon.', 'info') });

    if (!convData.isGroup) {
      items.push({ label: '🚫 Block User', action: () => Utils.showToast('Block coming soon.', 'info') });
    }

    items.push({ label: '🗑️ Clear Chat', action: async () => {
      const confirmed = await Utils.showConfirm('Clear Chat', 'Clear all messages in this chat? This cannot be undone.');
      if (!confirmed) return;
      Utils.showToast('Chat cleared.', 'success');
    }});

    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    menu.innerHTML = items.map((item, i) =>
      `<button class="context-menu-item" data-idx="${i}">${item.label}</button>`
    ).join('');

    document.body.appendChild(menu);

    // Position near the more button
    const moreBtn = document.getElementById('chat-more-btn');
    if (moreBtn) {
      const rect = moreBtn.getBoundingClientRect();
      menu.style.top = (rect.bottom + 4) + 'px';
      menu.style.right = (window.innerWidth - rect.right) + 'px';
    }

    menu.querySelectorAll('.context-menu-item').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        menu.remove();
        items[idx].action();
      });
    });

    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeHandler);
        document.removeEventListener('touchstart', closeHandler);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeHandler);
      document.addEventListener('touchstart', closeHandler);
    }, 10);
  }

  /**
   * Show group settings/info modal.
   */
  function showGroupSettings(conversationId, convData) {
    const existing = document.querySelector('.modal');
    if (existing) return; // don't stack modals

    const name = convData.name || 'Group Chat';
    const avatarUrl = convData.groupAvatarUrl || '';
    const participants = convData.participants || [];
    const adminIds = convData.adminIds || [];
    const uid = currentUserId();
    const isAdmin = adminIds.includes(uid);

    const avatarHtml = avatarUrl
      ? `<img src="${Utils.sanitizeHTML(avatarUrl)}" alt="" class="avatar avatar-lg">`
      : `<div class="avatar avatar-lg avatar-placeholder">${Utils.getInitials(name)}</div>`;

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content group-settings-modal">
        <div class="modal-header">
          <h3>Group Info</h3>
          <button class="modal-close" id="group-settings-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="group-settings-header">
            ${avatarHtml}
            <h3 class="group-settings-name">${Utils.sanitizeHTML(name)}</h3>
            <p class="group-settings-meta">${participants.length} member${participants.length !== 1 ? 's' : ''}</p>
          </div>
          <div id="group-members-list" class="group-members-list">
            <div class="skeleton-line" style="width:80%"></div>
            <div class="skeleton-line" style="width:60%"></div>
            <div class="skeleton-line" style="width:70%"></div>
          </div>
          ${isAdmin ? `
            <div class="group-settings-actions">
              <button class="btn btn-outline btn-sm" id="group-add-member-btn">Add Member</button>
              <button class="btn btn-outline btn-sm" id="group-edit-name-btn">Edit Name</button>
            </div>
          ` : ''}
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.remove('hidden');

    const close = () => overlay.remove();
    overlay.querySelector('#group-settings-close').addEventListener('click', close);
    overlay.querySelector('.modal-backdrop').addEventListener('click', close);

    // Load group members
    loadGroupMembers(conversationId, participants, adminIds, uid);
  }

  /**
   * Load and display group members in the settings modal.
   */
  async function loadGroupMembers(conversationId, participantIds, adminIds, currentUid) {
    const list = document.getElementById('group-members-list');
    if (!list) return;

    try {
      const members = [];
      for (const pid of participantIds) {
        try {
          const doc = await window.Firebase.db.collection('users').doc(pid).get();
          if (doc.exists) {
            members.push({
              uid: doc.id,
              ...doc.data(),
              isAdmin: adminIds.includes(pid),
              isMe: pid === currentUid
            });
          }
        } catch (_) {}
      }

      list.innerHTML = members.map(m => {
        const avatarHtml = m.avatarUrl
          ? `<img src="${Utils.sanitizeHTML(m.avatarUrl)}" alt="" class="avatar avatar-sm">`
          : `<div class="avatar avatar-sm avatar-placeholder">${Utils.getInitials(m.displayName)}</div>`;

        return `
          <div class="group-member-item" data-user-id="${m.uid}">
            ${avatarHtml}
            <div class="group-member-info">
              <span class="group-member-name">${Utils.sanitizeHTML(m.displayName || 'Unknown')}</span>
              ${m.isAdmin ? '<span class="admin-badge">Admin</span>' : ''}
              ${m.isMe ? '<span class="group-member-you">You</span>' : ''}
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('[Chat] loadGroupMembers error:', err);
      list.innerHTML = '<p>Failed to load members.</p>';
    }
  }

  // ── Create / Start Conversations ──────────────────────────────────────────

  /**
   * Check if a 1-on-1 conversation exists between current user and recipient.
   * If not, create a new one. Return the conversationId.
   * @param {string} recipientId
   * @returns {Promise<string>}
   */
  async function createConversation(recipientId) {
    const uid = currentUserId();
    if (!uid) throw new Error('Not authenticated');

    // Check for existing 1-on-1 conversation
    try {
      const snap = await window.Firebase.db
        .collection('conversations')
        .where('participants', 'array-contains', uid)
        .where('isGroup', '==', false)
        .get();

      for (const doc of snap.docs) {
        const data = doc.data();
        const participants = data.participants || [];
        if (participants.length === 2 && participants.includes(recipientId)) {
          return doc.id;
        }
      }
    } catch (err) {
      console.warn('[Chat] Error checking existing conversations:', err);
    }

    // Create new conversation
    try {
      const convRef = await window.Firebase.db.collection('conversations').add({
        participants: [uid, recipientId],
        isGroup: false,
        createdAt: window.Firebase.db.FieldValue.serverTimestamp(),
        lastMessageAt: window.Firebase.db.FieldValue.serverTimestamp(),
        lastMessage: null
      });

      return convRef.id;
    } catch (err) {
      console.error('[Chat] createConversation error:', err);
      throw err;
    }
  }

  /**
   * Show user search UI to start a new chat.
   */
  function startNewChat() {
    const existing = document.querySelector('.modal');
    if (existing) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content new-chat-modal">
        <div class="modal-header">
          <h3>New Message</h3>
          <button class="modal-close" id="new-chat-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="search-input-wrap">
            <span class="search-icon">🔍</span>
            <input type="text" id="new-chat-search" placeholder="Search users..." autocomplete="off">
          </div>
          <div id="new-chat-results" class="search-results-list">
            <div class="empty-state"><p>Search for a user to start chatting.</p></div>
          </div>
          <div class="new-chat-divider"><span>or</span></div>
          <button class="btn btn-outline btn-full" id="create-group-chat-btn">
            👥 Create Group Chat
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.remove('hidden');

    const close = () => overlay.remove();
    overlay.querySelector('#new-chat-close').addEventListener('click', close);
    overlay.querySelector('.modal-backdrop').addEventListener('click', close);

    // User search
    const searchInput = overlay.querySelector('#new-chat-search');
    if (searchInput) {
      searchInput.addEventListener('input', Utils.debounce(async function () {
        const query = this.value.trim().toLowerCase();
        const results = overlay.querySelector('#new-chat-results');

        if (!query) {
          results.innerHTML = '<div class="empty-state"><p>Search for a user to start chatting.</p></div>';
          return;
        }

        results.innerHTML = '<div class="loader-bar"></div>';

        try {
          // Search by displayName or username
          const snap = await window.Firebase.db
            .collection('users')
            .orderBy('displayName')
            .startAt(query)
            .endAt(query + '\uf8ff')
            .limit(10)
            .get();

          if (snap.empty) {
            results.innerHTML = '<div class="empty-state"><p>No users found.</p></div>';
            return;
          }

          const uid = currentUserId();
          results.innerHTML = snap.docs
            .filter(doc => doc.id !== uid)
            .map(doc => {
              const user = { uid: doc.id, ...doc.data() };
              return Components.renderUserItem(user, 'Chat', 'btn-primary btn-sm');
            })
            .join('');

          results.querySelectorAll('.user-action-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const userId = btn.dataset.userId;
              if (!userId) return;
              btn.disabled = true;
              btn.textContent = 'Opening...';
              try {
                const convId = await createConversation(userId);
                close();
                Router.navigate('chat-view', { conversationId: convId });
              } catch (err) {
                Utils.showToast('Failed to start chat.', 'error');
                btn.disabled = false;
                btn.textContent = 'Chat';
              }
            });
          });
        } catch (err) {
          console.error('[Chat] User search error:', err);
          results.innerHTML = '<div class="empty-state"><p>Search failed.</p></div>';
        }
      }, 300));
    }

    // Create group chat button
    const createGroupBtn = overlay.querySelector('#create-group-chat-btn');
    if (createGroupBtn) {
      createGroupBtn.addEventListener('click', () => {
        close();
        showCreateGroupChatDialog();
      });
    }
  }

  /**
   * Show dialog for creating a new group chat.
   */
  function showCreateGroupChatDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content create-group-modal">
        <div class="modal-header">
          <h3>Create Group Chat</h3>
          <button class="modal-close" id="create-group-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="group-name-input">Group Name</label>
            <input type="text" id="group-name-input" placeholder="Enter group name" maxlength="50">
          </div>
          <div class="search-input-wrap">
            <span class="search-icon">🔍</span>
            <input type="text" id="group-member-search" placeholder="Add members..." autocomplete="off">
          </div>
          <div id="group-member-search-results" class="search-results-list"></div>
          <div id="selected-members" class="selected-members-list"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="create-group-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="create-group-save-btn" disabled>Create Group</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    overlay.classList.remove('hidden');

    const selectedMembers = new Set();
    const uid = currentUserId();

    const close = () => overlay.remove();
    overlay.querySelector('#create-group-close').addEventListener('click', close);
    overlay.querySelector('#create-group-cancel-btn').addEventListener('click', close);
    overlay.querySelector('.modal-backdrop').addEventListener('click', close);

    const saveBtn = overlay.querySelector('#create-group-save-btn');

    function updateSelectedUI() {
      const container = overlay.querySelector('#selected-members');
      if (selectedMembers.size === 0) {
        container.innerHTML = '';
        saveBtn.disabled = true;
        return;
      }
      saveBtn.disabled = false;
      // We just show count since we don't have names cached
      container.innerHTML = `<p class="selected-members-count">${selectedMembers.size} member${selectedMembers.size !== 1 ? 's' : ''} selected (plus you)</p>`;
    }

    // Search for members
    const memberSearch = overlay.querySelector('#group-member-search');
    if (memberSearch) {
      memberSearch.addEventListener('input', Utils.debounce(async function () {
        const query = this.value.trim().toLowerCase();
        const results = overlay.querySelector('#group-member-search-results');

        if (!query) {
          results.innerHTML = '';
          return;
        }

        results.innerHTML = '<div class="loader-bar"></div>';

        try {
          const snap = await window.Firebase.db
            .collection('users')
            .orderBy('displayName')
            .startAt(query)
            .endAt(query + '\uf8ff')
            .limit(10)
            .get();

          if (snap.empty) {
            results.innerHTML = '<div class="empty-state"><p>No users found.</p></div>';
            return;
          }

          results.innerHTML = snap.docs
            .filter(doc => doc.id !== uid)
            .map(doc => {
              const user = { uid: doc.id, ...doc.data() };
              const isSelected = selectedMembers.has(doc.id);
              const actionText = isSelected ? '✓ Added' : 'Add';
              const actionClass = isSelected ? 'btn-sm btn-ghost active' : 'btn-sm btn-outline';
              return `
                <div class="user-item" data-user-id="${user.uid}">
                  ${user.avatarUrl
                    ? `<img src="${Utils.sanitizeHTML(user.avatarUrl)}" alt="" class="avatar">`
                    : `<div class="avatar avatar-placeholder">${Utils.getInitials(user.displayName)}</div>`}
                  <div class="user-item-info">
                    <span class="user-item-name">${Utils.sanitizeHTML(user.displayName || 'Unknown')}</span>
                    ${user.username ? `<span class="user-item-username">@${Utils.sanitizeHTML(user.username)}</span>` : ''}
                  </div>
                  <button class="btn ${actionClass} add-member-btn" data-user-id="${user.uid}" ${isSelected ? 'disabled' : ''}>${actionText}</button>
                </div>`;
            })
            .join('');

          results.querySelectorAll('.add-member-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const userId = btn.dataset.userId;
              if (userId && !selectedMembers.has(userId)) {
                selectedMembers.add(userId);
                btn.textContent = '✓ Added';
                btn.classList.add('active');
                btn.classList.remove('btn-outline');
                btn.classList.add('btn-ghost');
                btn.disabled = true;
                updateSelectedUI();
              }
            });
          });
        } catch (err) {
          console.error('[Chat] Group member search error:', err);
          results.innerHTML = '<div class="empty-state"><p>Search failed.</p></div>';
        }
      }, 300));
    }

    // Create group
    saveBtn.addEventListener('click', async () => {
      const nameInput = overlay.querySelector('#group-name-input');
      const groupName = nameInput ? nameInput.value.trim() : '';

      if (!groupName) {
        Utils.showToast('Please enter a group name.', 'warning');
        if (nameInput) nameInput.focus();
        return;
      }

      if (selectedMembers.size === 0) {
        Utils.showToast('Please add at least one member.', 'warning');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner"></span>';

      try {
        const participants = [uid, ...selectedMembers];
        const convId = await createGroupChat(groupName, participants);
        close();
        Router.navigate('chat-view', { conversationId: convId });
        Utils.showToast('Group created!', 'success');
      } catch (err) {
        console.error('[Chat] Failed to create group:', err);
        Utils.showToast('Failed to create group.', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Create Group';
      }
    });
  }

  /**
   * Create a group conversation.
   * @param {string} name
   * @param {Array} participants  – Array of user UIDs (must include current user)
   * @returns {Promise<string>} conversationId
   */
  async function createGroupChat(name, participants) {
    const uid = currentUserId();
    if (!uid) throw new Error('Not authenticated');

    try {
      const convRef = await window.Firebase.db.collection('conversations').add({
        name,
        participants,
        isGroup: true,
        adminIds: [uid],
        groupAvatarUrl: '',
        createdAt: window.Firebase.db.FieldValue.serverTimestamp(),
        lastMessageAt: window.Firebase.db.FieldValue.serverTimestamp(),
        lastMessage: null
      });

      return convRef.id;
    } catch (err) {
      console.error('[Chat] createGroupChat error:', err);
      throw err;
    }
  }

  // ── Scroll Utility ────────────────────────────────────────────────────────

  /**
   * Smooth-scroll a container to the bottom.
   * @param {HTMLElement} container
   */
  function scrollToBottom(container) {
    if (!container) return;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  // ── Page Cleanup (called on page change) ──────────────────────────────────

  function cleanup() {
    unsubscribeAll();
    _replyingTo = null;
    _emojiPickerOpen = false;
    _oldestMessageDoc = null;
    _hasMoreMessages = true;
    _isLoadingMore = false;
    _isNearBottom = true;

    // Clear typing
    if (_typingTimeout) {
      clearTimeout(_typingTimeout);
      _typingTimeout = null;
    }
    const uid = currentUserId();
    if (uid) {
      // Remove current user's typing status for any conversation
      window.Firebase.rtdb.ref(`/typing/`).orderByKey().limitToFirst(1).remove().catch(() => {});
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────

  /**
   * Initialize the Chat module. Set up page registrations and event listeners.
   */
  function init() {
    // Register page renderers with the Router
    Router.registerPages({
      'chats': render,
      'chat-view': renderChatView,
      'group-chat': renderGroupChatView
    });

    // Clean up listeners on page change
    window.addEventListener('page:beforeChange', (e) => {
      const { page } = e.detail;
      if (page === 'chat-view' || page === 'group-chat') {
        cleanup();
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.Chat = {
    init,
    render,
    renderChatView,
    renderGroupChatView,
    loadConversations,
    loadMessages,
    sendMessage,
    listenForMessages,
    listenForTyping,
    setTyping,
    markAsSeen,
    listenForPresence,
    setupPresence,
    listenForUnreadCounts,
    handleImageSend,
    handleDeleteMessage,
    handleEditMessage,
    handleReply,
    handleReaction,
    handleForward,
    createConversation,
    startNewChat,
    createGroupChat,
    searchConversations,
    renderConversationList,
    cleanup
  };
})();