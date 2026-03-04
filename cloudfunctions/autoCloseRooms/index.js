const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const OFFLINE_MS = 10 * 60 * 1000;
const MAX_RECENT_GAMES = 20;
const MAX_ROOMS_PER_RUN = 50;

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

function normalizeScore(score) {
  const n = Number(score || 0);
  return Number.isFinite(n) ? n : 0;
}

function getResult(score) {
  if (score > 0) return "win";
  if (score < 0) return "loss";
  return "draw";
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
        reason: closeReason
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
        await userRef.set({
          data: {
            nickName: member.openid.slice(0, 6),
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
    await requireUser(OPENID);
    if (!roomId) throw new Error("roomId 不能为空");
    const memberId = `${roomId}_${OPENID}`;
    await db.collection("room_members").doc(memberId).get().catch(() => {
      throw new Error("你不在该房间内");
    });
    return await tryCloseRoom(roomId, ts);
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
    if (res.closed) closed += 1;
  }

  return { ok: true, checked: rooms.length, closed };
};
