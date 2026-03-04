const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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

async function getUsersByOpenids(openids) {
  if (openids.length === 0) return new Map();
  const map = new Map();
  const batchSize = 20;
  for (let i = 0; i < openids.length; i += batchSize) {
    const batch = openids.slice(i, i + batchSize);
    const res = await db
      .collection("users")
      .where({ _id: _.in(batch) })
      .get();
    for (const user of res.data || []) {
      map.set(user._id, user);
    }
  }
  return map;
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

  const roomDoc = await db.collection("rooms").doc(roomId).get().catch(() => null);
  if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");
  if (roomDoc.data.status !== "active") throw new Error("房间已关闭");

  const activeRoomId = await findActiveRoomId(OPENID);
  if (activeRoomId && activeRoomId !== roomId) {
    throw new Error(`你已在房间 ${activeRoomId}，请先退房`);
  }

  const memberId = `${roomId}_${OPENID}`;
  const memberRef = db.collection("room_members").doc(memberId);
  const meMember = await memberRef.get().catch(() => null);
  if (!meMember || !meMember.data) {
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
  } else if (meMember.data.active === false) {
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
  }

  const membersRes = await db
    .collection("room_members")
    .where({ roomId })
    .orderBy("joinedAt", "asc")
    .get();
  const members = (membersRes.data || []).filter((m) => m.active !== false);
  const openids = members.map((m) => m.openid);

  const userMap = await getUsersByOpenids(openids);
  const membersWithProfile = members.map((m) => {
    const userProfile = userMap.get(m.openid) || {};
    return {
      openid: m.openid,
      score: m.score || 0,
      nickName: userProfile.nickName || m.openid.slice(0, 6),
      avatarUrl: userProfile.avatarUrl || ""
    };
  });

  const logsRes = await db
    .collection("room_logs")
    .where({ roomId })
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  const logs = (logsRes.data || []).reverse();

  return {
    meOpenid: OPENID,
    room: roomDoc.data,
    members: membersWithProfile,
    logs
  };
};
