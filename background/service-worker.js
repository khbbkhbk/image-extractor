import { downloadManager } from "./download-manager.js";
import { configManager } from "../core/config-manager.js";
import { saveScanCache } from "../storage/cache.js";
import { antiHotlinkManager } from "./anti-hotlink.js";
import { displayModeManager } from "./display-mode.js";
import { previewManager } from "./preview-manager.js";

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
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "INSTALL_PREVIEW_ANTI_HOTLINK") {
    antiHotlinkManager.installPreviewRules(message.payload?.images || [], message.payload?.context || {}, message.payload?.config || {})
      .then((result) => sendResponse({ ok: true, result }))
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
