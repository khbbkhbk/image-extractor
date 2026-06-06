import { TaskQueue } from "../core/task-queue.js";
import { buildFilename, buildMetadata, buildMetadataFilename, buildSourceFilename } from "./filename-builder.js";
import { fetchWithRetry } from "./retry-manager.js";
import { createOffscreenDownloadUrl, createOffscreenDownloadUrlFromRemote, revokeOffscreenDownloadUrl } from "./offscreen-download.js";
import { convertImageBlob } from "../preview/image-meta.js";

const downloadSessions = new Map();
const downloadBlobUrls = new Map();
const pendingFilenameSuggestions = [];
let downloadsListenerAttached = false;

export async function downloadSingleImages(images, context, config) {
  ensureDownloadSession(config.sessionId);
  const queue = new TaskQueue({ concurrency: config.concurrency });
  const results = [];
  const failures = [];
  const startGate = createIntervalGate(config.requestIntervalMs || 0);

  try {
    await Promise.all(images.map((image, itemIndex) => queue.add(async () => {
      assertNotAborted(config.sessionId);
      await startGate();
      assertNotAborted(config.sessionId);
      const index = itemIndex + 1;
      try {
        const downloaded = await downloadOne(image, context, index, config);
        results.push(downloaded);
        emitProgress(config, {
          completed: results.length,
          failed: failures.length,
          rateLimited: failures.filter((failure) => failure.status === 429).length,
          total: images.length
        });
      } catch (error) {
        failures.push(createFailure(image, index, error));
        emitProgress(config, {
          completed: results.length,
          failed: failures.length,
          rateLimited: failures.filter((failure) => failure.status === 429).length,
          total: images.length
        });
      }
    })));
  } finally {
    markSchedulingDoneInternal(config.sessionId);
  }

  if (isDownloadSessionAborted(config.sessionId)) {
    throw new Error("下载已中止");
  }

  if (config.includeMetadata && results.length) {
    const metadata = buildMetadata(context, results.sort((a, b) => a.pageIndex - b.pageIndex));
    const metadataUrl = jsonDataUrl(metadata);
    const metadataFilename = buildMetadataFilename(context);
    registerPendingFilenameSuggestion(metadataUrl, metadataFilename, config.conflictAction);
    const downloadId = await chrome.downloads.download({
      url: metadataUrl,
      filename: metadataFilename,
      conflictAction: normalizeConflict(config.conflictAction),
      saveAs: false
    });
    registerDownloadId(config.sessionId, downloadId);
  }

  const rateLimitedImages = failures.filter((failure) => failure.status === 429).map((failure) => failure.image);
  return {
    mode: "single",
    count: results.length,
    requestedCount: images.length,
    failedCount: failures.length,
    rateLimitedCount: rateLimitedImages.length,
    rateLimitedImages,
    failures,
    results
  };
}

async function downloadOne(image, context, index, config) {
  assertNotAborted(config.sessionId);
  const shouldConvert = config.format && config.format !== "original";
  const url = image.url || "";
  const supportsDirectDownload = /^https?:\/\//i.test(url);
  const shouldUseOffscreenRemoteFetch = !shouldConvert && supportsDirectDownload && config.antiHotlink?.enabled;
  const shouldMaterialize = shouldConvert || !supportsDirectDownload || url.startsWith("blob:") || url.startsWith("data:");
  let filename = config.singleUseSourceFilename
    ? buildSourceFilename(image, index, config)
    : buildFilename(image, context, index, config);
  let downloadUrl = url;
  let temporaryBlobUrl = "";
  let bytes = image.bytes || 0;
  let ext = image.ext;
  console.info("[CIE:download] Single image:", {
    index,
    url: image.url,
    originalUrl: image.originalUrl,
    editedUrl: image.editedUrl,
    filename,
    singleUseSourceFilename: Boolean(config.singleUseSourceFilename),
    shouldMaterialize: Boolean(shouldMaterialize)
  });

  if (shouldMaterialize) {
    assertNotAborted(config.sessionId);
    const sourceBlob = await fetchImageBlob(image.url, config);
    assertNotAborted(config.sessionId);
    const converted = await convertImageBlob(sourceBlob, config.format, config.quality);
    downloadUrl = await createOffscreenDownloadUrl(converted.blob);
    temporaryBlobUrl = downloadUrl;
    ext = converted.ext;
    filename = config.singleUseSourceFilename
      ? buildSourceFilename(image, index, { ...config, ext })
      : buildFilename(image, context, index, { ...config, ext });
    bytes = converted.blob.size;
  } else if (shouldUseOffscreenRemoteFetch) {
    downloadUrl = await createOffscreenDownloadUrlFromRemote(url);
    temporaryBlobUrl = downloadUrl;
  }

  assertNotAborted(config.sessionId);
  console.info("[CIE:download] Final download payload:", {
    index,
    downloadUrl,
    filename,
    ext,
    shouldMaterialize: Boolean(shouldMaterialize),
    singleUseSourceFilename: Boolean(config.singleUseSourceFilename),
    format: config.format || "original"
  });
  registerPendingFilenameSuggestion(downloadUrl, filename, config.conflictAction);
  let downloadId = 0;
  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      conflictAction: normalizeConflict(config.conflictAction),
      saveAs: false
    });
  } catch (error) {
    if (temporaryBlobUrl) await revokeOffscreenDownloadUrl(temporaryBlobUrl);
    throw error;
  }
  registerDownloadId(config.sessionId, downloadId, temporaryBlobUrl);

  return { ...image, pageIndex: index, filename, bytes, ext, downloadId };
}

