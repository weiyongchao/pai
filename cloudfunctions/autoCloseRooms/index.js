const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const OFFLINE_MS = 10 * 60 * 1000;
const MAX_RECENT_GAMES = 20;
const MAX_ROOMS_PER_RUN = 50;
const MAX_CLEANUP_ROOMS_PER_RUN = 50;
const MAX_CLEANUP_ROUNDS = 200;

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

function normalizeScore(score) {
  const n = Number(score || 0);
  return Number.isFinite(n) ? n : 0;
}

function getResult(score) {
  if (score > 0) return "win";
  if (score < 0) return "loss";
  return "draw";
}

function formatSignedScore(score) {
  const n = normalizeScore(score);
  return n > 0 ? `+${n}` : `${n}`;
}

function normalizeNickName(nickName, fallback) {
  const s = String(nickName || "").trim();
  if (s) return s.slice(0, 20);
  return String(fallback || "").trim() || "成员";
}

function getCloseReason(activeMembers, ts) {
  if (activeMembers.length === 0) return "all_left";
  const offlineBefore = ts - OFFLINE_MS;
  const allOffline = activeMembers.every((m) => {
    const lastSeenAt = Number(m.lastSeenAt || m.updatedAt || m.joinedAt || 0);
    return lastSeenAt > 0 && lastSeenAt <= offlineBefore;
  });
  return allOffline ? "inactive_10m" : "";
}

async function removeWhereAll(collectionName, where) {
  let total = 0;
  for (let round = 0; round < MAX_CLEANUP_ROUNDS; round += 1) {
    const res = await db
      .collection(collectionName)
      .where(where)
      .remove()
      .catch(() => null);
    const removed = Number(res?.stats?.removed || 0);
    total += removed;
    if (!removed) break;
  }
  return total;
}

async function cleanupRoomData(roomId) {
  const roomRef = db.collection("rooms").doc(roomId);
  const roomDoc = await roomRef.get().catch(() => null);
  const room = roomDoc?.data || null;

  const roomCodeFileID = String(room?.roomCodeFileID || "").trim();
  if (roomCodeFileID) {
    try {
      await cloud.deleteFile({ fileList: [roomCodeFileID] });
    } catch {
      // ignore
    }
  }

  const logsRemoved = await removeWhereAll("room_logs", { roomId });
  const membersRemoved = await removeWhereAll("room_members", { roomId });

  // 若已把房间相关数据清理干净，最后删除房间 doc
  const hasMoreLogs = await db
    .collection("room_logs")
    .where({ roomId })
    .limit(1)
    .get()
    .then((r) => (r.data || []).length > 0)
    .catch(() => false);
  const hasMoreMembers = await db
    .collection("room_members")
    .where({ roomId })
    .limit(1)
    .get()
    .then((r) => (r.data || []).length > 0)
    .catch(() => false);

  if (!hasMoreLogs && !hasMoreMembers) {
    await roomRef.remove().catch(() => null);
    return { ok: true, logsRemoved, membersRemoved, roomRemoved: true };
  }

  // 保留 rooms 以便后续重试清理
  await roomRef
    .update({ data: { cleanupPending: true, cleanupUpdatedAt: Date.now() } })
    .catch(() => null);
  return { ok: false, logsRemoved, membersRemoved, roomRemoved: false };
}

