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

async function requireUser(openid) {
  try {
    const doc = await db.collection("users").doc(openid).get();
    return doc.data;
  } catch {
    throw new Error("请先授权登录");
  }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  await ensureCollection("users");
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await requireUser(OPENID);

  const membersRes = await db
    .collection("room_members")
    .where({ openid: OPENID })
    .orderBy("updatedAt", "desc")
    .limit(20)
    .get();

  const members = membersRes.data || [];
  for (const member of members) {
    if (member.active === false) continue;
    const roomId = String(member.roomId || "").trim();
    if (!roomId) continue;
    const roomDoc = await db.collection("rooms").doc(roomId).get().catch(() => null);
    if (!roomDoc || !roomDoc.data) continue;
    if (roomDoc.data.status !== "active") continue;
    return { roomId };
  }

  return { roomId: "" };
};