export async function fetchImageBlob(url, config) {
  assertNotAborted(config.sessionId);
  if (url.startsWith("data:")) {
    const response = await fetch(url);
    return response.blob();
  }

  const requiresPageContextFetch = url.startsWith("blob:");
  if (!requiresPageContextFetch) {
    try {
      const response = await fetchWithRetry(url, config);
      return response.blob();
    } catch (error) {
      if (!config.antiHotlink?.enabled || !config.tabId) throw error;
      if (getErrorStatus(error) === 429) throw error;
      console.warn("[CIE:download] Background image fetch failed, fallback to page-context fetch.", error);
    }
  }

  if (config.tabId) {
    try {
      const response = await chrome.tabs.sendMessage(config.tabId, { type: "FETCH_IMAGE_BLOB", url });
      if (response?.ok && response.dataUrl) return await (await fetch(response.dataUrl)).blob();
      if (response?.status) throw createStatusError(response.status, response.error);
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      const message = String(error?.message || error || "");
      if (/quota exceeded/i.test(message)) {
        throw new Error("页面上下文取图时触发浏览器配额限制。建议关闭防盗链后重试，或改用 ZIP 模式、减少单次下载数量。");
      }
      throw error;
    }
  }

  throw new Error("当前图片需要页面上下文取图，但未获取到可用标签页上下文。");
}

function createIntervalGate(intervalMs) {
  let nextStartAt = 0;
  let chain = Promise.resolve();
  return () => {
    chain = chain.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, nextStartAt - now);
      nextStartAt = Math.max(now, nextStartAt) + intervalMs;
      if (waitMs > 0) await delay(waitMs);
    });
    return chain;
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFailure(image, index, error) {
  return {
    image,
    index,
    url: image.url,
    status: getErrorStatus(error),
    message: error?.message || String(error)
  };
}

function getErrorStatus(error) {
  if (Number.isFinite(error?.status)) return Number(error.status);
  const match = String(error?.message || error).match(/\bHTTP\s+(\d{3})\b/);
  return match ? Number(match[1]) : 0;
}

function createStatusError(status, message = "") {
  const error = new Error(message || `HTTP ${status}`);
  error.status = Number(status);
  return error;
}

function emitProgress(config, payload) {
  if (!config.sessionId) return;
  chrome.runtime.sendMessage({
    type: "DOWNLOAD_PROGRESS",
    sessionId: config.sessionId,
    payload
  }).catch(() => { });
}

function initSession(sessionId) {
  if (!sessionId) return;
  if (downloadSessions.has(sessionId)) return;
  attachDownloadsListener();
  downloadSessions.set(sessionId, {
    aborted: false,
    schedulingDone: false,
    downloadIds: new Set(),
    completedIds: new Set(),
    cleanupTimer: 0
  });
  sendSessionStatus(sessionId);
}

function markSchedulingDoneInternal(sessionId) {
  if (!sessionId) return;
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  session.schedulingDone = true;
  sendSessionStatus(sessionId);
  scheduleSessionCleanup(sessionId, 10 * 60 * 1000);
}

function registerDownloadId(sessionId, downloadId, temporaryBlobUrl = "") {
  if (!downloadId) {
    if (temporaryBlobUrl) revokeOffscreenDownloadUrl(temporaryBlobUrl).catch(() => { });
    return;
  }
  if (temporaryBlobUrl) downloadBlobUrls.set(downloadId, temporaryBlobUrl);
  if (!sessionId) return;
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  session.downloadIds.add(downloadId);
  sendSessionStatus(sessionId);
}

