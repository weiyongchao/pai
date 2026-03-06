const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  await ensureCollection("users");
  await ensureCollection("room_ids");
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await ensureCollection("room_logs");
  await ensureUser(OPENID);

  const roomId = String(event.roomId || "").trim();
  if (!roomId) throw new Error("roomId 不能为空");

  const ts = Date.now();

  await db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.collection("rooms").doc(roomId).get().catch(() => null);
    if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");
    const room = roomDoc.data;
    if (room.ownerOpenid !== OPENID) throw new Error("只有房主可以结束本局");
    if (room.status !== "active") return;

    const membersRes = await transaction.collection("room_members").where({ roomId }).get();
    const members = membersRes.data || [];

    for (const member of members) {
      const winInc = member.score > 0 ? 1 : 0;
      const lossInc = member.score < 0 ? 1 : 0;
      await transaction.collection("users").doc(member.openid).update({
        data: {
          "stats.gamesPlayed": _.inc(1),
          "stats.wins": _.inc(winInc),
          "stats.losses": _.inc(lossInc),
          updatedAt: ts
        }
      });
    }

    await transaction.collection("rooms").doc(roomId).update({
      data: {
        status: "ended",
        endedAt: ts,
        updatedAt: ts
      }
    });

    // 保留房间号记录，防止 4 位房间号被复用
    const roomIdRef = transaction.collection("room_ids").doc(roomId);
    try {
      await roomIdRef.get();
      await roomIdRef.update({
        data: {
          status: "ended",
          endedAt: ts,
          updatedAt: ts
        }
      });
    } catch {
      await roomIdRef.set({
        data: {
          status: "ended",
          ownerOpenid: String(room.ownerOpenid || ""),
          createdAt: Number(room.createdAt || ts),
          endedAt: ts,
          updatedAt: ts
        }
      });
    }

    await transaction.collection("room_logs").add({
      data: {
        roomId,
        type: "settle",
        createdAt: ts,
        text: "房主已结束本局并写入战绩"
      }
    });
  });

  return { ok: true };
};
