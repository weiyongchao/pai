const { callFunction } = require("../../utils/api");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");

Page({
  data: {
    me: null,
    checkingAuth: true,
    navigatingRoom: false,
    creatingRoom: false,
    joiningById: false,
    joinModalVisible: false,
    joinInputFocus: false,
    redirectRoomId: "",
    activeRoomId: "",
    manualRoomId: ""
  },

  _creatingRoom: false,
  _navigating: false,
  _joiningById: false,
  _checkedOnce: false,

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
    if (this.data.joiningById) this.setData({ joiningById: false });
    if (this.data.joinModalVisible) this.setData({ joinModalVisible: false, joinInputFocus: false });
    if (this.data.navigatingRoom) this.setData({ navigatingRoom: false });
    this._creatingRoom = false;
    this._navigating = false;
    this._joiningById = false;
    this.loadMe({ initial: !this._checkedOnce });
  },

  async loadMe(options = {}) {
    const initial = !!options.initial;
    if (initial) this.setData({ checkingAuth: true });
    try {
      const res = await callFunction("getMyProfile");
      let me = res.user || null;
      if (me && isCloudFileId(me.avatarUrl)) {
        const map = await resolveTempUrls([me.avatarUrl]);
        me = { ...me, avatarUrl: map.get(me.avatarUrl) || "" };
      }

      // 优先使用本地记录；同时尽量用服务端校准（房间自动关闭后可清理本地状态）
      let localActiveRoomId = "";
      try {
        localActiveRoomId = String(wx.getStorageSync("activeRoomId") || "").trim();
      } catch {
        localActiveRoomId = "";
      }

      let activeRoomId = me ? localActiveRoomId : "";
      let serverChecked = false;
      if (me) {
        try {
          const activeRes = await callFunction("getMyActiveRoom");
          serverChecked = true;
          activeRoomId = String(activeRes?.roomId || "").trim();
        } catch (e) {
          // 可选能力：不影响主流程（体验版未部署时避免报错刷屏）
          activeRoomId = localActiveRoomId;
        }
      }

      if (serverChecked) {
        try {
          if (activeRoomId) wx.setStorageSync("activeRoomId", activeRoomId);
          else wx.removeStorageSync("activeRoomId");
        } catch {
          // ignore
        }
      }

      this.setData(
        {
          me,
          activeRoomId
        },
        () => {
          this.maybeNavigateRedirect();
        }
      );
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "加载失败", icon: "none" });
    } finally {
      if (initial) {
        this._checkedOnce = true;
        this.setData({ checkingAuth: false });
      }
    }
  },

  maybeNavigateRedirect() {
    if (!this.data.me) return;
    const redirectRoomId = String(this.data.redirectRoomId || "").trim();
    if (!redirectRoomId) return;
    if (this._creatingRoom || this._navigating) return;

    const activeRoomId = String(this.data.activeRoomId || "").trim();
    const targetRoomId = activeRoomId && activeRoomId !== redirectRoomId ? activeRoomId : redirectRoomId;
    if (activeRoomId && activeRoomId !== redirectRoomId) {
      wx.showToast({ title: "你还在房间中，已为你打开当前房间", icon: "none" });
    }

    this.setData({ redirectRoomId: "" });
    this._navigating = true;
    this.setData({ navigatingRoom: true });
    wx.navigateTo({
      url: `/pages/room/room?roomId=${encodeURIComponent(targetRoomId)}`,
      fail: () => {
        this._navigating = false;
        this.setData({ navigatingRoom: false });
      }
    });
  },

  onBackToRoom() {
    if (this._creatingRoom || this._navigating) return;
    const roomId = String(this.data.activeRoomId || "").trim();
    if (!roomId) return;
    this._navigating = true;
    this.setData({ navigatingRoom: true });
    wx.navigateTo({
      url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}`,
      fail: () => {
        this._navigating = false;
        this.setData({ navigatingRoom: false });
      }
    });
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
    if (this.data.activeRoomId) {
      this.onBackToRoom();
      return;
    }

    this._creatingRoom = true;
    this.setData({ creatingRoom: true });
    try {
      const res = await callFunction("createRoom");
      const roomId = String(res.roomId || "").trim();
      const existed = !!res.existed;
      if (!roomId) throw new Error("开房失败");
      if (existed) {
        wx.showToast({ title: "你还在房间中，已为你打开", icon: "none" });
      }
      wx.navigateTo({
        url: `/pages/room/room?roomId=${encodeURIComponent(roomId)}${existed ? "" : "&showCode=1"}`,
        fail: () => {
          this._creatingRoom = false;
          this.setData({ creatingRoom: false });
        }
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "开房失败", icon: "none" });
      this._creatingRoom = false;
      this.setData({ creatingRoom: false });
    }
  },

  async onScanJoin() {
    if (!this.data.me) {
      wx.showToast({ title: "请先授权登录", icon: "none" });
      return;
    }
    if (this.data.activeRoomId) {
      wx.showToast({ title: "你还在房间中，请先退房", icon: "none" });
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

  openJoinModal() {
    if (this._creatingRoom || this._navigating || this._joiningById) return;
    if (!this.data.me) {
      wx.showToast({ title: "请先授权登录", icon: "none" });
      return;
    }
    if (this.data.activeRoomId) {
      this.onBackToRoom();
      return;
    }

    this.setData({
      joinModalVisible: true,
      joinInputFocus: true,
      manualRoomId: ""
    });
  },

  closeJoinModal() {
    if (this.data.joiningById) return;
    this.setData({ joinModalVisible: false, joinInputFocus: false, manualRoomId: "" });
  },

  onManualRoomIdInput(e) {
    this.setData({ manualRoomId: e.detail.value });
  },

  onJoinByRoomId() {
    if (this._creatingRoom || this._navigating || this._joiningById) return;
    if (!this.data.me) {
      wx.showToast({ title: "请先授权登录", icon: "none" });
      return;
    }
    if (this.data.activeRoomId) {
      this.onBackToRoom();
      return;
    }

    let roomId = String(this.data.manualRoomId || "").trim();
    if (!roomId) {
      wx.showToast({ title: "请输入房间号", icon: "none" });
      return;
    }

    if (roomId.includes("?")) {
      const parsed = this.parseRoomIdFromPath(roomId);
      if (parsed) roomId = parsed;
    }

    roomId = String(roomId || "").trim();
    if (!roomId) {
      wx.showToast({ title: "未识别到房间号", icon: "none" });
      return;
    }
    if (roomId.length > 32) {
      wx.showToast({ title: "房间号格式不正确", icon: "none" });
      return;
    }
    if (!/^[0-9a-zA-Z]+$/.test(roomId)) {
      wx.showToast({ title: "房间号格式不正确", icon: "none" });
      return;
    }

    this._joiningById = true;
    this.setData({ joiningById: true });
    this._navigating = true;
    wx.navigateTo({
      url: `/pages/room/room?roomId=${encodeURIComponent(roomId.toLowerCase())}`,
      success: () => {
        this.setData({ manualRoomId: "", joinModalVisible: false, joinInputFocus: false });
      },
      fail: () => {
        this._navigating = false;
        this._joiningById = false;
        this.setData({ joiningById: false });
      }
    });
  },

  noop() {},

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
  },

  toHistory() {
    wx.navigateTo({ url: "/pages/history/history" });
  }
});
