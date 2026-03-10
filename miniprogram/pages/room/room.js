const { callFunction } = require("../../utils/api");
const { formatTime } = require("../../utils/format");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");
const { compressImageForUpload } = require("../../utils/image");
const { envId } = require("../../env");

const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const ROOM_AUTO_REFRESH_INTERVAL_MS = 5000;
const MAX_TRANSFER_AMOUNT = 10000000000;

Page({
  data: {
    roomId: "",
    room: null,
    members: [],
    seatVariant: "md",
    seatEditMode: false,
    seatSwapFromOpenid: "",
    tableShape: "circle",
    tableClipStyle: "",
    tableBoxStyle: "",
    tableRingBoxStyle: "",
    tableAreaHeight: 630,
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

    isOwner: false,
    showFooterRoomCodeButton: false
  },

  _roomCodeOpenedAt: 0,
  _roomCodePrefetched: false,
  _roomCodePrefetching: false,
  _heartbeatTimer: null,
  _unloaded: false,
  _entered: false,
  _showCodeTimer: null,
  _prefetchRoomCodeTimer: null,
  _transferWarmupTimer: null,
  _transferWarmed: false,
  _silentRefreshTimer: null,
  _roomAutoRefreshTimer: null,
  _refreshingRoomAuto: false,
  _enterTimer: null,
  _avatarTempUrlCache: null,
  _lastRealMembersPlain: [],

  async onLoad(options) {
    this._unloaded = false;
    this._entered = false;
    const roomId = this.parseRoomId(options);
    if (!roomId) {
      wx.showToast({ title: "缺少房间参数", icon: "none" });
      this.setData({ loading: false });
      return;
    }
    if (!/^[0-9a-z]{4}$/.test(roomId)) {
      wx.showToast({ title: "房间号格式不正确（4位字母/数字）", icon: "none" });
      this.setData({ loading: false });
      return;
    }
    this._lastRealMembersPlain = [];
    this._transferWarmed = false;
    this._avatarTempUrlCache = new Map();
    this.setData({ roomId });

    // 让页面先完成过渡动画再发起接口请求，避免打开页卡顿
    if (this._enterTimer) clearTimeout(this._enterTimer);
    this._enterTimer = setTimeout(() => {
      this.enterRoom(roomId, options);
    }, 120);
  },

  async enterRoom(roomId, options) {
    if (this._unloaded) return;
    try {
      // 优先直拉详情：减少一次云函数调用；若云端仍是旧版 getRoomDetail 再降级 joinRoom
      try {
        await this.refresh({ throwOnError: true });
      } catch (e) {
        const msg = String(e?.message || "");
        const needJoinFirst = msg.includes("你不在该房间内") || msg.includes("请先加入");
        if (!needJoinFirst) throw e;
        await callFunction("joinRoom", { roomId });
        await this.refresh({ throwOnError: true });
      }
      this.afterEnterRoom(roomId, options);
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
        this.setData({ loading: false });
        wx.showModal({
          title: "已在其他房间",
          content: `当前在房间 ${activeRoomId}。是否返回该房间？选择“留在新房间”将退出旧房间并加入当前房间。`,
          confirmText: "返回旧房间",
          cancelText: "留在新房间",
          success: async (res) => {
            if (res.confirm) {
              wx.redirectTo({
                url: `/pages/room/room?roomId=${encodeURIComponent(activeRoomId)}`
              });
              return;
            }
            wx.showLoading({ title: "切换房间中", mask: true });
            this.setData({ loading: true });
            this._entered = false;
            this.stopHeartbeat();
            this.stopAutoRefresh();
            try {
              await callFunction("leaveRoom", { roomId: activeRoomId });
              await callFunction("joinRoom", { roomId });
              await this.refresh({ throwOnError: true });
              this.afterEnterRoom(roomId, options);
              wx.showToast({ title: "已进入新房间", icon: "success" });
            } catch (switchErr) {
              console.error(switchErr);
              this.setData({ loading: false });
              wx.showModal({
                title: "切换失败",
                content: switchErr?.message || "切换房间失败，是否返回旧房间？",
                confirmText: "返回旧房间",
                cancelText: "留在当前页",
                success: (fallbackRes) => {
                  if (fallbackRes.confirm) {
                    wx.redirectTo({
                      url: `/pages/room/room?roomId=${encodeURIComponent(activeRoomId)}`
                    });
                  }
                }
              });
            } finally {
              wx.hideLoading();
            }
          }
        });
        return;
      }

      const isRoomClosed = msg.includes("房间已关闭") || msg.includes("房间已结束") || msg.includes("房间不存在");
      if (isRoomClosed) {
        try {
          const stored = String(wx.getStorageSync("activeRoomId") || "").trim();
          if (stored && stored === roomId) wx.removeStorageSync("activeRoomId");
        } catch {
          // ignore
        }
        const title = "房间已结束";
        const content =
          msg.includes("房间不存在")
            ? "该房间不存在或已被关闭，无法加入。请让房主重新开房。"
            : "该房间已结束/关闭，无法加入。请让房主重新开房。";
        wx.showModal({
          title,
          content,
          showCancel: false,
          confirmText: "回首页",
          success: () => {
            wx.reLaunch({ url: "/pages/index/index" });
          }
        });
        this.setData({ loading: false });
        return;
      }

      console.error(e);
      wx.showToast({ title: msg || "进入房间失败", icon: "none" });
      this.setData({ loading: false });
    } finally {
    }
  },

  onShow() {
    if (!this._entered) return;
    this.startHeartbeat();
    this.startAutoRefresh();
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
    if (this._prefetchRoomCodeTimer) {
      clearTimeout(this._prefetchRoomCodeTimer);
      this._prefetchRoomCodeTimer = null;
    }
    if (this._transferWarmupTimer) {
      clearTimeout(this._transferWarmupTimer);
      this._transferWarmupTimer = null;
    }
    if (this._silentRefreshTimer) {
      clearTimeout(this._silentRefreshTimer);
      this._silentRefreshTimer = null;
    }
    this.stopHeartbeat();
    this.stopAutoRefresh();
  },

  onUnload() {
    this._unloaded = true;
    this._entered = false;
    if (this._enterTimer) {
      clearTimeout(this._enterTimer);
      this._enterTimer = null;
    }
    if (this._showCodeTimer) {
      clearTimeout(this._showCodeTimer);
      this._showCodeTimer = null;
    }
    if (this._prefetchRoomCodeTimer) {
      clearTimeout(this._prefetchRoomCodeTimer);
      this._prefetchRoomCodeTimer = null;
    }
    if (this._transferWarmupTimer) {
      clearTimeout(this._transferWarmupTimer);
      this._transferWarmupTimer = null;
    }
    if (this._silentRefreshTimer) {
      clearTimeout(this._silentRefreshTimer);
      this._silentRefreshTimer = null;
    }
    this.stopHeartbeat();
    this.stopAutoRefresh();
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

    this._heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  },

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    const roomId = String(this.data.roomId || "").trim();
    if (!roomId) return;
    const tick = async () => {
      if (this._unloaded || !this._entered || this._refreshingRoomAuto) return;
      this._refreshingRoomAuto = true;
      try {
        await this.refresh({ silent: true });
      } catch {
        // ignore
      } finally {
        this._refreshingRoomAuto = false;
      }
    };
    tick();
    this._roomAutoRefreshTimer = setInterval(tick, ROOM_AUTO_REFRESH_INTERVAL_MS);
  },

  stopAutoRefresh() {
    if (this._roomAutoRefreshTimer) {
      clearInterval(this._roomAutoRefreshTimer);
      this._roomAutoRefreshTimer = null;
    }
    this._refreshingRoomAuto = false;
  },

  afterEnterRoom(roomId, options = {}) {
    this._entered = true;
    this.startHeartbeat();
    this.startAutoRefresh();
    this.schedulePrefetchRoomCode();
    this.scheduleTransferWarmup();
    try {
      wx.setStorageSync("activeRoomId", roomId);
    } catch {
      // ignore
    }
    if (String(options.showCode) !== "1") return;
    if (this._showCodeTimer) clearTimeout(this._showCodeTimer);
    this._showCodeTimer = setTimeout(() => {
      if (this._unloaded) return;
      if (!this.data.roomId) return;
      if (this.data.roomCodeVisible) return;
      this.onShowRoomCode();
    }, 200);
  },

  onShareAppMessage() {
    const imageUrl = String(this.data.roomCodeUrl || "").trim();
    return {
      title: `加入房间 ${this.data.roomId}`,
      path: `/pages/room/room?roomId=${encodeURIComponent(this.data.roomId)}`,
      ...(imageUrl && /^https?:\/\//.test(imageUrl) ? { imageUrl } : {})
    };
  },

  schedulePrefetchRoomCode() {
    if (this._unloaded) return;
    if (this._roomCodePrefetched || this._roomCodePrefetching) return;
    if (this._prefetchRoomCodeTimer) clearTimeout(this._prefetchRoomCodeTimer);
    // 轻量延迟：避免与入房/渲染抢占
    this._prefetchRoomCodeTimer = setTimeout(() => {
      this._prefetchRoomCodeTimer = null;
      this.prefetchRoomCode();
    }, 400);
  },

  scheduleTransferWarmup() {
    if (this._unloaded || this._transferWarmed) return;
    if (this._transferWarmupTimer) clearTimeout(this._transferWarmupTimer);
    this._transferWarmupTimer = setTimeout(() => {
      this._transferWarmupTimer = null;
      callFunction("transferScore", { warmup: true })
        .then(() => {
          this._transferWarmed = true;
        })
        .catch(() => {});
    }, 650);
  },

  scheduleSilentRefresh(delay = 240) {
    if (this._unloaded) return;
    if (this._silentRefreshTimer) clearTimeout(this._silentRefreshTimer);
    this._silentRefreshTimer = setTimeout(() => {
      this._silentRefreshTimer = null;
      this.refresh({ silent: true }).catch(() => {});
    }, Math.max(0, Number(delay) || 0));
  },

  async ensureRoomCodeUrl(options = {}) {
    const roomId = String(this.data.roomId || "").trim();
    if (!roomId) return { fileID: "", url: "" };

    // 已有缓存 URL 直接用（关闭弹窗也不清空，供分享复用）
    const cachedUrl = String(this.data.roomCodeUrl || "").trim();
    if (cachedUrl) {
      return { fileID: String(this.data.room?.roomCodeFileID || "").trim(), url: cachedUrl };
    }

    let fileID = String(this.data.room?.roomCodeFileID || "").trim();
    if (!fileID) {
      const res = await callFunction("getRoomCode", { roomId });
      fileID = String(res?.fileID || "").trim();
      if (fileID && this.data.room) {
        this.setData({ "room.roomCodeFileID": fileID });
      }
    }

    if (!fileID) {
      throw new Error("未获取到房间码");
    }

    const map = await resolveTempUrls([fileID]);
    const url = map.get(fileID) || "";
    if (!url) {
      throw new Error("房间码获取失败");
    }

    this.setData({ roomCodeUrl: url, roomCodeError: "" });
    return { fileID, url };
  },

  async prefetchRoomCode() {
    if (this._unloaded) return;
    if (this._roomCodePrefetched || this._roomCodePrefetching) return;
    this._roomCodePrefetching = true;
    try {
      await this.ensureRoomCodeUrl({ silent: true });
      this._roomCodePrefetched = true;
    } catch {
      // 预取失败不打扰用户；点“房间码”时再提示
    } finally {
      this._roomCodePrefetching = false;
    }
  },

  parseRoomId(options) {
    if (options.roomId) return String(decodeURIComponent(options.roomId) || "").trim().toLowerCase();
    if (options.scene) return String(decodeURIComponent(options.scene) || "").trim().toLowerCase();
    return "";
  },

  getSeatVariant(count) {
    const n = Number(count || 0);
    if (!Number.isFinite(n) || n <= 0) return "md";
    if (n <= 6) return "lg";
    if (n <= 10) return "md";
    if (n <= 13) return "sm";
    if (n <= 24) return "xs";
    return "xxs";
  },

  attachSeatLayout(members, meOpenid) {
    const list = Array.isArray(members) ? members : [];
    const n = list.length;
    const seatVariant = this.getSeatVariant(n);
    const seatOffsetYByVariant = {
      lg: 38,
      md: 36,
      sm: 34,
      xs: 26,
      xxs: 22
    };
    let seatOffsetY = Number(seatOffsetYByVariant[seatVariant] ?? 34);
    if (n === 2) {
      seatOffsetY = Math.max(18, seatOffsetY - 12);
    } else if (n === 3) {
      seatOffsetY = Math.max(20, seatOffsetY - 8);
    }
    if (n === 0) {
      return {
        seatVariant,
        members: [],
        tableShape: "circle",
        tableClipStyle: "",
        tableBoxStyle: "",
        tableRingBoxStyle: "",
        tableAreaHeight: 630
      };
    }

    const meKey = String(meOpenid || "").trim();
    const meIdx = meKey ? list.findIndex((m) => String(m?.openid || "").trim() === meKey) : -1;
    const posIndexOf = (idx) => {
      if (meIdx < 0) return idx;
      return (idx - meIdx + n) % n;
    };

    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const clampPercent = (v) => clamp(v, 4, 96);
    const toPoint = (x, y) => ({ x: clampPercent(x), y: clampPercent(y) });
    const toSeatStyle = (pt) =>
      `left:${pt.x.toFixed(2)}%;top:${pt.y.toFixed(2)}%;transform:translate(-50%,-50%) translateY(${seatOffsetY}rpx);`;
    const clipStyleFromPoints = (pts) => {
      const points = Array.isArray(pts) ? pts : [];
      if (points.length < 3) return "";
      const str = points
        .map((p) => `${Number(p.x).toFixed(2)}% ${Number(p.y).toFixed(2)}%`)
        .join(", ");
      return `-webkit-clip-path: polygon(${str}); clip-path: polygon(${str});`;
    };
    const insetStyle = ({ left, top, right, bottom }) => {
      const l = clamp(Number(left), 0, 50);
      const r = clamp(Number(right), 50, 100);
      const t = clamp(Number(top), 0, 50);
      const b = clamp(Number(bottom), 50, 100);
      return `left:${l.toFixed(2)}%;top:${t.toFixed(2)}%;right:${(100 - r).toFixed(2)}%;bottom:${(100 - b).toFixed(2)}%;`;
    };

    let tableShape = "circle";
    let tableClipStyle = "";
    let tableBoxStyle = "";
    let tableRingBoxStyle = "";
    const effectiveN = Math.min(50, Math.max(0, n));
    let tableAreaHeight = 630;
    if (effectiveN >= 5 && effectiveN <= 10) {
      tableAreaHeight = 630 + (effectiveN - 4) * 36;
    } else if (effectiveN > 10) {
      const over = effectiveN - 10;
      tableAreaHeight = 1080 + over * 34;
      if (effectiveN > 20) {
        tableAreaHeight += (effectiveN - 20) * 12;
      }
    }
    tableAreaHeight = Math.min(2860, tableAreaHeight);
    const seatPoints = new Array(n);

    if (n <= 3) {
      const radiusPercent = n <= 2 ? 32 : seatVariant === "lg" ? 37.5 : seatVariant === "md" ? 39 : 40;
      tableShape = n === 1 ? "circle" : n === 2 ? "rect" : "poly";
      const step = (Math.PI * 2) / n;
      for (let i = 0; i < n; i++) {
        const angle = Math.PI / 2 + i * step;
        const left = 50 + radiusPercent * Math.cos(angle);
        const sin = Math.sin(angle);
        const yScale = n === 3 && sin < 0 ? 0.55 : 1;
        const top = 50 + radiusPercent * sin * yScale;
        seatPoints[i] = toPoint(left, top);
      }
      if (n === 2) {
        tableAreaHeight = Math.max(tableAreaHeight, 700);
        const dims = { left: 14, right: 86, top: 18, bottom: 82 };
        tableBoxStyle = insetStyle(dims);
        tableRingBoxStyle = insetStyle({ left: dims.left + 3, right: dims.right - 3, top: dims.top + 3, bottom: dims.bottom - 3 });
        // 两人：分别坐在长方形上下两侧（对坐）
        seatPoints[0] = toPoint(50, dims.bottom);
        seatPoints[1] = toPoint(50, dims.top);
      } else if (n === 3) {
        tableAreaHeight = Math.max(tableAreaHeight, 720);
        tableShape = "circle";
        const dims = { left: 11, right: 89, top: 12, bottom: 88 };
        tableBoxStyle = insetStyle(dims);
        tableRingBoxStyle = insetStyle({ left: dims.left + 3, right: dims.right - 3, top: dims.top + 3, bottom: dims.bottom - 3 });
        tableClipStyle = "";
      }
    } else if (n <= 10) {
      tableShape = "poly";
      const step = (Math.PI * 2) / n;
      const edgeRadiusPercent =
        seatVariant === "lg" ? 36 : seatVariant === "md" ? 38 : seatVariant === "sm" ? 40 : seatVariant === "xs" ? 42 : 43;
      const vertexRadiusPercent = edgeRadiusPercent / Math.cos(Math.PI / n);

      for (let i = 0; i < n; i++) {
        const angle = Math.PI / 2 + i * step;
        const left = 50 + edgeRadiusPercent * Math.cos(angle);
        const top = 50 + edgeRadiusPercent * Math.sin(angle);
        seatPoints[i] = toPoint(left, top);
      }

      const vertices = [];
      const baseVertexAngle = Math.PI / 2 - step / 2;
      for (let i = 0; i < n; i++) {
        const angle = baseVertexAngle + i * step;
        const left = 50 + vertexRadiusPercent * Math.cos(angle);
        const top = 50 + vertexRadiusPercent * Math.sin(angle);
        vertices.push(toPoint(left, top));
      }
      tableClipStyle = clipStyleFromPoints(vertices);
    } else {
      tableShape = "rect";
      const extra = clamp(effectiveN - 10, 0, 40);
      const verticalPadRpx = clamp(72 + extra * 0.9, 72, 118);
      const verticalPadPercent = clamp((verticalPadRpx / Math.max(1, tableAreaHeight)) * 100, 3.2, 10.5);
      const dims = {
        left: clamp(14.5 - extra * 0.18, 6, 14.5),
        right: clamp(85.5 + extra * 0.18, 85.5, 94),
        top: verticalPadPercent,
        bottom: 100 - verticalPadPercent
      };
      tableBoxStyle = insetStyle(dims);
      tableRingBoxStyle = insetStyle({
        left: dims.left + 2.2,
        right: dims.right - 2.2,
        top: dims.top + 2.2,
        bottom: dims.bottom - 2.2
      });

      const left = dims.left;
      const right = dims.right;
      const top = dims.top;
      const bottom = dims.bottom;
      const horizontalTarget = effectiveN >= 14 ? 4 : 3;
      const topCount = horizontalTarget;
      const bottomCount = horizontalTarget;
      const sideRemain = n - topCount - bottomCount;
      const rightCount = Math.ceil(sideRemain / 2);
      const leftCount = Math.floor(sideRemain / 2);

      const distributeBetween = (start, end, count) => {
        if (!count) return [];
        const span = end - start;
        return Array.from({ length: count }, (_, index) => start + (span * (index + 1)) / (count + 1));
      };

      const edgeInsetX = clamp((right - left) * 0.08, 4.5, 8.5);
      const edgeInsetY = clamp((bottom - top) * 0.04, 2.2, 6.5);
      const bottomCenterGap = clamp((right - left) * 0.18, 10, 15.5);
      const cornerInsetX = clamp((right - left) * 0.055, 3.8, 6.8);
      const sideCornerGap = clamp((bottom - top) * 0.05, 3.6, 7.2);
      const topLeft = left + edgeInsetX;
      const topRight = right - edgeInsetX;
      const topCornerLeft = left + cornerInsetX;
      const topCornerRight = right - cornerInsetX;
      const sideTop = top + edgeInsetY + sideCornerGap;
      const sideBottom = bottom - edgeInsetY - sideCornerGap;
      const bottomLeftLimit = 50 - bottomCenterGap;
      const bottomRightLimit = 50 + bottomCenterGap;

      const points = [];

      const buildTopXs = (count) => {
        if (!count) return [];
        if (count === 1) return [50];
        if (count === 2) return [topCornerLeft, topCornerRight];
        if (count === 3) return [topCornerLeft, 50, topCornerRight];
        const innerInset = clamp((right - left) * 0.13, 5.5, 8.5);
        const innerXs = distributeBetween(topCornerLeft + innerInset, topCornerRight - innerInset, count - 2);
        return [topCornerLeft, ...innerXs, topCornerRight];
      };

      const buildBottomRightXs = (count) => {
        if (!count) return [];
        if (count === 1) return [topCornerRight];
        const innerRightLimit = topCornerRight - clamp((right - left) * 0.06, 3, 5);
        const innerXs = distributeBetween(bottomRightLimit, innerRightLimit, count - 1);
        return [...innerXs, topCornerRight];
      };

      const buildBottomLeftXs = (count) => {
        if (!count) return [];
        if (count === 1) return [topCornerLeft];
        const innerLeftStart = topCornerLeft + clamp((right - left) * 0.06, 3, 5);
        const innerXs = distributeBetween(innerLeftStart, bottomLeftLimit, count - 1);
        return [topCornerLeft, ...innerXs];
      };

      const buildSideYs = (count) => {
        if (!count) return [];
        if (count === 1) return [(sideTop + sideBottom) / 2];
        const span = sideBottom - sideTop;
        const edgeRatio = count >= 5 ? 0.13 : count === 4 ? 0.15 : 0.18;
        return Array.from({ length: count }, (_, index) => {
          const t = index / (count - 1);
          const mapped = edgeRatio + t * (1 - edgeRatio * 2);
          return sideTop + span * mapped;
        });
      };

      // 底边：自己固定中间，其余位置左右拉开，避免和“我”重叠。
      points.push(toPoint(50, bottom));
      const bottomRemain = Math.max(0, bottomCount - 1);
      const bottomLeftCount = Math.ceil(bottomRemain / 2);
      const bottomRightCount = bottomRemain - bottomLeftCount;
      const bottomRightXs = buildBottomRightXs(bottomRightCount);
      const bottomLeftXs = buildBottomLeftXs(bottomLeftCount);
      for (const x of bottomRightXs) {
        points.push(toPoint(x, bottom));
      }

      // 右边：自下向上均匀排布。
      const rightYs = buildSideYs(rightCount).reverse();
      for (const y of rightYs) {
        points.push(toPoint(right, y));
      }

      // 顶边：11-13 人每边 3 个，14+ 每边 4 个。
      const topXs = buildTopXs(topCount).reverse();
      for (const x of topXs) {
        points.push(toPoint(x, top));
      }

      // 左边：自上向下均匀排布。
      const leftYs = buildSideYs(leftCount);
      for (const y of leftYs) {
        points.push(toPoint(left, y));
      }

      // 底边左侧：由左往中间回收，闭合环形。
      for (const x of bottomLeftXs) {
        points.push(toPoint(x, bottom));
      }

      for (let i = 0; i < n; i++) {
        seatPoints[i] = points[i] || toPoint(50, bottom);
      }
    }

    const withSeat = list.map((m, idx) => {
      const p = posIndexOf(idx);
      const pt = seatPoints[p] || toPoint(50, 86);
      return { ...m, seatStyle: toSeatStyle(pt) };
    });

    return {
      seatVariant,
      members: withSeat,
      tableShape,
      tableClipStyle,
      tableBoxStyle,
      tableRingBoxStyle,
      tableAreaHeight
    };
  },

  getSeatOrderKey(roomId) {
    const id = String(roomId || "").trim();
    return id ? `seatOrder_${id}` : "seatOrder_";
  },

  loadSeatOrder(roomId) {
    const key = this.getSeatOrderKey(roomId);
    try {
      const stored = wx.getStorageSync(key);
      if (Array.isArray(stored)) {
        return stored.map((v) => String(v || "").trim()).filter(Boolean);
      }
      if (typeof stored === "string") {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return parsed.map((v) => String(v || "").trim()).filter(Boolean);
        }
      }
    } catch {
      // ignore
    }
    return [];
  },

  saveSeatOrder(roomId, order) {
    const key = this.getSeatOrderKey(roomId);
    const list = Array.isArray(order) ? order.map((v) => String(v || "").trim()).filter(Boolean) : [];
    try {
      wx.setStorageSync(key, list);
    } catch {
      // ignore
    }
  },

  applySeatOrder(members, roomId) {
    const list = Array.isArray(members) ? members : [];
    const openids = list.map((m) => String(m?.openid || "").trim()).filter(Boolean);
    if (openids.length === 0) return [];

    const stored = this.loadSeatOrder(roomId);
    const seen = new Set();
    const existSet = new Set(openids);
    const normalized = [];
    for (const id of stored) {
      if (!id || !existSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }
    for (const id of openids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }

    if (normalized.length) this.saveSeatOrder(roomId, normalized);

    const indexByOpenid = new Map(normalized.map((id, idx) => [id, idx]));
    return [...list].sort((a, b) => {
      const ai = indexByOpenid.get(String(a?.openid || "").trim());
      const bi = indexByOpenid.get(String(b?.openid || "").trim());
      return Number(ai ?? 9999) - Number(bi ?? 9999);
    });
  },

  async refresh(options = {}) {
    const silent = !!options.silent;
    const throwOnError = !!options.throwOnError;
    if (!silent) this.setData({ loading: true });
    try {
      const res = await callFunction("getRoomDetail", { roomId: this.data.roomId });
      const rawMembers = res.members || [];
      const cloudAvatars = Array.from(new Set(rawMembers.map((member) => member.avatarUrl).filter(isCloudFileId)));
      if (!this._avatarTempUrlCache) this._avatarTempUrlCache = new Map();
      const missingCloudAvatars = cloudAvatars.filter((fileID) => !this._avatarTempUrlCache.has(fileID));
      if (missingCloudAvatars.length) {
        const fetchedMap = await resolveTempUrls(missingCloudAvatars);
        for (const fileID of missingCloudAvatars) {
          this._avatarTempUrlCache.set(fileID, fetchedMap.get(fileID) || "");
        }
      }
      const membersPlain = rawMembers.map((member) => ({
        ...member,
        avatarDisplayUrl: isCloudFileId(member.avatarUrl)
          ? this._avatarTempUrlCache.get(member.avatarUrl) || ""
          : member.avatarUrl || ""
      }));
      this._lastRealMembersPlain = membersPlain;
      const orderedPlain = this.applySeatOrder(membersPlain, this.data.roomId);
      const seatLayout = this.attachSeatLayout(orderedPlain, res.meOpenid);
      const members = seatLayout.members;
      const nameByOpenid = new Map((members || []).map((m) => [m.openid, m.nickName || m.openid?.slice(0, 6) || "成员"]));
      const logs = [...(res.logs || [])]
        .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0))
        .map((log) => {
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
        seatVariant: seatLayout.seatVariant,
        tableShape: seatLayout.tableShape,
        tableClipStyle: seatLayout.tableClipStyle,
        tableBoxStyle: seatLayout.tableBoxStyle,
        tableRingBoxStyle: seatLayout.tableRingBoxStyle,
        tableAreaHeight: seatLayout.tableAreaHeight,
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
      if (!silent) {
        wx.showToast({ title: e?.message || "刷新失败", icon: "none" });
      }
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
    if (this.data.seatEditMode) {
      this.onSwapSeatTap(openid);
      return;
    }
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

  toggleSeatEditMode() {
    const next = !this.data.seatEditMode;
    this.setData({
      seatEditMode: next,
      seatSwapFromOpenid: ""
    });
    wx.showToast({
      title: next ? "座位调整：点两人交换" : "已退出座位调整",
      icon: "none"
    });
  },

  onSwapSeatTap(openid) {
    const id = String(openid || "").trim();
    if (!id) return;
    const selected = String(this.data.seatSwapFromOpenid || "").trim();
    if (!selected) {
      this.setData({ seatSwapFromOpenid: id });
      return;
    }
    if (selected === id) {
      this.setData({ seatSwapFromOpenid: "" });
      return;
    }

    const roomId = this.data.roomId;
    const currentOrder = (this.data.members || []).map((m) => String(m?.openid || "").trim()).filter(Boolean);
    const i = currentOrder.indexOf(selected);
    const j = currentOrder.indexOf(id);
    if (i < 0 || j < 0) {
      this.setData({ seatSwapFromOpenid: "" });
      return;
    }
    const nextOrder = [...currentOrder];
    const tmp = nextOrder[i];
    nextOrder[i] = nextOrder[j];
    nextOrder[j] = tmp;
    this.saveSeatOrder(roomId, nextOrder);

    const idxMap = new Map(nextOrder.map((oid, idx) => [oid, idx]));
    const membersOrdered = [...(this.data.members || [])].sort((a, b) => {
      const ai = idxMap.get(String(a?.openid || "").trim());
      const bi = idxMap.get(String(b?.openid || "").trim());
      return Number(ai ?? 9999) - Number(bi ?? 9999);
    });
    const seatLayout = this.attachSeatLayout(membersOrdered, this.data.meOpenid);

    this.setData({
      members: seatLayout.members,
      seatVariant: seatLayout.seatVariant,
      tableShape: seatLayout.tableShape,
      tableClipStyle: seatLayout.tableClipStyle,
      tableBoxStyle: seatLayout.tableBoxStyle,
      tableRingBoxStyle: seatLayout.tableRingBoxStyle,
      tableAreaHeight: seatLayout.tableAreaHeight,
      seatSwapFromOpenid: ""
    });
    wx.showToast({ title: "已交换座位", icon: "success" });
  },

  rebuildSeatLayout() {
    const roomId = this.data.roomId;
    const base =
      Array.isArray(this._lastRealMembersPlain) && this._lastRealMembersPlain.length
        ? this._lastRealMembersPlain
        : (this.data.members || []).map((m) => ({ ...m, seatStyle: undefined }));
    const orderedPlain = this.applySeatOrder(base, roomId);
    const seatLayout = this.attachSeatLayout(orderedPlain, this.data.meOpenid);
    this.setData({
      members: seatLayout.members,
      seatVariant: seatLayout.seatVariant,
      tableShape: seatLayout.tableShape,
      tableClipStyle: seatLayout.tableClipStyle,
      tableBoxStyle: seatLayout.tableBoxStyle,
      tableRingBoxStyle: seatLayout.tableRingBoxStyle,
      tableAreaHeight: seatLayout.tableAreaHeight,
      seatSwapFromOpenid: ""
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

  applyLocalTransfer({ toOpenid, amount, createdAt }) {
    const fromOpenid = String(this.data.meOpenid || "").trim();
    const roomId = String(this.data.roomId || "").trim();
    if (!fromOpenid || !toOpenid || !roomId) return;

    const members = (this.data.members || []).map((m) => {
      const score = Number(m.score || 0) || 0;
      if (m.openid === fromOpenid) return { ...m, score: score - amount };
      if (m.openid === toOpenid) return { ...m, score: score + amount };
      return m;
    });

    const nameByOpenid = new Map((members || []).map((m) => [m.openid, m.nickName || m.openid?.slice(0, 6) || "成员"]));
    const ts = Number(createdAt) || Date.now();
    const log = {
      _id: `local-${ts}-${fromOpenid}-${toOpenid}-${amount}`,
      roomId,
      type: "transfer",
      fromOpenid,
      toOpenid,
      amount,
      createdAt: ts,
      text: "",
      time: formatTime(ts)
    };
    log.parts = this.buildLogParts(log, nameByOpenid);

    let logs = [log, ...(this.data.logs || [])];
    if (logs.length > 50) logs = logs.slice(0, 50);

    this.setData({ members, logs });
  },

  async confirmTransfer() {
    if (this.data.transferring) return;
    const amount = parseInt(this.data.transferAmount, 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      wx.showToast({ title: "请输入正整数", icon: "none" });
      return;
    }
    if (amount > MAX_TRANSFER_AMOUNT) {
      wx.showToast({ title: "单次最多转移100亿", icon: "none" });
      return;
    }
    const toOpenid = this.data.transferTo?.openid;
    if (!toOpenid) return;

    this.applyLocalTransfer({ toOpenid, amount, createdAt: Date.now() });
    this.closeTransferModal(true);
    this.setData({ transferring: true });
    try {
      await callFunction("transferScore", {
        roomId: this.data.roomId,
        toOpenid,
        amount
      });
      wx.showToast({ title: "已转移", icon: "success" });
      this.scheduleSilentRefresh(180);
    } catch (e) {
      console.error(e);
      this.scheduleSilentRefresh(60);
      wx.showToast({ title: e?.message || "转移失败", icon: "none" });
    } finally {
      this.setData({ transferring: false });
    }
  },

  async onShowRoomCode() {
    if (this.data.roomCodeLoading) return;
    // 若已缓存，直接打开弹窗即可
    if (this.data.roomCodeUrl) {
      this._roomCodeOpenedAt = Date.now();
      this.setData({ roomCodeVisible: true, roomCodeError: "" });
      return;
    }
    try {
      this._roomCodeOpenedAt = Date.now();
      this.setData({
        roomCodeVisible: true,
        roomCodeLoading: true,
        roomCodeError: ""
      });
      await this.ensureRoomCodeUrl({ silent: false });
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
    // 不清空 roomCodeUrl，供分享复用（房间码固定）
    this.setData({ roomCodeVisible: false, roomCodeLoading: false });
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
          wx.showLoading({ title: "处理中" });
          const compressed = await compressImageForUpload(filePath, { maxBytes: 350 * 1024 });
          wx.showLoading({ title: "上传中" });
          wx.cloud.init({ env: String(envId || "").trim() || wx.cloud.DYNAMIC_CURRENT_ENV });
          const uploadRes = await wx.cloud.uploadFile({
            cloudPath: `avatars/${Date.now()}-${Math.random().toString(16).slice(2)}.${compressed.ext || "jpg"}`,
            filePath: compressed.filePath || filePath
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
