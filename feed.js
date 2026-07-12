/**
 * GIOLYNK - Feed Module
 * Renders the home feed with stories, posts, infinite scroll, and pull-to-refresh.
 * Uses Firebase compat SDK via window.Firebase references.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _postsCache = [];
  let _lastDoc = null;
  let _isLoading = false;
  let _isRefreshing = false;
  let _hasMore = true;
  let _observer = null;
  let _sentinelObserver = null;
  const _pageSize = 10;

  // Pull-to-refresh state
  let _ptrStartY = 0;
  let _ptrCurrentY = 0;
  let _ptrActive = false;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function currentUser() {
    return window.Auth && window.Auth.getCurrentUser();
  }

  /**
   * Fetch pinned posts for the current user's school.
   */
  async function loadPinnedPosts() {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    try {
      const snap = await window.Firebase.db
        .collection('posts')
        .where('schoolId', '==', user.schoolId)
        .where('pinned', '==', true)
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get();

      const pinned = [];
      for (const doc of snap.docs) {
        const data = doc.data();
        const author = await fetchAuthor(data.authorId);
        pinned.push({
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
          author
        });
      }
      return pinned;
    } catch (err) {
      console.error('[Feed] Error loading pinned posts:', err);
      return [];
    }
  }

  /**
   * Fetch author user document and return a lightweight object.
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
    } catch (err) {
      console.warn('[Feed] Could not fetch author:', authorId, err);
    }
    return { displayName: 'Unknown', avatarUrl: null };
  }

  // ── Core Functions ────────────────────────────────────────────────────────

  /**
   * Fetch posts from Firestore.
   * @param {number} limit       - Max posts to fetch.
   * @param {Object} startAfter  - Firestore document snapshot to start after.
   * @returns {Promise<Array>}   - Array of post objects with author data.
   */
  async function loadPosts(limit = _pageSize, startAfter = null) {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    if (_isLoading) return [];
    _isLoading = true;

    try {
      let query = window.Firebase.db
        .collection('posts')
        .where('schoolId', '==', user.schoolId)
        .orderBy('createdAt', 'desc')
        .limit(limit);

      if (startAfter) {
        query = query.startAfter(startAfter);
      }

      const snap = await query.get();

      if (snap.empty) {
        _hasMore = false;
        _isLoading = false;
        return [];
      }

      _lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < limit) _hasMore = false;

      const posts = [];
      for (const doc of snap.docs) {
        const data = doc.data();
        const author = await fetchAuthor(data.authorId);

        // Fetch likes subcollection to get like count and current user status
        let likes = [];
        let savedBy = [];
        try {
          const likesSnap = await window.Firebase.db
            .collection('posts').doc(doc.id).collection('likes')
            .limit(200).get();
          likes = likesSnap.docs.map(l => l.id);
        } catch (_) {}

        // Check if current user saved this post
        try {
          const savedDoc = await window.Firebase.db
            .collection('posts').doc(doc.id).collection('savedPosts').doc(user.uid).get();
          if (savedDoc.exists) savedBy = [user.uid];
        } catch (_) {}

        // Fetch poll votes if poll exists
        let poll = data.poll;
        if (poll) {
          try {
            const votesSnap = await window.Firebase.db
              .collection('posts').doc(doc.id).collection('pollVotes').get();
            const userVotes = {};
            votesSnap.docs.forEach(v => {
              const vd = v.data();
              userVotes[v.id] = v.id;
            });
            poll = { ...poll, votedBy: userVotes };
          } catch (_) {}
        }

        posts.push({
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
          author,
          likes,
          savedBy,
          poll
        });
      }

      _isLoading = false;
      return posts;
    } catch (err) {
      console.error('[Feed] Error loading posts:', err);
      _isLoading = false;
      return [];
    }
  }

  /**
   * Render an array of post objects into the feed container with stagger animation.
   */
  function renderPosts(posts) {
    const container = document.getElementById('feed-posts');
    if (!container) return;

    const user = currentUser();
    const html = posts.map(post => Components.renderPostCard(post, user)).join('');
    container.insertAdjacentHTML('beforeend', html);

    // Stagger animation: add a class with incremental delay
    const cards = container.querySelectorAll('.post-card:not(.staggered)');
    cards.forEach((card, i) => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(20px)';
      card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      card.style.transitionDelay = `${i * 60}ms`;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          card.style.opacity = '1';
          card.style.transform = 'translateY(0)';
          card.classList.add('staggered');
        });
      });
    });
  }

  // ── Post Action Handlers ──────────────────────────────────────────────────

  /**
   * Toggle like on a post.
   */
  async function handleLike(postId) {
    const user = currentUser();
    if (!user) {
      Utils.showToast('Please sign in to like posts.', 'warning');
      return;
    }

    const likeRef = window.Firebase.db
      .collection('posts').doc(postId).collection('likes').doc(user.uid);
    const postRef = window.Firebase.db.collection('posts').doc(postId);

    try {
      const likeDoc = await likeRef.get();

      // Update UI immediately (optimistic)
      const postCard = document.querySelector(`.post-card[data-post-id="${postId}"]`);
      const likeBtn = postCard?.querySelector('.like-btn');
      const statLikes = postCard?.querySelector('.stat-likes');

      if (likeDoc.exists) {
        // Unlike
        await likeRef.delete();
        await postRef.update({
          likeCount: firebase.firestore.FieldValue.increment(-1)
        });
        if (likeBtn) {
          likeBtn.classList.remove('active');
          likeBtn.querySelector('.action-icon').textContent = '\uD83E\uDD0D';
        }
        if (statLikes) {
          const current = parseInt(statLikes.textContent) || 1;
          const newVal = current - 1;
          statLikes.textContent = newVal > 0 ? `${newVal} like${newVal !== 1 ? 's' : ''}` : '';
        }
      } else {
        // Like
        await likeRef.set({
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await postRef.update({
          likeCount: firebase.firestore.FieldValue.increment(1)
        });
        if (likeBtn) {
          likeBtn.classList.add('active');
          likeBtn.querySelector('.action-icon').textContent = '\u2764\uFE0F';
          // Heart animation
          likeBtn.style.transform = 'scale(1.3)';
          setTimeout(() => { likeBtn.style.transform = 'scale(1)'; }, 200);
        }
        if (statLikes) {
          const current = parseInt(statLikes.textContent) || 0;
          const newVal = current + 1;
          statLikes.textContent = `${newVal} like${newVal !== 1 ? 's' : ''}`;
        } else {
          // Create the stat element if it doesn't exist
          const statsEl = postCard?.querySelector('.post-stats');
          if (statsEl) {
            statsEl.insertAdjacentHTML('afterbegin', '<span class="stat-likes">1 like</span>');
          }
        }

        // Create notification for post author
        const postSnap = await postRef.get();
        if (postSnap.exists) {
          const postData = postSnap.data();
          if (postData.authorId && postData.authorId !== user.uid) {
            window.Firebase.db.collection('notifications').add({
              type: 'like',
              recipientId: postData.authorId,
              actorId: user.uid,
              actorName: user.displayName || user.firstName || 'Someone',
              postId: postId,
              read: false,
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('[Feed] handleLike error:', err);
      Utils.showToast('Failed to update like.', 'error');
    }
  }

  /**
   * Toggle save/bookmark on a post.
   */
  async function handleSave(postId) {
    const user = currentUser();
    if (!user) {
      Utils.showToast('Please sign in to save posts.', 'warning');
      return;
    }

    const saveRef = window.Firebase.db
      .collection('posts').doc(postId).collection('savedPosts').doc(user.uid);

    try {
      const saveDoc = await saveRef.get();
      const postCard = document.querySelector(`.post-card[data-post-id="${postId}"]`);
      const saveBtn = postCard?.querySelector('.save-btn');

      if (saveDoc.exists) {
        await saveRef.delete();
        if (saveBtn) {
          saveBtn.classList.remove('active');
          saveBtn.querySelector('.action-icon').textContent = '\uD83D\uDCCB';
        }
        Utils.showToast('Post unsaved.', 'info');
      } else {
        await saveRef.set({
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        if (saveBtn) {
          saveBtn.classList.add('active');
          saveBtn.querySelector('.action-icon').textContent = '\uD83D\uDD16';
        }
        Utils.showToast('Post saved!', 'success');
      }
    } catch (err) {
      console.error('[Feed] handleSave error:', err);
      Utils.showToast('Failed to save post.', 'error');
    }
  }

  /**
   * Report a post.
   */
  async function handleReport(postId, type = 'inappropriate') {
    const user = currentUser();
    if (!user) return;

    try {
      await window.Firebase.db.collection('reports').add({
        postId,
        reporterId: user.uid,
        reporterName: user.displayName || user.firstName || 'Anonymous',
        type,
        schoolId: user.schoolId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'pending'
      });
      Utils.showToast('Report submitted. Thank you for keeping GIOLYNK safe.', 'success');
    } catch (err) {
      console.error('[Feed] handleReport error:', err);
      Utils.showToast('Failed to submit report.', 'error');
    }
  }

  /**
   * Delete a post and its subcollections.
   */
  async function handleDelete(postId) {
    const confirmed = await Utils.showConfirm(
      'Delete Post',
      'Are you sure you want to delete this post? This action cannot be undone.'
    );
    if (!confirmed) return;

    try {
      const postRef = window.Firebase.db.collection('posts').doc(postId);

      // Delete subcollections
      const subcollections = ['likes', 'comments', 'savedPosts', 'pollVotes', 'reports'];
      const batch = window.Firebase.db.batch();
      const batchSize = 450;

      for (const sub of subcollections) {
        let remaining = true;
        while (remaining) {
          const snap = await postRef.collection(sub).limit(batchSize).get();
          if (snap.empty) {
            remaining = false;
            break;
          }
          snap.docs.forEach(doc => batch.delete(doc.ref));
          await batch.commit();
        }
      }

      // Delete the post itself
      await postRef.delete();

      // Remove from DOM
      const postCard = document.querySelector(`.post-card[data-post-id="${postId}"]`);
      if (postCard) {
        postCard.style.transition = 'opacity 0.3s, transform 0.3s';
        postCard.style.opacity = '0';
        postCard.style.transform = 'scale(0.95)';
        setTimeout(() => postCard.remove(), 300);
      }

      Utils.showToast('Post deleted.', 'success');
    } catch (err) {
      console.error('[Feed] handleDelete error:', err);
      Utils.showToast('Failed to delete post.', 'error');
    }
  }

  /**
   * Pin or unpin a post (admin/moderator only).
   */
  async function handlePin(postId, pinned) {
    const user = currentUser();
    if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
      Utils.showToast('Only admins can pin posts.', 'warning');
      return;
    }

    try {
      await window.Firebase.db.collection('posts').doc(postId).update({
        pinned: !pinned
      });
      Utils.showToast(pinned ? 'Post unpinned.' : 'Post pinned.', 'success');
      // Reload feed to reflect change
      refreshFeed();
    } catch (err) {
      console.error('[Feed] handlePin error:', err);
      Utils.showToast('Failed to update pin status.', 'error');
    }
  }

  /**
   * Vote on a poll option.
   */
  async function handlePollVote(postId, optionIndex) {
    const user = currentUser();
    if (!user) {
      Utils.showToast('Please sign in to vote.', 'warning');
      return;
    }

    const voteRef = window.Firebase.db
      .collection('posts').doc(postId).collection('pollVotes').doc(user.uid);
    const postRef = window.Firebase.db.collection('posts').doc(postId);

    try {
      const voteDoc = await voteRef.get();

      if (voteDoc.exists) {
        // Already voted – remove previous vote
        const prevOption = voteDoc.data().optionIndex;
        await voteRef.delete();

        // Decrement previous option count
        await postRef.update({
          [`poll.options.${prevOption}.votes`]: firebase.firestore.FieldValue.increment(-1),
          [`poll.totalVotes`]: firebase.firestore.FieldValue.increment(-1)
        });
      }

      // Cast new vote
      await voteRef.set({
        optionIndex,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Increment new option count
      await postRef.update({
        [`poll.options.${optionIndex}.votes`]: firebase.firestore.FieldValue.increment(1),
        [`poll.totalVotes`]: firebase.firestore.FieldValue.increment(1)
      });

      // Update UI for the poll
      const pollEl = document.querySelector(`.poll[data-poll-id]`);
      if (pollEl) {
        const postSnap = await postRef.get();
        if (postSnap.exists) {
          const postData = postSnap.data();
          if (postData.poll) {
            const userVoted = true;
            const newPollHtml = Components.renderPoll(postData.poll, userVoted);
            pollEl.outerHTML = newPollHtml;
          }
        }
      }

      Utils.showToast('Vote recorded!', 'success');
    } catch (err) {
      console.error('[Feed] handlePollVote error:', err);
      Utils.showToast('Failed to record vote.', 'error');
    }
  }

  /**
   * Share a post using Web Share API or copy link fallback.
   */
  async function handleShare(postId) {
    const shareUrl = `${window.location.origin}${window.location.pathname}#/post-detail/${postId}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'GIOLYNK Post',
          text: 'Check out this post on GIOLYNK!',
          url: shareUrl
        });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }

    // Fallback: copy link
    const copied = await Utils.copyToClipboard(shareUrl);
    if (copied) {
      Utils.showToast('Link copied to clipboard!', 'success');
    } else {
      Utils.showToast('Could not share post.', 'error');
    }
  }

  // ── Pull to Refresh ───────────────────────────────────────────────────────

  function initPullToRefresh() {
    const feedContainer = document.getElementById('feed-container');
    if (!feedContainer) return;

    feedContainer.addEventListener('touchstart', (e) => {
      if (window.scrollY === 0) {
        _ptrStartY = e.touches[0].clientY;
        _ptrActive = true;
      }
    }, { passive: true });

    feedContainer.addEventListener('touchmove', (e) => {
      if (!_ptrActive) return;
      _ptrCurrentY = e.touches[0].clientY;
      const diff = _ptrCurrentY - _ptrStartY;

      if (diff > 0 && diff < 120) {
        const indicator = document.getElementById('pull-indicator');
        if (indicator) {
          const rotation = Math.min(diff / 120, 1) * 360;
          const opacity = Math.min(diff / 80, 1);
          indicator.style.opacity = opacity;
          indicator.querySelector('.pull-icon') && (indicator.querySelector('.pull-icon').style.transform = `rotate(${rotation}deg)`);
        }
      }
    }, { passive: true });

    feedContainer.addEventListener('touchend', async () => {
      if (!_ptrActive) return;
      _ptrActive = false;
      const diff = _ptrCurrentY - _ptrStartY;

      if (diff > 80) {
        await refreshFeed();
      }

      const indicator = document.getElementById('pull-indicator');
      if (indicator) {
        indicator.style.opacity = '0';
      }

      _ptrStartY = 0;
      _ptrCurrentY = 0;
    }, { passive: true });
  }

  // ── Infinite Scroll ───────────────────────────────────────────────────────

  function initInfiniteScroll() {
    disconnectInfiniteScroll();

    const sentinel = document.getElementById('feed-sentinel');
    if (!sentinel) return;

    _sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !_isLoading && _hasMore) {
          loadMorePosts();
        }
      },
      { rootMargin: '200px' }
    );

    _sentinelObserver.observe(sentinel);
  }

  function disconnectInfiniteScroll() {
    if (_sentinelObserver) {
      _sentinelObserver.disconnect();
      _sentinelObserver = null;
    }
  }

  async function loadMorePosts() {
    if (_isLoading || !_hasMore) return;

    // Show loading indicator
    const loader = document.getElementById('feed-loader');
    if (loader) loader.classList.remove('hidden');

    const newPosts = await loadPosts(_pageSize, _lastDoc);

    if (newPosts.length > 0) {
      renderPosts(newPosts);
      _postsCache = _postsCache.concat(newPosts);
    }

    if (loader) loader.classList.add('hidden');

    if (!_hasMore && _postsCache.length > 0) {
      const endMsg = document.getElementById('feed-end');
      if (endMsg) endMsg.classList.remove('hidden');
    }
  }

  /**
   * Full refresh of the feed (used by pull-to-refresh and pin changes).
   */
  async function refreshFeed() {
    if (_isRefreshing) return;
    _isRefreshing = true;

    const indicator = document.getElementById('pull-indicator');
    if (indicator) indicator.style.opacity = '1';

    // Reset state
    _postsCache = [];
    _lastDoc = null;
    _hasMore = true;

    const container = document.getElementById('feed-posts');
    if (container) container.innerHTML = '';

    // Load pinned + regular posts
    const pinned = await loadPinnedPosts();
    const regular = await loadPosts(_pageSize);

    const allPosts = [...pinned, ...regular];
    _postsCache = allPosts;

    renderPosts(allPosts);
    bindPostEvents();
    initInfiniteScroll();

    if (indicator) indicator.style.opacity = '0';
    _isRefreshing = false;
  }

  // ── Event Delegation ──────────────────────────────────────────────────────

  /**
   * Bind all interactive events on the feed using event delegation.
   */
  function bindPostEvents() {
    const feedPosts = document.getElementById('feed-posts');
    if (!feedPosts) return;

    // Remove old listener by cloning
    const clone = feedPosts.cloneNode(true);
    feedPosts.parentNode.replaceChild(clone, feedPosts);

    const container = document.getElementById('feed-posts');
    if (!container) return;

    container.addEventListener('click', async (e) => {
      const target = e.target;

      // ── Like ─────────────────────────────────────
      const likeBtn = target.closest('.like-btn');
      if (likeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const postId = likeBtn.dataset.postId;
        if (postId) handleLike(postId);
        return;
      }

      // ── Comment ──────────────────────────────────
      const commentBtn = target.closest('.comment-btn, .view-all-comments');
      if (commentBtn) {
        e.preventDefault();
        const postId = commentBtn.dataset.postId;
        if (postId) Router.navigate('post-detail', { postId });
        return;
      }

      // ── Save/Bookmark ────────────────────────────
      const saveBtn = target.closest('.save-btn');
      if (saveBtn) {
        e.preventDefault();
        e.stopPropagation();
        const postId = saveBtn.dataset.postId;
        if (postId) handleSave(postId);
        return;
      }

      // ── Share ────────────────────────────────────
      const shareBtn = target.closest('.share-btn');
      if (shareBtn) {
        e.preventDefault();
        e.stopPropagation();
        const postId = shareBtn.dataset.postId;
        if (postId) handleShare(postId);
        return;
      }

      // ── Report ───────────────────────────────────
      const reportBtn = target.closest('.report-btn');
      if (reportBtn) {
        e.preventDefault();
        e.stopPropagation();
        const postId = reportBtn.dataset.postId;
        if (postId) {
          showReportModal(postId);
        }
        return;
      }

      // ── More Menu ────────────────────────────────
      const menuBtn = target.closest('.post-menu-btn');
      if (menuBtn) {
        e.preventDefault();
        e.stopPropagation();
        const postId = menuBtn.dataset.postId;
        if (postId) showMoreMenu(menuBtn, postId);
        return;
      }

      // ── User Avatar/Name Click ───────────────────
      const authorEl = target.closest('.post-author');
      if (authorEl) {
        e.preventDefault();
        const userId = authorEl.dataset.userId;
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

      // ── Post Image Click (Image Viewer) ──────────
      const postImage = target.closest('.post-image');
      if (postImage) {
        e.preventDefault();
        const img = postImage.querySelector('img');
        if (img) openImageViewer(img.src);
        return;
      }

      // ── See More for long posts ──────────────────
      const seeMore = target.closest('.see-more-btn');
      if (seeMore) {
        e.preventDefault();
        const postCard = seeMore.closest('.post-card');
        const postText = postCard?.querySelector('.post-text');
        if (postText) {
          postText.classList.add('expanded');
          seeMore.remove();
        }
        return;
      }

      // ── Poll Vote ────────────────────────────────
      const pollOption = target.closest('.poll-option:not(.voted)');
      if (pollOption) {
        e.preventDefault();
        const postCard = pollOption.closest('.post-card');
        const postId = postCard?.dataset.postId;
        const optionIndex = parseInt(pollOption.dataset.optionIndex, 10);
        if (!isNaN(optionIndex) && postId) {
          handlePollVote(postId, optionIndex);
        }
        return;
      }
    });
  }

  /**
   * Show the report modal for a post.
   */
  function showReportModal(postId) {
    // Remove any existing modal
    const existing = document.getElementById('report-modal');
    if (existing) existing.remove();

    const reasons = [
      { value: 'spam', label: 'Spam' },
      { value: 'inappropriate', label: 'Inappropriate Content' },
      { value: 'harassment', label: 'Harassment / Bullying' },
      { value: 'false_info', label: 'False Information' },
      { value: 'other', label: 'Other' }
    ];

    const reasonsHtml = reasons.map(r =>
      `<button class="report-reason-btn" data-reason="${r.value}" data-post-id="${postId}">${Utils.sanitizeHTML(r.label)}</button>`
    ).join('');

    const modalHtml = `
      <div class="modal" id="report-modal">
        <div class="modal-backdrop"></div>
        <div class="modal-content report-modal-content">
          <div class="modal-header">
            <h3>Report Post</h3>
            <button class="modal-close" id="close-report-modal">&times;</button>
          </div>
          <div class="modal-body">
            <p>Why are you reporting this post?</p>
            <div class="report-reasons">${reasonsHtml}</div>
          </div>
        </div>
      </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    document.body.classList.add('modal-open');

    // Bind events
    document.getElementById('close-report-modal')?.addEventListener('click', closeReportModal);
    document.querySelector('#report-modal .modal-backdrop')?.addEventListener('click', closeReportModal);

    document.querySelectorAll('.report-reason-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const reason = btn.dataset.reason;
        const pid = btn.dataset.postId;
        handleReport(pid, reason);
        closeReportModal();
      });
    });
  }

  function closeReportModal() {
    const modal = document.getElementById('report-modal');
    if (modal) {
      modal.remove();
      document.body.classList.remove('modal-open');
    }
  }

  /**
   * Show the "more" context menu for a post.
   */
  function showMoreMenu(anchorEl, postId) {
    // Remove existing menu
    const existing = document.getElementById('post-more-menu');
    if (existing) existing.remove();

    const user = currentUser();
    const postCard = anchorEl.closest('.post-card');
    const isOwnPost = postCard?.dataset.authorId === user?.uid;
    const isAdmin = user?.role === 'admin' || user?.role === 'moderator';

    let menuItems = '';

    if (isOwnPost) {
      menuItems += `<button class="menu-item" data-action="edit" data-post-id="${postId}">\u270F\uFE0F Edit Post</button>`;
      menuItems += `<button class="menu-item menu-item-danger" data-action="delete" data-post-id="${postId}">\uD83D\uDDD1\uFE0F Delete Post</button>`;
    }

    if (isAdmin && !isOwnPost) {
      menuItems += `<button class="menu-item" data-action="pin" data-post-id="${postId}">\uD83D\uDCCC Pin Post</button>`;
    }

    if (!isOwnPost) {
      menuItems += `<button class="menu-item" data-action="report" data-post-id="${postId}">\uD83D\uDEA8 Report</button>`;
    }

    if (!menuItems) return;

    const menuHtml = `
      <div class="dropdown-menu" id="post-more-menu">
        ${menuItems}
      </div>`;

    document.body.insertAdjacentHTML('beforeend', menuHtml);

    const menu = document.getElementById('post-more-menu');
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.classList.add('visible');

    // Bind menu item clicks
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;

      const action = item.dataset.action;
      const pid = item.dataset.postId;

      menu.remove();

      switch (action) {
        case 'edit':
          // Navigate to a create-post page in edit mode
          window.dispatchEvent(new CustomEvent('editPost', { detail: { postId: pid } }));
          break;
        case 'delete':
          handleDelete(pid);
          break;
        case 'pin':
          // Check current pinned state
          window.Firebase.db.collection('posts').doc(pid).get().then(doc => {
            if (doc.exists) {
              handlePin(pid, doc.data().pinned === true);
            }
          });
          break;
        case 'report':
          showReportModal(pid);
          break;
      }
    });

    // Close menu when clicking outside
    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== anchorEl) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 10);
  }

  /**
   * Open the image viewer with a given image URL.
   */
  function openImageViewer(imageUrl) {
    const viewer = document.getElementById('image-viewer');
    const viewerImg = document.getElementById('viewer-image');
    if (viewer && viewerImg) {
      viewerImg.src = imageUrl;
      viewer.classList.remove('hidden');
      document.body.classList.add('modal-open');
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * Render the home feed page. Returns a Promise resolving to an HTML string.
   * @param {Object} params
   * @returns {Promise<string>}
   */
  async function render(params) {
    const user = currentUser();

    // Mock stories (5 placeholder circles)
    const stories = ['You', 'Sarah K.', 'Mike T.', 'Emma W.', 'Jake R.'];
    const storiesHtml = stories.map((name, i) => {
      const isOwn = i === 0;
      const avatar = user?.avatarUrl && isOwn
        ? `<img src="${Utils.sanitizeHTML(user.avatarUrl)}" alt="${Utils.sanitizeHTML(name)}" class="story-avatar">`
        : `<div class="story-avatar story-placeholder">${Utils.getInitials(name)}</div>`;
      const addClass = isOwn ? 'story-add' : '';
      return `
        <div class="story-item ${addClass}" title="${Utils.sanitizeHTML(name)}">
          <div class="story-ring">${avatar}</div>
          <span class="story-name">${Utils.sanitizeHTML(name.length > 8 ? name.slice(0, 7) + '.' : name)}</span>
        </div>`;
    }).join('');

    // Skeleton loaders for initial load
    const skeletons = Array.from({ length: 3 }, () => Components.renderSkeletonPost()).join('');

    return `
      <div class="feed-page" id="feed-container">
        <!-- Pull to refresh indicator -->
        <div class="pull-indicator" id="pull-indicator">
          <span class="pull-icon">\u21BB</span>
          <span class="pull-text">Pull to refresh</span>
        </div>

        <!-- Stories / Highlights -->
        <div class="stories-row">
          ${storiesHtml}
        </div>

        <!-- Posts container -->
        <div id="feed-posts">
          ${skeletons}
        </div>

        <!-- Infinite scroll sentinel -->
        <div id="feed-sentinel" style="height:1px;"></div>

        <!-- Loading indicator -->
        <div id="feed-loader" class="feed-loader hidden">
          <span class="spinner"></span>
          <span>Loading more posts...</span>
        </div>

        <!-- End of feed message -->
        <div id="feed-end" class="feed-end hidden">
          <p>You've reached the end of your feed.</p>
        </div>
      </div>`;
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  /**
   * Initialize the feed module: bind global event listeners.
   */
  function init() {
    // Listen for page change to load posts when feed is shown
    window.addEventListener('pageChange', async (e) => {
      if (e.detail.page === 'home') {
        // Reset and load posts
        _postsCache = [];
        _lastDoc = null;
        _hasMore = true;

        const container = document.getElementById('feed-posts');
        if (container) container.innerHTML = '';

        const pinned = await loadPinnedPosts();
        const regular = await loadPosts(_pageSize);
        const allPosts = [...pinned, ...regular];
        _postsCache = allPosts;

        renderPosts(allPosts);
        bindPostEvents();
        initInfiniteScroll();
        initPullToRefresh();
      }
    });

    // Listen for new posts being created (refresh feed)
    window.addEventListener('postCreated', () => {
      refreshFeed();
    });

    // Listen for post edits
    window.addEventListener('postUpdated', () => {
      refreshFeed();
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.Feed = {
    init,
    render,
    loadPosts,
    renderPosts,
    bindPostEvents,
    handleLike,
    handleSave,
    handleReport,
    handleDelete,
    handlePin,
    handlePollVote,
    refreshFeed,
    openImageViewer
  };
})();