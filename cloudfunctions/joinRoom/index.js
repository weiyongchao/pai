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
