import { TaskQueue } from "../core/task-queue.js";
import { buildFilename, buildMetadata, buildMetadataFilename, buildSourceFilename } from "./filename-builder.js";
import { fetchWithRetry } from "./retry-manager.js";
import { convertImageBlob } from "../preview/image-meta.js";

const downloadSessions = new Map();

export async function downloadSingleImages(images, context, config) {
  initSession(config.sessionId);
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
    finalizeSession(config.sessionId);
  }

  if (isDownloadSessionAborted(config.sessionId)) {
    throw new Error("下载已中止");
  }

  if (config.includeMetadata && results.length) {
    const metadata = buildMetadata(context, results.sort((a, b) => a.pageIndex - b.pageIndex));
    const downloadId = await chrome.downloads.download({
      url: jsonDataUrl(metadata),
      filename: buildMetadataFilename(context),
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
  const shouldMaterialize = shouldConvert || config.antiHotlink?.enabled || image.url.startsWith("blob:") || image.url.startsWith("data:");
  let filename = config.singleUseSourceFilename
    ? buildSourceFilename(image, index, config)
    : buildFilename(image, context, index, config);
  let url = image.url;
  let bytes = image.bytes || 0;
  let ext = image.ext;

  if (shouldMaterialize) {
    assertNotAborted(config.sessionId);
    const sourceBlob = await fetchImageBlob(image.url, config);
    assertNotAborted(config.sessionId);
    const converted = await convertImageBlob(sourceBlob, config.format, config.quality);
    url = await blobToDataUrl(converted.blob);
    ext = converted.ext;
    filename = config.singleUseSourceFilename
      ? buildSourceFilename(image, index, { ...config, ext })
      : buildFilename(image, context, index, { ...config, ext });
    bytes = converted.blob.size;
  }

  assertNotAborted(config.sessionId);
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: normalizeConflict(config.conflictAction),
    saveAs: false
  });
  registerDownloadId(config.sessionId, downloadId);

  return { ...image, pageIndex: index, filename, bytes, ext, downloadId };
}

export async function fetchImageBlob(url, config) {
  assertNotAborted(config.sessionId);
  if (config.antiHotlink?.enabled && config.tabId && !url.startsWith("data:")) {
    try {
      const response = await chrome.tabs.sendMessage(config.tabId, { type: "FETCH_IMAGE_BLOB", url });
      if (response?.ok && response.dataUrl) return await (await fetch(response.dataUrl)).blob();
      if (response?.status) throw createStatusError(response.status, response.error);
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      if (getErrorStatus(error) === 429) throw error;
      console.warn("[CIE:download] Page-context image fetch failed, fallback to background fetch.", error);
    }
  }
  const response = url.startsWith("data:") ? await fetch(url) : await fetchWithRetry(url, config);
  return response.blob();
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
  }).catch(() => {});
}

function initSession(sessionId) {
  if (!sessionId) return;
  if (downloadSessions.has(sessionId)) return;
  downloadSessions.set(sessionId, { aborted: false, downloadIds: new Set() });
}

function finalizeSession(sessionId) {
  if (!sessionId) return;
  downloadSessions.delete(sessionId);
}

function registerDownloadId(sessionId, downloadId) {
  if (!sessionId || !downloadId) return;
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  session.downloadIds.add(downloadId);
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
  return { ok: true, cancelled: ids.length };
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
