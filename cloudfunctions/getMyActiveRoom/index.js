const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (event && event.warmup) return { ok: true, warmup: true, roomId: "" };
  const membersRes = await db
    .collection("room_members")
    .where({ openid: OPENID, active: _.neq(false) })
    .orderBy("updatedAt", "desc")
    .limit(20)
    .get();

  const members = membersRes.data || [];
  const roomIds = Array.from(new Set(members.map((m) => String(m.roomId || "").trim().toLowerCase()).filter(Boolean))).filter(
    (id) => /^[0-9a-z]{4}$/.test(id)
  );
  if (roomIds.length === 0) return { roomId: "" };

  const roomsRes = await db
    .collection("rooms")
    .where({ _id: _.in(roomIds) })
    .get()
    .catch(() => ({ data: [] }));
  const activeRooms = new Set(
    (roomsRes.data || [])
      .filter((r) => r.status === "active")
      .map((r) => String(r._id || "").trim().toLowerCase())
  );
  for (const member of members) {
    const roomId = String(member.roomId || "").trim().toLowerCase();
    if (roomId && activeRooms.has(roomId)) return { roomId };
  }

  return { roomId: "" };
};
