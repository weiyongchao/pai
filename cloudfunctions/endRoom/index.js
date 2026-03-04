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