async function tryCloseRoom(roomId, ts) {
  let result = { roomId, closed: false, reason: "" };
  await db.runTransaction(async (transaction) => {
    const roomRef = transaction.collection("rooms").doc(roomId);
    const roomDoc = await roomRef.get().catch(() => null);
    if (!roomDoc || !roomDoc.data) {
      result = { roomId, closed: false, reason: "not_found" };
      return;
    }

    const room = roomDoc.data;
    if (room.status !== "active") {
      result = { roomId, closed: false, reason: "already_closed" };
      return;
    }

    const membersRes = await transaction.collection("room_members").where({ roomId }).get();
    const members = membersRes.data || [];
    const activeMembers = members.filter((m) => m.active !== false);
    const closeReason = getCloseReason(activeMembers, ts);
    if (!closeReason) {
      result = { roomId, closed: false, reason: "" };
      return;
    }

    const openids = Array.from(new Set(members.map((m) => String(m.openid || "").trim()).filter(Boolean)));
    const usersRes = await transaction
      .collection("users")
      .where({ _id: _.in(openids) })
      .field({ _id: true, nickName: true })
      .get()
      .catch(() => ({ data: [] }));
    const userMap = new Map((usersRes.data || []).map((u) => [String(u._id || ""), u]));

    const players = members
      .map((m) => {
        const openid = String(m.openid || "").trim();
        const score = normalizeScore(m.score);
        const user = userMap.get(openid) || {};
        const fallback = openid ? `玩家${openid.slice(0, 6)}` : "玩家";
        const nickName = normalizeNickName(user.nickName, fallback);
        return { nickName, score, result: getResult(score) };
      })
      .sort((a, b) => b.score - a.score);
    const playersText = players.map((p) => `${p.nickName}(${formatSignedScore(p.score)})`).join("，");

    for (const member of members) {
      const score = normalizeScore(member.score);
      const winInc = score > 0 ? 1 : 0;
      const lossInc = score < 0 ? 1 : 0;
      const resultText = getResult(score);

      const userRef = transaction.collection("users").doc(member.openid);
      const userDoc = await userRef.get().catch(() => null);
      const existingRecent = Array.isArray(userDoc?.data?.recentGames) ? userDoc.data.recentGames : [];
      const entry = {
        roomId,
        endedAt: ts,
        score,
        result: resultText,
        reason: closeReason,
        players,
        playersText
      };
      const recentGames = [entry, ...existingRecent].slice(0, MAX_RECENT_GAMES);

      if (userDoc && userDoc.data) {
        await userRef.update({
          data: {
            "stats.gamesPlayed": _.inc(1),
            "stats.wins": _.inc(winInc),
            "stats.losses": _.inc(lossInc),
            recentGames,
            updatedAt: ts
          }
        });
      } else {
        const fallback = member.openid ? `玩家${String(member.openid).slice(0, 6)}` : "玩家";
        await userRef.set({
          data: {
            nickName: fallback,
            avatarUrl: "",
            stats: { gamesPlayed: 1, wins: winInc, losses: lossInc },
            recentGames: [entry],
            createdAt: ts,
            updatedAt: ts
          }
        });
      }
    }

    await roomRef.update({
      data: {
        status: "ended",
        endedAt: ts,
        closeReason,
        cleanupPending: true,
        updatedAt: ts
      }
    });

    const reasonText =
      closeReason === "all_left" ? "所有人已退房" : "全员离线 10 分钟";
    await transaction.collection("room_logs").add({
      data: {
        roomId,
        type: "settle",
        createdAt: ts,
        text: `房间已自动关闭（${reasonText}）并写入战绩`
      }
    });

    result = { roomId, closed: true, reason: closeReason };
  });
  return result;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  await ensureCollection("users");
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await ensureCollection("room_logs");

  const roomId = String(event?.roomId || "").trim();
  const ts = Date.now();

  if (OPENID) {
    await ensureUser(OPENID);
    if (!roomId) throw new Error("roomId 不能为空");
    const memberId = `${roomId}_${OPENID}`;
    await db.collection("room_members").doc(memberId).get().catch(() => {
      throw new Error("你不在该房间内");
    });
    const res = await tryCloseRoom(roomId, ts);
    if (res.closed) {
      await cleanupRoomData(roomId);
    }
    return res;
  }

  const roomsRes = await db
    .collection("rooms")
    .where({ status: "active" })
    .orderBy("updatedAt", "asc")
    .limit(MAX_ROOMS_PER_RUN)
    .get();
  const rooms = roomsRes.data || [];

  let closed = 0;
  for (const room of rooms) {
    const res = await tryCloseRoom(String(room._id || ""), ts);
    if (res.closed) {
      closed += 1;
      await cleanupRoomData(res.roomId);
    }
  }

  // 清理上次关闭但未清理干净的房间
  const pendingRes = await db
    .collection("rooms")
    .where({ status: "ended" })
    .orderBy("endedAt", "asc")
    .limit(MAX_CLEANUP_ROOMS_PER_RUN)
    .get()
    .catch(() => ({ data: [] }));

  let cleaned = 0;
  for (const room of pendingRes.data || []) {
    const id = String(room._id || "").trim();
    if (!id) continue;
    const cleanRes = await cleanupRoomData(id);
    if (cleanRes.ok) cleaned += 1;
  }

  return { ok: true, checked: rooms.length, closed, cleanupChecked: (pendingRes.data || []).length, cleaned };
};
