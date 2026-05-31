import { filterImages, sortImages } from "../preview/filter-engine.js";
import { renderPreview } from "../preview/preview-engine.js";
import { buildFilename, buildSourceFilename } from "../download/filename-builder.js";
import { createSelectionSummary } from "./components/image-card.js";

const state = {
  images: [],
  visibleImages: [],
  selected: new Set(),
  context: {},
  config: null,
  layout: "grid",
  size: "medium",
  rateLimitedImages: [],
  activeSessionId: "",
  previewRunId: 0,
  retryTimer: 0,
  autoRetryStopped: false,
  isDownloading: false
};

const $ = (selector) => document.querySelector(selector);
const preview = $("#preview");
const message = $("#message");

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await loadConfig();
  await scanImages();
}

function bindEvents() {
  $("#scanBtn").addEventListener("click", () => scanImages());
  $("#scrollBtn").addEventListener("click", () => scanImages({ autoScroll: true }));
  $("#downloadBtn").addEventListener("click", downloadSelected);
  $("#retry429Btn").addEventListener("click", retryRateLimited);
  $("#stopRetryBtn").addEventListener("click", stopAutoRetry);
  $("#selectAllBtn").addEventListener("click", () => {
    state.visibleImages.forEach((image) => state.selected.add(image.id));
    render();
  });
  $("#clearBtn").addEventListener("click", () => {
    state.selected.clear();
    render();
  });
  $("#toggleDisplayMode").addEventListener("click", toggleDisplayMode);
  $("#openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  for (const id of ["searchInput", "includeInput", "excludeInput", "domainInput", "layoutSelect", "sizeSelect", "sortSelect"]) {
    $(`#${id}`).addEventListener("input", render);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "DOWNLOAD_PROGRESS" || message.sessionId !== state.activeSessionId) return;
  const { completed, failed, rateLimited, total } = message.payload;
  setMessage(`下载中：成功 ${completed}/${total}，失败 ${failed}，429 ${rateLimited}`);
});

async function loadConfig() {
  const response = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
  if (!response.ok) throw new Error(response.error);
  state.config = response.config;
  updateDisplayModeButton();
  $("#excludeInput").value = response.config.preview.excludeKeywords || "";
  $("#layoutSelect").value = response.config.preview.layout || "grid";
  $("#sizeSelect").value = response.config.preview.size || "medium";
  $("#sortSelect").value = response.config.preview.sortBy || "pageIndex";
}

async function toggleDisplayMode() {
  const response = await chrome.runtime.sendMessage({ type: "TOGGLE_DISPLAY_MODE" });
  if (!response.ok) throw new Error(response.error);
  state.config.ui = { ...(state.config.ui || {}), displayMode: response.displayMode };
  updateDisplayModeButton();
  if (response.displayMode === "sidePanel") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL", tabId: tab?.id }).catch(() => {});
    setMessage("已切换为侧边栏模式。下次点击扩展图标会打开侧边栏。");
  } else {
    setMessage("已切换为窗口模式。下次点击扩展图标会打开弹窗。");
  }
}

function updateDisplayModeButton() {
  const mode = state.config?.ui?.displayMode || "popup";
  $("#toggleDisplayMode").textContent = mode === "sidePanel" ? "窗口模式" : "侧边栏";
  document.body.dataset.displayMode = mode;
}

async function scanImages({ autoScroll = false } = {}) {
  setMessage(autoScroll ? "正在滚动并扫描页面..." : "正在扫描当前页面...");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  await ensureContentScript(tab);
  const type = autoScroll ? "AUTO_SCROLL_SCAN" : "SCAN_IMAGES";
  const payload = await sendTabMessage(tab.id, { type, maxSteps: 12 });
  if (payload?.error) throw new Error(payload.error);

  state.context = payload.context || {};
  state.images = (payload.images || []).map((image, index) => ({
    ...image,
    filename: state.config.download.singleUseSourceFilename && state.config.download.mode === "single"
      ? buildSourceFilename(image, index + 1, state.config.download)
      : buildFilename(image, payload.context || {}, index + 1, state.config.download)
  }));
  state.selected = new Set(state.images.map((image) => image.id));
  $("#pageContext").textContent = `${state.context.comic || state.context.pageTitle || tab.title} · ${state.context.chapter || state.context.site || ""}`;
  await installPreviewAntiHotlinkRules();
  render();
  hydrateVisiblePreviews();
  setMessage(`扫描完成：${state.images.length} 张图片`);
}

function render() {
  state.layout = $("#layoutSelect").value;
  state.size = $("#sizeSelect").value;
  const filters = {
    ...state.config.preview,
    search: $("#searchInput").value,
    includeKeywords: $("#includeInput").value,
    excludeKeywords: $("#excludeInput").value,
    domain: $("#domainInput").value
  };
  state.visibleImages = sortImages(filterImages(state.images, filters), $("#sortSelect").value);
  $("#countLabel").textContent = `${state.visibleImages.length}/${state.images.length} images`;
  $("#selectionLabel").textContent = createSelectionSummary([...state.selected].filter((id) => state.visibleImages.some((image) => image.id === id)).length, state.visibleImages.length);
  renderPreview(preview, state.visibleImages, {
    layout: state.layout,
    size: state.size,
    selected: state.selected,
    onSelectionChange: render
  });
  hydrateVisiblePreviews();
}

async function downloadSelected() {
  const images = state.images.filter((image) => state.selected.has(image.id));
  if (!images.length) {
    setMessage("没有选中的图片");
    return;
  }
  state.autoRetryStopped = false;
  await startDownload(images, "正在创建下载任务");
}

