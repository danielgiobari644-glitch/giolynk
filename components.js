/**
 * GIOLYNK - Reusable UI Components
 * Every function returns an HTML string ready for innerHTML insertion.
 */
(function () {
  'use strict';

  const U = () => window.Utils || {
    sanitizeHTML: (s) => String(s || '').replace(/[<>"'&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c])),
    formatTimeAgo: (d) => d ? new Date(d).toLocaleDateString() : '',
    formatTime: (d) => d ? new Date(d).toLocaleTimeString() : '',
    truncate: (s, l) => (s || '').length > l ? s.slice(0, l) + '…' : (s || ''),
    formatNumber: (n) => n != null ? String(n) : '0',
    getInitials: (n) => (n || '?').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2)
  };

  window.Components = {

    /* ──────────────────────────── Post Card ──────────────────────────── */

    /**
     * @param {Object} post         – Post document from Firestore
     * @param {Object} currentUser  – Currently logged-in user doc
     */
    renderPostCard(post, currentUser) {
      const u = U();
      const author = post.author || {};
      const isOwnPost = currentUser && (post.authorId === currentUser.uid);
      const currentUserLiked = post.likes && post.likes.includes(currentUser?.uid);
      const saved = post.savedBy && post.savedBy.includes(currentUser?.uid);

      const avatarHtml = author.avatarUrl
        ? `<img src="${u.sanitizeHTML(author.avatarUrl)}" alt="${u.sanitizeHTML(author.displayName || '')}" class="avatar">`
        : `<div class="avatar avatar-placeholder">${u.getInitials(author.displayName)}</div>`;

      let mediaHtml = '';
      if (post.imageUrl) {
        mediaHtml = `<div class="post-image" data-post-id="${post.id}">
          <img src="${u.sanitizeHTML(post.imageUrl)}" alt="Post image" loading="lazy" onclick="window.openImageViewer && window.openImageViewer('${post.imageUrl}')">
        </div>`;
      } else if (post.videoUrl) {
        mediaHtml = `<div class="post-video">
          <video src="${u.sanitizeHTML(post.videoUrl)}" controls preload="metadata" playsinline></video>
        </div>`;
      } else if (post.poll) {
        const userVoted = post.poll.votedBy && post.poll.votedBy.includes(currentUser?.uid);
        mediaHtml = this.renderPoll(post.poll, userVoted);
      }

      // Inline comments preview (first 2)
      let commentsPreview = '';
      const comments = post.comments || [];
      if (comments.length > 0) {
        const previewComments = comments.slice(0, 2);
        commentsPreview = previewComments.map(c => this.renderComment(c, currentUser, 0)).join('');
        if (comments.length > 2) {
          commentsPreview += `<button class="view-all-comments link" data-post-id="${post.id}">View all ${comments.length} comments</button>`;
        }
      }

      return `
        <article class="post-card" data-post-id="${post.id}">
          <div class="post-header">
            <div class="post-author" data-user-id="${post.authorId}">
              ${avatarHtml}
              <div class="post-author-info">
                <span class="post-author-name">${u.sanitizeHTML(author.displayName || 'Unknown')}</span>
                ${post.authorRole === 'admin' ? '<span class="admin-badge">Admin</span>' : ''}
                ${post.isAnnouncement ? '<span class="announcement-badge">📢 Announcement</span>' : ''}
                <span class="post-time" title="${u.sanitizeHTML(post.createdAt ? new Date(post.createdAt).toLocaleString() : '')}">${u.formatTimeAgo(post.createdAt)}</span>
              </div>
            </div>
            ${isOwnPost || (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator'))
        ? `<button class="post-menu-btn" data-post-id="${post.id}" aria-label="More options">⋮</button>`
        : ''}
          </div>
          <div class="post-body">
            <p class="post-text">${u.sanitizeHTML(post.content)}</p>
          </div>
          ${mediaHtml}
          <div class="post-stats">
            ${post.likes && post.likes.length ? `<span class="stat-likes">${u.formatNumber(post.likes.length)} like${post.likes.length !== 1 ? 's' : ''}</span>` : ''}
            ${comments.length ? `<span class="stat-comments">${comments.length} comment${comments.length !== 1 ? 's' : ''}</span>` : ''}
          </div>
          ${this.renderPostActions(post.id, post.likes || [], comments.length, saved, currentUserLiked)}
          <div class="post-comments-preview" data-post-id="${post.id}">
            ${commentsPreview}
          </div>
        </article>`;
    },

    /* ──────────────────────────── Comment ─────────────────────────────── */

    /**
     * @param {Object} comment     – Comment object
     * @param {Object} currentUser – Currently logged-in user doc
     * @param {number} depth       – Nesting depth (max 3)
     */
    renderComment(comment, currentUser, depth = 0) {
      const u = U();
      const maxDepth = 3;
      const author = comment.author || {};
      const isOwnComment = currentUser && (comment.authorId === currentUser.uid);
      const marginLeft = depth > 0 ? `margin-left: ${Math.min(depth, maxDepth) * 20}px;` : '';
      const isLiked = comment.likes && comment.likes.includes(currentUser?.uid);

      const avatarHtml = author.avatarUrl
        ? `<img src="${u.sanitizeHTML(author.avatarUrl)}" alt="" class="avatar avatar-sm">`
        : `<div class="avatar avatar-sm avatar-placeholder">${u.getInitials(author.displayName)}</div>`;

      let repliesHtml = '';
      if (comment.replies && comment.replies.length > 0 && depth < maxDepth) {
        repliesHtml = comment.replies.map(r => this.renderComment(r, currentUser, depth + 1)).join('');
      }

      return `
        <div class="comment ${depth > 0 ? 'comment-reply' : ''}" style="${marginLeft}" data-comment-id="${comment.id}" data-depth="${depth}">
          ${avatarHtml}
          <div class="comment-body">
            <div class="comment-header">
              <span class="comment-author" data-user-id="${comment.authorId}">${u.sanitizeHTML(author.displayName || 'Unknown')}</span>
              <span class="comment-time">${u.formatTimeAgo(comment.createdAt)}</span>
            </div>
            <p class="comment-text">${u.sanitizeHTML(comment.text)}</p>
            <div class="comment-actions">
              <button class="comment-action-btn like-comment-btn ${isLiked ? 'liked' : ''}" data-comment-id="${comment.id}">
                ❤️ ${u.formatNumber(comment.likes ? comment.likes.length : 0)}
              </button>
              ${depth < maxDepth ? `<button class="comment-action-btn reply-comment-btn" data-comment-id="${comment.id}">Reply</button>` : ''}
              ${isOwnComment ? `<button class="comment-action-btn delete-comment-btn" data-comment-id="${comment.id}">Delete</button>` : ''}
            </div>
          </div>
          ${repliesHtml}
        </div>`;
    },

    /* ──────────────────────────── User Item ──────────────────────────── */

    /**
     * @param {Object} user        – User document
     * @param {string} actionText  – Button label (e.g. "Add Friend", "Follow")
     * @param {string} actionClass – Extra CSS class for the action button
     */
    renderUserItem(user, actionText = 'Add Friend', actionClass = 'btn-outline') {
      const u = U();

      const avatarHtml = user.avatarUrl
        ? `<img src="${u.sanitizeHTML(user.avatarUrl)}" alt="" class="avatar">`
        : `<div class="avatar avatar-placeholder">${u.getInitials(user.displayName)}</div>`;

      return `
        <div class="user-item" data-user-id="${user.uid || user.id}">
          ${avatarHtml}
          <div class="user-item-info">
            <span class="user-item-name">${u.sanitizeHTML(user.displayName || user.firstName + ' ' + user.lastName || 'Unknown')}</span>
            ${user.username ? `<span class="user-item-username">@${u.sanitizeHTML(user.username)}</span>` : ''}
            ${user.bio ? `<span class="user-item-bio">${u.sanitizeHTML(u.truncate(user.bio, 60))}</span>` : ''}
          </div>
          <button class="btn btn-sm ${actionClass} user-action-btn" data-user-id="${user.uid || user.id}">${u.sanitizeHTML(actionText)}</button>
        </div>`;
    },

    /* ──────────────────────────── Chat Item ──────────────────────────── */

    /**
     * @param {Object} chat        – Chat/conversation document
     * @param {Object} currentUser – Currently logged-in user doc
     */
    renderChatItem(chat, currentUser) {
      const u = U();
      const isGroup = chat.isGroup === true;
      const otherUser = isGroup
        ? { displayName: chat.name || 'Group Chat', avatarUrl: chat.avatarUrl }
        : (chat.otherUser || {});
      const lastMessage = chat.lastMessage || {};
      const isMine = lastMessage.senderId === currentUser?.uid;
      const unread = chat.unreadCount || 0;

      const avatarHtml = otherUser.avatarUrl
        ? `<img src="${u.sanitizeHTML(otherUser.avatarUrl)}" alt="" class="avatar">`
        : `<div class="avatar avatar-placeholder">${u.getInitials(otherUser.displayName)}</div>`;

      let preview = '';
      if (lastMessage.text) {
        preview = isMine ? `You: ${u.sanitizeHTML(u.truncate(lastMessage.text, 35))}` : u.sanitizeHTML(u.truncate(lastMessage.text, 40));
      } else if (lastMessage.imageUrl) {
        preview = isMine ? 'You sent a photo' : '📷 Photo';
      } else if (lastMessage.videoUrl) {
        preview = isMine ? 'You sent a video' : '🎥 Video';
      } else {
        preview = 'No messages yet';
      }

      return `
        <div class="chat-item" data-chat-id="${chat.id}" role="button" tabindex="0">
          <div class="chat-avatar">
            ${avatarHtml}
            ${chat.online ? '<span class="online-dot"></span>' : ''}
          </div>
          <div class="chat-info">
            <div class="chat-info-top">
              <span class="chat-name">${u.sanitizeHTML(otherUser.displayName || 'Unknown')}</span>
              <span class="chat-time">${u.formatTimeAgo(lastMessage.createdAt)}</span>
            </div>
            <div class="chat-info-bottom">
              <span class="chat-preview">${preview}</span>
              ${unread > 0 ? `<span class="chat-unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
            </div>
          </div>
        </div>`;
    },

    /* ──────────────────────────── Message Bubble ─────────────────────── */

    /**
     * @param {Object} message  – Message object
     * @param {boolean} isMine  – Whether the current user sent this message
     */
    renderMessageBubble(message, isMine) {
      const u = U();
      const side = isMine ? 'mine' : 'theirs';

      let contentHtml = '';
      if (message.imageUrl) {
        contentHtml = `<img src="${u.sanitizeHTML(message.imageUrl)}" alt="Image" class="message-image" loading="lazy">`;
      } else if (message.videoUrl) {
        contentHtml = `<video src="${u.sanitizeHTML(message.videoUrl)}" controls class="message-video" playsinline></video>`;
      } else {
        contentHtml = `<p class="message-text">${u.sanitizeHTML(message.text || '')}</p>`;
      }

      const senderName = !isMine && message.senderName
        ? `<span class="message-sender">${u.sanitizeHTML(message.senderName)}</span>`
        : '';

      return `
        <div class="message-bubble message-${side}" data-message-id="${message.id}">
          ${senderName}
          ${contentHtml}
          <span class="message-time">${u.formatTime(message.createdAt)}</span>
          ${isMine && message.read ? '<span class="message-status read">✓✓</span>' : isMine ? '<span class="message-status">✓</span>' : ''}
        </div>`;
    },

    /* ──────────────────────────── Skeleton Loaders ───────────────────── */

    renderSkeletonPost() {
      return `
        <article class="post-card skeleton">
          <div class="post-header">
            <div class="skeleton-avatar"></div>
            <div class="skeleton-lines">
              <div class="skeleton-line" style="width:40%"></div>
              <div class="skeleton-line" style="width:20%"></div>
            </div>
          </div>
          <div class="post-body">
            <div class="skeleton-line" style="width:90%"></div>
            <div class="skeleton-line" style="width:70%"></div>
          </div>
          <div class="skeleton-image"></div>
          <div class="skeleton-actions">
            <div class="skeleton-line" style="width:60%"></div>
          </div>
        </article>`;
    },

    renderSkeletonUser() {
      return `
        <div class="user-item skeleton">
          <div class="skeleton-avatar"></div>
          <div class="skeleton-lines" style="flex:1">
            <div class="skeleton-line" style="width:50%"></div>
            <div class="skeleton-line" style="width:30%"></div>
          </div>
          <div class="skeleton-btn"></div>
        </div>`;
    },

    renderSkeletonChat() {
      return `
        <div class="chat-item skeleton">
          <div class="skeleton-avatar"></div>
          <div class="skeleton-lines" style="flex:1">
            <div class="skeleton-line" style="width:40%"></div>
            <div class="skeleton-line" style="width:65%"></div>
          </div>
        </div>`;
    },

    /* ──────────────────────────── Post Actions ───────────────────────── */

    /**
     * @param {string}  postId
     * @param {Array}   likes           – Array of user UIDs who liked
     * @param {number}  comments
     * @param {boolean} saved
     * @param {boolean} currentUserLiked
     */
    renderPostActions(postId, likes = [], comments = 0, saved = false, currentUserLiked = false) {
      const u = U();
      const likeClass = currentUserLiked ? 'active' : '';
      const saveClass = saved ? 'active' : '';

      return `
        <div class="post-actions" data-post-id="${postId}">
          <button class="post-action-btn like-btn ${likeClass}" data-post-id="${postId}" aria-label="Like">
            <span class="action-icon">${currentUserLiked ? '❤️' : '🤍'}</span>
            <span class="action-count">${likes.length > 0 ? u.formatNumber(likes.length) : ''}</span>
          </button>
          <button class="post-action-btn comment-btn" data-post-id="${postId}" aria-label="Comment">
            <span class="action-icon">💬</span>
            <span class="action-count">${comments > 0 ? u.formatNumber(comments) : ''}</span>
          </button>
          <button class="post-action-btn share-btn" data-post-id="${postId}" aria-label="Share">
            <span class="action-icon">🔗</span>
          </button>
          <button class="post-action-btn save-btn ${saveClass}" data-post-id="${postId}" aria-label="Save">
            <span class="action-icon">${saved ? '🔖' : '📋'}</span>
          </button>
          <button class="post-action-btn report-btn" data-post-id="${postId}" aria-label="Report">
            <span class="action-icon">🚩</span>
          </button>
        </div>`;
    },

    /* ──────────────────────────── Poll ───────────────────────────────── */

    /**
     * @param {Object}  poll      – { question, options: [{text, votes}], votedBy, totalVotes }
     * @param {boolean} userVoted
     */
    renderPoll(poll, userVoted = false) {
      const u = U();
      const options = poll.options || [];
      const totalVotes = poll.totalVotes || options.reduce((sum, o) => sum + (o.votes || 0), 0);

      const optionsHtml = options.map((opt, idx) => {
        const votes = opt.votes || 0;
        const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
        const userVote = opt.votedBy && opt.votedBy.length > 0;

        return `
          <button class="poll-option ${userVoted || userVote ? 'voted' : ''}" data-poll-id="${poll.id}" data-option-index="${idx}">
            <div class="poll-option-text">
              <span>${u.sanitizeHTML(opt.text)}</span>
              ${userVoted || userVote ? `<span class="poll-pct">${pct}%</span>` : ''}
            </div>
            ${(userVoted || userVote) ? `<div class="poll-bar"><div class="poll-bar-fill" style="width:${pct}%"></div></div>` : ''}
          </button>`;
      }).join('');

      return `
        <div class="poll" data-poll-id="${poll.id}">
          <p class="poll-question">${u.sanitizeHTML(poll.question)}</p>
          <div class="poll-options">${optionsHtml}</div>
          <span class="poll-meta">${u.formatNumber(totalVotes)} vote${totalVotes !== 1 ? 's' : ''}</span>
        </div>`;
    },

    /* ──────────────────────────── Badge ──────────────────────────────── */

    renderBadge(badge) {
      const u = U();
      return `
        <div class="badge-item" data-badge-id="${badge.id}">
          <div class="badge-icon">${badge.icon || '🏅'}</div>
          <div class="badge-info">
            <span class="badge-name">${u.sanitizeHTML(badge.name)}</span>
            <span class="badge-desc">${u.sanitizeHTML(badge.description || '')}</span>
          </div>
          ${badge.earned ? '<span class="badge-earned">✅ Earned</span>' : '<span class="badge-locked">🔒 Locked</span>'}
        </div>`;
    },

    /* ──────────────────────────── Event Card ─────────────────────────── */

    renderEventCard(event) {
      const u = U();

      const date = event.date ? new Date(event.date) : null;
      const month = date ? date.toLocaleString('en-US', { month: 'short' }).toUpperCase() : '';
      const day = date ? date.getDate() : '';

      return `
        <div class="event-card" data-event-id="${event.id}">
          <div class="event-date-badge">
            <span class="event-month">${month}</span>
            <span class="event-day">${day}</span>
          </div>
          <div class="event-info">
            <h3 class="event-title">${u.sanitizeHTML(event.title || 'Untitled Event')}</h3>
            <span class="event-time">${event.time ? u.sanitizeHTML(event.time) : ''} ${event.location ? '• ' + u.sanitizeHTML(event.location) : ''}</span>
            <p class="event-desc">${u.sanitizeHTML(u.truncate(event.description || '', 100))}</p>
            <div class="event-meta">
              <span>👥 ${u.formatNumber(event.attendees || 0)} attending</span>
              ${event.organizerName ? `<span>By ${u.sanitizeHTML(event.organizerName)}</span>` : ''}
            </div>
          </div>
        </div>`;
    },

    /* ──────────────────────────── Group Card ─────────────────────────── */

    renderGroupCard(group) {
      const u = U();

      const avatarHtml = group.avatarUrl
        ? `<img src="${u.sanitizeHTML(group.avatarUrl)}" alt="" class="group-avatar">`
        : `<div class="group-avatar avatar-placeholder">${u.getInitials(group.name)}</div>`;

      return `
        <div class="group-card" data-group-id="${group.id}">
          ${avatarHtml}
          <div class="group-info">
            <h3 class="group-name">${u.sanitizeHTML(group.name || 'Untitled Group')}</h3>
            <p class="group-desc">${u.sanitizeHTML(u.truncate(group.description || '', 80))}</p>
            <div class="group-meta">
              <span>👥 ${u.formatNumber(group.memberCount || 0)} members</span>
              <span>💬 ${u.formatNumber(group.postsCount || 0)} posts</span>
            </div>
          </div>
        </div>`;
    },

    /* ──────────────────────────── Competition Card ───────────────────── */

    renderCompetitionCard(comp) {
      const u = U();

      const statusClass = comp.status || 'upcoming';
      const statusLabel = {
        upcoming: '🟡 Upcoming',
        ongoing: '🟢 Active',
        completed: '🔴 Ended'
      }[statusClass] || '🟡 Upcoming';

      return `
        <div class="competition-card" data-competition-id="${comp.id}">
          <div class="comp-header">
            <h3 class="comp-title">${u.sanitizeHTML(comp.title || 'Untitled Competition')}</h3>
            <span class="comp-status ${statusClass}">${statusLabel}</span>
          </div>
          <p class="comp-desc">${u.sanitizeHTML(u.truncate(comp.description || '', 120))}</p>
          <div class="comp-meta">
            <span>📅 ${comp.startDate ? u.formatDate(comp.startDate) : 'TBD'}</span>
            ${comp.endDate ? `<span> → ${u.formatDate(comp.endDate)}</span>` : ''}
          </div>
          <div class="comp-stats">
            <span>👥 ${u.formatNumber(comp.participants || 0)} participants</span>
            <span>🏆 ${u.formatNumber(comp.prize || 0)} coins prize</span>
          </div>
        </div>`;
    },

    /* ──────────────────────────── Notification Item ──────────────────── */

    renderNotifItem(notif) {
      const u = U();
      const unread = !notif.read ? 'unread' : '';

      let icon = '🔔';
      let actionText = '';

      switch (notif.type) {
        case 'like':       icon = '❤️'; actionText = 'liked your post'; break;
        case 'comment':    icon = '💬'; actionText = 'commented on your post'; break;
        case 'follow':     icon = '👤'; actionText = 'started following you'; break;
        case 'friend_request': icon = '🤝'; actionText = 'sent you a friend request'; break;
        case 'group_invite':    icon = '👥'; actionText = 'invited you to a group'; break;
        case 'competition':     icon = '🏆'; actionText = 'A new competition has started'; break;
        case 'event':      icon = '📅'; actionText = 'A new event is coming up'; break;
        case 'badge':      icon = '🏅'; actionText = 'You earned a new badge!'; break;
        case 'level_up':   icon = '⬆️'; actionText = 'You leveled up!'; break;
        case 'mention':    icon = '📢'; actionText = 'mentioned you in a post'; break;
        case 'reply':      icon = '💬'; actionText = 'replied to your comment'; break;
        case 'system':     icon = '⚙️'; actionText = ''; break;
        default:           icon = '🔔'; actionText = '';
      }

      const actorHtml = notif.actorName
        ? `<strong>${u.sanitizeHTML(notif.actorName)}</strong> ${actionText}`
        : u.sanitizeHTML(notif.message || actionText);

      return `
        <div class="notif-item ${unread}" data-notif-id="${notif.id}">
          <div class="notif-icon">${icon}</div>
          <div class="notif-content">
            <p class="notif-text">${actorHtml}</p>
            <span class="notif-time">${u.formatTimeAgo(notif.createdAt)}</span>
          </div>
          ${notif.postId ? `<button class="notif-action" data-post-id="${notif.postId}" aria-label="View">View</button>` : ''}
        </div>`;
    }
  };
})();