export function isDownloadSessionAborted(sessionId) {
  if (!sessionId) return false;
  return Boolean(downloadSessions.get(sessionId)?.aborted);
}

function assertNotAborted(sessionId) {
  if (!sessionId) return;
  if (downloadSessions.get(sessionId)?.aborted) throw new Error("下载已中止");
}

export async function abortDownloadSession(sessionId) {
  if (!sessionId) return { ok: false, message: "No session id" };
  const session = downloadSessions.get(sessionId);
  if (!session) return { ok: false, message: "No active session" };
  session.aborted = true;
  const ids = [...session.downloadIds];
  await Promise.allSettled(ids.map((id) => chrome.downloads.cancel(id)));
  sendSessionStatus(sessionId, { state: "aborted" });
  scheduleSessionCleanup(sessionId, 2 * 60 * 1000);
  return { ok: true, cancelled: ids.length };
}

export function ensureDownloadSession(sessionId) {
  initSession(sessionId);
}

export function registerDownloadIdForSession(sessionId, downloadId, temporaryBlobUrl = "") {
  registerDownloadId(sessionId, downloadId, temporaryBlobUrl);
}

export function markDownloadSessionSchedulingDone(sessionId) {
  markSchedulingDoneInternal(sessionId);
}

export function registerPendingFilenameSuggestion(url, filename, conflictAction = "uniquify") {
  if (!url || !filename) return;
  pendingFilenameSuggestions.push({
    url,
    filename,
    conflictAction: normalizeConflict(conflictAction),
    createdAt: Date.now()
  });
  prunePendingFilenameSuggestions();
}

function attachDownloadsListener() {
  if (downloadsListenerAttached) return;
  downloadsListenerAttached = true;
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const matchIndex = pendingFilenameSuggestions.findIndex((entry) => entry.url === item.url);
    if (matchIndex < 0) {
      suggest();
      return;
    }
    const [entry] = pendingFilenameSuggestions.splice(matchIndex, 1);
    suggest({
      filename: entry.filename,
      conflictAction: entry.conflictAction
    });
  });
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta?.id || !delta?.state?.current) return;
    const state = delta.state.current;
    if (state !== "complete" && state !== "interrupted") return;
    cleanupDownloadBlobUrl(delta.id);
    for (const [sessionId, session] of downloadSessions.entries()) {
      if (!session.downloadIds.has(delta.id)) continue;
      session.completedIds.add(delta.id);
      sendSessionStatus(sessionId);
      if (session.schedulingDone && session.completedIds.size >= session.downloadIds.size) {
        sendSessionStatus(sessionId, { state: session.aborted ? "aborted" : "finished" });
        clearTimeout(session.cleanupTimer);
        downloadSessions.delete(sessionId);
      }
    }
  });
}

function cleanupDownloadBlobUrl(downloadId) {
  const url = downloadBlobUrls.get(downloadId);
  if (!url) return;
  downloadBlobUrls.delete(downloadId);
  revokeOffscreenDownloadUrl(url).catch(() => { });
}

function prunePendingFilenameSuggestions() {
  const expireBefore = Date.now() - 5 * 60 * 1000;
  for (let index = pendingFilenameSuggestions.length - 1; index >= 0; index -= 1) {
    if (pendingFilenameSuggestions[index].createdAt < expireBefore) pendingFilenameSuggestions.splice(index, 1);
  }
}

function scheduleSessionCleanup(sessionId, delayMs) {
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    downloadSessions.delete(sessionId);
  }, Math.max(10_000, Number(delayMs) || 60_000));
}

function sendSessionStatus(sessionId, override = {}) {
  if (!sessionId) return;
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  const total = session.downloadIds.size;
  const completed = session.completedIds.size;
  const active = Math.max(0, total - completed);
  chrome.runtime.sendMessage({
    type: "DOWNLOAD_SESSION_STATUS",
    sessionId,
    payload: {
      active,
      total,
      completed,
      schedulingDone: session.schedulingDone,
      aborted: session.aborted,
      state: session.aborted ? "aborted" : (session.schedulingDone && active === 0 ? "finished" : "active"),
      ...override
    }
  }).catch(() => { });
}

export function normalizeConflict(conflictAction = "uniquify") {
  if (["uniquify", "overwrite", "prompt"].includes(conflictAction)) return conflictAction;
  return "uniquify";
}

export function jsonDataUrl(value) {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value, null, 2))}`;
}

export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

export async function blobToDownloadDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}
