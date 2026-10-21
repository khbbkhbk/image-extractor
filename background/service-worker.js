import { downloadManager } from "./download-manager.js";
import { configManager } from "../core/config-manager.js";
import { saveScanCache } from "../storage/cache.js";
import { antiHotlinkManager } from "./anti-hotlink.js";
import { displayModeManager } from "./display-mode.js";
import { previewManager } from "./preview-manager.js";
import { abortDownloadSession } from "../download/single-download.js";
import { estimateStorageUsage, getCapturedImage, putCapturedImage } from "../download/blob-store.js";

displayModeManager.applyFromConfig().catch(console.error);


chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("config");
  if (!existing.config) await configManager.reset();
  await displayModeManager.applyFromConfig();
});

chrome.runtime.onStartup.addListener(() => {
  displayModeManager.applyFromConfig().catch(console.error);
});

chrome.action.onClicked.addListener((tab) => {
  displayModeManager.openSidePanel(tab.id).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === "IMAGES_UPDATED") {
    if (sender.tab?.id) saveScanCache(sender.tab.id, message.payload).catch(console.error);
    return false;
  }

  if (message.type === "DOWNLOAD_IMAGES") {
    downloadManager.download(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        console.error("[CIE:download] Download request failed:", {
          mode: message.payload?.options?.mode || "auto",
          imageCount: Array.isArray(message.payload?.images) ? message.payload.images.length : 0,
          tabId: message.payload?.tabId || 0,
          context: message.payload?.context || {}
        }, error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "ABORT_DOWNLOAD_SESSION") {
    abortDownloadSession(message.sessionId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "INSTALL_PREVIEW_ANTI_HOTLINK") {
    antiHotlinkManager.installPreviewRules(message.payload?.images || [], message.payload?.context || {}, message.payload?.config || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STORE_CAPTURED_IMAGE") {
    storeCapturedImage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "FETCH_PREVIEW_IMAGES") {
    previewManager.fetchPreviews(message.payload || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CLEAR_PREVIEW_ANTI_HOTLINK") {
    antiHotlinkManager.clearPreviewRules()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_CONFIG") {
    configManager.getConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "SAVE_CONFIG") {
    configManager.saveConfig(message.config)
      .then(async (config) => {
        await displayModeManager.apply(config.ui?.displayMode || "popup");
        sendResponse({ ok: true, config });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "APPLY_PROFILE") {
    configManager.applyProfile(message.name)
      .then(async (config) => {
        await displayModeManager.apply(config.ui?.displayMode || "popup");
        sendResponse({ ok: true, config });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "TOGGLE_DISPLAY_MODE") {
    displayModeManager.toggle()
      .then((displayMode) => sendResponse({ ok: true, displayMode }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "OPEN_SIDE_PANEL") {
    displayModeManager.openSidePanel(message.tabId || sender.tab?.id)
      .then((opened) => sendResponse({ ok: true, opened }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

let lastCaptureCacheWarningAt = 0;

// 内容脚本在扫描阶段把 blob 图片原始字节送来做持久化，避免页面内存淘汰后无法下载
async function storeCapturedImage({ url, dataUrl } = {}) {
  if (!url || !dataUrl) return { ok: false, error: "参数不完整" };
  if (await getCapturedImage(url).catch(() => null)) return { ok: true, skipped: true };
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  try {
    await putCapturedImage(url, blob);
  } catch (error) {
    if (error?.name === "CaptureCacheFullError") {
      notifyCaptureCacheFull("图片缓存空间不足，请先下载已扫描的图片，再继续浏览。");
      return { ok: false, full: true, error: error.message };
    }
    throw error;
  }
  await warnCaptureCacheIfNeeded();
  return { ok: true, bytes: blob.size };
}

const CAPTURE_SOFT_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

async function warnCaptureCacheIfNeeded() {
  const now = Date.now();
  if (now - lastCaptureCacheWarningAt < 5 * 60 * 1000) return;
  const { usage, quota } = await estimateStorageUsage();
  if (!usage) return;
  const ratio = quota ? usage / quota : 0;
  // 不做硬性上限，但占用超过 2GB 或接近浏览器配额时提醒用户先下载
  if (usage < CAPTURE_SOFT_LIMIT_BYTES && ratio < 0.8) return;
  lastCaptureCacheWarningAt = now;
  chrome.runtime.sendMessage({
    type: "CAPTURE_CACHE_WARNING",
    ratio,
    usage,
    quota
  }).catch(() => { });
}

function notifyCaptureCacheFull(text) {
  chrome.runtime.sendMessage({ type: "CAPTURE_CACHE_FULL", text }).catch(() => { });
}
