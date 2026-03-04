function isCloudFileId(s) {
  return typeof s === "string" && s.startsWith("cloud://");
}

async function resolveTempUrls(fileIDs) {
  const unique = Array.from(new Set((fileIDs || []).filter(isCloudFileId)));
  const map = new Map();
  if (unique.length === 0) return map;

  const res = await wx.cloud.getTempFileURL({ fileList: unique });
  for (const item of res.fileList || []) {
    if (item.status === 0 && item.tempFileURL) {
      map.set(item.fileID, item.tempFileURL);
    }
  }
  return map;
}

module.exports = {
  isCloudFileId,
  resolveTempUrls
};

