const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ROOM_ID_LEN = 4;
const ROOM_ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomRoomId(len = ROOM_ID_LEN) {
  let s = "";
  for (let i = 0; i < len; i += 1) {
    s += ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)];
  }
  return s;
}

async function allocateRoomId() {
  // 4 位 base36：约 167 万空间；配合“存在性检查+重试”基本可满足不重复需求
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = randomRoomId();
    const existing = await db
      .collection("rooms")
      .doc(candidate)
      .get()
      .catch(() => null);
    if (!existing || !existing.data) return candidate;
  }
  throw new Error("生成房间号失败，请重试");
}

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
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await ensureCollection("room_logs");
  const me = await ensureUser(OPENID);

  const activeRoomId = await findActiveRoomId(OPENID);
  if (activeRoomId) {
    return { roomId: activeRoomId, existed: true };
  }

  const ts = Date.now();
  const roomId = await allocateRoomId();

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
