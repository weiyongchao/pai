const { callFunction } = require("../../utils/api");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");

Page({
  data: {
    me: null,
    creatingRoom: false,
    redirectRoomId: ""
  },

  _creatingRoom: false,
  _navigating: false,

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
    if (this.data.creatingRoom) this.setData({ creatingRoom: false });
    this._creatingRoom = false;
    this._navigating = false;
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
      this.setData({
        me
      }, () => {
        if (me && this.data.redirectRoomId) {
          if (this._creatingRoom || this._navigating) return;
          const roomId = this.data.redirectRoomId;
          this.setData({ redirectRoomId: "" });
          this._navigating = true;
          wx.navigateTo({
            url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}`,
            fail: () => {
              this._navigating = false;
            }
          });
        }
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "加载失败", icon: "none" });
    }
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
        if (this._creatingRoom || this._navigating) return;
        const roomId = this.data.redirectRoomId;
        this.setData({ redirectRoomId: "" });
        this._navigating = true;
        wx.navigateTo({
          url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}`,
          fail: () => {
            this._navigating = false;
          }
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
      this._navigating = true;
      wx.navigateTo({
        url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}&showCode=1`,
        fail: () => {
          this._navigating = false;
          this._creatingRoom = false;
          this.setData({ creatingRoom: false });
        }
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "开房失败", icon: "none" });
      this.setData({ creatingRoom: false });
      this._creatingRoom = false;
    }
  },

  async onScanJoin() {
    if (!this.data.me) {
      wx.showToast({ title: "请先授权登录", icon: "none" });
      return;
    }

    wx.scanCode({
      success: (res) => {
        if (this._creatingRoom || this._navigating) return;
        const roomId = this.parseRoomIdFromScan(res);
        if (!roomId) {
          wx.showToast({ title: "未识别到房间码", icon: "none" });
          return;
        }
        this._navigating = true;
        wx.navigateTo({
          url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}`,
          fail: () => {
            this._navigating = false;
          }
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
