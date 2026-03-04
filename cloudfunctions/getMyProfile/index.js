const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch {
    // ignore
  }
}

function withDefaultStats(user) {
  if (!user) return user;
  const stats = user.stats || {};
  const recentGames = Array.isArray(user.recentGames) ? user.recentGames : [];
  return {
    ...user,
    stats: {
      gamesPlayed: stats.gamesPlayed || 0,
      wins: stats.wins || 0,
      losses: stats.losses || 0
    },
    recentGames
  };
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  await ensureCollection("users");
  try {
    const doc = await db.collection("users").doc(OPENID).get();
    return { openid: OPENID, user: withDefaultStats(doc.data) };
  } catch {
    return { openid: OPENID, user: null };
  }
};
