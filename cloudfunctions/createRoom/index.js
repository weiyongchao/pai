const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch {
    // ignore
  }
}

function genRoomId() {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${timePart}${randomPart}`.slice(0, 32);
}

async function requireUser(openid) {
  try {
    const doc = await db.collection("users").doc(openid).get();
    return doc.data;
  } catch {
    throw new Error("请先授权登录");
  }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  await ensureCollection("users");
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await ensureCollection("room_logs");
  const me = await requireUser(OPENID);

  const ts = Date.now();
  const roomId = genRoomId();

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
