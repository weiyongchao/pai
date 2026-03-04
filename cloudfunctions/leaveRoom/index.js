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
  await ensureCollection("room_logs");
  const me = await requireUser(OPENID);

  const roomId = String(event.roomId || "").trim();
  if (!roomId) throw new Error("roomId 不能为空");

  const ts = Date.now();
  await db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.collection("rooms").doc(roomId).get().catch(() => null);
    if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");

    const memberId = `${roomId}_${OPENID}`;
    const memberRef = transaction.collection("room_members").doc(memberId);
    const memberDoc = await memberRef.get().catch(() => null);
    if (!memberDoc || !memberDoc.data) throw new Error("你不在该房间内");
    if (memberDoc.data.active === false) return;

    await memberRef.update({
      data: {
        active: false,
        leftAt: ts,
        updatedAt: ts
      }
    });

    await transaction.collection("room_logs").add({
      data: {
        roomId,
        type: "leave",
        createdAt: ts,
        text: `${me.nickName} 退出房间`
      }
    });

    await transaction.collection("rooms").doc(roomId).update({
      data: {
        updatedAt: ts
      }
    });
  });

  try {
    await cloud.callFunction({
      name: "autoCloseRooms",
      data: { roomId }
    });
  } catch {
    // ignore
  }

  return { ok: true };
};

