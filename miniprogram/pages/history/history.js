const { callFunction } = require("../../utils/api");
const { isCloudFileId, resolveTempUrls } = require("../../utils/cloudFile");

Page({
  data: {
    me: null,
    history: [],
    loading: true
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    wx.showNavigationBarLoading();
    try {
      const res = await callFunction("getMyProfile");
      let me = res.user || null;
      if (!me) {
        this.setData({ me: null, history: [], loading: false });
        return;
      }
      if (me && isCloudFileId(me.avatarUrl)) {
        const map = await resolveTempUrls([me.avatarUrl]);
        me = { ...me, avatarUrl: map.get(me.avatarUrl) || "" };
      }
      const history = this.buildHistory(me?.recentGames || []);
      this.setData({ me, history, loading: false });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: e?.message || "加载失败", icon: "none" });
      this.setData({ loading: false });
    } finally {
      wx.hideNavigationBarLoading();
    }
  },

  buildHistory(list) {
    const rows = Array.isArray(list) ? list : [];
    return rows.map((g) => {
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
  }
});

