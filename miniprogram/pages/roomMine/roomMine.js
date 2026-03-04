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
    loading: true,
    leaving: false
  },

  _heartbeatTimer: null,

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
    this.load();
    this.startHeartbeat();
  },

  onHide() {
    this.stopHeartbeat();
  },

  onUnload() {
    this.stopHeartbeat();
  },

  async load() {
    this.setData({ loading: true });
    try {
      const [profileRes, summaryRes] = await Promise.all([
        callFunction("getMyProfile"),
        callFunction("getMyRoomSummary", { roomId: this.data.roomId })
      ]);

      let me = profileRes.user || null;
      if (!me) throw new Error("请先授权登录");
      if (me && isCloudFileId(me.avatarUrl)) {
        const map = await resolveTempUrls([me.avatarUrl]);
        me = { ...me, avatarUrl: map.get(me.avatarUrl) || "" };
      }

      const items = (summaryRes.items || []).map((item) => {
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

      this.setData({
        me,
        score: Number(summaryRes.score || 0),
        totalGiven: Number(summaryRes.totalGiven || 0),
        totalReceived: Number(summaryRes.totalReceived || 0),
        items,
        loading: false
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "加载失败", icon: "none" });
      this.setData({ loading: false });
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
        try {
          await callFunction("leaveRoom", { roomId: this.data.roomId });
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

