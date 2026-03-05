function isCloudFileId(s) {
  return typeof s === "string" && s.startsWith("cloud://");
}

const DEFAULT_TEMP_URL_TTL_MS = 10 * 60 * 1000;
const TEMP_URL_SAFETY_MARGIN_MS = 2 * 60 * 1000;
const tempUrlCache = new Map(); // fileID -> { url, expireAt }

function parseExpireAtFromTempUrl(tempFileURL) {
  const url = String(tempFileURL || "").trim();
  if (!url) return 0;
  const idx = url.indexOf("?");
  if (idx < 0) return 0;
  const query = url.slice(idx + 1);
  const params = {};
  query.split("&").forEach((kv) => {
    const [k, v] = kv.split("=");
    if (!k) return;
    params[k] = v || "";
  });
  const t = Number(params.t || 0);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t * 1000;
}

function computeExpireAtMs(nowMs, item) {
  const maxAgeSeconds = Number(item?.maxAge || 0);
  let expireAtMs = nowMs + DEFAULT_TEMP_URL_TTL_MS;
  if (Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0) {
    expireAtMs = nowMs + maxAgeSeconds * 1000;
  }

  const fromUrl = parseExpireAtFromTempUrl(item?.tempFileURL);
  if (fromUrl > 0) {
    expireAtMs = Math.min(expireAtMs, fromUrl);
  }

  expireAtMs -= TEMP_URL_SAFETY_MARGIN_MS;
  if (expireAtMs < nowMs + 30 * 1000) expireAtMs = nowMs + 30 * 1000;
  return expireAtMs;
}

async function resolveTempUrls(fileIDs) {
  const unique = Array.from(new Set((fileIDs || []).filter(isCloudFileId)));
  const map = new Map();
  if (unique.length === 0) return map;

  const now = Date.now();
  const needFetch = [];
  for (const fileID of unique) {
    const cached = tempUrlCache.get(fileID);
    if (cached && cached.url && cached.expireAt > now) {
      map.set(fileID, cached.url);
      continue;
    }
    needFetch.push(fileID);
  }

  if (needFetch.length === 0) return map;

  // 显式传 maxAge，避免不同端默认值不一致导致过期过快
  let res;
  try {
    res = await wx.cloud.getTempFileURL({
      fileList: needFetch.map((fileID) => ({ fileID, maxAge: 60 * 60 }))
    });
  } catch {
    // 兼容旧版本：仅支持字符串数组
    res = await wx.cloud.getTempFileURL({ fileList: needFetch });
  }
  for (const item of res.fileList || []) {
    if (item.status === 0 && item.tempFileURL) {
      map.set(item.fileID, item.tempFileURL);
      const expireAt = computeExpireAtMs(now, item);
      tempUrlCache.set(item.fileID, {
        url: item.tempFileURL,
        expireAt
      });
    }
  }
  return map;
}

module.exports = {
  isCloudFileId,
  resolveTempUrls
};
