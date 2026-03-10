const { callFunction } = require("../../utils/api");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");
const { compressImageForUpload } = require("../../utils/image");

Page({
  data: {
    me: null,
    nickName: "",
    avatarUrl: "",
    avatarPreviewUrl: "",
    saving: false
  },

  _dirty: false,
  _nickDirty: false,
  _avatarDirty: false,
  _loadedOnce: false,
  _loadTimer: null,

  onShow() {
    this._loadedOnce = true;
    if (this._loadTimer) clearTimeout(this._loadTimer);
    // 让页面先完成过渡动画再发起接口请求，避免打开页卡顿
    this._loadTimer = setTimeout(() => {
      this.loadMe();
    }, 120);
  },

  onHide() {
    if (this._loadTimer) {
      clearTimeout(this._loadTimer);
      this._loadTimer = null;
    }
  },

  onUnload() {
    if (this._loadTimer) {
      clearTimeout(this._loadTimer);
      this._loadTimer = null;
    }
  },

  async loadMe() {
    const isDirty = !!this._dirty;
    try {
      const res = await callFunction("getMyProfile");
      if (!res.user) {
        this.setData({ me: null });
        return;
      }
      let avatarPreviewUrl = res.user.avatarUrl || "";
      if (isCloudFileId(avatarPreviewUrl)) {
        const map = await resolveTempUrls([avatarPreviewUrl]);
        avatarPreviewUrl = map.get(avatarPreviewUrl) || "";
      }
      if (isDirty) {
        const patch = { me: res.user };
        if (!this._nickDirty) {
          patch.nickName = res.user.nickName || "";
        }
        if (!this._avatarDirty) {
          patch.avatarUrl = res.user.avatarUrl || "";
          patch.avatarPreviewUrl = avatarPreviewUrl;
        }
        this.setData(patch);
        return;
      }
      this.setData({
        me: res.user,
        nickName: res.user.nickName || "",
        avatarUrl: res.user.avatarUrl || "",
        avatarPreviewUrl
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "加载失败", icon: "none" });
    }
  },

  onNickInput(e) {
    this._dirty = true;
    this._nickDirty = true;
    this.setData({ nickName: e.detail.value });
  },

  onChooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (res) => {
        try {
          const filePath = res.tempFiles?.[0]?.tempFilePath;
          if (!filePath) return;
          this._dirty = true;
          this._avatarDirty = true;
          wx.showLoading({ title: "处理中" });
          const compressed = await compressImageForUpload(filePath, { maxBytes: 350 * 1024 });
          wx.showLoading({ title: "上传中" });
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `avatars/${Date.now()}-${Math.random().toString(16).slice(2)}.${compressed.ext || "jpg"}`,
            filePath: compressed.filePath || filePath
          });
          const map = await resolveTempUrls([uploadRes.fileID]);
          this.setData({
            avatarUrl: uploadRes.fileID,
            avatarPreviewUrl: map.get(uploadRes.fileID) || ""
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

  async onSave() {
    if (!this.data.me) return;
    const nickName = (this.data.nickName || "").trim();
    if (!nickName) {
      wx.showToast({ title: "昵称不能为空", icon: "none" });
      return;
    }

    this.setData({ saving: true });
    try {
      await callFunction("updateProfile", {
        nickName,
        avatarUrl: this.data.avatarUrl
      });
      wx.showToast({ title: "已保存", icon: "success" });
      setTimeout(() => {
        const pages = getCurrentPages();
        if (pages.length > 1) {
          wx.navigateBack({ delta: 1 });
        } else {
          wx.reLaunch({ url: "/pages/index/index" });
        }
      }, 400);
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "保存失败", icon: "none" });
    } finally {
      this.setData({ saving: false });
    }
  }
});
