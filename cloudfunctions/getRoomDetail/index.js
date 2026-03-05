const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MAX_MEMBERS = 20;
const SEEN_TOUCH_MIN_INTERVAL_MS = 15 * 1000;

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

async function ensureUser(openid) {
  await ensureCollection("users");
  const userRef = db.collection("users").doc(openid);
  const doc = await userRef.get().catch(() => null);
  if (doc && doc.data) return doc.data;
  const ts = Date.now();
  const user = buildDefaultUser(openid, ts);
  await userRef
    .set({
      data: user
    })
    .catch(() => null);
  return user;
}

async function findActiveRoomId(openid) {
  const membersRes = await db
    .collection("room_members")
    .where({ openid, active: _.neq(false) })
    .orderBy("updatedAt", "desc")
    .limit(20)
    .get();

  const members = membersRes.data || [];
  const roomIds = Array.from(
    new Set(
      members
        .map((m) => String(m.roomId || "").trim())
        .filter(Boolean)
    )
  );
  if (roomIds.length === 0) return "";

  const roomsRes = await db
    .collection("rooms")
    .where({ _id: _.in(roomIds) })
    .get()
    .catch(() => ({ data: [] }));
  const activeRooms = new Set((roomsRes.data || []).filter((r) => r.status === "active").map((r) => String(r._id || "").trim()));
  for (const member of members) {
    const roomId = String(member.roomId || "").trim();
    if (roomId && activeRooms.has(roomId)) return roomId;
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
      .field({ _id: true, nickName: true, avatarUrl: true })
      .get();
    for (const user of res.data || []) {
      map.set(user._id, user);
    }
  }
  return map;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (event && event.warmup) return { ok: true, warmup: true };
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await ensureCollection("room_logs");
  const roomId = String(event.roomId || "").trim();
  if (!roomId) throw new Error("roomId 不能为空");

  const roomDoc = await db.collection("rooms").doc(roomId).get().catch(() => null);
  if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");
  if (roomDoc.data.status !== "active") throw new Error("房间已关闭");

  const memberId = `${roomId}_${OPENID}`;
  const memberRef = db.collection("room_members").doc(memberId);
  const meMember = await memberRef.get().catch(() => null);

  const needJoin = !meMember || !meMember.data || meMember.data.active === false;
  let me = null;
  if (needJoin) {
    // 需要入房/重新入房时才强制校验授权并取昵称（用于写入 join 流水）
    me = await ensureUser(OPENID);
  }

  // 性能优化：只有在需要“入房/重新入房”时才检查是否已在其他房间
  // 已在当前房间内刷新数据不需要做全局扫描（findActiveRoomId 会触发多次 rooms 读取）
  if (needJoin) {
    const activeRoomId = await findActiveRoomId(OPENID);
    if (activeRoomId && activeRoomId !== roomId) {
      throw new Error(`你已在房间 ${activeRoomId}，请先退房`);
    }
  }

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
  } else {
    const ts = Date.now();
    const lastSeenAt = Number(meMember.data.lastSeenAt || meMember.data.updatedAt || 0);
    if (!lastSeenAt || ts - lastSeenAt >= SEEN_TOUCH_MIN_INTERVAL_MS) {
      await memberRef
        .update({
          data: {
            lastSeenAt: ts,
            updatedAt: ts
          }
        })
        .catch(() => null);
    }
  }

  const [membersRes, logsRes] = await Promise.all([
    db
      .collection("room_members")
      .where({ roomId })
      .orderBy("joinedAt", "asc")
      .field({ openid: true, score: true, active: true, joinedAt: true })
      .get(),
    db
      .collection("room_logs")
      .where({ roomId })
      .orderBy("createdAt", "desc")
      .limit(50)
      .field({ roomId: true, type: true, fromOpenid: true, toOpenid: true, amount: true, createdAt: true, text: true })
      .get()
  ]);

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

  const logs = (logsRes.data || []).reverse();

  return {
    meOpenid: OPENID,
    room: roomDoc.data,
    members: membersWithProfile,
    logs
  };
};
