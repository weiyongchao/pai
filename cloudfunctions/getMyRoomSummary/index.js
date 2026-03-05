const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEFAULT_ROUND_GAP_MS = 2 * 60 * 1000; // 2 分钟：把一段连续结算视为一回合
const MIN_ROUND_GAP_MS = 10 * 1000;
const MAX_ROUND_GAP_MS = 10 * 60 * 1000;
const MAX_ROUNDS = 20;

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

async function getUsersByOpenids(openids) {
  if (openids.length === 0) return new Map();
  const map = new Map();
  const batchSize = 20;
  for (let i = 0; i < openids.length; i += batchSize) {
    const batch = openids.slice(i, i + batchSize);
    const res = await db
      .collection("users")
      .where({ _id: _.in(batch) })
      .field({ _id: true, nickName: true })
      .get();
    for (const user of res.data || []) {
      map.set(user._id, user);
    }
  }
  return map;
}

function resolveRoundGapMs(event) {
  const raw = Number(event?.roundGapMs);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ROUND_GAP_MS;
  return Math.min(MAX_ROUND_GAP_MS, Math.max(MIN_ROUND_GAP_MS, Math.floor(ms)));
}

function incObj(obj, key, delta) {
  if (!key) return;
  const k = String(key || "").trim();
  if (!k) return;
  const prev = Number(obj[k] || 0);
  obj[k] = prev + delta;
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

  const membersRes = await db
    .collection("room_members")
    .where({ roomId })
    .orderBy("joinedAt", "asc")
    .get();
  const memberDocs = membersRes.data || [];
  const memberOpenids = Array.from(new Set(memberDocs.map((m) => String(m.openid || "").trim()).filter(Boolean)));
  const memberUserMap = await getUsersByOpenids(memberOpenids);
  const members = memberOpenids.map((openid) => {
    const user = memberUserMap.get(openid) || {};
    return {
      openid,
      nickName: user.nickName || openid.slice(0, 6)
    };
  });

  const roundGapMs = resolveRoundGapMs(event);
  const rounds = [];
  let currentRound = null; // { index, startAt, endAt, deltas: { [openid]: net } }
  let roundIndex = 0;
  let lastTransferAt = 0;

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
      const createdAt = Number(log.createdAt || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      // 回合分组：按相邻交易间隔是否超过阈值来切分
      if (createdAt > 0) {
        if (!currentRound) {
          roundIndex += 1;
          currentRound = { index: roundIndex, startAt: createdAt, endAt: createdAt, deltas: {} };
          lastTransferAt = createdAt;
        } else if (createdAt - lastTransferAt > roundGapMs) {
          rounds.push(currentRound);
          if (rounds.length > MAX_ROUNDS) rounds.shift();
          roundIndex += 1;
          currentRound = { index: roundIndex, startAt: createdAt, endAt: createdAt, deltas: {} };
          lastTransferAt = createdAt;
        } else {
          currentRound.endAt = createdAt;
          lastTransferAt = createdAt;
        }

        incObj(currentRound.deltas, fromOpenid, -amount);
        incObj(currentRound.deltas, toOpenid, amount);
      }

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

  if (currentRound) {
    rounds.push(currentRound);
    if (rounds.length > MAX_ROUNDS) rounds.shift();
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
    items,
    members,
    rounds,
    roundGapMs
  };
};
