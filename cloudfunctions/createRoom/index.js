const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function genRoomId() {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${timePart}${randomPart}`.slice(0, 32);
}

async function requireUser(openid) {
  try {
    const doc = await db
      .collection("users")
      .doc(openid)
      .field({ nickName: true })
      .get();
    return doc.data;
  } catch {
    throw new Error("请先授权登录");
  }
}

async function findActiveRoomId(openid) {
  const membersRes = await db
    .collection("room_members")
    .where({ openid, active: _.neq(false) })
    .orderBy("updatedAt", "desc")
    .limit(20)
    .field({ roomId: true, updatedAt: true })
    .get();

  const members = membersRes.data || [];
  const roomIds = Array.from(new Set(members.map((m) => String(m.roomId || "").trim()).filter(Boolean)));
  if (roomIds.length === 0) return "";

  const roomsRes = await db
    .collection("rooms")
    .where({ _id: _.in(roomIds) })
    .field({ _id: true, status: true })
    .get()
    .catch(() => ({ data: [] }));
  const activeRooms = new Set((roomsRes.data || []).filter((r) => r.status === "active").map((r) => String(r._id || "").trim()));
  for (const member of members) {
    const roomId = String(member.roomId || "").trim();
    if (roomId && activeRooms.has(roomId)) return roomId;
  }

  return "";
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (event && event.warmup) return { ok: true, warmup: true };
  const me = await requireUser(OPENID);

  const activeRoomId = await findActiveRoomId(OPENID);
  if (activeRoomId) {
    return { roomId: activeRoomId, existed: true };
  }

  const ts = Date.now();
  const roomId = genRoomId();

  await db.collection("rooms").doc(roomId).set({
    data: {
      ownerOpenid: OPENID,
      status: "active",
      createdAt: ts,
      updatedAt: ts
    }
  });

  await db.collection("room_members").doc(`${roomId}_${OPENID}`).set({
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
      text: `${me.nickName} 创建房间`
    }
  });

  return { roomId };
};
