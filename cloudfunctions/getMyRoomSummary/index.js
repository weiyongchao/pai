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

async function getUsersByOpenids(openids) {
  if (openids.length === 0) return new Map();
  const map = new Map();
  const batchSize = 20;
  for (let i = 0; i < openids.length; i += batchSize) {
    const batch = openids.slice(i, i + batchSize);
    const res = await db
      .collection("users")
      .where({ _id: _.in(batch) })
      .get();
    for (const user of res.data || []) {
      map.set(user._id, user);
    }
  }
  return map;
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

  const memberId = `${roomId}_${OPENID}`;
  const memberDoc = await db.collection("room_members").doc(memberId).get().catch(() => null);
  if (!memberDoc || !memberDoc.data) throw new Error("你不在该房间内");

  const score = Number(memberDoc.data.score || 0);

  const PAGE_SIZE = 100;
  let skip = 0;
  const netMap = new Map(); // peerOpenid -> net(receive - give)
  let totalGiven = 0;
  let totalReceived = 0;

  while (true) {
    const res = await db
      .collection("room_logs")
      .where({ roomId, type: "transfer" })
      .orderBy("createdAt", "asc")
      .skip(skip)
      .limit(PAGE_SIZE)
      .get();
    const list = res.data || [];
    for (const log of list) {
      const fromOpenid = String(log.fromOpenid || "");
      const toOpenid = String(log.toOpenid || "");
      const amount = Number(log.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      if (fromOpenid === OPENID && toOpenid) {
        totalGiven += amount;
        netMap.set(toOpenid, (netMap.get(toOpenid) || 0) - amount);
      } else if (toOpenid === OPENID && fromOpenid) {
        totalReceived += amount;
        netMap.set(fromOpenid, (netMap.get(fromOpenid) || 0) + amount);
      }
    }
    if (list.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  const peers = Array.from(netMap.entries())
    .map(([openid, net]) => ({ openid, net }))
    .filter((item) => item.net !== 0);

  const userMap = await getUsersByOpenids(peers.map((p) => p.openid));
  const items = peers
    .map((p) => {
      const user = userMap.get(p.openid) || {};
      return {
        openid: p.openid,
        nickName: user.nickName || p.openid.slice(0, 6),
        net: p.net
      };
    })
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  return {
    roomId,
    score,
    totalGiven,
    totalReceived,
    items
  };
};

