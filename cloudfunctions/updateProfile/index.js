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

function now() {
  return Date.now();
}

function normalizeNickName(nickName) {
  const s = String(nickName || "").trim();
  if (!s) return "";
  return s.slice(0, 20);
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const nickName = normalizeNickName(event.nickName);
  const avatarUrl = String(event.avatarUrl || "").trim();

  if (!nickName) {
    throw new Error("昵称不能为空");
  }

  await ensureCollection("users");

  const ts = now();
  const userRef = db.collection("users").doc(OPENID);

  try {
    await userRef.get();
    await userRef.update({
      data: {
        nickName,
        avatarUrl,
        profileCompleted: true,
        updatedAt: ts
      }
    });
  } catch {
    await userRef.set({
      data: {
        nickName,
        avatarUrl,
        profileCompleted: true,
        stats: { gamesPlayed: 0, wins: 0, losses: 0 },
        recentGames: [],
        createdAt: ts,
        updatedAt: ts
      }
    });
  }

  return { ok: true };
};
