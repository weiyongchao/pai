const { callFunction } = require("../../utils/api");
const { formatTime } = require("../../utils/format");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");
const { envId } = require("../../env");

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

Page({
  data: {
    roomId: "",
    room: null,
    members: [],
    logs: [],
    meOpenid: "",
    loading: true,

    transferModalVisible: false,
    transferTo: null,
    transferAmount: "",
    transferring: false,

    roomCodeVisible: false,
    roomCodeUrl: "",
    roomCodeLoading: false,
    roomCodeError: "",

    profileModalVisible: false,
    profileNickName: "",
    profileAvatarUrl: "",
    profileAvatarPreviewUrl: "",
    profileSaving: false,

    isOwner: false
  },

  _roomCodeOpenedAt: 0,
  _heartbeatTimer: null,
  _unloaded: false,
  _showCodeTimer: null,
  _enterTimer: null,

  async onLoad(options) {
    this._unloaded = false;
    const roomId = this.parseRoomId(options);
    if (!roomId) {
      wx.showToast({ title: "缺少房间参数", icon: "none" });
      this.setData({ loading: false });
      return;
    }
    this.setData({ roomId });

    // 让页面先完成过渡动画再发起接口请求，避免打开页卡顿
    if (this._enterTimer) clearTimeout(this._enterTimer);
    this._enterTimer = setTimeout(() => {
      this.enterRoom(roomId, options);
    }, 120);
  },

  async enterRoom(roomId, options) {
    if (this._unloaded) return;
    wx.showNavigationBarLoading();
    try {
      await this.refresh({ throwOnError: true });
      try {
        wx.setStorageSync("activeRoomId", roomId);
      } catch {
        // ignore
      }
      if (String(options.showCode) === "1") {
        // 避免页面切换的“松手点击”误触导致弹窗立即关闭/闪一下
        if (this._showCodeTimer) clearTimeout(this._showCodeTimer);
        this._showCodeTimer = setTimeout(() => {
          if (this._unloaded) return;
          if (!this.data.roomId) return;
          if (this.data.roomCodeVisible) return;
          this.onShowRoomCode();
        }, 200);
      }
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg === "请先授权登录") {
        wx.reLaunch({
          url: `/pages/index/index?redirectRoomId=${encodeURIComponent(roomId)}`
        });
        return;
      }

      const alreadyInRoomMatch = msg.match(/你已在房间\\s*([a-z0-9]+)/i);
      const activeRoomId = String(alreadyInRoomMatch?.[1] || "").trim();
      if (activeRoomId) {
        wx.showModal({
          title: "已在其他房间",
          content: `你当前在房间 ${activeRoomId}，需要先退房才能加入新房间。是否前往当前房间？`,
          confirmText: "去房间",
          cancelText: "回首页",
          success: (res) => {
            if (res.confirm) {
              wx.redirectTo({
                url: `/pages/room/room?roomId=${encodeURIComponent(activeRoomId)}`
              });
            } else {
              wx.reLaunch({ url: "/pages/index/index" });
            }
          }
        });
        this.setData({ loading: false });
        return;
      }

      const isRoomClosed = msg.includes("房间已关闭") || msg.includes("房间不存在");
      if (isRoomClosed) {
        try {
          const stored = String(wx.getStorageSync("activeRoomId") || "").trim();
          if (stored && stored === roomId) wx.removeStorageSync("activeRoomId");
        } catch {
          // ignore
        }
      }

      console.error(e);
      wx.showToast({ title: msg || "进入房间失败", icon: "none" });
      this.setData({ loading: false });
    } finally {
      wx.hideNavigationBarLoading();
    }
  },

  onShow() {
    this.startHeartbeat();
  },

  onHide() {
    if (this._enterTimer) {
      clearTimeout(this._enterTimer);
      this._enterTimer = null;
    }
    if (this._showCodeTimer) {
      clearTimeout(this._showCodeTimer);
      this._showCodeTimer = null;
    }
    this.stopHeartbeat();
  },

  onUnload() {
    this._unloaded = true;
    if (this._enterTimer) {
      clearTimeout(this._enterTimer);
      this._enterTimer = null;
    }
    if (this._showCodeTimer) {
      clearTimeout(this._showCodeTimer);
      this._showCodeTimer = null;
    }
    this.stopHeartbeat();
  },

  startHeartbeat() {
    this.stopHeartbeat();
    const roomId = this.data.roomId;
    if (!roomId) return;

    const tick = async () => {
      try {
        await callFunction("heartbeatRoom", { roomId });
      } catch {
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

  onShareAppMessage() {
    return {
      title: `加入房间 ${this.data.roomId}`,
      path: `/pages/room/room?roomId=${encodeURIComponent(this.data.roomId)}`
    };
  },

  parseRoomId(options) {
    if (options.roomId) return decodeURIComponent(options.roomId);
    if (options.scene) return decodeURIComponent(options.scene);
    return "";
  },

  async refresh(options = {}) {
    const silent = !!options.silent;
    const throwOnError = !!options.throwOnError;
    if (!silent) this.setData({ loading: true });
    try {
      const res = await callFunction("getRoomDetail", { roomId: this.data.roomId });
      const rawMembers = res.members || [];
      const cloudAvatars = rawMembers.map((member) => member.avatarUrl).filter(isCloudFileId);
      let avatarMap = new Map();
      if (cloudAvatars.length) {
        avatarMap = await resolveTempUrls(cloudAvatars);
      }
      const members = rawMembers.map((member) => ({
        ...member,
        avatarDisplayUrl: avatarMap.get(member.avatarUrl) || member.avatarUrl || ""
      }));
      const nameByOpenid = new Map((members || []).map((m) => [m.openid, m.nickName || m.openid?.slice(0, 6) || "成员"]));
      const logs = (res.logs || []).map((log) => {
        const normalized = {
          ...log,
          time: formatTime(log.createdAt),
          text: log.text || ""
        };
        return {
          ...normalized,
          parts: this.buildLogParts(normalized, nameByOpenid)
        };
      });
      const isOwner = res.room?.ownerOpenid === res.meOpenid;
      const patch = {
        room: res.room,
        members,
        logs,
        meOpenid: res.meOpenid,
        isOwner
      };
      if (!silent) patch.loading = false;
      this.setData(patch);
    } catch (e) {
      console.error(e);
      if (!silent) this.setData({ loading: false });
      if (throwOnError) throw e;
      wx.showToast({ title: e?.message || "刷新失败", icon: "none" });
    }
  },

  buildLogParts(log, nameByOpenid) {
    const safeName = (openid, fallback) => {
      const key = String(openid || "").trim();
      if (!key) return String(fallback || "成员");
      return nameByOpenid.get(key) || key.slice(0, 6);
    };

    if (log?.type === "transfer" && log.fromOpenid && log.toOpenid) {
      const fromName = safeName(log.fromOpenid, "成员");
      const toName = safeName(log.toOpenid, "成员");
      const amount = Number(log.amount || 0);
      return [
        { text: fromName, class: "log-name" },
        { text: " 向 ", class: "" },
        { text: toName, class: "log-name" },
        { text: " 转移了 ", class: "" },
        { text: `${Number.isFinite(amount) ? amount : ""}`, class: "log-amount" },
        { text: " 积分", class: "" }
      ];
    }

    const text = String(log?.text || "");
    const idx = text.indexOf(" ");
    if (idx > 0) {
      const name = text.slice(0, idx);
      const rest = text.slice(idx);
      return [
        { text: name, class: "log-name" },
        { text: rest, class: "" }
      ];
    }

    return [{ text, class: "" }];
  },

  onCopyRoomId() {
    wx.setClipboardData({
      data: this.data.roomId,
      success: () => wx.showToast({ title: "已复制", icon: "success" })
    });
  },

  onTapMember(e) {
    const openid = e.currentTarget.dataset.openid;
    const member = (this.data.members || []).find((m) => m.openid === openid);
    if (!member) return;
    if (openid === this.data.meOpenid) {
      this.openProfileModal();
      return;
    }
    if (this.data.room?.status !== "active") {
      wx.showToast({ title: "房间已结束", icon: "none" });
      return;
    }

    this.setData({
      transferModalVisible: true,
      transferTo: member,
      transferAmount: ""
    });
  },

  onTransferAmountInput(e) {
    this.setData({ transferAmount: e.detail.value });
  },

  closeTransferModal() {
    const force = arguments.length > 0 ? !!arguments[0] : false;
    if (!force && this.data.transferring) return;
    this.setData({ transferModalVisible: false, transferTo: null, transferAmount: "" });
  },

  noop() {},

  async confirmTransfer() {
    const amount = parseInt(this.data.transferAmount, 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      wx.showToast({ title: "请输入正整数", icon: "none" });
      return;
    }
    const toOpenid = this.data.transferTo?.openid;
    if (!toOpenid) return;

    this.setData({ transferring: true });
    try {
      await callFunction("transferScore", {
        roomId: this.data.roomId,
        toOpenid,
        amount
      });
      this.closeTransferModal(true);
      await this.refresh({ silent: true });
      wx.showToast({ title: "已转移", icon: "success" });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "转移失败", icon: "none" });
    } finally {
      this.setData({ transferring: false });
    }
  },

  async onShowRoomCode() {
    if (this.data.roomCodeLoading) return;
    try {
      this._roomCodeOpenedAt = Date.now();
      this.setData({
        roomCodeVisible: true,
        roomCodeUrl: "",
        roomCodeLoading: true,
        roomCodeError: ""
      });
      const res = await callFunction("getRoomCode", { roomId: this.data.roomId });
      const fileID = res.fileID;
      const tempRes = await wx.cloud.getTempFileURL({ fileList: [fileID] });
      const url = tempRes.fileList?.[0]?.tempFileURL || "";
      this.setData({ roomCodeUrl: url });
      this._roomCodeOpenedAt = Date.now();
    } catch (e) {
      const msg = e?.message || "生成失败";
      this.setData({ roomCodeError: msg });
      const isNoPermission =
        msg.includes("-604101") ||
        msg.includes("云调用权限") ||
        msg.includes("无权限") ||
        msg.toLowerCase().includes("no permission");
      if (isNoPermission) {
        console.warn(e);
        wx.showToast({ title: "暂无法生成房间码，可先分享入房", icon: "none" });
      } else {
        console.error(e);
        wx.showToast({ title: msg, icon: "none" });
      }
    } finally {
      this.setData({ roomCodeLoading: false });
    }
  },

  closeRoomCode() {
    if (Date.now() - (this._roomCodeOpenedAt || 0) < 350) return;
    if (this.data.roomCodeLoading) return;
    this.setData({ roomCodeVisible: false, roomCodeUrl: "", roomCodeLoading: false, roomCodeError: "" });
  },

  toMine() {
    wx.navigateTo({
      url: `/pages/roomMine/roomMine?roomId=${encodeURIComponent(this.data.roomId)}`
    });
  },

  openProfileModal() {
    const meOpenid = this.data.meOpenid;
    const meMember = (this.data.members || []).find((m) => m.openid === meOpenid) || {};
    const profileAvatarUrl = meMember.avatarUrl || "";
    const profileAvatarPreviewUrl = meMember.avatarDisplayUrl || profileAvatarUrl || "";
    this.setData({
      profileModalVisible: true,
      profileNickName: meMember.nickName || "",
      profileAvatarUrl,
      profileAvatarPreviewUrl
    });
  },

  closeProfileModal() {
    if (this.data.profileSaving) return;
    this.setData({
      profileModalVisible: false,
      profileNickName: "",
      profileAvatarUrl: "",
      profileAvatarPreviewUrl: ""
    });
  },

  onProfileNickInput(e) {
    this.setData({ profileNickName: e.detail.value });
  },

  async onChooseProfileAvatar() {
    if (this.data.profileSaving) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (res) => {
        try {
          const filePath = res.tempFiles?.[0]?.tempFilePath;
          if (!filePath) return;
          wx.showLoading({ title: "上传中" });
          wx.cloud.init({ env: String(envId || "").trim() || wx.cloud.DYNAMIC_CURRENT_ENV });
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `avatars/${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
            filePath
          });
          const map = await resolveTempUrls([uploadRes.fileID]);
          this.setData({
            profileAvatarUrl: uploadRes.fileID,
            profileAvatarPreviewUrl: map.get(uploadRes.fileID) || ""
          });
        } catch (e) {
          console.error(e);
          wx.showToast({ title: "上传失败", icon: "none" });
        } finally {
          wx.hideLoading();
        }
      }
    });
  },

  async saveProfile() {
    const nickName = String(this.data.profileNickName || "").trim();
    if (!nickName) {
      wx.showToast({ title: "昵称不能为空", icon: "none" });
      return;
    }

    this.setData({ profileSaving: true });
    try {
      await callFunction("updateProfile", {
        nickName,
        avatarUrl: this.data.profileAvatarUrl
      });
      wx.showToast({ title: "已保存", icon: "success" });
      this.setData({
        profileModalVisible: false,
        profileNickName: "",
        profileAvatarUrl: "",
        profileAvatarPreviewUrl: ""
      });
      await this.refresh({ silent: true });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "保存失败", icon: "none" });
    } finally {
      this.setData({ profileSaving: false });
    }
  },
});
