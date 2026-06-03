import { PRESET_EXCLUDE_KEYWORDS } from "../core/config-manager.js";
import { buildFilename, buildSourceFilename } from "../download/filename-builder.js";
import { filterImages, sortImages } from "../preview/filter-engine.js";
import { renderPreview } from "../preview/preview-engine.js";
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
  isDownloading: false,
  activeTabId: 0,
  activeTabUrl: "",
  scheduledScan: 0,
  scheduledPayloadApply: 0,
  pendingPayload: null,
  excludePresetOptions: [...PRESET_EXCLUDE_KEYWORDS],
  selectedExcludePresets: new Set(),
  formatOptions: [],
  selectedFormats: new Set(),
  formatFilterTouched: false,
  sizeFilterTouched: false,
  bounds: {
    maxWidth: 1000,
    maxHeight: 1000
  }
};

const RANGE_KEYS = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
const $ = (selector) => document.querySelector(selector);
const preview = $("#preview");
const message = $("#message");

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  bindTabEvents();
  await loadConfig();
  await scanImages();
}

function bindEvents() {
  $("#scanBtn").addEventListener("click", () => scanImages());
  $("#scrollBtn").addEventListener("click", () => scanImages({
    autoScroll: true,
    scrollDirection: $("#scrollDirectionSelect").value
  }));
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
  $("#zoomCloseBtn").addEventListener("click", closeZoomModal);
  $("#zoomModal").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeZoomModal();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeZoomModal();
  });

  for (const id of ["searchInput", "includeInput", "excludeInput", "domainInput", "layoutSelect", "sizeSelect", "sortSelect"]) {
    $(`#${id}`).addEventListener("input", render);
  }

  $("#sizeFilterEnabled").addEventListener("change", () => {
    state.sizeFilterTouched = true;
    updateSizeFilterDisabledState();
    render();
  });

  for (const key of RANGE_KEYS) {
    bindRangePair(key);
  }
}

chrome.runtime.onMessage.addListener((runtimeMessage, sender) => {
  if (runtimeMessage?.type === "DOWNLOAD_PROGRESS" && runtimeMessage.sessionId === state.activeSessionId) {
    const { completed, failed, rateLimited, total } = runtimeMessage.payload;
    setMessage(`下载中：成功 ${completed}/${total}，失败 ${failed}，429 ${rateLimited}`);
    return;
  }

  if (runtimeMessage?.type === "IMAGES_UPDATED" && sender?.tab?.id === state.activeTabId) {
    schedulePayloadApply(runtimeMessage.payload, sender.tab);
  }
});

function bindTabEvents() {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    scheduleScanForTab(tabId, "已切换标签页，正在重新扫描...");
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== state.activeTabId) return;
    if (changeInfo.status === "complete" || changeInfo.url) {
      scheduleScanForTab(tabId, "页面已更新，正在重新扫描...", tab);
    }
  });
}

function scheduleScanForTab(tabId, messageText, tabFromEvent = null) {
  clearTimeout(state.scheduledScan);
  state.scheduledScan = setTimeout(async () => {
    const tab = tabFromEvent || await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active || !/^https?:\/\//i.test(tab.url || "")) return;
    if (state.activeTabId === tab.id && state.activeTabUrl === tab.url && messageText.startsWith("页面已更新")) return;
    state.activeTabId = tab.id;
    state.activeTabUrl = tab.url || "";
    clearPreviewState();
    setMessage(messageText);
    await scanImages().catch((error) => setMessage(error.message));
  }, 350);
}

function schedulePayloadApply(payload, tab) {
  state.pendingPayload = { payload, tab };
  clearTimeout(state.scheduledPayloadApply);
  state.scheduledPayloadApply = setTimeout(() => {
    const pending = state.pendingPayload;
    state.pendingPayload = null;
    if (!pending) return;
    applyScanPayload(pending.payload, pending.tab, { preserveFilters: true }).catch((error) => setMessage(error.message));
  }, 320);
}

