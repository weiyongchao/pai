const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await ensureUser(OPENID);

  const roomId = String(event.roomId || "").trim();
  if (!roomId) throw new Error("roomId 不能为空");

  const roomDoc = await db.collection("rooms").doc(roomId).get().catch(() => null);
  if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");
  const room = roomDoc.data;

  const memberId = `${roomId}_${OPENID}`;
  await db.collection("room_members").doc(memberId).get().catch(() => {
    throw new Error("你不在该房间内");
  });

  if (room.roomCodeFileID) {
    return { fileID: room.roomCodeFileID };
  }

  let res;
  try {
    res = await cloud.openapi.wxacode.getUnlimited({
      scene: roomId,
      page: "pages/room/room",
      checkPath: false,
      isHyaline: false,
      width: 430
    });
  } catch (e) {
    const msg = String(e?.errMsg || e?.message || "");
    const isNoPermission =
      msg.includes("-604101") ||
      msg.toLowerCase().includes("has no permission") ||
      msg.toLowerCase().includes("no permission to call this api");
    if (isNoPermission) {
      throw new Error(
        "云函数无权限调用小程序码接口（-604101）。请在云开发控制台为当前环境开通「云调用/微信开放接口」并授权「小程序码」后再试。"
      );
    }
    const isInvalidPage = msg.includes("41030") || msg.toLowerCase().includes("invalid page");
    if (!isInvalidPage) throw e;

    // 兜底：不指定 page，避免线上版本未同步导致的 page 校验失败
    try {
      res = await cloud.openapi.wxacode.getUnlimited({
        scene: roomId,
        checkPath: false,
        isHyaline: false,
        width: 430
      });
    } catch (e2) {
      const msg2 = String(e2?.errMsg || e2?.message || "");
      const isNoPermission2 =
        msg2.includes("-604101") ||
        msg2.toLowerCase().includes("has no permission") ||
        msg2.toLowerCase().includes("no permission to call this api");
      if (isNoPermission2) {
        throw new Error(
          "云函数无权限调用小程序码接口（-604101）。请在云开发控制台为当前环境开通「云调用/微信开放接口」并授权「小程序码」后再试。"
        );
      }
      throw e2;
    }
  }

  const ts = Date.now();
  const cloudPath = `room-codes/${roomId}-${ts}.png`;
  const upload = await cloud.uploadFile({
    cloudPath,
    fileContent: res.buffer
  });

  await db.collection("rooms").doc(roomId).update({
    data: {
      roomCodeFileID: upload.fileID,
      updatedAt: ts
    }
  });

  return { fileID: upload.fileID };
};
