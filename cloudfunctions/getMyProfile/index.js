const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ensuredCollections = new Set();
async function ensureCollection(name) {
  if (ensuredCollections.has(name)) return;
  ensuredCollections.add(name);
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

function buildDefaultUser(openid, ts) {
  const safe = String(openid || "").slice(0, 6);
  return {
    nickName: safe ? `玩家${safe}` : "玩家",
    avatarUrl: "",
    profileCompleted: false,
    stats: { gamesPlayed: 0, wins: 0, losses: 0 },
    recentGames: [],
    createdAt: ts,
    updatedAt: ts
  };
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  await ensureCollection("users");
  const userRef = db.collection("users").doc(OPENID);
  const doc = await userRef.get().catch(() => null);
  if (doc && doc.data) {
    return { openid: OPENID, user: withDefaultStats(doc.data) };
  }

  // 默认创建“游客用户”，避免进入首页就必须授权头像/昵称（审核要求：先体验后授权）
  const ts = Date.now();
  const user = buildDefaultUser(OPENID, ts);
  await userRef
    .set({
      data: user
    })
    .catch(() => null);
  return { openid: OPENID, user: withDefaultStats(user) };
};
