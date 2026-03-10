const { callFunction } = require("../../utils/api");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

Page({
  data: {
    roomId: "",
    me: null,
    score: 0,
    totalGiven: 0,
    totalReceived: 0,
    items: [],
    roundHeaders: [],
    roundRows: [],
    roundHint: "",
    loading: true,
    leaving: false
  },

  _heartbeatTimer: null,
  _loadTimer: null,

  onLoad(options) {
    const roomId = String(options.roomId || "").trim();
    if (!roomId) {
      wx.showToast({ title: "缺少房间参数", icon: "none" });
      this.setData({ loading: false });
      return;
    }
    this.setData({ roomId });
  },

  onShow() {
    if (this._loadTimer) clearTimeout(this._loadTimer);
    // 让页面先完成过渡动画再发起接口请求，避免打开页卡顿
    this._loadTimer = setTimeout(() => {
      this.load();
    }, 120);
    this.startHeartbeat();
  },

  onHide() {
    if (this._loadTimer) {
      clearTimeout(this._loadTimer);
      this._loadTimer = null;
    }
    this.stopHeartbeat();
  },

  onUnload() {
    if (this._loadTimer) {
      clearTimeout(this._loadTimer);
      this._loadTimer = null;
    }
    this.stopHeartbeat();
  },

  async load() {
    this.setData({ loading: true });
    wx.showNavigationBarLoading();
    try {
      const [profileSettled, summarySettled] = await Promise.allSettled([
        callFunction("getMyProfile"),
        callFunction("getMyRoomSummary", { roomId: this.data.roomId })
      ]);

      const profileRes = profileSettled.status === "fulfilled" ? profileSettled.value : null;
      const summaryRes = summarySettled.status === "fulfilled" ? summarySettled.value : null;

      let me = profileRes?.user || null;
      if (!me) {
        const err = profileSettled.status === "rejected" ? profileSettled.reason : null;
        const msg = String(err?.message || err?.errMsg || "").trim() || "用户信息加载失败";
        throw new Error(msg);
      }
      if (me && isCloudFileId(me.avatarUrl)) {
        const map = await resolveTempUrls([me.avatarUrl]);
        me = { ...me, avatarUrl: map.get(me.avatarUrl) || "" };
      }

      let score = 0;
      let totalGiven = 0;
      let totalReceived = 0;
      let items = [];
      let roundHeaders = [];
      let roundRows = [];
      let roundHint = "";

      if (summaryRes) {
        score = Number(summaryRes.score || 0);
        totalGiven = Number(summaryRes.totalGiven || 0);
        totalReceived = Number(summaryRes.totalReceived || 0);
        items = (summaryRes.items || []).map((item) => {
          const net = Number(item.net || 0);
          const nickName = item.nickName || item.openid?.slice(0, 6) || "成员";
          if (net < 0) {
            return {
              openid: item.openid,
              type: "lose",
              amount: Math.abs(net),
              text: `输给 ${nickName}`
            };
          }
          return {
            openid: item.openid,
            type: "win",
            amount: net,
            text: `赢了 ${nickName}`
          };
        });

        const rounds = Array.isArray(summaryRes.rounds) ? summaryRes.rounds : [];
        const members = Array.isArray(summaryRes.members) ? summaryRes.members : [];
        roundHeaders = rounds.map((r) => Number(r.index || 0)).filter((n) => Number.isFinite(n) && n > 0);
        roundRows = members.map((m) => {
          const openid = String(m.openid || "").trim();
          const nickName = String(m.nickName || "").trim() || (openid ? openid.slice(0, 6) : "成员");
          const joinedAt = Number(m.joinedAt || 0) || 0;
          const cells = rounds.map((r) => {
            const roundStartAt = Number(r?.startAt || r?.endAt || 0) || 0;
            const notJoinedYet = joinedAt > 0 && roundStartAt > 0 && roundStartAt < joinedAt;
            if (notJoinedYet) return { text: "-", class: "cell-na" };
            const raw = r?.deltas ? r.deltas[openid] : 0;
            const v = Number(raw || 0);
            if (!Number.isFinite(v) || v === 0) return { text: "0", class: "cell-empty" };
            if (v > 0) return { text: `+${v}`, class: "cell-pos" };
            return { text: `${v}`, class: "cell-neg" };
          });
          return { openid, nickName, cells };
        });

        const gapMs = Number(summaryRes.roundGapMs || 0);
        if (gapMs > 0) {
          const sec = Math.round(gapMs / 1000);
          roundHint = `按“相邻交易间隔 > ${sec}s”自动分回合（仅展示最近 ${roundHeaders.length} 回）`;
        } else if (roundHeaders.length) {
          roundHint = `自动分回合（仅展示最近 ${roundHeaders.length} 回）`;
        }
      } else if (summarySettled.status === "rejected") {
        // 汇总失败不影响头像/昵称展示
        const msg = String(summarySettled.reason?.message || summarySettled.reason?.errMsg || "").trim();
        if (msg) wx.showToast({ title: msg, icon: "none" });
      }

      this.setData({
        me,
        score,
        totalGiven,
        totalReceived,
        items,
        roundHeaders,
        roundRows,
        roundHint,
        loading: false
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "加载失败", icon: "none" });
      this.setData({ loading: false });
    } finally {
      wx.hideNavigationBarLoading();
    }
  },

  startHeartbeat() {
    this.stopHeartbeat();
    const roomId = this.data.roomId;
    if (!roomId) return;
    const tick = async () => {
      try {
        await callFunction("heartbeatRoom", { roomId });
      } catch (e) {
        // ignore
      }
    };
    tick();
    this._heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  },

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  onLeave() {
    if (this.data.leaving) return;
    wx.showModal({
      title: "退房",
      content: "确认退房？退房后将返回首页。",
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ leaving: true });
        this.stopHeartbeat();
        try {
          const tryLeave = async () => {
            await callFunction("leaveRoom", { roomId: this.data.roomId });
          };

          try {
            await tryLeave();
          } catch (e) {
            const msg = String(e?.message || e?.errMsg || "").trim();
            const isTimeout = msg.includes("-504003") || msg.includes("TIME_LIMIT_EXCEEDED") || msg.includes("timed out after 3 seconds");
            if (!isTimeout) throw e;
            wx.showToast({ title: "网络较慢，正在重试…", icon: "none" });
            await new Promise((r) => setTimeout(r, 800));
            await tryLeave();
          }
          try {
            wx.removeStorageSync("activeRoomId");
          } catch {
            // ignore
          }
          wx.showToast({ title: "已退房", icon: "success" });
          setTimeout(() => {
            wx.reLaunch({ url: "/pages/index/index" });
          }, 350);
        } catch (e) {
          console.error(e);
          wx.showToast({ title: e?.message || "退房失败", icon: "none" });
        } finally {
          this.setData({ leaving: false });
        }
      }
    });
  }
});
