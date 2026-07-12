'use strict';
/* GIOLYNK - Reputation Module */
window.Reputation = {};

(function () {
  const db = () => window.Firebase.db;

  const LEVEL_THRESHOLDS = [
    0, 50, 120, 220, 350, 520, 730, 1000, 1350, 1780,
    2300, 2950, 3700, 4600, 5700, 7000, 8600, 10500, 12800, 15500
  ];

  const LEVEL_TITLES = [
    'Newcomer', 'Freshman', 'Explorer', 'Contributor', 'Active',
    'Rising Star', 'Influencer', 'Trendsetter', 'Veteran', 'Elite',
    'Champion', 'Legend', 'Superstar', 'Icon', 'Mentor',
    'Master', 'Grandmaster', 'Guru', 'Sage', 'GIOLYNK Legend'
  ];

  const DEFAULT_BADGES = [
    { id: 'first_post', name: 'First Post', icon: '📝', description: 'Created your first post', requirement: 'posts >= 1' },
    { id: 'social_butterfly', name: 'Social Butterfly', icon: '🦋', description: 'Made 10 friends', requirement: 'friends >= 10' },
    { id: 'popular', name: 'Popular', icon: '⭐', description: 'Got 100 likes total', requirement: 'totalLikes >= 100' },
    { id: 'chatterbox', name: 'Chatterbox', icon: '💬', description: 'Sent 500 messages', requirement: 'messages >= 500' },
    { id: 'helper', name: 'Helper', icon: '🤝', description: 'Answered 10 polls', requirement: 'pollVotes >= 10' },
    { id: 'event_goer', name: 'Event Goer', icon: '🎉', description: 'Attended 5 events', requirement: 'eventsAttended >= 5' },
    { id: 'competitor', name: 'Competitor', icon: '🏆', description: 'Joined 3 competitions', requirement: 'competitionsJoined >= 3' },
    { id: 'early_adopter', name: 'Early Adopter', icon: '🚀', description: 'Joined GIOLYNK early', requirement: 'createdAt < 2026-01-01' },
    { id: 'streak_7', name: 'Week Warrior', icon: '🔥', description: '7-day posting streak', requirement: 'streak >= 7' },
    { id: 'group_creator', name: 'Group Creator', icon: '👥', description: 'Created a group', requirement: 'groupsCreated >= 1' },
    { id: 'coin_master', name: 'Coin Master', icon: '💰', description: 'Earned 1000 coins', requirement: 'coins >= 1000' },
    { id: 'commentator', name: 'Commentator', icon: '💬', description: 'Made 50 comments', requirement: 'comments >= 50' }
  ];

  const DEFAULT_ACHIEVEMENTS = [
    { id: 'welcome', name: 'Welcome to GIOLYNK', icon: '🎉', description: 'Completed onboarding', xpReward: 20, coinReward: 50 },
    { id: 'first_friend', name: 'First Friend', icon: '🤝', description: 'Made your first friend', xpReward: 30, coinReward: 25 },
    { id: 'poster_10', name: 'Content Creator', icon: '📝', description: 'Created 10 posts', xpReward: 50, coinReward: 50 },
    { id: 'liker_50', name: 'Engaged', icon: '❤️', description: 'Liked 50 posts', xpReward: 30, coinReward: 30 },
    { id: 'level_5', name: 'Rising Star', icon: '⭐', description: 'Reached Level 5', xpReward: 0, coinReward: 100 },
    { id: 'group_join_3', name: 'Community Member', icon: '👥', description: 'Joined 3 groups', xpReward: 40, coinReward: 40 },
    { id: 'competition_win', name: 'Champion', icon: '🏆', description: 'Won a competition', xpReward: 100, coinReward: 200 },
    { id: 'streak_30', name: 'Dedicated', icon: '🔥', description: '30-day posting streak', xpReward: 200, coinReward: 300 }
  ];

  const XP_REWARDS = {
    post_created: 5,
    comment_added: 2,
    like_given: 1,
    like_received: 3,
    friend_added: 10,
    competition_joined: 5,
    event_rsvp: 3,
    group_created: 15,
    poll_voted: 1,
    daily_login: 2
  };

  const COIN_REWARDS = {
    post_created: 2,
    competition_win: 100,
    achievement_unlocked: 50,
    level_up: 25,
    daily_login: 1
  };

  Reputation.getLevelInfo = function (level, xp) {
    const currentThreshold = LEVEL_THRESHOLDS[Math.min(level - 1, LEVEL_THRESHOLDS.length - 1)] || 0;
    const nextThreshold = LEVEL_THRESHOLDS[Math.min(level, LEVEL_THRESHOLDS.length - 1)] || (currentThreshold + 500);
    const progress = Math.min(((xp - currentThreshold) / (nextThreshold - currentThreshold)) * 100, 100);
    const title = LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)] || 'Legend';
    return { level, xp, currentThreshold, nextThreshold, progress: Math.max(0, progress), title };
  };

  Reputation.getBadges = function (userBadges) {
    return DEFAULT_BADGES.map(b => ({
      ...b,
      earned: (userBadges || []).includes(b.id)
    }));
  };

  Reputation.getAchievements = function (userAchievements) {
    return DEFAULT_ACHIEVEMENTS.map(a => ({
      ...a,
      completed: (userAchievements || []).includes(a.id)
    }));
  };

  Reputation.awardXP = async function (userId, amount, reason) {
    try {
      const userRef = db().collection('users').doc(userId);
      const doc = await userRef.get();
      if (!doc.exists) return;

      const user = doc.data();
      let xp = (user.xp || 0) + amount;
      let level = user.level || 1;
      let coins = user.coins || 0;
      let newLevel = level;

      // Check level up
      while (newLevel < LEVEL_THRESHOLDS.length && xp >= (LEVEL_THRESHOLDS[newLevel] || Infinity)) {
        newLevel++;
      }

      const updateData = {
        xp: xp,
        coins: coins + (COIN_REWARDS[reason] || 0)
      };

      if (newLevel > level) {
        updateData.level = newLevel;
        updateData.coins = updateData.coins + 25; // Level up coin bonus
        Notifications.createNotification(userId, 'level_up', {
          senderId: 'system',
          title: 'Level Up!',
          body: 'You reached Level ' + newLevel + ': ' + (LEVEL_TITLES[newLevel - 1] || 'Unknown'),
          targetType: 'user',
          targetId: userId
        });
      }

      await userRef.update(updateData);

      // Check for new achievements
      await checkAchievements(userId, user, xp, newLevel, coins);

    } catch (err) {
      console.error('XP award error:', err);
    }
  };

  async function checkAchievements(userId, user, xp, level, coins) {
    const currentAchievements = user.achievements || [];
    const newAchievements = [];

    const checks = {
      welcome: user.isOnboarded === true,
      first_friend: (user.friendsCount || 0) >= 1,
      poster_10: (user.postsCount || 0) >= 10,
      liker_50: (user.likesGiven || 0) >= 50,
      level_5: level >= 5,
      group_join_3: (user.groupsJoined || 0) >= 3,
      competition_win: (user.competitionsWon || 0) >= 1,
      streak_30: (user.currentStreak || 0) >= 30
    };

    for (const [id, condition] of Object.entries(checks)) {
      if (condition && !currentAchievements.includes(id)) {
        newAchievements.push(id);
      }
    }

    if (newAchievements.length > 0) {
      const allAchievements = [...currentAchievements, ...newAchievements];
      const totalCoinReward = newAchievements.reduce((sum, id) => {
        const ach = DEFAULT_ACHIEVEMENTS.find(a => a.id === id);
        return sum + (ach?.coinReward || 0);
      }, 0);
      const totalXPReward = newAchievements.reduce((sum, id) => {
        const ach = DEFAULT_ACHIEVEMENTS.find(a => a.id === id);
        return sum + (ach?.xpReward || 0);
      }, 0);

      await db().collection('users').doc(userId).update({
        achievements: allAchievements,
        coins: firebase.firestore.FieldValue.increment(totalCoinReward),
        xp: firebase.firestore.FieldValue.increment(totalXPReward)
      });

      newAchievements.forEach(id => {
        const ach = DEFAULT_ACHIEVEMENTS.find(a => a.id === id);
        if (ach) {
          Notifications.createNotification(userId, 'achievement', {
            senderId: 'system',
            title: 'Achievement Unlocked!',
            body: ach.name + ': ' + ach.description,
            targetType: 'user',
            targetId: userId
          });
        }
      });
    }
  }

  Reputation.getLeaderboard = async function (schoolId, limit) {
    try {
      const snap = await db().collection('users')
        .where('schoolId', '==', schoolId)
        .orderBy('xp', 'desc')
        .limit(limit || 20)
        .get();
      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
      console.error('Leaderboard error:', err);
      return [];
    }
  };
})();