const { callFunction } = require("../../utils/api");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");

Page({
  data: {
    me: null,
    isAuthed: false,
    displayNickName: "未登录",
    displayAvatarUrl: "",
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
  _authing: false,
  _askedRedirectAuth: false,

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
      const rawAvatarUrl = me ? String(me.avatarUrl || "").trim() : "";
      if (me && isCloudFileId(me.avatarUrl)) {
        const map = await resolveTempUrls([me.avatarUrl]);
        me = { ...me, avatarUrl: map.get(me.avatarUrl) || "" };
      }

      const isAuthed = !!(me && (me.profileCompleted || rawAvatarUrl));
      const displayNickName = isAuthed ? String(me.nickName || "").trim() || "未登录" : "未登录";
      const displayAvatarUrl = isAuthed ? String(me.avatarUrl || "").trim() : "";

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
          isAuthed,
          displayNickName,
          displayAvatarUrl,
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
    const redirectRoomId = String(this.data.redirectRoomId || "").trim();
    if (!redirectRoomId) return;
    if (this._creatingRoom || this._navigating) return;

    if (!this.data.isAuthed) {
      if (this._askedRedirectAuth) return;
      this._askedRedirectAuth = true;
      (async () => {
        try {
          const ok = await this.ensureAuthorized({
            desc: "用于加入房间并展示成员信息",
            confirmTitle: "加入房间需要授权",
            confirmContent: "加入房间需要获取你的微信头像和昵称，用于展示成员信息。是否现在授权？",
            confirmText: "去授权",
            cancelText: "先看看"
          });
          if (ok) {
            this.maybeNavigateRedirect();
          } else {
            this.setData({ redirectRoomId: "" });
          }
        } finally {
          this._askedRedirectAuth = false;
        }
      })();
      return;
    }

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

  async onBackToRoom() {
    if (this._creatingRoom || this._navigating) return;
    const roomId = String(this.data.activeRoomId || "").trim();
    if (!roomId) return;

    const ok = await this.ensureAuthorized({ desc: "用于进入房间并展示成员信息" });
    if (!ok) return;

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

  async ensureAuthorized(options = {}) {
    if (this.data.isAuthed) return true;
    if (this._authing) return false;
    this._authing = true;
    const desc = String(options.desc || "用于显示昵称和头像");
    const confirmTitle = String(options.confirmTitle || "需要授权");
    const confirmContent = String(
      options.confirmContent || `将获取你的微信头像和昵称，${desc}。是否继续？`
    );
    const confirmText = String(options.confirmText || "去授权");
    const cancelText = String(options.cancelText || "取消");
    try {
      const authRes = await new Promise((resolve) => {
        wx.showModal({
          title: confirmTitle,
          content: confirmContent,
          confirmText,
          cancelText,
          success: (res) => {
            if (!res.confirm) {
              resolve({ ok: false, reason: "cancel_confirm" });
              return;
            }
            wx.getUserProfile({
              desc,
              success: (profile) => resolve({ ok: true, profile }),
              fail: (err) => resolve({ ok: false, reason: "user_profile_fail", err })
            });
          },
          fail: (err) => resolve({ ok: false, reason: "modal_fail", err })
        });
      });

      if (!authRes.ok) {
        if (authRes.reason === "cancel_confirm") return false;
        const errMsg = String(authRes.err?.errMsg || authRes.err?.message || "");
        if (errMsg.includes("deny") || errMsg.includes("cancel")) {
          wx.showToast({ title: "已取消授权", icon: "none" });
          return false;
        }
        console.error(authRes.err);
        wx.showToast({ title: "授权失败，请重试", icon: "none" });
        return false;
      }

      const userInfo = authRes.profile?.userInfo || {};
      const nickName = String(userInfo.nickName || "").trim();
      const avatarUrl = String(userInfo.avatarUrl || "").trim();
      if (!nickName) {
        console.warn("[auth] empty nickName from wx.getUserProfile:", authRes.profile);
        wx.showToast({ title: "未获取到昵称，请重试", icon: "none" });
        return false;
      }
      await callFunction("updateProfile", { nickName, avatarUrl });
      await this.loadMe();
      wx.showToast({ title: "授权成功", icon: "success" });
      return true;
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "授权失败", icon: "none" });
      return false;
    } finally {
      this._authing = false;
    }
  },

  async onTapAvatarOrNick() {
    if (!this.data.isAuthed) {
      await this.ensureAuthorized({ desc: "用于登录并展示昵称头像" });
      return;
    }
    wx.navigateTo({ url: "/pages/profile/profile" });
  },

  async onImproveProfile() {
    const ok = await this.ensureAuthorized({ desc: "用于完善资料" });
    if (!ok) return;
    wx.navigateTo({ url: "/pages/profile/profile" });
  },

  async onCreateRoom() {
    if (this._creatingRoom) return;
    const ok = await this.ensureAuthorized({ desc: "用于开房并展示成员信息" });
    if (!ok) return;
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
    const ok = await this.ensureAuthorized({ desc: "用于加入房间并展示成员信息" });
    if (!ok) return;
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

  async openJoinModal() {
    if (this._creatingRoom || this._navigating || this._joiningById) return;
    const ok = await this.ensureAuthorized({ desc: "用于加入房间并展示成员信息" });
    if (!ok) return;
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
    if (!/^[0-9a-zA-Z]+$/.test(roomId)) {
      wx.showToast({ title: "房间号格式不正确", icon: "none" });
      return;
    }
    if (roomId.length !== 4) {
      wx.showToast({ title: "房间号为 4 位字母/数字", icon: "none" });
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
    this.onImproveProfile();
  },

  async toHistory() {
    const ok = await this.ensureAuthorized({ desc: "用于查看历史战绩" });
    if (!ok) return;
    wx.navigateTo({ url: "/pages/history/history" });
  }
});
