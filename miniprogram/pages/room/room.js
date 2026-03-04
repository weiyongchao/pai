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

    profileModalVisible: false,
    profileNickName: "",
    profileAvatarUrl: "",
    profileAvatarPreviewUrl: "",
    profileSaving: false,

    isOwner: false
  },

  _roomCodeOpenedAt: 0,
  _heartbeatTimer: null,

  async onLoad(options) {
    const roomId = this.parseRoomId(options);
    if (!roomId) {
      wx.showToast({ title: "缺少房间参数", icon: "none" });
      this.setData({ loading: false });
      return;
    }
    this.setData({ roomId });

    try {
      await callFunction("joinRoom", { roomId });
      await this.refresh();
      if (String(options.showCode) === "1") {
        await this.onShowRoomCode();
      }
    } catch (e) {
      console.error(e);
      if (e?.message === "请先授权登录") {
        wx.reLaunch({
          url: `/pages/index/index?redirectRoomId=${encodeURIComponent(roomId)}`
        });
        return;
      }
      wx.showToast({ title: e?.message || "进入房间失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  onShow() {
    this.startHeartbeat();
  },

  onHide() {
    this.stopHeartbeat();
  },

  onUnload() {
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

  async refresh() {
    this.setData({ loading: true });
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
      const logs = (res.logs || []).map((log) => ({
        ...log,
        time: formatTime(log.createdAt),
        text: log.text || ""
      }));
      const isOwner = res.room?.ownerOpenid === res.meOpenid;
      this.setData({
        room: res.room,
        members,
        logs,
        meOpenid: res.meOpenid,
        isOwner,
        loading: false
      });
    } catch (e) {
      console.error(e);
      this.setData({ loading: false });
      wx.showToast({ title: e?.message || "刷新失败", icon: "none" });
    }
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
    if (this.data.transferring) return;
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
      this.closeTransferModal();
      await this.refresh();
      wx.showToast({ title: "已转移", icon: "success" });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "转移失败", icon: "none" });
    } finally {
      this.setData({ transferring: false });
    }
  },

  async onShowRoomCode() {
    try {
      wx.showLoading({ title: "生成中" });
      const res = await callFunction("getRoomCode", { roomId: this.data.roomId });
      const fileID = res.fileID;
      const tempRes = await wx.cloud.getTempFileURL({ fileList: [fileID] });
      const url = tempRes.fileList?.[0]?.tempFileURL || "";
      this.setData({ roomCodeVisible: true, roomCodeUrl: url });
      this._roomCodeOpenedAt = Date.now();
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "生成失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  closeRoomCode() {
    if (Date.now() - (this._roomCodeOpenedAt || 0) < 350) return;
    this.setData({ roomCodeVisible: false, roomCodeUrl: "" });
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
      await this.refresh();
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "保存失败", icon: "none" });
    } finally {
      this.setData({ profileSaving: false });
    }
  },
});
