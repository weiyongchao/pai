const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (event && event.warmup) return { ok: true, warmup: true };

  const roomId = String(event?.roomId || "").trim();
  if (!roomId) throw new Error("roomId 不能为空");

  const ts = Date.now();
  const memberId = `${roomId}_${OPENID}`;
  const memberRef = db.collection("room_members").doc(memberId);
  const memberDoc = await memberRef.get().catch(() => null);
  if (!memberDoc || !memberDoc.data) throw new Error("你不在该房间内");
  if (memberDoc.data.active === false) return { ok: true, alreadyLeft: true };

  // 退房必须尽快返回，避免移动端 3s 调用超时；结算/清理由定时 autoCloseRooms 处理
  await memberRef.update({
    data: {
      active: false,
      leftAt: ts,
      updatedAt: ts
    }
  });

  // 写流水失败不影响退房成功
  db.collection("room_logs")
    .add({
      data: {
        roomId,
        type: "leave",
        openid: OPENID,
        createdAt: ts,
        text: `${String(OPENID || "").slice(0, 6)} 退出房间`
      }
    })
    .catch(() => null);

  return { ok: true };
};

