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
  const fromOpenid = OPENID;
  await ensureCollection("users");
  await ensureCollection("rooms");
  await ensureCollection("room_members");
  await ensureCollection("room_logs");
  const fromUser = await requireUser(fromOpenid);

  const roomId = String(event.roomId || "").trim();
  const toOpenid = String(event.toOpenid || "").trim();
  const amount = Number(event.amount);

  if (!roomId) throw new Error("roomId 不能为空");
  if (!toOpenid) throw new Error("toOpenid 不能为空");
  if (toOpenid === fromOpenid) throw new Error("不能给自己转移积分");
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount 必须为正整数");

  const toUser = await requireUser(toOpenid);

  const ts = Date.now();
  const fromMemberId = `${roomId}_${fromOpenid}`;
  const toMemberId = `${roomId}_${toOpenid}`;

  await db.runTransaction(async (transaction) => {
    const roomDoc = await transaction.collection("rooms").doc(roomId).get().catch(() => null);
    if (!roomDoc || !roomDoc.data) throw new Error("房间不存在");
    if (roomDoc.data.status !== "active") throw new Error("房间已结束");

    const fromMember = await transaction.collection("room_members").doc(fromMemberId).get().catch(() => null);
    if (!fromMember || !fromMember.data) {
      throw new Error("你不在该房间内");
    }
    if (fromMember.data.active === false) throw new Error("你已退房");

    const toMember = await transaction.collection("room_members").doc(toMemberId).get().catch(() => null);
    if (!toMember || !toMember.data) {
      throw new Error("对方不在该房间内");
    }
    if (toMember.data.active === false) throw new Error("对方已退房");

    await transaction.collection("room_members").doc(fromMemberId).update({
      data: {
        score: _.inc(-amount),
        updatedAt: ts
      }
    });
    await transaction.collection("room_members").doc(toMemberId).update({
      data: {
        score: _.inc(amount),
        updatedAt: ts
      }
    });

    await transaction.collection("room_logs").add({
      data: {
        roomId,
        type: "transfer",
        fromOpenid,
        toOpenid,
        amount,
        createdAt: ts,
        text: `${fromUser.nickName} 向 ${toUser.nickName} 转移了 ${amount} 积分`
      }
    });

    await transaction.collection("rooms").doc(roomId).update({
      data: {
        updatedAt: ts
      }
    });
  });

  return { ok: true };
};
