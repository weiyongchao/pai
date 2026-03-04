const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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
  await requireUser(OPENID);

  const roomId = String(event.roomId || "").trim();
  if (!roomId) throw new Error("roomId 不能为空");

  const ts = Date.now();
  const memberId = `${roomId}_${OPENID}`;
  const memberRef = db.collection("room_members").doc(memberId);
  const meMember = await memberRef.get().catch(() => null);
  if (!meMember || !meMember.data) {
    throw new Error("你不在该房间内");
  }
  if (meMember.data.active === false) throw new Error("你已退房");

  await memberRef.update({
    data: {
      active: true,
      lastSeenAt: ts,
      updatedAt: ts
    }
  });

  const roomDoc = await db.collection("rooms").doc(roomId).get().catch(() => null);
  if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");

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
