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
    const safeRows = rows
      .map((g) => ({ ...(g || {}) }))
      .sort((a, b) => Number(b.endedAt || 0) - Number(a.endedAt || 0));

    const pad2 = (n) => (n < 10 ? `0${n}` : `${n}`);
    const fmtTime = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };

    const fmtScore = (n) => {
      const v = Number(n || 0);
      if (!Number.isFinite(v)) return "0";
      // 按截图：正数不加 '+'
      return `${v}`;
    };

    let lastYear = "";
    return safeRows.map((g) => {
      const endedAt = Number(g.endedAt || 0);
      const d = endedAt ? new Date(endedAt) : null;
      const year = d ? String(d.getFullYear()) : "";
      const score = Number(g.score || 0);
      const absScore = Math.abs(Number.isFinite(score) ? score : 0);
      const result = String(g.result || "");

      const players = Array.isArray(g.players) ? g.players : [];
      let detailText = "";
      if (players.length) {
        detailText = players
          .map((p) => {
            const nick = String(p?.nickName || "").trim() || "成员";
            const s = Number(p?.score || 0);
            return `${nick}(${fmtScore(s)})`;
          })
          .join("，");
      } else {
        const raw = String(g.playersText || "").trim();
        detailText = raw ? raw.replace(/\(\+/g, "(") : "";
      }

      const showYearHeader = !!year && year !== lastYear;
      if (year) lastYear = year;

      return {
        roomId: String(g.roomId || ""),
        endedAt,
        year,
        showYearHeader,
        timeText: fmtTime(endedAt),
        absScore,
        absScoreText: String(absScore),
        resultText: result === "win" ? "赢" : result === "loss" ? "输" : "和",
        resultClass: result === "win" ? "win" : result === "loss" ? "loss" : "draw",
        detailText
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
