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

async function requireUser(openid) {
  try {
    const doc = await db.collection("users").doc(openid).get();
    return doc.data;
  } catch {
    throw new Error("请先授权登录");
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  await ensureCollection("users");
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await requireUser(OPENID);

  const roomId = String(event.roomId || "").trim();
  if (!roomId) throw new Error("roomId 不能为空");

  const roomDoc = await db.collection("rooms").doc(roomId).get().catch(() => null);
  if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");
  if (roomDoc.data.status !== "active") return { ok: true, ended: true };

  const ts = Date.now();
  const memberId = `${roomId}_${OPENID}`;
  const memberRef = db.collection("room_members").doc(memberId);
  const memberDoc = await memberRef.get().catch(() => null);
  if (!memberDoc || !memberDoc.data) throw new Error("你不在该房间内");
  if (memberDoc.data.active === false) throw new Error("你已退房");

  await memberRef.update({
    data: {
      active: true,
      lastSeenAt: ts,
      updatedAt: ts
    }
  });

  return { ok: true };
};

