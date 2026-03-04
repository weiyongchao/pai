const { callFunction } = require("../../utils/api");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");

Page({
  data: {
    me: null,
    creatingRoom: false,
    redirectRoomId: "",
    history: []
  },

  _creatingRoom: false,

  onLoad(options) {
    if (options.redirectRoomId) {
      this.setData({ redirectRoomId: decodeURIComponent(options.redirectRoomId) });
      return;
    }

    if (options.scene) {
      this.setData({ redirectRoomId: decodeURIComponent(options.scene) });
    }
  },

  onShow() {
    this.loadMe();
  },

  async loadMe() {
    try {
      const res = await callFunction("getMyProfile");
      let me = res.user || null;
      if (me && isCloudFileId(me.avatarUrl)) {
        const map = await resolveTempUrls([me.avatarUrl]);
        me = { ...me, avatarUrl: map.get(me.avatarUrl) || "" };
      }
      const history = this.buildHistory(me?.recentGames || []);
      this.setData(
        {
          me,
          history
        },
        () => {
          if (me && this.data.redirectRoomId) {
            const roomId = this.data.redirectRoomId;
            this.setData({ redirectRoomId: "" });
            wx.navigateTo({
              url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}`
            });
          }
        }
      );
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "加载失败", icon: "none" });
    }
  },

  buildHistory(list) {
    const rows = Array.isArray(list) ? list : [];
    return rows.slice(0, 10).map((g) => {
      const endedAt = Number(g.endedAt || 0);
      const score = Number(g.score || 0);
      const result = String(g.result || "");
      return {
        roomId: String(g.roomId || ""),
        endedAt,
        time: this.formatDateTime(endedAt),
        score,
        scoreText: score > 0 ? `+${score}` : `${score}`,
        resultText: result === "win" ? "胜" : result === "loss" ? "负" : "平",
        resultClass: result === "win" ? "win" : result === "loss" ? "loss" : "draw"
      };
    });
  },

  formatDateTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  },

  async onGetProfile() {
    try {
      const profile = await new Promise((resolve, reject) => {
        wx.getUserProfile({
          desc: "用于显示昵称和头像",
          success: resolve,
          fail: reject
        });
      });
      const { nickName, avatarUrl } = profile.userInfo || {};
      await callFunction("updateProfile", { nickName, avatarUrl });
      await this.loadMe();
      wx.showToast({ title: "登录成功", icon: "success" });

      if (this.data.redirectRoomId) {
        const roomId = this.data.redirectRoomId;
        this.setData({ redirectRoomId: "" });
        wx.navigateTo({
          url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}`
        });
      }
    } catch (e) {
      if (e && e.errMsg && e.errMsg.includes("deny")) {
        wx.showToast({ title: "已取消授权", icon: "none" });
        return;
      }
      console.error(e);
      wx.showToast({ title: e?.message || "授权失败", icon: "none" });
    }
  },

  async onCreateRoom() {
    if (this._creatingRoom) return;
    if (!this.data.me) {
      wx.showToast({ title: "请先授权登录", icon: "none" });
      return;
    }

    this._creatingRoom = true;
    this.setData({ creatingRoom: true });
    try {
      const res = await callFunction("createRoom");
      const roomId = res.roomId;
      wx.navigateTo({
        url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}&showCode=1`
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "开房失败", icon: "none" });
    } finally {
      this._creatingRoom = false;
      this.setData({ creatingRoom: false });
    }
  },

  async onScanJoin() {
    if (!this.data.me) {
      wx.showToast({ title: "请先授权登录", icon: "none" });
      return;
    }

    wx.scanCode({
      success: (res) => {
        const roomId = this.parseRoomIdFromScan(res);
        if (!roomId) {
          wx.showToast({ title: "未识别到房间码", icon: "none" });
          return;
        }
        wx.navigateTo({
          url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}`
        });
      },
      fail: () => {
        wx.showToast({ title: "扫码取消", icon: "none" });
      }
    });
  },

  parseRoomIdFromScan(res) {
    const path = res.path || "";
    const result = res.result || "";
    const candidates = [path, result].filter(Boolean);
    for (const candidate of candidates) {
      const roomId = this.parseRoomIdFromPath(candidate);
      if (roomId) return roomId;
    }
    return "";
  },

  parseRoomIdFromPath(path) {
    const idx = path.indexOf("?");
    if (idx < 0) return "";
    const query = path.slice(idx + 1);
    const params = {};
    query.split("&").forEach((kv) => {
      const [k, v] = kv.split("=");
      if (!k) return;
      params[k] = decodeURIComponent(v || "");
    });
    return params.roomId || params.scene || "";
  },

  toProfile() {
    wx.navigateTo({ url: "/pages/profile/profile" });
  }
});
