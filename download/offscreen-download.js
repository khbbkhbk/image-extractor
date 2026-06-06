import { deleteTempBlob, putTempBlob } from "./blob-store.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen/download-offscreen.html";
const OFFSCREEN_CREATE_MESSAGE = "OFFSCREEN_CREATE_BLOB_URL";
const OFFSCREEN_FETCH_MESSAGE = "OFFSCREEN_FETCH_REMOTE_BLOB_URL";
const OFFSCREEN_REVOKE_MESSAGE = "OFFSCREEN_REVOKE_BLOB_URL";

let ensureOffscreenPromise = null;

export async function createOffscreenDownloadUrl(blob) {
  if (!(blob instanceof Blob)) throw new Error("下载内容必须是 Blob");
  const blobKey = crypto.randomUUID();
  try {
    await putTempBlob(blobKey, blob);
  } catch (error) {
    throw normalizeOffscreenError(error, blob, "cache-blob");
  }

  try {
    await ensureOffscreenDocument(blob);
    const response = await chrome.runtime.sendMessage({
      type: OFFSCREEN_CREATE_MESSAGE,
      blobKey
    });
    if (!response?.ok || !response.url) {
      throw createOffscreenDownloadError(blob, response?.error || "offscreen 文档未返回有效下载地址", "create-url");
    }
    return response.url;
  } catch (error) {
    await deleteTempBlob(blobKey).catch(() => { });
    throw normalizeOffscreenError(error, blob, "create-url");
  }
}

export async function createOffscreenDownloadUrlFromRemote(url) {
  if (!/^https?:\/\//i.test(String(url || ""))) {
    throw new Error("远程下载地址必须是 HTTP 或 HTTPS");
  }
  try {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      type: OFFSCREEN_FETCH_MESSAGE,
      url
    });
    if (!response?.ok || !response.url) {
      throw createOffscreenDownloadError(null, response?.error || "offscreen 文档未返回远程下载地址", "fetch-remote");
    }
    return response.url;
  } catch (error) {
    throw normalizeOffscreenError(error, null, "fetch-remote");
  }
}

export async function revokeOffscreenDownloadUrl(url) {
  if (!url) return;
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: OFFSCREEN_REVOKE_MESSAGE,
      url
    });
  } catch (error) {
    console.warn("[CIE:download] Revoke offscreen blob URL failed.", error);
  }
}

async function ensureOffscreenDocument(blob) {
  if (ensureOffscreenPromise) return ensureOffscreenPromise;
  ensureOffscreenPromise = (async () => {
    if (!chrome.offscreen?.createDocument) {
      throw createOffscreenDownloadError(blob, "当前 Chrome 版本不支持 offscreen 文档", "unsupported");
    }

    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl]
      });
      if (contexts.length) return;
    } else if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
      return;
    }

    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["BLOBS"],
        justification: "为大体积图片与压缩包生成临时 blob 下载地址"
      });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (!/single offscreen document/i.test(message)) {
        throw createOffscreenDownloadError(blob, message || "offscreen 文档创建失败", "create-document");
      }
    }
  })();

  try {
    await ensureOffscreenPromise;
  } finally {
    ensureOffscreenPromise = null;
  }
}

function normalizeOffscreenError(error, blob, stage) {
  if (error?.name === "OffscreenDownloadError") return error;
  return createOffscreenDownloadError(blob, error?.message || String(error), stage);
}

function createOffscreenDownloadError(blob, reason, stage) {
  const error = new Error(buildOffscreenErrorMessage(blob, reason, stage));
  error.name = "OffscreenDownloadError";
  error.cause = reason;
  return error;
}

function buildOffscreenErrorMessage(blob, reason, stage) {
  const sizeText = formatBlobSize(blob?.size || 0);
  const hint = stage === "unsupported"
    ? "请升级 Chrome 到较新版本后重试。"
    : stage === "cache-blob"
      ? "建议优先按原图直链下载，或改用 ZIP 模式、降低导出质量/尺寸、减少单次下载数量后重试。"
      : stage === "fetch-remote"
        ? "该站点可能要求特定 Referer、Cookie 或签名参数。建议保持防盗链开启后重试，或改用 ZIP 模式下载。"
        : "建议改用 ZIP 模式、降低导出质量/尺寸、减少单次下载数量，或重新加载扩展后重试。";
  return `当前下载文件约 ${sizeText}，浏览器未能建立大文件临时下载通道（${reason}）。${hint}`;
}

function formatBlobSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "未知大小";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
