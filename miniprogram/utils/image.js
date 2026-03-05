function guessImageExt(filePath) {
  const s = String(filePath || "").toLowerCase();
  const m = s.match(/\.([a-z0-9]+)$/);
  const ext = (m && m[1]) || "";
  if (ext === "jpeg") return "jpg";
  if (ext === "jpg" || ext === "png" || ext === "webp") return ext;
  return "jpg";
}

function getFileSize(filePath) {
  return new Promise((resolve) => {
    wx.getFileInfo({
      filePath,
      success: (res) => resolve(Number(res?.size || 0)),
      fail: () => resolve(0)
    });
  });
}

function compressOnce(src, quality) {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src,
      quality,
      success: (res) => resolve(String(res?.tempFilePath || "")),
      fail: reject
    });
  });
}

/**
 * 压缩图片用于上传（主要用于头像）
 * - 仅在文件体积超出阈值时尝试压缩
 * - 多档质量逐步压缩，取满足阈值的最小档
 * - 压缩失败则返回原图路径
 */
async function compressImageForUpload(filePath, options = {}) {
  const src = String(filePath || "").trim();
  if (!src) return { filePath: "", ext: "jpg", size: 0, compressed: false };

  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : 350 * 1024;
  const qualities = Array.isArray(options.qualities) && options.qualities.length ? options.qualities : [80, 60, 40];

  const originalSize = await getFileSize(src);
  if (originalSize > 0 && originalSize <= maxBytes) {
    return { filePath: src, ext: guessImageExt(src), size: originalSize, compressed: false, originalSize };
  }

  let bestPath = src;
  let bestSize = originalSize || 0;
  for (const q of qualities) {
    const quality = Math.max(1, Math.min(100, Number(q || 0)));
    if (!quality) continue;
    try {
      const tmp = await compressOnce(src, quality);
      if (!tmp) continue;
      const s = await getFileSize(tmp);
      if (s > 0 && (bestSize === 0 || s < bestSize)) {
        bestPath = tmp;
        bestSize = s;
      }
      if (s > 0 && s <= maxBytes) break;
    } catch {
      // ignore
    }
  }

  return {
    filePath: bestPath,
    ext: guessImageExt(bestPath),
    size: bestSize,
    compressed: bestPath !== src,
    originalSize
  };
}

module.exports = {
  guessImageExt,
  compressImageForUpload
};

