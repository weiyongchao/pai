const { envId } = require("../env");

let cloudInited = false;

function resolveEnv() {
  const id = String(envId || "").trim();
  return id || wx.cloud.DYNAMIC_CURRENT_ENV || undefined;
}

function ensureCloudInit() {
  if (cloudInited) return;
  if (wx.__cloudInited) {
    cloudInited = true;
    return;
  }
  if (!wx.cloud) {
    throw new Error("当前基础库不支持云开发，请升级微信或基础库版本。");
  }
  wx.cloud.init({
    env: resolveEnv(),
    traceUser: true
  });
  cloudInited = true;
  wx.__cloudInited = true;
}

function callFunction(name, data) {
  return new Promise((resolve, reject) => {
    try {
      ensureCloudInit();
    } catch (e) {
      reject(e);
      return;
    }

    const env = resolveEnv();
    const startedAt = Date.now();
    wx.cloud.callFunction({
      name,
      data,
      config: env ? { env } : undefined,
      success: (res) => {
        const costMs = Date.now() - startedAt;
        if (costMs >= 800) {
          console.info(`[cloud] ${name} ok ${costMs}ms`);
        }
        resolve(res.result);
      },
      fail: (err) => {
        const costMs = Date.now() - startedAt;
        const errMsg = String(err?.errMsg || err?.message || "");
        const currentEnvId = String(envId || "").trim();
        if (costMs >= 800) {
          console.warn(`[cloud] ${name} fail ${costMs}ms: ${errMsg}`);
        }

        const isInvalidEnv =
          errMsg.includes("INVALID_ENV") ||
          errMsg.includes("Environment not found") ||
          errMsg.includes("there is no default environment exists");
        if (isInvalidEnv) {
          const e = new Error(
            `云开发环境不可用：请确认已创建并选择环境，且 envId 正确。当前 envId=${currentEnvId || "(空)"}；原始错误：${errMsg}`
          );
          e.original = err;
          reject(e);
          return;
        }

        const isFunctionNotFound =
          errMsg.includes("FUNCTION_NOT_FOUND") || errMsg.includes("FunctionName parameter could not be found");
        if (isFunctionNotFound) {
          const e = new Error(
            `云函数未部署或不存在：${name}。请在开发者工具「云开发」面板上传并部署 cloudfunctions/${name}（选择环境 ${currentEnvId ||
              "(空)"}）。原始错误：${errMsg}`
          );
          e.original = err;
          reject(e);
          return;
        }

        const isLocalDebugPollEmpty = errMsg.includes("-404006") && errMsg.includes("empty poll result");
        if (isLocalDebugPollEmpty) {
          const e = new Error(
            `云函数本地调试异常（-404006）：本地调试进程没有返回结果。建议先关闭「云函数本地调试」，改为云端运行；或重启开发者工具/清缓存后再试。原始错误：${errMsg}`
          );
          e.original = err;
          reject(e);
          return;
        }

        const isCollectionNotExist =
          errMsg.includes("-502005") ||
          errMsg.includes("DATABASE_COLLECTION_NOT_EXIST") ||
          errMsg.includes("Db or Table not exist") ||
          errMsg.includes("database collection not exists");
        if (isCollectionNotExist) {
          const match = errMsg.match(/Db or Table not exist:\\s*([a-zA-Z0-9_-]+)/);
          const collection = match?.[1] || "";
          const hint = collection
            ? `缺少集合：${collection}`
            : "缺少数据库集合";
          const e = new Error(
            `数据库集合不存在（-502005）：${hint}。请在开发者工具「云开发 → 数据库」创建集合（至少：users/rooms/room_members/room_logs），并确认当前环境为 ${currentEnvId ||
              "(空)"}。原始错误：${errMsg}`
          );
          e.original = err;
          reject(e);
          return;
        }

        const isOpenApiNoPermission =
          errMsg.includes("-604101") ||
          errMsg.includes("function has no permission to call this API") ||
          errMsg.toLowerCase().includes("has no permission") ||
          errMsg.toLowerCase().includes("no permission to call this api");
        if (isOpenApiNoPermission) {
          const e = new Error(
            `云函数缺少云调用权限（-604101）：当前环境未授权调用微信开放接口。请在云开发控制台为环境 ${currentEnvId ||
              "(空)"} 开通「云调用/微信开放接口」并授权「小程序码」等接口后再试。原始错误：${errMsg}`
          );
          e.original = err;
          reject(e);
          return;
        }

        const e = err instanceof Error ? err : new Error(errMsg || "调用云函数失败");
        e.original = err;
        reject(e);
      }
    });
  });
}

module.exports = {
  callFunction
};
