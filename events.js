/**
 * GIOLYNK - Events Module
 * Renders events list, detail, and create pages.
 * Handles RSVP, sharing, editing, and deleting events.
 * Uses Firebase compat SDK via window.Firebase references.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _activeTab = 'upcoming';        // 'upcoming' | 'past' | 'my'
  let _eventData = null;              // Cached event doc
  let _myRSVP = null;                 // Current user's RSVP status
  let _isAdmin = false;               // Whether current user is admin/moderator

  const EVENT_TYPES = [
    'Academic', 'Social', 'Sports', 'Cultural', 'Workshop', 'Seminar', 'Other'
  ];

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

  function isAdminOrMod(user) {
    return user && (user.role === 'admin' || user.role === 'moderator');
  }

  /**
   * Fetch a lightweight user object by UID.
   */
  async function fetchUser(uid) {
    if (!uid) return {};
    try {
      const doc = await window.Firebase.db.collection('users').doc(uid).get();
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
      console.warn('[Events] Could not fetch user:', uid, err);
    }
    return { displayName: 'Unknown', avatarUrl: null, username: '' };
  }

  /**
   * Batch fetch user objects from UIDs.
   */
  async function fetchUsers(uids) {
    if (!uids || uids.length === 0) return [];
    const users = [];
    for (let i = 0; i < uids.length; i += 10) {
      const batch = uids.slice(i, i + 10);
      const snaps = await Promise.all(
        batch.map(uid => window.Firebase.db.collection('users').doc(uid).get())
      );
      snaps.forEach(doc => {
        if (doc.exists) {
          const d = doc.data();
          users.push({ uid: doc.id, ...d });
        }
      });
    }
    return users;
  }

  /**
   * Render an avatar element for a user.
   */
  function renderAvatar(user, size = '') {
    const util = u();
    const cls = size ? `avatar ${size}` : 'avatar';
    if (user.avatarUrl) {
      return `<img src="${util.sanitizeHTML(user.avatarUrl)}" alt="${util.sanitizeHTML(user.displayName || '')}" class="${cls}">`;
    }
    return `<div class="${cls} avatar-placeholder">${util.getInitials(user.displayName)}</div>`;
  }

  // ── Data Loaders ──────────────────────────────────────────────────────────

  /**
   * Load events for the current user's school, filtered by date.
   * @param {string} filter - 'upcoming', 'past', 'my'
   * @returns {Promise<Array>}
   */
  async function loadEvents(filter = 'upcoming') {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    const db = window.Firebase.db;
    const now = new Date();

    try {
      if (filter === 'my') {
        // Events the user has RSVP'd to (going or interested)
        const snap = await db
          .collection('events')
          .where('schoolId', '==', user.schoolId)
          .orderBy('startDateTime', 'desc')
          .limit(50)
          .get();

        const allEvents = snap.docs.map(doc => {
          const d = doc.data();
          return {
            id: doc.id,
            ...d,
            startDateTime: d.startDateTime?.toDate ? d.startDateTime.toDate() : d.startDateTime,
            endDateTime: d.endDateTime?.toDate ? d.endDateTime.toDate() : d.endDateTime
          };
        });

        // Filter to events where user has RSVP'd
        const myEvents = [];
        for (const event of allEvents) {
          try {
            const rsvpDoc = await db
              .collection('events').doc(event.id)
              .collection('rsvps').doc(user.uid)
              .get();
            if (rsvpDoc.exists) {
              event._myRSVP = rsvpDoc.data().status;
              myEvents.push(event);
            }
          } catch (_) {
            // Skip this event if rsvp fetch fails
          }
        }
        return myEvents;
      }

      // Upcoming: startDateTime >= now
      if (filter === 'upcoming') {
        const snap = await db
          .collection('events')
          .where('schoolId', '==', user.schoolId)
          .where('startDateTime', '>=', now)
          .orderBy('startDateTime', 'asc')
          .limit(50)
          .get();

        return snap.docs.map(doc => {
          const d = doc.data();
          return {
            id: doc.id,
            ...d,
            startDateTime: d.startDateTime?.toDate ? d.startDateTime.toDate() : d.startDateTime,
            endDateTime: d.endDateTime?.toDate ? d.endDateTime.toDate() : d.endDateTime
          };
        });
      }

      // Past: endDateTime < now (or startDateTime < now if no endDateTime)
      if (filter === 'past') {
        const snap = await db
          .collection('events')
          .where('schoolId', '==', user.schoolId)
          .orderBy('startDateTime', 'desc')
          .limit(50)
          .get();

        return snap.docs
          .map(doc => {
            const d = doc.data();
            return {
              id: doc.id,
              ...d,
              startDateTime: d.startDateTime?.toDate ? d.startDateTime.toDate() : d.startDateTime,
              endDateTime: d.endDateTime?.toDate ? d.endDateTime.toDate() : d.endDateTime
            };
          })
          .filter(event => {
            const end = event.endDateTime || event.startDateTime;
            return end && end < now;
          });
      }

      return [];
    } catch (err) {
      console.error('[Events] Error loading events:', err);
      return [];
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * RSVP to an event.
   * @param {string} eventId
   * @param {string} status - 'going', 'interested', 'not_going'
   */
  async function handleRSVP(eventId, status) {
    const user = currentUser();
    if (!user || !eventId) return;

    const util = u();
    const db = window.Firebase.db;
    const batch = db.batch();

    try {
      // Write RSVP doc
      const rsvpRef = db.collection('events').doc(eventId).collection('rsvps').doc(user.uid);
      batch.set(rsvpRef, {
        userId: user.uid,
        status: status,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Get current counts from event doc to compute deltas
      const eventDoc = await db.collection('events').doc(eventId).get();
      if (!eventDoc.exists) {
        util.showToast('Event not found.', 'error');
        return;
      }

      const event = eventDoc.data();
      const prevStatus = _myRSVP; // Previous RSVP status

      // Calculate count updates
      const updates = {};

      // Remove from previous status count
      if (prevStatus === 'going') {
        updates.goingCount = firebase.firestore.FieldValue.increment(-1);
      } else if (prevStatus === 'interested') {
        updates.interestedCount = firebase.firestore.FieldValue.increment(-1);
      }
      // 'not_going' doesn't have a visible count

      // Add to new status count
      if (status === 'going') {
        updates.goingCount = firebase.firestore.FieldValue.increment(1);
      } else if (status === 'interested') {
        updates.interestedCount = firebase.firestore.FieldValue.increment(1);
      }

      // If switching from one status to the same, no net change needed
      if (prevStatus === status) {
        // Just update the RSVP doc timestamp
        await rsvpRef.set({
          userId: user.uid,
          status: status,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return;
      }

      // Apply count updates to event doc
      const eventRef = db.collection('events').doc(eventId);
      batch.update(eventRef, updates);
      await batch.commit();

      _myRSVP = status;

      const labels = { going: 'Going', interested: 'Interested', not_going: 'Not Going' };
      util.showToast(`Marked as ${labels[status] || status}.`, 'success');

      // Re-render detail page if viewing it
      if (window.Router && window.Router.getCurrentPage() === 'event') {
        const params = window.Router.getParams();
        const html = await renderEventDetail(params);
        document.getElementById('page-content').innerHTML = html;
        afterDetailRender(params);
      }
    } catch (err) {
      console.error('[Events] Error RSVPing:', err);
      util.showToast('Failed to update RSVP.', 'error');
    }
  }

  /**
   * Create a new event.
   */
  async function handleCreateEvent(data) {
    const user = currentUser();
    if (!user) return null;

    const util = u();
    const db = window.Firebase.db;

    if (!data.title || !data.title.trim()) {
      util.showToast('Event title is required.', 'warning');
      return null;
    }
    if (!data.startDateTime) {
      util.showToast('Start date/time is required.', 'warning');
      return null;
    }

    try {
      const eventId = util.generateId();
      const startDateTime = new Date(data.startDateTime);
      const endDateTime = data.endDateTime ? new Date(data.endDateTime) : null;

      const eventDoc = {
        id: eventId,
        title: data.title.trim(),
        description: (data.description || '').trim(),
        type: data.type || 'Other',
        startDateTime: firebase.firestore.Timestamp.fromDate(startDateTime),
        endDateTime: endDateTime ? firebase.firestore.Timestamp.fromDate(endDateTime) : null,
        location: (data.location || '').trim(),
        coverImage: data.coverImage || null,
        maxAttendees: data.maxAttendees ? parseInt(data.maxAttendees, 10) : null,
        goingCount: 0,
        interestedCount: 0,
        schoolId: user.schoolId || null,
        organizerId: user.uid,
        organizerName: user.displayName || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('events').doc(eventId).set(eventDoc);

      util.showToast('Event created successfully!', 'success');
      return { id: eventId, ...eventDoc };
    } catch (err) {
      console.error('[Events] Error creating event:', err);
      util.showToast('Failed to create event.', 'error');
      return null;
    }
  }

  /**
   * Edit an existing event.
   * @param {string} eventId
   * @param {Object} data - Updated fields
   */
  async function handleEditEvent(eventId, data) {
    const user = currentUser();
    if (!user || !eventId) return false;

    const util = u();
    const db = window.Firebase.db;

    try {
      const updates = {};

      if (data.title !== undefined) updates.title = data.title.trim();
      if (data.description !== undefined) updates.description = (data.description || '').trim();
      if (data.type !== undefined) updates.type = data.type;
      if (data.location !== undefined) updates.location = (data.location || '').trim();
      if (data.maxAttendees !== undefined) updates.maxAttendees = data.maxAttendees ? parseInt(data.maxAttendees, 10) : null;
      if (data.coverImage !== undefined) updates.coverImage = data.coverImage;

      if (data.startDateTime) {
        updates.startDateTime = firebase.firestore.Timestamp.fromDate(new Date(data.startDateTime));
      }
      if (data.endDateTime) {
        updates.endDateTime = data.endDateTime ? firebase.firestore.Timestamp.fromDate(new Date(data.endDateTime)) : null;
      }

      updates.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

      await db.collection('events').doc(eventId).update(updates);

      util.showToast('Event updated!', 'success');

      // Re-render if on event detail page
      if (window.Router && window.Router.getCurrentPage() === 'event') {
        const params = window.Router.getParams();
        const html = await renderEventDetail(params);
        document.getElementById('page-content').innerHTML = html;
        afterDetailRender(params);
      }

      return true;
    } catch (err) {
      console.error('[Events] Error editing event:', err);
      util.showToast('Failed to update event.', 'error');
      return false;
    }
  }

  /**
   * Delete an event (admin only).
   * @param {string} eventId
   */
  async function handleDeleteEvent(eventId) {
    const user = currentUser();
    if (!user || !eventId) return;

    const util = u();
    const db = window.Firebase.db;

    const confirmed = await util.showConfirm(
      'Delete Event',
      'This action cannot be undone. All RSVPs and comments will be permanently deleted.'
    );
    if (!confirmed) return;

    try {
      await db.collection('events').doc(eventId).delete();

      // Delete RSVPs subcollection
      const rsvpsSnap = await db
        .collection('events').doc(eventId).collection('rsvps')
        .get();
      const batch = db.batch();
      rsvpsSnap.docs.forEach(d => batch.delete(d.ref));
      if (!rsvpsSnap.empty) await batch.commit();

      // Delete comments subcollection
      const commentsSnap = await db
        .collection('events').doc(eventId).collection('comments')
        .get();
      const batch2 = db.batch();
      commentsSnap.docs.forEach(d => batch2.delete(d.ref));
      if (!commentsSnap.empty) await batch2.commit();

      util.showToast('Event deleted.', 'info');

      if (window.Router) {
        window.Router.navigate('events', { _hash: '/events' });
      }
    } catch (err) {
      console.error('[Events] Error deleting event:', err);
      util.showToast('Failed to delete event.', 'error');
    }
  }

  /**
   * Share an event using Web Share API or clipboard fallback.
   * @param {string} eventId
   */
  async function handleShareEvent(eventId) {
    if (!eventId || !_eventData) return;

    const util = u();
    const title = _eventData.title || 'Event';
    const url = `${window.location.origin}${window.location.pathname}#/events/${eventId}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: title,
          text: `Check out "${title}" on GIOLYNK!`,
          url: url
        });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // User cancelled
      }
    }

    // Fallback: copy link
    const ok = await util.copyToClipboard(url);
    if (ok) {
      util.showToast('Event link copied!', 'success');
    } else {
      util.showToast('Failed to copy link.', 'error');
    }
  }

  // ── Events List Page ──────────────────────────────────────────────────────

  /**
   * Render the events list page.
   * @param {Object} params - Route parameters.
   * @returns {Promise<string>} HTML string.
   */
  async function render(params) {
    const user = currentUser();
    if (!user) {
      return '<div class="error-page"><p>Please sign in to view events.</p></div>';
    }

    const util = u();
    const activeTab = params?.tab || _activeTab;

    let tabContentHtml = '<div class="loading-indicator"><span class="spinner"></span></div>';

    const showFAB = isAdminOrMod(user);
    const tabItems = [
      { key: 'upcoming', label: 'Upcoming' },
      { key: 'past', label: 'Past' },
      { key: 'my', label: 'My Events' }
    ];

    const tabsHtml = tabItems.map(t =>
      `<button class="events-tab ${activeTab === t.key ? 'active' : ''}" data-events-tab="${t.key}">${t.label}</button>`
    ).join('');

    const html = `
      <div class="events-page" id="events-page">
        <div class="events-tabs">
          ${tabsHtml}
        </div>
        <div class="events-tab-content" id="events-tab-content">
          ${tabContentHtml}
        </div>
        ${showFAB ? `
          <button class="fab" id="create-event-fab" aria-label="Create Event">
            <span class="fab-icon">+</span>
          </button>` : ''}
      </div>`;

    return html;
  }

  /**
   * Load and render events list into tab container.
   */
  async function loadAndRenderTab(filter) {
    const container = document.getElementById('events-tab-content');
    if (!container) return;

    const events = await loadEvents(filter);

    if (events.length === 0) {
      const icons = { upcoming: '📅', past: '🕐', my: '🗓️' };
      const messages = {
        upcoming: 'No upcoming events right now.',
        past: 'No past events to show.',
        my: "You haven't RSVP'd to any events yet."
      };
      container.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <span class="empty-icon">${icons[filter] || '📅'}</span>
          <h3>Nothing here</h3>
          <p>${messages[filter] || 'No events found.'}</p>
        </div>`;
      return;
    }

    container.innerHTML = '<div class="events-list">' +
      events.map(event => c().renderEventCard(event)).join('') +
      '</div>';
  }

  // ── Event Detail Page ─────────────────────────────────────────────────────

  /**
   * Render a single event detail page.
   * @param {Object} params - Must include eventId.
   * @returns {Promise<string>} HTML string.
   */
  async function renderEventDetail(params) {
    const user = currentUser();
    if (!user) {
      return '<div class="error-page"><p>Please sign in to view this event.</p></div>';
    }

    const eventId = params?.eventId;
    if (!eventId) {
      return '<div class="error-page"><h2>Event not found</h2>' +
        '<button class="btn btn-primary" onclick="window.Router.navigate(\'events\')">Browse Events</button></div>';
    }

    const util = u();
    const db = window.Firebase.db;

    // Fetch event doc
    let eventDoc;
    try {
      const doc = await db.collection('events').doc(eventId).get();
      if (!doc.exists) {
        return '<div class="error-page"><h2>Event not found</h2>' +
          '<button class="btn btn-primary" onclick="window.Router.navigate(\'events\')">Browse Events</button></div>';
      }
      eventDoc = { id: doc.id, ...doc.data() };
      eventDoc.startDateTime = eventDoc.startDateTime?.toDate ? eventDoc.startDateTime.toDate() : eventDoc.startDateTime;
      eventDoc.endDateTime = eventDoc.endDateTime?.toDate ? eventDoc.endDateTime.toDate() : eventDoc.endDateTime;
      _eventData = eventDoc;
    } catch (err) {
      console.error('[Events] Error fetching event:', err);
      return '<div class="error-page"><h2>Something went wrong</h2><p>Failed to load event.</p></div>';
    }

    // Fetch user's RSVP
    try {
      const rsvpDoc = await db
        .collection('events').doc(eventId)
        .collection('rsvps').doc(user.uid)
        .get();
      _myRSVP = rsvpDoc.exists ? rsvpDoc.data().status : null;
    } catch (_) {
      _myRSVP = null;
    }

    // Admin check
    _isAdmin = isAdminOrMod(user) || eventDoc.organizerId === user.uid;

    // Fetch organizer info
    let organizer = await fetchUser(eventDoc.organizerId);

    // Date box
    const startDate = eventDoc.startDateTime;
    const month = startDate ? startDate.toLocaleString('en-US', { month: 'short' }).toUpperCase() : '';
    const day = startDate ? startDate.getDate() : '';
    const year = startDate ? startDate.getFullYear() : '';
    const weekday = startDate ? startDate.toLocaleString('en-US', { weekday: 'long' }) : '';
    const startTime = startDate ? util.formatTime(startDate) : '';
    const endTime = eventDoc.endDateTime ? util.formatTime(eventDoc.endDateTime) : '';

    // Cover image / Hero
    let heroHtml = '';
    if (eventDoc.coverImage) {
      heroHtml = `<div class="event-hero" style="background-image:url('${util.sanitizeHTML(eventDoc.coverImage)}')">
        <div class="event-hero-overlay"></div>
      </div>`;
    }

    // RSVP counts
    const goingCount = eventDoc.goingCount || 0;
    const interestedCount = eventDoc.interestedCount || 0;

    // RSVP buttons
    const rsvpButtons = ['going', 'interested', 'not_going'].map(status => {
      const labels = { going: 'Going', interested: 'Interested', not_going: 'Not Going' };
      const icons = { going: '✅', interested: '🤔', not_going: '✕' };
      const isActive = _myRSVP === status;
      const count = status === 'going' ? goingCount : status === 'interested' ? interestedCount : '';
      const cls = status === 'going'
        ? `btn ${isActive ? 'btn-primary' : 'btn-outline'}`
        : status === 'interested'
          ? `btn ${isActive ? 'btn-ghost' : 'btn-outline'}`
          : `btn ${isActive ? 'btn-danger' : 'btn-outline'} btn-sm`;

      return `<button class="rsvp-btn ${cls}" data-rsvp-status="${status}" data-event-id="${eventId}">
        ${icons[status]} ${labels[status]}${count ? ` (${count})` : ''}
      </button>`;
    }).join('');

    // Attendees section (loading, will be populated after render)
    let attendeesHtml = '<div class="loading-indicator"><span class="spinner"></span></div>';
    let commentsHtml = '<div class="loading-indicator"><span class="spinner"></span></div>';

    // Admin section
    let adminHtml = '';
    if (_isAdmin) {
      adminHtml = `
        <div class="admin-section">
          <h4 class="admin-section-title">Admin Controls</h4>
          <div class="admin-actions">
            <button class="btn btn-outline btn-sm" id="edit-event-btn">Edit Event</button>
            <button class="btn btn-danger btn-sm" id="delete-event-btn">Delete Event</button>
          </div>
        </div>`;
    }

    // Max attendees indicator
    let capacityHtml = '';
    if (eventDoc.maxAttendees) {
      const pct = Math.min(100, (goingCount / eventDoc.maxAttendees) * 100);
      capacityHtml = `
        <div class="capacity-info">
          <span>${goingCount} / ${eventDoc.maxAttendees} spots filled</span>
          <div class="capacity-bar">
            <div class="capacity-fill" style="width:${pct}%"></div>
          </div>
        </div>`;
    }

    const html = `
      <div class="event-detail-page" id="event-detail-page" data-event-id="${eventId}">
        ${heroHtml}

        <div class="event-detail-body">
          <!-- Hero section with date box, title, time, location -->
          <div class="event-detail-hero-info">
            <div class="event-date-box">
              <span class="event-date-month">${month}</span>
              <span class="event-date-day">${day}</span>
              <span class="event-date-year">${year}</span>
            </div>
            <div class="event-detail-info">
              <h1 class="event-detail-title">${util.sanitizeHTML(eventDoc.title || 'Untitled Event')}</h1>
              <div class="event-detail-meta">
                <span class="event-type-badge">${util.sanitizeHTML(eventDoc.type || 'Other')}</span>
                <span>${weekday}</span>
                ${startTime ? `<span>${startTime}${endTime ? ' - ' + endTime : ''}</span>` : ''}
                ${eventDoc.location ? `<span>📍 ${util.sanitizeHTML(eventDoc.location)}</span>` : ''}
              </div>
            </div>
          </div>

          <!-- Description -->
          ${eventDoc.description ? `
            <div class="event-section">
              <h3 class="event-section-title">About This Event</h3>
              <p class="event-description">${util.sanitizeHTML(eventDoc.description).replace(/\n/g, '<br>')}</p>
            </div>` : ''}

          <!-- Organizer info -->
          <div class="event-section">
            <h3 class="event-section-title">Organizer</h3>
            <div class="event-organizer" data-user-id="${eventDoc.organizerId}">
              ${renderAvatar(organizer)}
              <div class="organizer-info">
                <span class="organizer-name">${util.sanitizeHTML(organizer.displayName || 'Unknown')}</span>
                ${organizer.username ? `<span class="organizer-username">@${util.sanitizeHTML(organizer.username)}</span>` : ''}
              </div>
            </div>
          </div>

          <!-- RSVP Section -->
          <div class="event-section">
            <h3 class="event-section-title">Your RSVP</h3>
            <div class="rsvp-buttons" id="rsvp-buttons">
              ${rsvpButtons}
            </div>
            ${capacityHtml}
          </div>

          <!-- Attendees (Going) -->
          <div class="event-section">
            <h3 class="event-section-title">Going (${goingCount})</h3>
            <div class="attendees-list" id="attendees-going">
              ${attendeesHtml}
            </div>
          </div>

          <!-- Interested -->
          <div class="event-section">
            <h3 class="event-section-title">Interested (${interestedCount})</h3>
            <div class="attendees-list" id="attendees-interested">
              <div class="loading-indicator"><span class="spinner"></span></div>
            </div>
          </div>

          <!-- Comments -->
          <div class="event-section">
            <h3 class="event-section-title">Comments</h3>
            <div class="event-comments" id="event-comments">
              ${commentsHtml}
            </div>
            <div class="comment-input-wrap" id="event-comment-input-wrap">
              <input type="text" id="event-comment-input" placeholder="Add a comment..." maxlength="500">
              <button class="btn btn-primary btn-sm" id="event-comment-submit-btn">Post</button>
            </div>
          </div>

          <!-- Share -->
          <div class="event-section">
            <button class="btn btn-outline btn-full" id="share-event-btn">🔗 Share Event</button>
          </div>

          ${adminHtml}
        </div>
      </div>`;

    return html;
  }

  // ── Detail Tab Content Loaders ────────────────────────────────────────────

  /**
   * Load and render the attendees going list.
   */
  async function loadGoingAttendees() {
    const container = document.getElementById('attendees-going');
    if (!container || !_eventData) return;

    const db = window.Firebase.db;
    const util = u();

    try {
      const snap = await db
        .collection('events').doc(_eventData.id)
        .collection('rsvps')
        .where('status', '==', 'going')
        .limit(100)
        .get();

      if (snap.empty) {
        container.innerHTML = '<p class="empty-text">No one is going yet. Be the first!</p>';
        return;
      }

      const userIds = snap.docs.map(d => d.id);
      const users = await fetchUsers(userIds);

      container.innerHTML = '<div class="attendees-grid">' +
        users.map(p => `
          <div class="attendee-chip" data-user-id="${p.uid}">
            ${renderAvatar(p, 'avatar-sm')}
            <span class="attendee-name">${util.sanitizeHTML(p.displayName || 'Unknown')}</span>
          </div>`).join('') +
        '</div>';
    } catch (err) {
      console.error('[Events] Error loading going attendees:', err);
      container.innerHTML = '<p class="empty-text">Failed to load attendees.</p>';
    }
  }

  /**
   * Load and render the interested list.
   */
  async function loadInterestedAttendees() {
    const container = document.getElementById('attendees-interested');
    if (!container || !_eventData) return;

    const db = window.Firebase.db;
    const util = u();

    try {
      const snap = await db
        .collection('events').doc(_eventData.id)
        .collection('rsvps')
        .where('status', '==', 'interested')
        .limit(100)
        .get();

      if (snap.empty) {
        container.innerHTML = '<p class="empty-text">No one is interested yet.</p>';
        return;
      }

      const userIds = snap.docs.map(d => d.id);
      const users = await fetchUsers(userIds);

      container.innerHTML = '<div class="attendees-grid">' +
        users.map(p => `
          <div class="attendee-chip" data-user-id="${p.uid}">
            ${renderAvatar(p, 'avatar-sm')}
            <span class="attendee-name">${util.sanitizeHTML(p.displayName || 'Unknown')}</span>
          </div>`).join('') +
        '</div>';
    } catch (err) {
      console.error('[Events] Error loading interested attendees:', err);
      container.innerHTML = '<p class="empty-text">Failed to load interested list.</p>';
    }
  }

  /**
   * Load and render event comments.
   */
  async function loadComments() {
    const container = document.getElementById('event-comments');
    if (!container || !_eventData) return;

    const db = window.Firebase.db;
    const util = u();
    const user = currentUser();

    try {
      const snap = await db
        .collection('events').doc(_eventData.id)
        .collection('comments')
        .orderBy('createdAt', 'asc')
        .limit(50)
        .get();

      if (snap.empty) {
        container.innerHTML = '<p class="empty-text">No comments yet. Be the first to comment!</p>';
        return;
      }

      // Fetch comment authors
      const comments = [];
      const authorIds = [...new Set(snap.docs.map(d => d.data().authorId))];
      const authorMap = {};
      const authors = await fetchUsers(authorIds);
      authors.forEach(a => { authorMap[a.uid] = a; });

      for (const doc of snap.docs) {
        const data = doc.data();
        const author = authorMap[data.authorId] || {};
        comments.push({
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
          author
        });
      }

      const userObj = user || {};
      container.innerHTML = comments.map(comment => {
        const isOwn = comment.authorId === user.uid;
        return `
          <div class="comment" data-comment-id="${comment.id}">
            ${renderAvatar(comment.author, 'avatar-sm')}
            <div class="comment-body">
              <div class="comment-header">
                <span class="comment-author" data-user-id="${comment.authorId}">${util.sanitizeHTML(comment.author.displayName || 'Unknown')}</span>
                <span class="comment-time">${util.formatTimeAgo(comment.createdAt)}</span>
              </div>
              <p class="comment-text">${util.sanitizeHTML(comment.text)}</p>
              ${isOwn ? `<button class="comment-action-btn delete-event-comment-btn" data-comment-id="${comment.id}" data-event-id="${_eventData.id}">Delete</button>` : ''}
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('[Events] Error loading comments:', err);
      container.innerHTML = '<p class="empty-text">Failed to load comments.</p>';
    }
  }

  /**
   * Post a comment on an event.
   */
  async function handlePostComment(eventId, text) {
    const user = currentUser();
    if (!user || !eventId || !text || !text.trim()) return;

    const util = u();
    const db = window.Firebase.db;

    try {
      const commentId = util.generateId();
      await db
        .collection('events').doc(eventId)
        .collection('comments')
        .doc(commentId)
        .set({
          id: commentId,
          authorId: user.uid,
          text: text.trim(),
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

      // Reload comments
      await loadComments();

      // Clear input
      const input = document.getElementById('event-comment-input');
      if (input) input.value = '';
    } catch (err) {
      console.error('[Events] Error posting comment:', err);
      util.showToast('Failed to post comment.', 'error');
    }
  }

  /**
   * Delete a comment from an event.
   */
  async function handleDeleteComment(eventId, commentId) {
    const user = currentUser();
    if (!user || !eventId || !commentId) return;

    const util = u();

    try {
      await window.Firebase.db
        .collection('events').doc(eventId)
        .collection('comments')
        .doc(commentId)
        .delete();

      util.showToast('Comment deleted.', 'info');
      await loadComments();
    } catch (err) {
      console.error('[Events] Error deleting comment:', err);
      util.showToast('Failed to delete comment.', 'error');
    }
  }

  // ── Create Event Page ─────────────────────────────────────────────────────

  /**
   * Render the create event form page.
   * @param {Object} params - Route parameters.
   * @returns {Promise<string>} HTML string.
   */
  async function renderCreateEvent(params) {
    const user = currentUser();
    if (!user || !isAdminOrMod(user)) {
      return '<div class="error-page"><p>You do not have permission to create events.</p></div>';
    }

    const util = u();

    // If editing, pre-fill form with existing data
    let prefill = {};
    const isEdit = params?.eventId;
    if (isEdit) {
      try {
        const doc = await window.Firebase.db.collection('events').doc(params.eventId).get();
        if (doc.exists) {
          prefill = doc.data();
          _eventData = { id: doc.id, ...prefill };
        }
      } catch (_) {}
    }

    const typeOptions = EVENT_TYPES.map(t =>
      `<option value="${t}" ${prefill.type === t ? 'selected' : ''}>${t}</option>`
    ).join('');

    // Format datetime values for prefill
    const startVal = prefill.startDateTime
      ? (prefill.startDateTime.toDate ? prefill.startDateTime.toDate() : new Date(prefill.startDateTime))
          .toISOString().slice(0, 16)
      : '';
    const endVal = prefill.endDateTime
      ? (prefill.endDateTime.toDate ? prefill.endDateTime.toDate() : new Date(prefill.endDateTime))
          .toISOString().slice(0, 16)
      : '';

    const pageTitle = isEdit ? 'Edit Event' : 'Create Event';

    return `
      <div class="create-event-page" id="create-event-page" ${isEdit ? `data-event-id="${params.eventId}"` : ''}>
        <h2 class="page-title">${pageTitle}</h2>
        <form class="create-form" id="create-event-form" novalidate>
          <div class="form-group">
            <label for="event-title-input">Title *</label>
            <input type="text" id="event-title-input" placeholder="e.g. Annual Science Fair" maxlength="100" required
              value="${util.sanitizeHTML(prefill.title || '')}">
          </div>

          <div class="form-group">
            <label for="event-desc-input">Description</label>
            <textarea id="event-desc-input" placeholder="Describe the event..." maxlength="2000" rows="4">${util.sanitizeHTML(prefill.description || '')}</textarea>
            <span class="char-count"><span id="event-desc-count">${(prefill.description || '').length}</span>/2000</span>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="event-start-dt">Start Date/Time *</label>
              <input type="datetime-local" id="event-start-dt" required value="${startVal}">
            </div>
            <div class="form-group">
              <label for="event-end-dt">End Date/Time</label>
              <input type="datetime-local" id="event-end-dt" value="${endVal}">
            </div>
          </div>

          <div class="form-group">
            <label for="event-location-input">Location</label>
            <input type="text" id="event-location-input" placeholder="e.g. School Auditorium, Room 301" maxlength="200"
              value="${util.sanitizeHTML(prefill.location || '')}">
          </div>

          <div class="form-group">
            <label for="event-type-select">Event Type</label>
            <select id="event-type-select" class="form-select">
              ${typeOptions}
            </select>
          </div>

          <div class="form-group">
            <label for="event-max-attendees">Max Attendees (optional)</label>
            <input type="number" id="event-max-attendees" placeholder="Leave empty for unlimited" min="1" max="100000"
              value="${prefill.maxAttendees || ''}">
          </div>

          <div class="form-group">
            <label>Cover Image</label>
            <div class="image-upload" id="event-cover-upload">
              <div class="image-preview" id="event-cover-preview">
                ${prefill.coverImage
                  ? `<img src="${util.sanitizeHTML(prefill.coverImage)}" alt="Cover preview" class="cover-preview-img">`
                  : '<span class="image-placeholder">📷 Click to add cover image</span>'}
              </div>
              <input type="file" id="event-cover-input" accept="image/*" class="hidden">
            </div>
          </div>

          <button type="button" class="btn btn-primary btn-full" id="create-event-submit-btn">
            <span class="btn-text">${isEdit ? 'Save Changes' : 'Create Event'}</span>
            <span class="btn-loader hidden"><span class="spinner"></span></span>
          </button>
        </form>
      </div>`;
  }

  // ── After-Render Hooks ─────────────────────────────────────────────────────

  /**
   * Attach listeners after events list page renders.
   */
  function afterRender(params) {
    const activeTab = params?.tab || _activeTab;

    // Tab switching
    document.querySelectorAll('[data-events-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        _activeTab = tab.dataset.eventsTab;
        document.querySelectorAll('[data-events-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const contentEl = document.getElementById('events-tab-content');
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="loading-indicator"><span class="spinner"></span></div>';
        loadAndRenderTab(_activeTab);
      });
    });

    // Create FAB
    const fab = document.getElementById('create-event-fab');
    if (fab) {
      fab.addEventListener('click', () => {
        if (window.Router) {
          window.Router.navigate('create-event', { _hash: '/events/create' });
        }
      });
    }

    // Load initial tab
    loadAndRenderTab(activeTab);
  }

  /**
   * Attach listeners after event detail page renders.
   */
  function afterDetailRender(params) {
    const eventId = params?.eventId;
    if (!eventId) return;

    // RSVP buttons
    document.querySelectorAll('.rsvp-btn[data-rsvp-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        const status = btn.dataset.rsvpStatus;
        if (status) handleRSVP(eventId, status);
      });
    });

    // Share button
    const shareBtn = document.getElementById('share-event-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => handleShareEvent(eventId));
    }

    // Comment submit
    const commentInput = document.getElementById('event-comment-input');
    const commentSubmit = document.getElementById('event-comment-submit-btn');
    if (commentSubmit && commentInput) {
      commentSubmit.addEventListener('click', () => {
        const text = commentInput.value;
        if (text.trim()) {
          handlePostComment(eventId, text);
        }
      });
      commentInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (commentInput.value.trim()) {
            handlePostComment(eventId, commentInput.value);
          }
        }
      });
    }

    // Admin buttons
    const editBtn = document.getElementById('edit-event-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        if (window.Router) {
          window.Router.navigate('create-event', { eventId, _hash: `/events/${eventId}/edit` });
        }
      });
    }

    const deleteBtn = document.getElementById('delete-event-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => handleDeleteEvent(eventId));
    }

    // Load async content
    loadGoingAttendees();
    loadInterestedAttendees();
    loadComments();
  }

  /**
   * Initialize the create/edit event form listeners.
   */
  function initCreateForm() {
    const form = document.getElementById('create-event-form');
    if (!form) return;

    const util = u();
    const createPage = document.getElementById('create-event-page');
    const isEdit = createPage && createPage.dataset.eventId;
    const eventId = isEdit ? createPage.dataset.eventId : null;

    const titleInput = document.getElementById('event-title-input');
    const descInput = document.getElementById('event-desc-input');
    const descCount = document.getElementById('event-desc-count');
    const coverUpload = document.getElementById('event-cover-upload');
    const coverInput = document.getElementById('event-cover-input');
    const coverPreview = document.getElementById('event-cover-preview');
    const submitBtn = document.getElementById('create-event-submit-btn');

    // Char counter
    if (descInput && descCount) {
      descInput.addEventListener('input', () => { descCount.textContent = descInput.value.length; });
    }

    // Cover image upload
    if (coverUpload && coverInput) {
      coverUpload.addEventListener('click', () => coverInput.click());
      coverInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const base64 = await util.compressImage(file, 1200, 0.7);
          if (coverPreview) {
            coverPreview.innerHTML = `<img src="${base64}" alt="Cover preview" class="cover-preview-img">`;
          }
          coverPreview.dataset.coverData = base64;
          util.showToast('Cover image selected!', 'success');
        } catch (err) {
          util.showToast('Failed to process image.', 'error');
        }
      });
    }

    // Submit
    if (submitBtn) {
      submitBtn.addEventListener('click', async (e) => {
        e.preventDefault();

        if (!titleInput?.value.trim()) {
          util.showToast('Please enter a title.', 'warning');
          titleInput?.focus();
          return;
        }

        if (!document.getElementById('event-start-dt')?.value) {
          util.showToast('Please select a start date/time.', 'warning');
          return;
        }

        submitBtn.disabled = true;
        const textEl = submitBtn.querySelector('.btn-text');
        const loaderEl = submitBtn.querySelector('.btn-loader');
        if (textEl) textEl.classList.add('hidden');
        if (loaderEl) loaderEl.classList.remove('hidden');

        const coverData = coverPreview?.dataset?.coverData || null;

        const data = {
          title: titleInput.value,
          description: descInput?.value || '',
          type: document.getElementById('event-type-select')?.value || 'Other',
          startDateTime: document.getElementById('event-start-dt')?.value,
          endDateTime: document.getElementById('event-end-dt')?.value || null,
          location: document.getElementById('event-location-input')?.value || '',
          maxAttendees: document.getElementById('event-max-attendees')?.value || null,
          coverImage: coverData
        };

        let result;

        if (isEdit) {
          result = await handleEditEvent(eventId, data);
        } else {
          result = await handleCreateEvent(data);
        }

        submitBtn.disabled = false;
        if (textEl) textEl.classList.remove('hidden');
        if (loaderEl) loaderEl.classList.add('hidden');

        if (result) {
          if (window.Router) {
            if (isEdit) {
              // Stay on detail page, it was re-rendered by handleEditEvent
            } else {
              window.Router.navigate('event', {
                eventId: result.id,
                _hash: `/events/${result.id}`
              });
            }
          }
        }
      });
    }
  }

  // ── Event Delegation ──────────────────────────────────────────────────────

  function handleEventsClicks(e) {
    const target = e.target;

    // Event card clicks
    const eventCard = target.closest('.event-card[data-event-id]');
    if (eventCard) {
      const eventId = eventCard.dataset.eventId;
      if (eventId && window.Router) {
        window.Router.navigate('event', { eventId, _hash: `/events/${eventId}` });
      }
      return;
    }

    // Organizer click -> profile
    const organizerEl = target.closest('.event-organizer[data-user-id]');
    if (organizerEl && !target.closest('.btn')) {
      const userId = organizerEl.dataset.userId;
      if (userId && window.Router) {
        window.Router.navigate('user-profile', { userId, _hash: `/user/${userId}` });
      }
      return;
    }

    // Attendee/user click -> profile
    const attendeeChip = target.closest('.attendee-chip[data-user-id]');
    if (attendeeChip && !target.closest('.btn')) {
      const userId = attendeeChip.dataset.userId;
      if (userId && window.Router) {
        window.Router.navigate('user-profile', { userId, _hash: `/user/${userId}` });
      }
      return;
    }

    // Comment author click -> profile
    const commentAuthor = target.closest('.comment-author[data-user-id]');
    if (commentAuthor) {
      const userId = commentAuthor.dataset.userId;
      if (userId && window.Router) {
        window.Router.navigate('user-profile', { userId, _hash: `/user/${userId}` });
      }
      return;
    }

    // Delete comment button
    const deleteCommentBtn = target.closest('.delete-event-comment-btn');
    if (deleteCommentBtn) {
      const commentId = deleteCommentBtn.dataset.commentId;
      const eventId = deleteCommentBtn.dataset.eventId;
      if (commentId && eventId) {
        handleDeleteComment(eventId, commentId);
      }
      return;
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────

  function init() {
    // Listen for clicks within events pages via delegation
    document.addEventListener('click', (e) => {
      const eventsPage = document.getElementById('events-page');
      const eventDetailPage = document.getElementById('event-detail-page');
      const createEventPage = document.getElementById('create-event-page');

      if ((eventsPage && eventsPage.contains(e.target)) ||
          (eventDetailPage && eventDetailPage.contains(e.target)) ||
          (createEventPage && createEventPage.contains(e.target))) {
        handleEventsClicks(e);
      }
    });

    // After page renders, attach specific listeners
    window.addEventListener('pageChange', (e) => {
      if (e.detail.page === 'events') {
        afterRender(e.detail.params);
      } else if (e.detail.page === 'event') {
        afterDetailRender(e.detail.params);
      } else if (e.detail.page === 'create-event') {
        initCreateForm();
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.Events = {
    init,
    render,
    loadEvents,
    renderEventDetail,
    renderCreateEvent,
    handleRSVP,
    handleEditEvent,
    handleDeleteEvent,
    handleShareEvent
  };
})();