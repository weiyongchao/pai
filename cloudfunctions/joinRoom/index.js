const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_MEMBERS = 20;

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

async function findActiveRoomId(openid) {
  const membersRes = await db
    .collection("room_members")
    .where({ openid })
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
    return roomId;
  }

  return "";
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

  const activeRoomId = await findActiveRoomId(OPENID);
  if (activeRoomId && activeRoomId !== roomId) {
    throw new Error(`你已在房间 ${activeRoomId}，请先退房`);
  }

  const roomDoc = await db.collection("rooms").doc(roomId).get().catch(() => null);
  if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");
  const roomStatus = roomDoc.data.status;
  if (roomStatus !== "active") throw new Error("房间已关闭");

  const memberId = `${roomId}_${OPENID}`;
  const memberRef = db.collection("room_members").doc(memberId);

  try {
    const existing = await memberRef.get();
    if (existing?.data?.active === false) {
      const ts = Date.now();
      await memberRef.update({
        data: {
          active: true,
          lastSeenAt: ts,
          updatedAt: ts
        }
      });
      await db.collection("room_logs").add({
        data: {
          roomId,
          type: "join",
          createdAt: ts,
          text: `${me.nickName} 重新加入房间`
        }
      });
      return { joined: false, rejoined: true, roomStatus };
    }

    const ts = Date.now();
    await memberRef.update({
      data: {
        active: true,
        lastSeenAt: ts,
        updatedAt: ts
      }
    });
    return { joined: false, roomStatus };
  } catch {
    const membersRes = await db.collection("room_members").where({ roomId }).get();
    const activeCount = (membersRes.data || []).filter((m) => m.active !== false).length;
    if (activeCount >= MAX_MEMBERS) {
      throw new Error(`房间人数已满（上限 ${MAX_MEMBERS}）`);
    }

    const ts = Date.now();
    await memberRef.set({
      data: {
        roomId,
        openid: OPENID,
        score: 0,
        active: true,
        lastSeenAt: ts,
        joinedAt: ts,
        updatedAt: ts
      }
    });

    await db.collection("room_logs").add({
      data: {
        roomId,
        type: "join",
        createdAt: ts,
        text: `${me.nickName} 加入房间`
      }
    });
    return { joined: true, roomStatus };
  }
};
