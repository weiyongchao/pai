const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (event && event.warmup) return { ok: true, warmup: true };
  const roomId = String(event.roomId || "").trim().toLowerCase();
  if (!roomId) throw new Error("roomId 不能为空");
  if (!/^[0-9a-z]{4}$/.test(roomId)) throw new Error("roomId 格式不正确");

  const ts = Date.now();
  const memberId = `${roomId}_${OPENID}`;
  const res = await db
    .collection("room_members")
    .where({ _id: memberId, active: _.neq(false) })
    .update({
    data: {
      lastSeenAt: ts,
      updatedAt: ts
    }
  });

  const updated = Number(res?.stats?.updated || 0);
  return { ok: true, updated };
};
