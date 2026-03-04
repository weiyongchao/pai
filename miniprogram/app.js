const { envId } = require("./env");

App({
  globalData: {
    me: null
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error("当前基础库不支持云开发，请升级微信或基础库版本。");
      return;
    }

    const resolvedEnvId = String(envId || "").trim();
    const resolvedEnv = resolvedEnvId || wx.cloud.DYNAMIC_CURRENT_ENV || undefined;

    wx.cloud.init({
      env: resolvedEnv,
      traceUser: true
    });
    wx.__cloudInited = true;
  }
});