async function retryRateLimited() {
  if (!state.rateLimitedImages.length) return;
  stopAutoRetry();
  state.autoRetryStopped = false;
  await startDownload(state.rateLimitedImages, "正在重下 429 图片");
}

async function startDownload(images, label, { autoRetry = false } = {}) {
  state.isDownloading = true;
  state.rateLimitedImages = [];
  $("#retry429Btn").hidden = true;
  $("#stopRetryBtn").hidden = !autoRetry;
  state.activeSessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  setMessage(`${label}：${images.length} 张图片...`);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await ensureContentScript(tab);
  const response = await chrome.runtime.sendMessage({
    type: "DOWNLOAD_IMAGES",
    payload: {
      images,
      context: state.context,
      options: { ...state.config.download, sessionId: state.activeSessionId },
      tabId: tab?.id
    }
  });
  state.isDownloading = false;
  if (!response.ok) throw new Error(response.error);
  state.rateLimitedImages = response.result.rateLimitedImages || [];
  $("#retry429Btn").hidden = state.rateLimitedImages.length === 0;
  const failedText = response.result.failedCount ? `，失败 ${response.result.failedCount}` : "";
  const rateLimitedText = response.result.rateLimitedCount ? `，429 ${response.result.rateLimitedCount}` : "";
  setMessage(`下载完成：成功 ${response.result.count}/${response.result.requestedCount || images.length}${failedText}${rateLimitedText}`);
  if (state.rateLimitedImages.length && !state.autoRetryStopped) scheduleAutoRetry429();
}

function setMessage(text) {
  message.textContent = text;
}

function sendTabMessage(tabId, messageBody) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, messageBody, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(`${error.message}. 请刷新页面后重试，或确认当前页不是 chrome:// / edge:// 页面。`));
      else resolve(response);
    });
  });
}

async function ensureContentScript(tab) {
  if (!/^https?:\/\//i.test(tab.url || "")) {
    throw new Error("当前页面不支持内容脚本，请确认不是 chrome:// / edge:// / 扩展管理页。");
  }
  try {
    await sendTabMessage(tab.id, { type: "PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/content-entry.js"]
    });
    await wait(250);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleAutoRetry429() {
  clearTimeout(state.retryTimer);
  state.autoRetryStopped = false;
  $("#stopRetryBtn").hidden = false;
  setMessage(`检测到 ${state.rateLimitedImages.length} 张 429 图片，1 秒后自动重试。`);
  state.retryTimer = setTimeout(() => {
    if (state.autoRetryStopped || !state.rateLimitedImages.length || state.isDownloading) return;
    startDownload(state.rateLimitedImages, "自动重试 429 图片", { autoRetry: true }).catch((error) => setMessage(error.message));
  }, 1000);
}

function stopAutoRetry() {
  state.autoRetryStopped = true;
  clearTimeout(state.retryTimer);
  $("#stopRetryBtn").hidden = true;
  if (state.rateLimitedImages.length) $("#retry429Btn").hidden = false;
  setMessage(state.rateLimitedImages.length ? `已停止自动重试，仍有 ${state.rateLimitedImages.length} 张 429 图片可手动重试。` : "已停止自动重试。");
}

async function hydrateVisiblePreviews() {
  const candidates = state.visibleImages
    .filter((image) => !image.previewUrl && !image.previewLoading && !image.previewFailed)
    .slice(0, 24);
  if (!candidates.length) return;

  const runId = ++state.previewRunId;
  markPreviewState(candidates, { previewLoading: true });

  const response = await chrome.runtime.sendMessage({
    type: "FETCH_PREVIEW_IMAGES",
    payload: {
      images: candidates,
      context: state.context,
      config: state.config.download,
      limit: candidates.length
    }
  }).catch((error) => ({ ok: false, error: error.message }));

  if (runId !== state.previewRunId || !response?.ok) {
    markPreviewState(candidates, { previewLoading: false, previewFailed: true });
    return;
  }

  for (const item of response.result.results || []) {
    const image = state.images.find((candidate) => candidate.id === item.id);
    if (!image) continue;
    image.previewLoading = false;
    if (item.ok) {
      image.previewUrl = item.previewUrl;
      image.bytes = image.bytes || item.bytes || 0;
    } else {
      image.previewFailed = true;
      image.previewError = item.error;
    }
  }

  renderPreview(preview, state.visibleImages, {
    layout: state.layout,
    size: state.size,
    selected: state.selected,
    onSelectionChange: render
  });
}

function markPreviewState(images, patch) {
  for (const item of images) {
    const image = state.images.find((candidate) => candidate.id === item.id);
    if (image) Object.assign(image, patch);
  }
}

async function installPreviewAntiHotlinkRules() {
  if (!state.config?.download?.antiHotlink?.enabled || !state.images.length) return;
  const response = await chrome.runtime.sendMessage({
    type: "INSTALL_PREVIEW_ANTI_HOTLINK",
    payload: {
      images: state.images,
      context: state.context,
      config: state.config.download
    }
  });
  if (!response?.ok) console.warn("[CIE:popup] Failed to install preview anti-hotlink rules.", response?.error);
}

function clearPreviewAntiHotlinkRules() {
  chrome.runtime.sendMessage({ type: "CLEAR_PREVIEW_ANTI_HOTLINK" }).catch(() => {});
}

window.addEventListener("unhandledrejection", (event) => setMessage(event.reason?.message || String(event.reason)));
window.addEventListener("error", (event) => setMessage(event.message));
window.addEventListener("pagehide", clearPreviewAntiHotlinkRules);
