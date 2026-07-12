/**
 * GIOLYNK - Competitions Module
 * Renders competitions list, detail, and create pages.
 * Handles joining, leaving, creating, tournament brackets, scoring, and results.
 * Uses Firebase compat SDK via window.Firebase references.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  let _activeTab = 'active';        // 'active' | 'upcoming' | 'ended' | 'my'
  let _detailTab = 'info';          // 'info' | 'participants' | 'bracket' | 'leaderboard' | 'feed'
  let _compData = null;             // Cached competition doc
  let _isParticipant = false;       // Whether current user is a participant
  let _isAdmin = false;             // Whether current user is admin/moderator

  const COMPETITION_TYPES = [
    'Debate', 'Quiz', 'Sports', 'Hackathon', 'Art', 'Photography',
    'Essay', 'Coding', 'Gaming', 'Music', 'Dance', 'Science Fair', 'General'
  ];

  const TOURNAMENT_FORMATS = [
    'None', 'Single Elimination', 'Double Elimination', 'Round Robin', 'League'
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
      console.warn('[Competitions] Could not fetch user:', uid, err);
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
   * Load competitions filtered by status for the current user's school.
   * @param {string} filter - 'active', 'upcoming', 'ended', 'my'
   * @returns {Promise<Array>}
   */
  async function loadCompetitions(filter = 'active') {
    const user = currentUser();
    if (!user || !user.schoolId) return [];

    const db = window.Firebase.db;
    let query;

    try {
      if (filter === 'my') {
        // Competitions the user has joined
        const snap = await db
          .collection('competitions')
          .where('schoolId', '==', user.schoolId)
          .where('participants', 'array-contains', user.uid)
          .orderBy('createdAt', 'desc')
          .limit(50)
          .get();
        return snap.docs.map(doc => {
          const d = doc.data();
          return {
            id: doc.id,
            ...d,
            startDate: d.startDate?.toDate ? d.startDate.toDate() : d.startDate,
            endDate: d.endDate?.toDate ? d.endDate.toDate() : d.endDate
          };
        });
      }

      query = db
        .collection('competitions')
        .where('schoolId', '==', user.schoolId)
        .where('status', '==', filter === 'active' ? 'active' : filter);

      // Sort order depends on filter
      if (filter === 'upcoming') {
        query = query.orderBy('startDate', 'asc');
      } else if (filter === 'ended') {
        query = query.orderBy('endDate', 'desc');
      } else {
        // Active: sort by participantCount desc
        query = query.orderBy('participantCount', 'desc');
      }

      const snap = await query.limit(50).get();
      return snap.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          ...d,
          startDate: d.startDate?.toDate ? d.startDate.toDate() : d.startDate,
          endDate: d.endDate?.toDate ? d.endDate.toDate() : d.endDate
        };
      });
    } catch (err) {
      console.error('[Competitions] Error loading competitions:', err);
      return [];
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Join a competition: add currentUserId to participants, increment count, create notification.
   */
  async function handleJoinCompetition(competitionId) {
    const user = currentUser();
    if (!user || !competitionId) return;

    const util = u();
    const db = window.Firebase.db;

    try {
      // Check max participants
      const compDoc = await db.collection('competitions').doc(competitionId).get();
      if (!compDoc.exists) {
        util.showToast('Competition not found.', 'error');
        return;
      }
      const comp = compDoc.data();
      if (comp.maxParticipants && comp.participants && comp.participants.length >= comp.maxParticipants) {
        util.showToast('This competition is full.', 'warning');
        return;
      }
      if (comp.status !== 'active' && comp.status !== 'upcoming') {
        util.showToast('This competition is no longer accepting participants.', 'warning');
        return;
      }

      await db.collection('competitions').doc(competitionId).update({
        participants: firebase.firestore.FieldValue.arrayUnion(user.uid),
        participantCount: firebase.firestore.FieldValue.increment(1)
      });

      _isParticipant = true;
      util.showToast('Joined competition!', 'success');

      // Create notification for competition organizer
      if (comp.createdBy && comp.createdBy !== user.uid) {
        try {
          await db.collection('notifications').doc(util.generateId()).set({
            userId: comp.createdBy,
            type: 'competition',
            actorId: user.uid,
            actorName: user.displayName || 'Someone',
            competitionId: competitionId,
            message: `${user.displayName || 'Someone'} joined your competition "${comp.title}"`,
            read: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } catch (_) {}
      }

      // Re-render detail page if viewing it
      if (window.Router && window.Router.getCurrentPage() === 'competition') {
        const params = window.Router.getParams();
        const html = await renderCompetitionDetail(params);
        document.getElementById('page-content').innerHTML = html;
        afterDetailRender(params);
      }
    } catch (err) {
      console.error('[Competitions] Error joining competition:', err);
      util.showToast('Failed to join competition.', 'error');
    }
  }

  /**
   * Leave a competition: remove currentUserId from participants, decrement count.
   */
  async function handleLeaveCompetition(competitionId) {
    const user = currentUser();
    if (!user || !competitionId) return;

    const util = u();
    const db = window.Firebase.db;

    const confirmed = await util.showConfirm('Leave Competition', 'Are you sure you want to leave this competition?');
    if (!confirmed) return;

    try {
      await db.collection('competitions').doc(competitionId).update({
        participants: firebase.firestore.FieldValue.arrayRemove(user.uid),
        participantCount: firebase.firestore.FieldValue.increment(-1)
      });

      _isParticipant = false;
      util.showToast('Left competition.', 'info');

      if (window.Router && window.Router.getCurrentPage() === 'competition') {
        const params = window.Router.getParams();
        const html = await renderCompetitionDetail(params);
        document.getElementById('page-content').innerHTML = html;
        afterDetailRender(params);
      }
    } catch (err) {
      console.error('[Competitions] Error leaving competition:', err);
      util.showToast('Failed to leave competition.', 'error');
    }
  }

  /**
   * Create a new competition.
   */
  async function handleCreateCompetition(data) {
    const user = currentUser();
    if (!user) return null;

    const util = u();
    const db = window.Firebase.db;

    if (!data.title || !data.title.trim()) {
      util.showToast('Competition title is required.', 'warning');
      return null;
    }
    if (!data.startDate) {
      util.showToast('Start date is required.', 'warning');
      return null;
    }

    try {
      const compId = util.generateId();
      const startDate = new Date(data.startDate);
      const endDate = data.endDate ? new Date(data.endDate) : null;
      const now = new Date();

      // Determine initial status
      let status = 'upcoming';
      if (startDate <= now) {
        status = endDate && endDate <= now ? 'ended' : 'active';
      }

      const compDoc = {
        id: compId,
        title: data.title.trim(),
        description: (data.description || '').trim(),
        type: data.type || 'General',
        startDate: firebase.firestore.Timestamp.fromDate(startDate),
        endDate: endDate ? firebase.firestore.Timestamp.fromDate(endDate) : null,
        maxParticipants: data.maxParticipants ? parseInt(data.maxParticipants, 10) : null,
        prizeDescription: (data.prizeDescription || '').trim(),
        tournamentFormat: data.tournamentFormat || 'None',
        rules: (data.rules || '').trim(),
        coverImage: data.coverImage || null,
        status: status,
        participants: [],
        participantCount: 0,
        schoolId: user.schoolId || null,
        createdBy: user.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('competitions').doc(compId).set(compDoc);

      // If tournament format is not None, initialize bracket structure
      if (data.tournamentFormat && data.tournamentFormat !== 'None') {
        await db.collection('competitions').doc(compId).update({
          bracket: null // Will be generated when participants are finalized
        });
      }

      util.showToast('Competition created successfully!', 'success');
      return { id: compId, ...compDoc };
    } catch (err) {
      console.error('[Competitions] Error creating competition:', err);
      util.showToast('Failed to create competition.', 'error');
      return null;
    }
  }

  // ── Tournament Bracket Generation ─────────────────────────────────────────

  /**
   * Generate bracket data structure for a tournament.
   * @param {Array} participants - Array of { uid, displayName, ... }
   * @param {string} format - 'Single Elimination', 'Double Elimination', 'Round Robin', 'League'
   * @returns {Object} Bracket data structure
   */
  function generateBracket(participants, format) {
    if (!participants || participants.length < 2) {
      return { format, rounds: [], matches: [], standings: [] };
    }

    switch (format) {
      case 'Single Elimination':
        return generateSingleElimination(participants);
      case 'Double Elimination':
        return generateDoubleElimination(participants);
      case 'Round Robin':
        return generateRoundRobin(participants);
      case 'League':
        return generateLeague(participants);
      default:
        return { format, rounds: [], matches: [], standings: [] };
    }
  }

  /**
   * Single Elimination: binary tree bracket.
   */
  function generateSingleElimination(participants) {
    const n = participants.length;
    // Pad to next power of 2
    const totalSlots = Math.pow(2, Math.ceil(Math.log2(n)));
    const byes = totalSlots - n;

    // Shuffle participants and assign to slots
    const shuffled = [...participants].sort(() => Math.random() - 0.5);
    const slots = [];
    let pIdx = 0;

    // Distribute byes evenly (first slots get byes)
    for (let i = 0; i < totalSlots; i++) {
      if (i < byes) {
        slots.push(null); // bye
      } else {
        slots.push(shuffled[pIdx++] || null);
      }
    }

    const rounds = [];
    const matches = [];
    const numRounds = Math.log2(totalSlots);

    // Round 1
    const round1Matches = [];
    for (let i = 0; i < totalSlots; i += 2) {
      const matchId = u().generateId();
      const match = {
        id: matchId,
        round: 0,
        slot: round1Matches.length,
        team1: slots[i],
        team2: slots[i + 1],
        team1Score: null,
        team2Score: null,
        winnerId: null,
        status: (slots[i] && slots[i + 1]) ? 'pending' : (slots[i] ? 'bye_win_1' : 'bye_win_2')
      };

      // If one slot is a bye, auto-advance
      if (match.status === 'bye_win_1' && match.team1) {
        match.winnerId = match.team1.uid;
        match.status = 'completed';
      } else if (match.status === 'bye_win_2' && match.team2) {
        match.winnerId = match.team2.uid;
        match.status = 'completed';
      }

      round1Matches.push(matchId);
      matches.push(match);
    }
    rounds.push({ name: 'Round 1', matchIds: round1Matches });

    // Subsequent rounds
    let prevMatchIds = round1Matches;
    for (let r = 1; r < numRounds; r++) {
      const roundMatches = [];
      const numMatches = prevMatchIds.length / 2;
      for (let i = 0; i < numMatches; i++) {
        const matchId = u().generateId();
        const match = {
          id: matchId,
          round: r,
          slot: i,
          team1: null, // Filled from previous round winners
          team2: null,
          team1Score: null,
          team2Score: null,
          winnerId: null,
          status: 'waiting',
          feedsFrom: [prevMatchIds[i * 2], prevMatchIds[i * 2 + 1]]
        };
        roundMatches.push(matchId);
        matches.push(match);
      }

      const roundName = r === numRounds - 1 ? 'Final' : `Round ${r + 1}`;
      rounds.push({ name: roundName, matchIds: roundMatches });
      prevMatchIds = roundMatches;
    }

    return { format: 'Single Elimination', rounds, matches };
  }

  /**
   * Double Elimination: winners and losers bracket.
   */
  function generateDoubleElimination(participants) {
    // Start with a winners bracket (same as single elimination)
    const winnersBracket = generateSingleElimination(participants);

    // Create losers bracket rounds (one fewer than winners)
    const losersRounds = [];
    const losersMatches = [];
    const numWinnersRounds = winnersBracket.rounds.length;

    for (let r = 0; r < numWinnersRounds - 1; r++) {
      const numMatches = Math.pow(2, r);
      const roundMatches = [];
      for (let i = 0; i < numMatches; i++) {
        const matchId = u().generateId();
        losersMatches.push({
          id: matchId,
          bracket: 'losers',
          round: r,
          slot: i,
          team1: null,
          team2: null,
          team1Score: null,
          team2Score: null,
          winnerId: null,
          status: 'waiting'
        });
        roundMatches.push(matchId);
      }
      losersRounds.push({ name: `Losers Round ${r + 1}`, matchIds: roundMatches });
    }

    // Grand final
    const grandFinalId = u().generateId();
    losersMatches.push({
      id: grandFinalId,
      bracket: 'grand_final',
      round: 0,
      slot: 0,
      team1: null,
      team2: null,
      team1Score: null,
      team2Score: null,
      winnerId: null,
      status: 'waiting'
    });

    return {
      format: 'Double Elimination',
      winnersBracket,
      losersRounds,
      losersMatches,
      grandFinal: { name: 'Grand Final', matchId: grandFinalId }
    };
  }

  /**
   * Round Robin: every participant plays every other participant.
   */
  function generateRoundRobin(participants) {
    const matches = [];
    const rounds = [];
    const n = participants.length;

    // If odd number, add a dummy for bye
    const list = [...participants];
    if (n % 2 !== 0) {
      list.push({ uid: '__bye__', displayName: 'BYE' });
    }

    const totalRounds = list.length - 1;
    const matchesPerRound = list.length / 2;

    // Fix first player and rotate the rest
    const fixed = list[0];
    const rotating = list.slice(1);

    for (let r = 0; r < totalRounds; r++) {
      const roundMatchIds = [];
      const roundList = [fixed, ...rotating];

      for (let m = 0; m < matchesPerRound; m++) {
        const team1 = roundList[m];
        const team2 = roundList[roundList.length - 1 - m];

        // Skip if both are byes (shouldn't happen)
        if (team1.uid === '__bye__' && team2.uid === '__bye__') continue;

        const matchId = u().generateId();
        const match = {
          id: matchId,
          bracket: 'round_robin',
          round: r,
          slot: m,
          team1: team1.uid === '__bye__' ? null : team1,
          team2: team2.uid === '__bye__' ? null : team2,
          team1Score: null,
          team2Score: null,
          winnerId: null,
          status: (team1.uid === '__bye__' || team2.uid === '__bye__') ? 'bye' : 'pending'
        };
        matches.push(match);
        roundMatchIds.push(matchId);
      }

      rounds.push({ name: `Round ${r + 1}`, matchIds: roundMatchIds });

      // Rotate: move last element of rotating to front
      rotating.unshift(rotating.pop());
    }

    return { format: 'Round Robin', rounds, matches };
  }

  /**
   * League: same as round robin but with a league table for standings.
   */
  function generateLeague(participants) {
    const rr = generateRoundRobin(participants);

    // Build initial standings
    const standings = participants.map(p => ({
      uid: p.uid,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl || null,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      points: 0,
      scoreFor: 0,
      scoreAgainst: 0
    }));

    return {
      format: 'League',
      rounds: rr.rounds,
      matches: rr.matches,
      standings
    };
  }

  /**
   * Render bracket data as HTML visualization.
   * @param {Object} bracketData - From generateBracket()
   * @param {string} format - Tournament format
   * @returns {string} HTML string
   */
  function renderBracket(bracketData, format) {
    if (!bracketData) {
      return '<div class="empty-state"><p>No bracket data available.</p></div>';
    }

    const util = u();

    if (format === 'League' || format === 'Round Robin') {
      return renderLeagueBracket(bracketData, format);
    }

    if (format === 'Double Elimination') {
      return renderDoubleEliminationBracket(bracketData);
    }

    // Single Elimination (default)
    return renderSingleEliminationBracket(bracketData);
  }

  /**
   * Render a single match box.
   */
  function renderMatchBox(match, isSmall = false) {
    const util = u();
    const statusClass = match.status === 'completed' ? 'completed' : match.status === 'live' ? 'live' : '';

    const team1Name = match.team1 ? util.sanitizeHTML(match.team1.displayName || 'TBD') : 'TBD';
    const team2Name = match.team2 ? util.sanitizeHTML(match.team2.displayName || 'TBD') : 'TBD';
    const t1Score = match.team1Score != null ? match.team1Score : '-';
    const t2Score = match.team2Score != null ? match.team2Score : '-';
    const t1Win = match.winnerId && match.team1 && match.winnerId === match.team1.uid;
    const t2Win = match.winnerId && match.team2 && match.winnerId === match.team2.uid;

    return `
      <div class="bracket-match ${statusClass}" data-match-id="${match.id}" ${isSmall ? 'data-small="true"' : ''}>
        <div class="bracket-match-team ${t1Win ? 'winner' : ''}">
          <span class="bracket-team-name">${team1Name}</span>
          <span class="bracket-team-score">${t1Score}</span>
        </div>
        <div class="bracket-match-divider"></div>
        <div class="bracket-match-team ${t2Win ? 'winner' : ''}">
          <span class="bracket-team-name">${team2Name}</span>
          <span class="bracket-team-score">${t2Score}</span>
        </div>
      </div>`;
  }

  /**
   * Render single elimination bracket.
   */
  function renderSingleEliminationBracket(bracketData) {
    if (!bracketData.rounds || bracketData.rounds.length === 0) {
      return '<div class="empty-state"><p>Bracket not yet generated.</p></div>';
    }

    const matchMap = {};
    (bracketData.matches || []).forEach(m => { matchMap[m.id] = m; });

    const roundsHtml = bracketData.rounds.map(round => {
      const matchesHtml = round.matchIds.map(matchId => {
        const match = matchMap[matchId];
        return match ? renderMatchBox(match) : '';
      }).join('');

      return `
        <div class="bracket-round">
          <h4 class="bracket-round-title">${round.name}</h4>
          <div class="bracket-round-matches">${matchesHtml}</div>
        </div>`;
    }).join('');

    return `<div class="bracket-container bracket-single-elim">${roundsHtml}</div>`;
  }

  /**
   * Render double elimination bracket.
   */
  function renderDoubleEliminationBracket(bracketData) {
    const html = [];

    // Winners bracket
    if (bracketData.winnersBracket) {
      html.push(`<h4 class="bracket-section-title">Winners Bracket</h4>`);
      html.push(renderSingleEliminationBracket(bracketData.winnersBracket));
    }

    // Losers bracket
    if (bracketData.losersRounds && bracketData.losersMatches) {
      const matchMap = {};
      bracketData.losersMatches.forEach(m => { matchMap[m.id] = m; });

      const losersHtml = bracketData.losersRounds.map(round => {
        const matchesHtml = round.matchIds.map(matchId => {
          const match = matchMap[matchId];
          return match ? renderMatchBox(match, true) : '';
        }).join('');

        return `
          <div class="bracket-round bracket-losers-round">
            <h4 class="bracket-round-title">${round.name}</h4>
            <div class="bracket-round-matches">${matchesHtml}</div>
          </div>`;
      }).join('');

      html.push(`<h4 class="bracket-section-title">Losers Bracket</h4>`);
      html.push(`<div class="bracket-container bracket-losers">${losersHtml}</div>`);
    }

    // Grand final
    if (bracketData.grandFinal) {
      const matchMap = {};
      bracketData.losersMatches.forEach(m => { matchMap[m.id] = m; });
      const gfMatch = matchMap[bracketData.grandFinal.matchId];
      if (gfMatch) {
        html.push(`<h4 class="bracket-section-title">${bracketData.grandFinal.name}</h4>`);
        html.push(`<div class="bracket-container bracket-grand-final">${renderMatchBox(gfMatch)}</div>`);
      }
    }

    return html.join('');
  }

  /**
   * Render round-robin / league bracket with standings table.
   */
  function renderLeagueBracket(bracketData, format) {
    const util = u();
    let html = '';

    // Standings table (for League format)
    if (format === 'League' && bracketData.standings && bracketData.standings.length > 0) {
      const sorted = [...bracketData.standings].sort((a, b) => b.points - a.points || (b.scoreFor - b.scoreAgainst) - (a.scoreFor - a.scoreAgainst));

      const rowsHtml = sorted.map((s, idx) => `
        <tr class="standings-row">
          <td class="standings-pos">${idx + 1}</td>
          <td class="standings-name">${util.sanitizeHTML(s.displayName || 'Unknown')}</td>
          <td class="standings-stat">${s.played}</td>
          <td class="standings-stat">${s.won}</td>
          <td class="standings-stat">${s.drawn}</td>
          <td class="standings-stat">${s.lost}</td>
          <td class="standings-stat">${s.scoreFor}:${s.scoreAgainst}</td>
          <td class="standings-pts">${s.points}</td>
        </tr>`).join('');

      html += `
        <div class="standings-table-wrap">
          <table class="standings-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th>P</th>
                <th>W</th>
                <th>D</th>
                <th>L</th>
                <th>GD</th>
                <th>Pts</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`;
    }

    // Match list
    if (bracketData.rounds && bracketData.rounds.length > 0) {
      const matchMap = {};
      (bracketData.matches || []).forEach(m => { matchMap[m.id] = m; });

      const roundsHtml = bracketData.rounds.map(round => {
        const matchesHtml = round.matchIds.map(matchId => {
          const match = matchMap[matchId];
          if (!match) return '';
          if (match.status === 'bye') return '';
          return renderMatchBox(match, true);
        }).filter(Boolean).join('');

        if (!matchesHtml) return '';
        return `
          <div class="bracket-round">
            <h4 class="bracket-round-title">${round.name}</h4>
            <div class="bracket-round-matches">${matchesHtml}</div>
          </div>`;
      }).filter(Boolean).join('');

      if (roundsHtml) {
        html += `<div class="bracket-container bracket-round-robin">${roundsHtml}</div>`;
      }
    }

    return html || '<div class="empty-state"><p>No bracket data available.</p></div>';
  }

  /**
   * Update match score in tournaments subcollection + Realtime DB for live updates.
   */
  async function handleUpdateMatchScore(matchId, team1Score, team2Score) {
    const user = currentUser();
    if (!user || !matchId || !_compData) return;

    const util = u();
    const db = window.Firebase.db;

    try {
      await db
        .collection('competitions')
        .doc(_compData.id)
        .collection('tournaments')
        .doc(matchId)
        .set({
          team1Score: parseInt(team1Score, 10) || 0,
          team2Score: parseInt(team2Score, 10) || 0,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

      // Push to Realtime DB for live updates
      try {
        await window.Firebase.rtdb
          .ref(`competitions/${_compData.id}/matches/${matchId}`)
          .update({
            team1Score: parseInt(team1Score, 10) || 0,
            team2Score: parseInt(team2Score, 10) || 0,
            updatedAt: firebase.database.ServerValue.TIMESTAMP
          });
      } catch (_) {}

      util.showToast('Score updated!', 'success');
    } catch (err) {
      console.error('[Competitions] Error updating match score:', err);
      util.showToast('Failed to update score.', 'error');
    }
  }

  /**
   * Advance winner to next round in bracket.
   */
  async function handleAdvanceWinner(matchId, winnerId) {
    const user = currentUser();
    if (!user || !matchId || !_compData) return;

    const util = u();
    const db = window.Firebase.db;

    try {
      // Get the current bracket data
      const compDoc = await db.collection('competitions').doc(_compData.id).get();
      if (!compDoc.exists) return;

      const bracket = compDoc.data().bracket;
      if (!bracket) return;

      // Find the match and mark winner
      let matchFound = null;
      const searchMatches = (matches) => {
        if (!matches) return;
        for (const m of matches) {
          if (m.id === matchId) {
            m.winnerId = winnerId;
            m.status = 'completed';
            matchFound = m;
            return;
          }
        }
      };

      searchMatches(bracket.matches);

      // For double elimination, also search losers matches
      if (!matchFound && bracket.losersMatches) {
        searchMatches(bracket.losersMatches);
      }

      if (!matchFound) return;

      // Find the next round match that feeds from this match
      const advanceToNext = (rounds, matches) => {
        for (let r = 0; r < rounds.length; r++) {
          for (const mid of rounds[r].matchIds) {
            const m = matches.find(x => x.id === mid);
            if (m && m.feedsFrom && m.feedsFrom.includes(matchId)) {
              // Fill empty slot
              const winnerData = (bracket.matches || []).find(x => x.id === matchId);
              const winnerParticipant = winnerData?.team1?.uid === winnerId
                ? winnerData.team1
                : winnerData?.team2;
              if (!m.team1) {
                m.team1 = winnerParticipant;
              } else if (!m.team2) {
                m.team2 = winnerParticipant;
              }
              if (m.team1 && m.team2 && m.status === 'waiting') {
                m.status = 'pending';
              }
              return true;
            }
          }
        }
        return false;
      };

      advanceToNext(bracket.rounds, bracket.matches);

      // Save updated bracket
      await db.collection('competitions').doc(_compData.id).update({ bracket });

      // Push to RTDB
      try {
        await window.Firebase.rtdb
          .ref(`competitions/${_compData.id}/bracket`)
          .set(bracket);
      } catch (_) {}

      util.showToast('Winner advanced!', 'success');

      // Re-render detail page
      if (window.Router && window.Router.getCurrentPage() === 'competition') {
        const params = window.Router.getParams();
        const html = await renderCompetitionDetail(params);
        document.getElementById('page-content').innerHTML = html;
        afterDetailRender(params);
      }
    } catch (err) {
      console.error('[Competitions] Error advancing winner:', err);
      util.showToast('Failed to advance winner.', 'error');
    }
  }

  /**
   * Announce results: set competition status to ended, create announcement post.
   */
  async function handleAnnounceResults(competitionId, results) {
    const user = currentUser();
    if (!user || !competitionId) return;

    const util = u();
    const db = window.Firebase.db;

    try {
      // Update competition status
      await db.collection('competitions').doc(competitionId).update({
        status: 'ended',
        results: results || null,
        endedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Create announcement post
      const compDoc = await db.collection('competitions').doc(competitionId).get();
      if (compDoc.exists) {
        const comp = compDoc.data();
        const resultsText = results
          ? (results.map((r, i) => `${i + 1}. ${r.displayName}`).join('\n'))
          : 'Results will be announced soon.';

        const postId = util.generateId();
        const author = await fetchUser(user.uid);
        await db.collection('posts').doc(postId).set({
          id: postId,
          authorId: user.uid,
          author: { uid: user.uid, displayName: author.displayName, avatarUrl: author.avatarUrl },
          content: `🏆 Competition Results: ${comp.title}\n\n${resultsText}`,
          schoolId: user.schoolId || null,
          competitionId: competitionId,
          isAnnouncement: true,
          likes: [],
          comments: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Notify all participants
        const participantIds = comp.participants || [];
        for (const pid of participantIds) {
          if (pid === user.uid) continue;
          try {
            await db.collection('notifications').doc(util.generateId()).set({
              userId: pid,
              type: 'competition',
              actorId: user.uid,
              actorName: user.displayName || 'Admin',
              competitionId: competitionId,
              message: `Results for "${comp.title}" have been announced!`,
              read: false,
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
          } catch (_) {}
        }
      }

      util.showToast('Results announced!', 'success');

      if (window.Router && window.Router.getCurrentPage() === 'competition') {
        const params = window.Router.getParams();
        const html = await renderCompetitionDetail(params);
        document.getElementById('page-content').innerHTML = html;
        afterDetailRender(params);
      }
    } catch (err) {
      console.error('[Competitions] Error announcing results:', err);
      util.showToast('Failed to announce results.', 'error');
    }
  }

  // ── Competitions List Page ────────────────────────────────────────────────

  /**
   * Render the competitions list page.
   * @param {Object} params - Route parameters.
   * @returns {Promise<string>} HTML string.
   */
  async function render(params) {
    const user = currentUser();
    if (!user) {
      return '<div class="error-page"><p>Please sign in to view competitions.</p></div>';
    }

    const util = u();
    const activeTab = params?.tab || _activeTab;

    let tabContentHtml = '<div class="loading-indicator"><span class="spinner"></span></div>';

    const showFAB = isAdminOrMod(user);
    const tabItems = [
      { key: 'active', label: 'Active' },
      { key: 'upcoming', label: 'Upcoming' },
      { key: 'ended', label: 'Ended' },
      { key: 'my', label: 'My Competitions' }
    ];

    const tabsHtml = tabItems.map(t =>
      `<button class="comp-tab ${activeTab === t.key ? 'active' : ''}" data-comp-tab="${t.key}">${t.label}</button>`
    ).join('');

    const html = `
      <div class="competitions-page" id="competitions-page">
        <div class="comp-tabs">
          ${tabsHtml}
        </div>
        <div class="comp-tab-content" id="comp-tab-content">
          ${tabContentHtml}
        </div>
        ${showFAB ? `
          <button class="fab" id="create-competition-fab" aria-label="Create Competition">
            <span class="fab-icon">+</span>
          </button>` : ''}
      </div>`;

    return html;
  }

  /**
   * Load and render competitions list into tab container.
   */
  async function loadAndRenderTab(filter) {
    const container = document.getElementById('comp-tab-content');
    if (!container) return;

    const comps = await loadCompetitions(filter);

    if (comps.length === 0) {
      const icons = { active: '🏆', upcoming: '📅', ended: '🏁', my: '🏅' };
      const messages = {
        active: 'No active competitions right now.',
        upcoming: 'No upcoming competitions yet.',
        ended: 'No past competitions to show.',
        my: "You haven't joined any competitions yet."
      };
      container.innerHTML = `
        <div class="empty-state" style="padding:40px 20px;">
          <span class="empty-icon">${icons[filter] || '🏆'}</span>
          <h3>Nothing here</h3>
          <p>${messages[filter] || 'No competitions found.'}</p>
        </div>`;
      return;
    }

    container.innerHTML = '<div class="competitions-list">' +
      comps.map(comp => c().renderCompetitionCard(comp)).join('') +
      '</div>';
  }

  // ── Competition Detail Page ───────────────────────────────────────────────

  /**
   * Render a single competition detail page.
   * @param {Object} params - Must include competitionId.
   * @returns {Promise<string>} HTML string.
   */
  async function renderCompetitionDetail(params) {
    const user = currentUser();
    if (!user) {
      return '<div class="error-page"><p>Please sign in to view this competition.</p></div>';
    }

    const competitionId = params?.competitionId;
    if (!competitionId) {
      return '<div class="error-page"><h2>Competition not found</h2>' +
        '<button class="btn btn-primary" onclick="window.Router.navigate(\'competitions\')">Browse Competitions</button></div>';
    }

    const util = u();
    const db = window.Firebase.db;

    // Fetch competition doc
    let compDoc;
    try {
      const doc = await db.collection('competitions').doc(competitionId).get();
      if (!doc.exists) {
        return '<div class="error-page"><h2>Competition not found</h2>' +
          '<button class="btn btn-primary" onclick="window.Router.navigate(\'competitions\')">Browse Competitions</button></div>';
      }
      compDoc = { id: doc.id, ...doc.data() };
      compDoc.startDate = compDoc.startDate?.toDate ? compDoc.startDate.toDate() : compDoc.startDate;
      compDoc.endDate = compDoc.endDate?.toDate ? compDoc.endDate.toDate() : compDoc.endDate;
      _compData = compDoc;
    } catch (err) {
      console.error('[Competitions] Error fetching competition:', err);
      return '<div class="error-page"><h2>Something went wrong</h2><p>Failed to load competition.</p></div>';
    }

    // Determine participation and admin status
    _isParticipant = (compDoc.participants || []).includes(user.uid);
    _isAdmin = isAdminOrMod(user) || compDoc.createdBy === user.uid;
    _detailTab = params?.tab || 'info';

    // Status badge
    const statusMap = {
      upcoming: { label: 'Upcoming', cls: 'status-upcoming' },
      active: { label: 'Active', cls: 'status-active' },
      ended: { label: 'Ended', cls: 'status-ended' }
    };
    const status = statusMap[compDoc.status] || statusMap.upcoming;

    // Cover image
    let coverHtml = '';
    if (compDoc.coverImage) {
      coverHtml = `<div class="comp-detail-cover">
        <img src="${util.sanitizeHTML(compDoc.coverImage)}" alt="" loading="lazy">
      </div>`;
    }

    // Join/Leave button
    let actionBtnHtml = '';
    if (compDoc.status !== 'ended') {
      if (_isParticipant) {
        actionBtnHtml = '<button class="btn btn-ghost" id="leave-comp-btn">Leave Competition</button>';
      } else {
        actionBtnHtml = '<button class="btn btn-primary" id="join-comp-btn">Join Competition</button>';
      }
    }

    // Participants avatars (first 10)
    const participantUids = compDoc.participants || [];
    let participantAvatarsHtml = '';
    if (participantUids.length > 0) {
      const participantUsers = await fetchUsers(participantUids.slice(0, 10));
      participantAvatarsHtml = participantUsers.map(p => renderAvatar(p, 'avatar-sm')).join('');
      if (participantUids.length > 10) {
        participantAvatarsHtml += `<span class="avatar avatar-sm avatar-placeholder">+${participantUids.length - 10}</span>`;
      }
    }

    // Tabs
    const detailTabs = [
      { key: 'info', label: 'Info' },
      { key: 'participants', label: `Participants (${participantUids.length})` },
    ];

    // Only show bracket tab if tournament format is set
    if (compDoc.tournamentFormat && compDoc.tournamentFormat !== 'None') {
      detailTabs.push({ key: 'bracket', label: 'Bracket' });
    }

    // Show leaderboard if competition has scores or results
    if (compDoc.status === 'ended' || compDoc.leaderboard) {
      detailTabs.push({ key: 'leaderboard', label: 'Leaderboard' });
    }

    detailTabs.push({ key: 'feed', label: 'Feed' });

    const detailTabsHtml = detailTabs.map(t =>
      `<button class="detail-tab ${_detailTab === t.key ? 'active' : ''}" data-detail-tab="${t.key}">${t.label}</button>`
    ).join('');

    // Admin section
    let adminHtml = '';
    if (_isAdmin) {
      adminHtml = `
        <div class="admin-section">
          <h4 class="admin-section-title">Admin Controls</h4>
          <div class="admin-actions">
            <button class="btn btn-outline btn-sm" id="edit-comp-btn">Edit Competition</button>
            ${compDoc.tournamentFormat && compDoc.tournamentFormat !== 'None' ?
              '<button class="btn btn-outline btn-sm" id="manage-scores-btn">Update Scores</button>' : ''}
            <button class="btn btn-outline btn-sm" id="manage-participants-btn">Manage Participants</button>
            ${compDoc.status !== 'ended' ?
              '<button class="btn btn-primary btn-sm" id="announce-results-btn">Announce Results</button>' : ''}
          </div>
        </div>`;
    }

    const html = `
      <div class="comp-detail-page" id="comp-detail-page" data-competition-id="${competitionId}">
        ${coverHtml}
        <div class="comp-detail-header">
          <div class="comp-detail-title-row">
            <h1 class="comp-detail-title">${util.sanitizeHTML(compDoc.title || 'Untitled Competition')}</h1>
            <span class="comp-status-badge ${status.cls}">${status.label}</span>
          </div>
          <div class="comp-detail-meta">
            <span class="comp-type-badge">${util.sanitizeHTML(compDoc.type || 'General')}</span>
            <span>📅 ${compDoc.startDate ? util.formatDate(compDoc.startDate) : 'TBD'}</span>
            ${compDoc.endDate ? `<span> → ${util.formatDate(compDoc.endDate)}</span>` : ''}
          </div>
          ${compDoc.prizeDescription ? `<p class="comp-prize">🏆 ${util.sanitizeHTML(compDoc.prizeDescription)}</p>` : ''}
        </div>

        <div class="comp-detail-actions">${actionBtnHtml}</div>

        <!-- Tabs -->
        <div class="detail-tabs" id="comp-detail-tabs">
          ${detailTabsHtml}
        </div>

        <!-- Tab Content -->
        <div class="detail-tab-content" id="comp-detail-tab-content">
          <div class="loading-indicator"><span class="spinner"></span></div>
        </div>

        ${adminHtml}
      </div>`;

    return html;
  }

  // ── Detail Tab Renderers ──────────────────────────────────────────────────

  /**
   * Render the Info tab.
   */
  async function renderInfoTab() {
    const container = document.getElementById('comp-detail-tab-content');
    if (!container || !_compData) return;

    const util = u();

    let html = '';

    // Description
    if (_compData.description) {
      html += `<div class="comp-section">
        <h3 class="comp-section-title">Description</h3>
        <p class="comp-description">${util.sanitizeHTML(_compData.description)}</p>
      </div>`;
    }

    // Rules
    if (_compData.rules) {
      html += `<div class="comp-section">
        <h3 class="comp-section-title">Rules & Instructions</h3>
        <div class="comp-rules">${util.sanitizeHTML(_compData.rules).replace(/\n/g, '<br>')}</div>
      </div>`;
    }

    // Tournament format
    if (_compData.tournamentFormat && _compData.tournamentFormat !== 'None') {
      html += `<div class="comp-section">
        <h3 class="comp-section-title">Tournament Format</h3>
        <p>${util.sanitizeHTML(_compData.tournamentFormat)}</p>
      </div>`;
    }

    // Max participants
    if (_compData.maxParticipants) {
      html += `<div class="comp-section">
        <h3 class="comp-section-title">Capacity</h3>
        <p>${(_compData.participantCount || 0)} / ${_compData.maxParticipants} participants</p>
        <div class="capacity-bar">
          <div class="capacity-fill" style="width:${Math.min(100, ((_compData.participantCount || 0) / _compData.maxParticipants) * 100)}%"></div>
        </div>
      </div>`;
    }

    // Participants avatars
    const participantUids = _compData.participants || [];
    if (participantUids.length > 0) {
      const users = await fetchUsers(participantUids.slice(0, 20));
      const avatarsHtml = users.map(p => `
        <div class="participant-chip" data-user-id="${p.uid}">
          ${renderAvatar(p, 'avatar-sm')}
          <span class="participant-name">${util.sanitizeHTML(p.displayName || 'Unknown')}</span>
        </div>`).join('');

      html += `<div class="comp-section">
        <h3 class="comp-section-title">Participants (${participantUids.length})</h3>
        <div class="participants-grid">${avatarsHtml}</div>
        ${participantUids.length > 20 ? `<p class="see-all-link" id="see-all-participants">See all ${participantUids.length} participants</p>` : ''}
      </div>`;
    }

    // Results (if ended)
    if (_compData.status === 'ended' && _compData.results && _compData.results.length > 0) {
      const resultsHtml = _compData.results.map((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `<div class="result-item">
          <span class="result-medal">${medal}</span>
          <span class="result-name">${util.sanitizeHTML(r.displayName || r.name || 'Unknown')}</span>
          ${r.score != null ? `<span class="result-score">${r.score}</span>` : ''}
        </div>`;
      }).join('');

      html += `<div class="comp-section">
        <h3 class="comp-section-title">🏆 Results</h3>
        <div class="results-list">${resultsHtml}</div>
      </div>`;
    }

    if (!html) {
      html = '<div class="empty-state"><p>No details available.</p></div>';
    }

    container.innerHTML = html;
  }

  /**
   * Render the Participants tab.
   */
  async function renderParticipantsTab() {
    const container = document.getElementById('comp-detail-tab-content');
    if (!container || !_compData) return;

    const participantUids = _compData.participants || [];
    if (participantUids.length === 0) {
      container.innerHTML = '<div class="empty-state"><span class="empty-icon">👥</span><h3>No participants yet</h3><p>Be the first to join!</p></div>';
      return;
    }

    const users = await fetchUsers(participantUids);
    const util = u();

    const html = users.map(p => {
      const roleBadge = _compData.createdBy === p.uid ? '<span class="role-badge role-creator">Organizer</span>' : '';
      return `
        <div class="member-item" data-user-id="${p.uid}">
          ${renderAvatar(p)}
          <div class="member-info">
            <span class="member-name">${util.sanitizeHTML(p.displayName || 'Unknown')}</span>
            ${p.username ? `<span class="member-username">@${util.sanitizeHTML(p.username)}</span>` : ''}
            ${roleBadge}
          </div>
          ${_isAdmin && p.uid !== currentUser()?.uid && _compData.createdBy !== p.uid ?
            `<button class="btn btn-danger btn-sm remove-participant-btn" data-user-id="${p.uid}">Remove</button>` : ''}
        </div>`;
    }).join('');

    container.innerHTML = `<div class="members-list">${html}</div>`;
  }

  /**
   * Render the Bracket tab.
   */
  async function renderBracketTab() {
    const container = document.getElementById('comp-detail-tab-content');
    if (!container || !_compData) return;

    if (!_compData.tournamentFormat || _compData.tournamentFormat === 'None') {
      container.innerHTML = '<div class="empty-state"><p>No bracket for this competition.</p></div>';
      return;
    }

    if (!_compData.bracket || !_compData.bracket.rounds || _compData.bracket.rounds.length === 0) {
      // Generate bracket from participants
      const participantUids = _compData.participants || [];
      if (participantUids.length < 2) {
        container.innerHTML = `<div class="empty-state">
          <span class="empty-icon">🏆</span>
          <h3>Bracket not ready</h3>
          <p>Need at least 2 participants to generate a bracket. Currently: ${participantUids.length}</p>
          ${_isAdmin ? '<button class="btn btn-primary" id="generate-bracket-btn">Generate Bracket Now</button>' : ''}
        </div>`;

        const genBtn = document.getElementById('generate-bracket-btn');
        if (genBtn) {
          genBtn.addEventListener('click', async () => {
            genBtn.disabled = true;
            genBtn.textContent = 'Generating...';
            try {
              const users = await fetchUsers(participantUids);
              const bracket = generateBracket(users, _compData.tournamentFormat);
              await window.Firebase.db.collection('competitions').doc(_compData.id).update({ bracket });

              // Re-render
              _compData.bracket = bracket;
              renderBracketTab();
            } catch (err) {
              u().showToast('Failed to generate bracket.', 'error');
              genBtn.disabled = false;
              genBtn.textContent = 'Generate Bracket Now';
            }
          });
        }
        return;
      }
    }

    const bracketHtml = renderBracket(_compData.bracket, _compData.tournamentFormat);
    container.innerHTML = `<div class="bracket-page">${bracketHtml}</div>`;

    // If admin, attach score update listeners
    if (_isAdmin) {
      attachBracketAdminListeners();
    }
  }

  /**
   * Attach admin listeners for bracket score updates and winner advancement.
   */
  function attachBracketAdminListeners() {
    const matches = document.querySelectorAll('.bracket-match[data-match-id]');
    matches.forEach(matchEl => {
      const matchId = matchEl.dataset.matchId;
      // Click on match to open score editor
      matchEl.style.cursor = 'pointer';
      matchEl.title = 'Click to update score';
      matchEl.addEventListener('click', () => {
        showScoreEditor(matchId);
      });
    });
  }

  /**
   * Show a simple score editor for a match.
   */
  function showScoreEditor(matchId) {
    const util = u();

    // Find match data
    let matchData = null;
    const bracket = _compData?.bracket;
    if (!bracket) return;

    const allMatches = [...(bracket.matches || []), ...(bracket.losersMatches || [])];
    matchData = allMatches.find(m => m.id === matchId);
    if (!matchData) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" id="score-editor-modal">
        <div class="modal-header">
          <h3>Update Score</h3>
          <button class="modal-close" id="score-modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="score-editor">
            <div class="score-team">
              <span class="score-team-name">${util.sanitizeHTML(matchData.team1?.displayName || 'Team 1')}</span>
              <input type="number" id="score-team1" class="score-input" min="0" value="${matchData.team1Score || 0}">
            </div>
            <span class="score-vs">vs</span>
            <div class="score-team">
              <span class="score-team-name">${util.sanitizeHTML(matchData.team2?.displayName || 'Team 2')}</span>
              <input type="number" id="score-team2" class="score-input" min="0" value="${matchData.team2Score || 0}">
            </div>
          </div>
          <div class="score-winner-section">
            <label>Select Winner:</label>
            <select id="score-winner-select" class="form-select">
              <option value="">-- Select Winner --</option>
              ${matchData.team1 ? `<option value="${matchData.team1.uid}" ${matchData.winnerId === matchData.team1.uid ? 'selected' : ''}>${util.sanitizeHTML(matchData.team1.displayName)}</option>` : ''}
              ${matchData.team2 ? `<option value="${matchData.team2.uid}" ${matchData.winnerId === matchData.team2.uid ? 'selected' : ''}>${util.sanitizeHTML(matchData.team2.displayName)}</option>` : ''}
              <option value="draw">Draw</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" id="score-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="score-save-btn">Save & Advance</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('score-modal-close').addEventListener('click', close);
    document.getElementById('score-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    document.getElementById('score-save-btn').addEventListener('click', async () => {
      const t1Score = document.getElementById('score-team1').value;
      const t2Score = document.getElementById('score-team2').value;
      const winnerId = document.getElementById('score-winner-select').value;

      await handleUpdateMatchScore(matchId, t1Score, t2Score);

      if (winnerId && winnerId !== 'draw') {
        await handleAdvanceWinner(matchId, winnerId);
      } else {
        // Just update the bracket in-place without advancing
        // Re-render
        const params = window.Router.getParams();
        const html = await renderCompetitionDetail(params);
        document.getElementById('page-content').innerHTML = html;
        afterDetailRender(params);
      }

      close();
    });
  }

  /**
   * Render the Leaderboard tab.
   */
  async function renderLeaderboardTab() {
    const container = document.getElementById('comp-detail-tab-content');
    if (!container || !_compData) return;

    const util = u();

    // If bracket is a League format, use standings from bracket
    if (_compData.bracket && _compData.bracket.format === 'League' && _compData.bracket.standings) {
      const sorted = [..._compData.bracket.standings].sort((a, b) => b.points - a.points);
      const rowsHtml = sorted.map((s, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `
          <div class="leaderboard-item ${i < 3 ? 'leaderboard-top' : ''}">
            <span class="leaderboard-rank">${medal}</span>
            ${renderAvatar(s, 'avatar-sm')}
            <div class="leaderboard-info">
              <span class="leaderboard-name">${util.sanitizeHTML(s.displayName)}</span>
              <span class="leaderboard-stats">W${s.won} D${s.drawn} L${s.lost}</span>
            </div>
            <span class="leaderboard-pts">${s.points} pts</span>
          </div>`;
      }).join('');

      container.innerHTML = `<div class="leaderboard-list">${rowsHtml}</div>`;
      return;
    }

    // Otherwise use results or a custom leaderboard
    if (_compData.leaderboard && _compData.leaderboard.length > 0) {
      const sorted = [..._compData.leaderboard].sort((a, b) => (b.score || 0) - (a.score || 0));
      const rowsHtml = sorted.map((entry, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `
          <div class="leaderboard-item ${i < 3 ? 'leaderboard-top' : ''}">
            <span class="leaderboard-rank">${medal}</span>
            ${renderAvatar(entry, 'avatar-sm')}
            <div class="leaderboard-info">
              <span class="leaderboard-name">${util.sanitizeHTML(entry.displayName || 'Unknown')}</span>
            </div>
            <span class="leaderboard-pts">${entry.score || 0} pts</span>
          </div>`;
      }).join('');

      container.innerHTML = `<div class="leaderboard-list">${rowsHtml}</div>`;
      return;
    }

    container.innerHTML = '<div class="empty-state"><span class="empty-icon">📊</span><h3>No leaderboard yet</h3><p>Scores will appear here once the competition progresses.</p></div>';
  }

  /**
   * Render the Feed tab - posts tagged with this competition.
   */
  async function renderFeedTab() {
    const container = document.getElementById('comp-detail-tab-content');
    if (!container || !_compData) return;

    const db = window.Firebase.db;
    const user = currentUser();

    try {
      const snap = await db
        .collection('posts')
        .where('competitionId', '==', _compData.id)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();

      if (snap.empty) {
        container.innerHTML = '<div class="empty-state"><span class="empty-icon">📝</span><h3>No posts yet</h3><p>Posts about this competition will appear here.</p></div>';
        return;
      }

      const posts = [];
      for (const doc of snap.docs) {
        const data = doc.data();
        let author = data.author || {};
        if (!author.displayName) {
          author = await fetchUser(data.authorId);
        }
        posts.push({
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt,
          author
        });
      }

      container.innerHTML = posts.map(post => c().renderPostCard(post, user)).join('');
    } catch (err) {
      console.error('[Competitions] Error loading competition feed:', err);
      container.innerHTML = '<div class="error-page"><p>Failed to load feed.</p></div>';
    }
  }

  // ── Create Competition Page ───────────────────────────────────────────────

  /**
   * Render the create competition form page.
   * @param {Object} params - Route parameters.
   * @returns {Promise<string>} HTML string.
   */
  async function renderCreateCompetition(params) {
    const user = currentUser();
    if (!user || !isAdminOrMod(user)) {
      return '<div class="error-page"><p>You do not have permission to create competitions.</p></div>';
    }

    const util = u();

    const typeOptions = COMPETITION_TYPES.map(t =>
      `<option value="${t}">${t}</option>`
    ).join('');

    const formatOptions = TOURNAMENT_FORMATS.map(f =>
      `<option value="${f}">${f}</option>`
    ).join('');

    return `
      <div class="create-comp-page" id="create-comp-page">
        <h2 class="page-title">Create Competition</h2>
        <form class="create-form" id="create-comp-form" novalidate>
          <div class="form-group">
            <label for="comp-title-input">Title *</label>
            <input type="text" id="comp-title-input" placeholder="e.g. Annual Science Quiz" maxlength="100" required>
          </div>

          <div class="form-group">
            <label for="comp-desc-input">Description</label>
            <textarea id="comp-desc-input" placeholder="Describe the competition..." maxlength="2000" rows="4"></textarea>
            <span class="char-count"><span id="comp-desc-count">0</span>/2000</span>
          </div>

          <div class="form-group">
            <label for="comp-type-select">Type *</label>
            <select id="comp-type-select" class="form-select" required>
              ${typeOptions}
            </select>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="comp-start-date">Start Date *</label>
              <input type="date" id="comp-start-date" required>
            </div>
            <div class="form-group">
              <label for="comp-end-date">End Date</label>
              <input type="date" id="comp-end-date">
            </div>
          </div>

          <div class="form-group">
            <label for="comp-max-participants">Max Participants</label>
            <input type="number" id="comp-max-participants" placeholder="Leave empty for unlimited" min="2" max="10000">
          </div>

          <div class="form-group">
            <label for="comp-prize-input">Prize Description</label>
            <input type="text" id="comp-prize-input" placeholder="e.g. 500 GIOLYNK Coins + Certificate" maxlength="200">
          </div>

          <div class="form-group">
            <label for="comp-format-select">Tournament Format</label>
            <select id="comp-format-select" class="form-select">
              ${formatOptions}
            </select>
          </div>

          <div class="form-group">
            <label for="comp-rules-input">Rules / Instructions</label>
            <textarea id="comp-rules-input" placeholder="Competition rules and guidelines..." maxlength="5000" rows="5"></textarea>
            <span class="char-count"><span id="comp-rules-count">0</span>/5000</span>
          </div>

          <div class="form-group">
            <label>Cover Image</label>
            <div class="image-upload" id="comp-cover-upload">
              <div class="image-preview" id="comp-cover-preview">
                <span class="image-placeholder">📷 Click to add cover image</span>
              </div>
              <input type="file" id="comp-cover-input" accept="image/*" class="hidden">
            </div>
          </div>

          <button type="button" class="btn btn-primary btn-full" id="create-comp-submit-btn">
            <span class="btn-text">Create Competition</span>
            <span class="btn-loader hidden"><span class="spinner"></span></span>
          </button>
        </form>
      </div>`;
  }

  // ── After-Render Hooks ─────────────────────────────────────────────────────

  /**
   * Attach listeners after competitions list page renders.
   */
  function afterRender(params) {
    const activeTab = params?.tab || _activeTab;

    // Tab switching
    document.querySelectorAll('[data-comp-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        _activeTab = tab.dataset.compTab;
        document.querySelectorAll('[data-comp-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const contentEl = document.getElementById('comp-tab-content');
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="loading-indicator"><span class="spinner"></span></div>';
        loadAndRenderTab(_activeTab);
      });
    });

    // Create FAB
    const fab = document.getElementById('create-competition-fab');
    if (fab) {
      fab.addEventListener('click', () => {
        if (window.Router) {
          window.Router.navigate('create-competition', { _hash: '/competitions/create' });
        }
      });
    }

    // Load initial tab
    loadAndRenderTab(activeTab);
  }

  /**
   * Attach listeners after competition detail page renders.
   */
  function afterDetailRender(params) {
    const competitionId = params?.competitionId;
    if (!competitionId) return;

    // Join / Leave
    const joinBtn = document.getElementById('join-comp-btn');
    if (joinBtn) {
      joinBtn.addEventListener('click', () => handleJoinCompetition(competitionId));
    }

    const leaveBtn = document.getElementById('leave-comp-btn');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', () => handleLeaveCompetition(competitionId));
    }

    // Detail tab switching
    document.querySelectorAll('[data-detail-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        _detailTab = tab.dataset.detailTab;
        document.querySelectorAll('[data-detail-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const contentEl = document.getElementById('comp-detail-tab-content');
        if (!contentEl) return;
        contentEl.innerHTML = '<div class="loading-indicator"><span class="spinner"></span></div>';

        if (_detailTab === 'info') renderInfoTab();
        else if (_detailTab === 'participants') renderParticipantsTab();
        else if (_detailTab === 'bracket') renderBracketTab();
        else if (_detailTab === 'leaderboard') renderLeaderboardTab();
        else if (_detailTab === 'feed') renderFeedTab();
      });
    });

    // Admin buttons
    const editBtn = document.getElementById('edit-comp-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        if (window.Router) {
          window.Router.navigate('create-competition', { competitionId, _hash: `/competitions/${competitionId}/edit` });
        }
      });
    }

    const announceBtn = document.getElementById('announce-results-btn');
    if (announceBtn) {
      announceBtn.addEventListener('click', async () => {
        // Build results from bracket or prompt
        const results = [];
        if (_compData?.bracket?.standings) {
          const sorted = [..._compData.bracket.standings].sort((a, b) => b.points - a.points).slice(0, 3);
          sorted.forEach(s => results.push({ displayName: s.displayName, score: s.points }));
        } else if (_compData?.leaderboard) {
          const sorted = [..._compData.leaderboard].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 3);
          sorted.forEach(s => results.push({ displayName: s.displayName, score: s.score }));
        }
        await handleAnnounceResults(competitionId, results.length > 0 ? results : null);
      });
    }

    // Load initial tab
    const contentEl = document.getElementById('comp-detail-tab-content');
    if (contentEl) {
      contentEl.innerHTML = '<div class="loading-indicator"><span class="spinner"></span></div>';
      if (_detailTab === 'info') renderInfoTab();
      else if (_detailTab === 'participants') renderParticipantsTab();
      else if (_detailTab === 'bracket') renderBracketTab();
      else if (_detailTab === 'leaderboard') renderLeaderboardTab();
      else if (_detailTab === 'feed') renderFeedTab();
    }
  }

  /**
   * Initialize the create competition form listeners.
   */
  function initCreateForm(editMode = false) {
    const form = document.getElementById('create-comp-form');
    if (!form) return;

    const util = u();

    const titleInput = document.getElementById('comp-title-input');
    const descInput = document.getElementById('comp-desc-input');
    const descCount = document.getElementById('comp-desc-count');
    const rulesInput = document.getElementById('comp-rules-input');
    const rulesCount = document.getElementById('comp-rules-count');
    const coverUpload = document.getElementById('comp-cover-upload');
    const coverInput = document.getElementById('comp-cover-input');
    const coverPreview = document.getElementById('comp-cover-preview');
    const submitBtn = document.getElementById('create-comp-submit-btn');

    // Char counters
    if (descInput && descCount) {
      descInput.addEventListener('input', () => { descCount.textContent = descInput.value.length; });
    }
    if (rulesInput && rulesCount) {
      rulesInput.addEventListener('input', () => { rulesCount.textContent = rulesInput.value.length; });
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

        if (!document.getElementById('comp-start-date')?.value) {
          util.showToast('Please select a start date.', 'warning');
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
          type: document.getElementById('comp-type-select')?.value || 'General',
          startDate: document.getElementById('comp-start-date')?.value,
          endDate: document.getElementById('comp-end-date')?.value || null,
          maxParticipants: document.getElementById('comp-max-participants')?.value || null,
          prizeDescription: document.getElementById('comp-prize-input')?.value || '',
          tournamentFormat: document.getElementById('comp-format-select')?.value || 'None',
          rules: rulesInput?.value || '',
          coverImage: coverData
        };

        const result = await handleCreateCompetition(data);

        submitBtn.disabled = false;
        if (textEl) textEl.classList.remove('hidden');
        if (loaderEl) loaderEl.classList.add('hidden');

        if (result) {
          if (window.Router) {
            window.Router.navigate('competition', {
              competitionId: result.id,
              _hash: `/competitions/${result.id}`
            });
          }
        }
      });
    }
  }

  // ── Event Delegation ──────────────────────────────────────────────────────

  function handleCompetitionsClicks(e) {
    const target = e.target;

    // Competition card clicks
    const compCard = target.closest('.competition-card[data-competition-id]');
    if (compCard) {
      const competitionId = compCard.dataset.competitionId;
      if (competitionId && window.Router) {
        window.Router.navigate('competition', { competitionId, _hash: `/competitions/${competitionId}` });
      }
      return;
    }

    // Participant/user clicks -> navigate to profile
    const userItem = target.closest('[data-user-id]');
    if (userItem && !target.closest('.member-actions') && !target.closest('.btn')) {
      const userId = userItem.dataset.userId;
      if (userId && window.Router) {
        window.Router.navigate('user-profile', { userId, _hash: `/user/${userId}` });
      }
      return;
    }

    // Post card clicks
    const postCard = target.closest('.post-card[data-post-id]');
    if (postCard) {
      if (target.closest('.post-action-btn') || target.closest('.comment-action-btn')) return;
      const postId = postCard.dataset.postId;
      if (postId && window.Router) {
        window.Router.navigate('post-detail', { postId, _hash: `/post/${postId}` });
      }
      return;
    }

    // Remove participant button
    const removeBtn = target.closest('.remove-participant-btn');
    if (removeBtn && _compData) {
      const userId = removeBtn.dataset.userId;
      if (userId) {
        handleRemoveParticipant(_compData.id, userId);
      }
      return;
    }

    // See all participants
    if (target.closest('#see-all-participants')) {
      const tab = document.querySelector('[data-detail-tab="participants"]');
      if (tab) tab.click();
      return;
    }
  }

  /**
   * Remove a participant (admin only).
   */
  async function handleRemoveParticipant(competitionId, userId) {
    const user = currentUser();
    if (!user || !competitionId || !userId) return;

    const util = u();
    const confirmed = await util.showConfirm('Remove Participant', 'Are you sure you want to remove this participant?');
    if (!confirmed) return;

    try {
      await window.Firebase.db.collection('competitions').doc(competitionId).update({
        participants: firebase.firestore.FieldValue.arrayRemove(userId),
        participantCount: firebase.firestore.FieldValue.increment(-1)
      });

      util.showToast('Participant removed.', 'info');

      // Re-render
      if (window.Router && window.Router.getCurrentPage() === 'competition') {
        const params = window.Router.getParams();
        const html = await renderCompetitionDetail(params);
        document.getElementById('page-content').innerHTML = html;
        afterDetailRender(params);
      }
    } catch (err) {
      console.error('[Competitions] Error removing participant:', err);
      util.showToast('Failed to remove participant.', 'error');
    }
  }

  // ── Initialization ────────────────────────────────────────────────────────

  function init() {
    document.addEventListener('click', (e) => {
      const compPage = document.getElementById('competitions-page');
      const compDetailPage = document.getElementById('comp-detail-page');
      const createCompPage = document.getElementById('create-comp-page');

      if ((compPage && compPage.contains(e.target)) ||
          (compDetailPage && compDetailPage.contains(e.target)) ||
          (createCompPage && createCompPage.contains(e.target))) {
        handleCompetitionsClicks(e);
      }
    });

    window.addEventListener('pageChange', (e) => {
      if (e.detail.page === 'competitions') {
        afterRender(e.detail.params);
      } else if (e.detail.page === 'competition') {
        afterDetailRender(e.detail.params);
      } else if (e.detail.page === 'create-competition') {
        initCreateForm(!!e.detail.params?.competitionId);
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.Competitions = {
    init,
    render,
    loadCompetitions,
    renderCompetitionDetail,
    renderCreateCompetition,
    handleJoinCompetition,
    handleLeaveCompetition,
    generateBracket,
    renderBracket,
    handleUpdateMatchScore,
    handleAdvanceWinner,
    handleAnnounceResults
  };
})();