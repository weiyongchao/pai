const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MAX_MEMBERS = 20;

async function requireUser(openid) {
  try {
    const doc = await db
      .collection("users")
      .doc(openid)
      .field({ nickName: true })
      .get();
    return doc.data;
  } catch {
    throw new Error("请先授权登录");
  }
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
  const me = await requireUser(OPENID);

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
