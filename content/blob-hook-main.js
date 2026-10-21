/**
 * 页面主世界脚本：在站点创建 blob 图片地址时保留原始 Blob。
 * 许多阅读器在渲染后会立即回收 blob 地址，只有在其回收前持有 Blob 引用，
 * 扩展才能拿到与页面显示完全一致的原始图片字节。
 */
(() => {
  if (window.__CIE_BLOB_HOOK__) return;
  window.__CIE_BLOB_HOOK__ = true;

  const MAX_BLOBS = 160;
  const MAX_BLOB_BYTES = 20 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
  const blobEntries = new Map();
  let totalBytes = 0;

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

  URL.createObjectURL = (object) => {
    const url = originalCreateObjectURL(object);
    try {
      if (isCandidateBlob(object)) rememberBlob(url, object);
    } catch (error) {
      // 忽略站点对象异常，保持原有行为
    }
    return url;
  };

  URL.revokeObjectURL = (url) => {
    // 仍按站点预期回收地址，但保留 Blob 引用供扩展读取
    try {
      originalRevokeObjectURL(url);
    } catch (error) {
      // 忽略回收异常
    }
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.__cieBlobRequest !== true || !data.id) return;
    respondWithBlob(data.id, data.url);
  });

  function isCandidateBlob(object) {
    if (!(object instanceof Blob)) return false;
    if (object.size <= 0 || object.size > MAX_BLOB_BYTES) return false;
    const type = String(object.type || "").toLowerCase();
    return !type || type.startsWith("image/");
  }

  function rememberBlob(url, blob) {
    const entry = {
      blob,
      type: /^image\//i.test(blob.type || "") ? blob.type : "",
      ready: null
    };
    entry.ready = (async () => {
      if (!entry.type) entry.type = await sniffImageType(blob);
      if (!entry.type && blobEntries.get(url) === entry) deleteEntry(url);
    })();
    blobEntries.set(url, entry);
    totalBytes += blob.size;
    // 同时限制条目数与总字节，避免长时间浏览占满内存
    while (blobEntries.size > MAX_BLOBS || totalBytes > MAX_TOTAL_BYTES) {
      const oldestUrl = blobEntries.keys().next().value;
      if (!oldestUrl) break;
      deleteEntry(oldestUrl);
    }
  }

  function deleteEntry(url) {
    const entry = blobEntries.get(url);
    if (!entry) return;
    blobEntries.delete(url);
    totalBytes -= entry.blob.size;
  }

  async function sniffImageType(blob) {
    try {
      const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "image/webp";
      }
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
      if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "image/avif";
      if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
    } catch (error) {
      // 读取失败按非图片处理
    }
    return "";
  }

  async function respondWithBlob(id, url) {
    const entry = blobEntries.get(url);
    if (!entry) {
      postResponse({ id, ok: false });
      return;
    }
    await entry.ready;
    if (!entry.type) {
      postResponse({ id, ok: false });
      return;
    }
    try {
      const dataUrl = await blobToDataUrl(new Blob([entry.blob], { type: entry.type }));
      postResponse({ id, ok: true, dataUrl });
    } catch (error) {
      postResponse({ id, ok: false });
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取图片内容失败"));
      reader.readAsDataURL(blob);
    });
  }

  function postResponse(payload) {
    window.postMessage({ __cieBlobResponse: true, ...payload }, "*");
  }
})();
