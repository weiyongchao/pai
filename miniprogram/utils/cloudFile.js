function isCloudFileId(s) {
  return typeof s === "string" && s.startsWith("cloud://");
}

const TEMP_URL_TTL_MS = 50 * 60 * 1000;
const tempUrlCache = new Map(); // fileID -> { url, expireAt }

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

  const res = await wx.cloud.getTempFileURL({ fileList: needFetch });
  for (const item of res.fileList || []) {
    if (item.status === 0 && item.tempFileURL) {
      map.set(item.fileID, item.tempFileURL);
      tempUrlCache.set(item.fileID, {
        url: item.tempFileURL,
        expireAt: now + TEMP_URL_TTL_MS
      });
    }
  }
  return map;
}

module.exports = {
  isCloudFileId,
  resolveTempUrls
};