async function loadConfig() {
  const response = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
  if (!response.ok) throw new Error(response.error);
  state.config = response.config;
  updateDisplayModeButton();

  const previewConfig = response.config.preview || {};
  $("#searchInput").value = previewConfig.search || "";
  $("#includeInput").value = previewConfig.includeKeywords || "";
  $("#domainInput").value = previewConfig.domain || "";
  $("#layoutSelect").value = previewConfig.layout || "grid";
  $("#sizeSelect").value = previewConfig.size || "medium";
  $("#sortSelect").value = previewConfig.sortBy || "pageIndex";
  $("#scrollDirectionSelect").value = "down";

  const excludeKeywords = parseCommaList(previewConfig.excludeKeywords);
  state.selectedExcludePresets = new Set(excludeKeywords.filter((keyword) => state.excludePresetOptions.includes(keyword)));
  $("#excludeInput").value = excludeKeywords.filter((keyword) => !state.excludePresetOptions.includes(keyword)).join(",");

  const configuredSizeFilter = {
    enabled: Boolean(previewConfig.sizeFilteringEnabled),
    minWidth: Number(previewConfig.minWidth || 0),
    maxWidth: Number(previewConfig.maxWidth || 0),
    minHeight: Number(previewConfig.minHeight || 0),
    maxHeight: Number(previewConfig.maxHeight || 0)
  };
  applySizeFilterValues(configuredSizeFilter, { keepTouched: false });
  renderExcludePresetOptions();
  renderFormatOptions();
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

async function scanImages({ autoScroll = false, scrollDirection = "down" } = {}) {
  setMessage(autoScroll ? `正在向${directionLabel(scrollDirection)}滚动并扫描页面...` : "正在扫描当前页面...");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  state.activeTabId = tab.id;
  state.activeTabUrl = tab.url || "";
  await ensureContentScript(tab);
  const type = autoScroll ? "AUTO_SCROLL_SCAN" : "SCAN_IMAGES";
  const payload = await sendTabMessage(tab.id, { type, maxSteps: 12, direction: scrollDirection });
  if (payload?.error) throw new Error(payload.error);

  await applyScanPayload(payload, tab);
  setMessage(`扫描完成：${state.images.length} 张图片`);
}

async function applyScanPayload(payload, tab = {}, { preserveFilters = false } = {}) {
  if (!payload) return;
  const previousSelected = preserveFilters ? new Set(state.selected) : new Set();
  state.context = payload.context || {};
  state.images = (payload.images || []).map((image, index) => ({
    ...image,
    editedUrl: image.editedUrl || image.url,
    filename: state.config.download.singleUseSourceFilename && state.config.download.mode === "single"
      ? buildSourceFilename(image, index + 1, state.config.download)
      : buildFilename(image, payload.context || {}, index + 1, state.config.download)
  }));
  state.selected = previousSelected.size
    ? new Set(state.images.filter((image) => previousSelected.has(image.id)).map((image) => image.id))
    : new Set(state.images.map((image) => image.id));
  $("#pageContext").textContent = `${state.context.comic || state.context.pageTitle || tab.title || "当前页面"} · ${state.context.chapter || state.context.site || ""}`;

  syncDynamicFilters({ preserveFilters });
  await installPreviewAntiHotlinkRules();
  render();
}

function syncDynamicFilters({ preserveFilters } = {}) {
  syncFormatOptions({ preserveFilters });
  syncSizeBounds({ preserveFilters });
}

function render() {
  state.layout = $("#layoutSelect").value;
  state.size = $("#sizeSelect").value;

  const filters = {
    ...state.config.preview,
    search: $("#searchInput").value,
    includeKeywords: $("#includeInput").value,
    excludeKeywords: [...state.selectedExcludePresets, ...parseCommaList($("#excludeInput").value)],
    domain: $("#domainInput").value,
    formats: [...state.selectedFormats],
    sizeFilteringEnabled: $("#sizeFilterEnabled").checked,
    ...getSizeFilterValues()
  };

  state.visibleImages = sortImages(filterImages(state.images, filters), $("#sortSelect").value);
  $("#countLabel").textContent = `${state.visibleImages.length}/${state.images.length} images`;
  $("#selectionLabel").textContent = createSelectionSummary(
    [...state.selected].filter((id) => state.visibleImages.some((image) => image.id === id)).length,
    state.visibleImages.length
  );

  renderPreview(preview, state.visibleImages, {
    layout: state.layout,
    size: state.size,
    selected: state.selected,
    onSelectionChange: render,
    onUrlChange: handleImageUrlChange,
    onCopyUrl: copyImageUrl,
    onOpenUrl: openImageUrl,
    onZoom: openZoomModal
  });
  hydrateVisiblePreviews();
}

function handleImageUrlChange(imageId, value) {
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return;
  image.editedUrl = String(value || "").trim();
}

async function copyImageUrl(imageId) {
  const url = getEditableUrl(imageId);
  if (!url) {
    setMessage("没有可复制的图片地址。");
    return;
  }
  await navigator.clipboard.writeText(url);
  setMessage("已复制图片地址。");
}

async function openImageUrl(imageId) {
  const url = getEditableUrl(imageId);
  if (!url) {
    setMessage("图片地址为空，无法打开。");
    return;
  }
  const normalized = normalizeUrl(url);
  if (!normalized) {
    setMessage("图片地址格式无效，请检查后重试。");
    return;
  }
  await chrome.tabs.create({ url: normalized });
}

function openZoomModal(imageId) {
  const image = state.images.find((item) => item.id === imageId);
  if (!image) return;
  const zoomImage = $("#zoomImage");
  zoomImage.src = image.previewUrl || getEditableUrl(imageId) || image.url;
  zoomImage.alt = image.alt || image.filename || "zoomed-image";
  $("#zoomTitle").textContent = image.filename || "图片预览";
  $("#zoomModal").hidden = false;
}

function closeZoomModal() {
  const zoomModal = $("#zoomModal");
  if (zoomModal.hidden) return;
  zoomModal.hidden = true;
  $("#zoomImage").removeAttribute("src");
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

function clearPreviewState() {
  state.previewRunId += 1;
  state.images = [];
  state.visibleImages = [];
  state.selected.clear();
  state.formatOptions = [];
  state.selectedFormats = new Set();
  state.formatFilterTouched = false;
  state.sizeFilterTouched = false;
  preview.replaceChildren();
  $("#countLabel").textContent = "0 images";
  $("#selectionLabel").textContent = "0/0 selected";
  closeZoomModal();
  renderFormatOptions();
  clearPreviewAntiHotlinkRules();
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
    onSelectionChange: render,
    onUrlChange: handleImageUrlChange,
    onCopyUrl: copyImageUrl,
    onOpenUrl: openImageUrl,
    onZoom: openZoomModal
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

function renderExcludePresetOptions() {
  renderMultiSelectOptions({
    container: $("#excludePresetOptions"),
    selected: state.selectedExcludePresets,
    options: state.excludePresetOptions,
    emptyText: "没有可用预设关键词。",
    onToggle: (value, checked) => {
      if (checked) state.selectedExcludePresets.add(value);
      else state.selectedExcludePresets.delete(value);
      updateExcludePresetLabel();
      render();
    }
  });
  updateExcludePresetLabel();
}

function renderFormatOptions() {
  renderMultiSelectOptions({
    container: $("#formatOptions"),
    selected: state.selectedFormats,
    options: state.formatOptions,
    emptyText: "等待扫描图片后生成格式列表。",
    onToggle: (value, checked) => {
      state.formatFilterTouched = true;
      if (checked) state.selectedFormats.add(value);
      else state.selectedFormats.delete(value);
      updateFormatLabel();
      render();
    }
  });
  updateFormatLabel();
}

function renderMultiSelectOptions({ container, selected, options, emptyText, onToggle }) {
  container.replaceChildren();
  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = "multi-select-empty";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  for (const value of options) {
    const label = document.createElement("label");
    label.className = "multi-select-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(value);
    input.addEventListener("change", () => onToggle(value, input.checked));
    const text = document.createElement("span");
    text.textContent = value;
    label.append(input, text);
    container.append(label);
  }
}

function updateExcludePresetLabel() {
  const label = $("#excludePresetLabel");
  if (!state.selectedExcludePresets.size) {
    label.textContent = "未选择预设关键词";
    return;
  }
  label.textContent = [...state.selectedExcludePresets].join(", ");
}

function updateFormatLabel() {
  const label = $("#formatLabel");
  if (!state.formatOptions.length) {
    label.textContent = "等待扫描格式";
    return;
  }
  if (state.selectedFormats.size === state.formatOptions.length) {
    label.textContent = `全部格式 (${state.formatOptions.length})`;
    return;
  }
  if (!state.selectedFormats.size) {
    label.textContent = "未选择格式";
    return;
  }
  label.textContent = [...state.selectedFormats].join(", ");
}

function syncFormatOptions({ preserveFilters } = {}) {
  const nextOptions = [...new Set(
    state.images
      .map((image) => normalizeFormat(image.ext || image.format || "unknown"))
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));

  state.formatOptions = nextOptions;
  if (!preserveFilters || !state.formatFilterTouched) {
    state.selectedFormats = new Set(nextOptions);
  } else {
    state.selectedFormats = new Set(nextOptions.filter((format) => state.selectedFormats.has(format)));
    if (!state.selectedFormats.size) state.selectedFormats = new Set(nextOptions);
  }
  renderFormatOptions();
}

function syncSizeBounds({ preserveFilters } = {}) {
  const maxWidth = roundDimension(Math.max(...state.images.map((image) => Number(image.width || 0)), 1000));
  const maxHeight = roundDimension(Math.max(...state.images.map((image) => Number(image.height || 0)), 1000));
  state.bounds = { maxWidth, maxHeight };

  const defaultValues = preserveFilters && state.sizeFilterTouched
    ? getSizeFilterValues()
    : {
        enabled: Boolean(state.config?.preview?.sizeFilteringEnabled),
        minWidth: Number(state.config?.preview?.minWidth || 0),
        maxWidth: Number(state.config?.preview?.maxWidth || maxWidth || 0) || maxWidth,
        minHeight: Number(state.config?.preview?.minHeight || 0),
        maxHeight: Number(state.config?.preview?.maxHeight || maxHeight || 0) || maxHeight
      };

  applySizeFilterValues(defaultValues, { keepTouched: preserveFilters && state.sizeFilterTouched });
}

function bindRangePair(key) {
  const range = $(`#${key}Range`);
  const number = $(`#${key}Number`);
  const update = (source) => {
    state.sizeFilterTouched = true;
    const numeric = clampNumber(source.value, 0, Number(range.max || 0), 0);
    range.value = numeric;
    number.value = numeric;
    normalizeRangePairs(key);
    render();
  };
  range.addEventListener("input", () => update(range));
  number.addEventListener("input", () => update(number));
}

function applySizeFilterValues(values, { keepTouched } = {}) {
  $("#sizeFilterEnabled").checked = Boolean(values.enabled);
  setRangePair("minWidth", values.minWidth, state.bounds.maxWidth);
  setRangePair("maxWidth", values.maxWidth || state.bounds.maxWidth, state.bounds.maxWidth);
  setRangePair("minHeight", values.minHeight, state.bounds.maxHeight);
  setRangePair("maxHeight", values.maxHeight || state.bounds.maxHeight, state.bounds.maxHeight);
  normalizeRangePairs();
  if (!keepTouched) state.sizeFilterTouched = false;
  updateSizeFilterDisabledState();
}

function setRangePair(key, value, max) {
  const range = $(`#${key}Range`);
  const number = $(`#${key}Number`);
  const safeMax = Math.max(100, Number(max || 100));
  const safeValue = clampNumber(value, 0, safeMax, key.startsWith("max") ? safeMax : 0);
  range.max = safeMax;
  number.max = safeMax;
  range.value = safeValue;
  number.value = safeValue;
}

function normalizeRangePairs(changedKey = "") {
  const values = getSizeFilterValues();
  if (values.minWidth > values.maxWidth) {
    if (changedKey === "minWidth") setRangePair("maxWidth", values.minWidth, state.bounds.maxWidth);
    else setRangePair("minWidth", values.maxWidth, state.bounds.maxWidth);
  }
  if (values.minHeight > values.maxHeight) {
    if (changedKey === "minHeight") setRangePair("maxHeight", values.minHeight, state.bounds.maxHeight);
    else setRangePair("minHeight", values.maxHeight, state.bounds.maxHeight);
  }
}

function updateSizeFilterDisabledState() {
  const disabled = !$("#sizeFilterEnabled").checked;
  document.querySelector(".size-filter")?.toggleAttribute("data-disabled", disabled);
  for (const key of RANGE_KEYS) {
    $(`#${key}Range`).disabled = disabled;
    $(`#${key}Number`).disabled = disabled;
  }
}

function getSizeFilterValues() {
  return {
    minWidth: Number($("#minWidthNumber").value || 0),
    maxWidth: Number($("#maxWidthNumber").value || state.bounds.maxWidth),
    minHeight: Number($("#minHeightNumber").value || 0),
    maxHeight: Number($("#maxHeightNumber").value || state.bounds.maxHeight)
  };
}

function getEditableUrl(imageId) {
  const image = state.images.find((item) => item.id === imageId);
  return String(image?.editedUrl || image?.url || "").trim();
}

function parseCommaList(value = "") {
  return [...new Set(String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))];
}

function normalizeFormat(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    return "";
  }
}

function roundDimension(value) {
  return Math.max(1000, Math.ceil(Number(value || 0) / 50) * 50);
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function directionLabel(direction) {
  return ({
    down: "下",
    up: "上",
    left: "左",
    right: "右"
  }[direction] || "下");
}

window.addEventListener("unhandledrejection", (event) => setMessage(event.reason?.message || String(event.reason)));
window.addEventListener("error", (event) => setMessage(event.message));
window.addEventListener("pagehide", clearPreviewAntiHotlinkRules);
