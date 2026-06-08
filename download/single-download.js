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
        const failureSummary = summarizeFailures(failures);
        emitProgress(config, {
          completed: results.length,
          failed: failures.length,
          rateLimited: failureSummary.rateLimitedCount,
          timedOut: failureSummary.timeoutCount,
          total: images.length
        });
      } catch (error) {
        const failure = createFailure(image, index, error);
        logDownloadFailure("single-image", error, {
          index,
          image,
          failure
        });
        failures.push(failure);
        const failureSummary = summarizeFailures(failures);
        emitProgress(config, {
          completed: results.length,
          failed: failures.length,
          rateLimited: failureSummary.rateLimitedCount,
          timedOut: failureSummary.timeoutCount,
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
    let downloadId = 0;
    try {
      downloadId = await chrome.downloads.download({
        url: metadataUrl,
        filename: metadataFilename,
        conflictAction: normalizeConflict(config.conflictAction),
        saveAs: false
      });
    } catch (error) {
      logDownloadFailure("metadata-submit", error, {
        filename: metadataFilename,
        url: metadataUrl
      });
      throw error;
    }
    registerDownloadId(config.sessionId, downloadId, "", {
      kind: "metadata",
      filename: metadataFilename
    });
  }

  setSessionPreSubmitFailures(config.sessionId, failures);
  const failureSummary = summarizeFailures(failures);
  return {
    mode: "single",
    count: results.length,
    requestedCount: images.length,
    failedCount: failures.length,
    rateLimitedCount: failureSummary.rateLimitedCount,
    rateLimitedImages: failureSummary.rateLimitedImages,
    timeoutCount: failureSummary.timeoutCount,
    timeoutImages: failureSummary.timeoutImages,
    transientNetworkCount: failureSummary.transientNetworkCount,
    interruptedTransientCount: failureSummary.interruptedTransientCount,
    autoRetryCount: failureSummary.autoRetryCount,
    autoRetryImages: failureSummary.autoRetryImages,
    manualRetryCount: failureSummary.manualRetryCount,
    manualRetryImages: failureSummary.manualRetryImages,
    promptOnlyCount: failureSummary.promptOnlyCount,
    promptOnlyMessages: failureSummary.promptOnlyMessages,
    autoRetryLabels: failureSummary.autoRetryLabels,
    manualRetryLabels: failureSummary.manualRetryLabels,
    failures: failures.map(createFailureResponseSummary),
    results: results.map(createDownloadResponseSummary)
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
    let converted;
    try {
      converted = await convertImageBlob(sourceBlob, config.format, config.quality);
    } catch (error) {
      const conversionError = new Error(`格式转换失败：${error?.message || error}`);
      conversionError.code = "FORMAT_CONVERSION_ERROR";
      throw conversionError;
    }
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
    logDownloadFailure("single-submit", error, {
      index,
      image,
      downloadUrl,
      filename
    });
    throw error;
  }
  registerDownloadId(config.sessionId, downloadId, temporaryBlobUrl, {
    kind: "image",
    image,
    index,
    filename
  });

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

export function logDownloadFailure(stage, error, extra = {}) {
  const failure = extra.failure || createFailure(extra.image || null, extra.index || 0, error);
  console.error("[CIE:download] Failure:", {
    stage,
    kind: failure.kind,
    retryPolicy: failure.retryPolicy,
    label: failure.label,
    code: failure.code,
    status: failure.status,
    message: failure.message,
    index: extra.index || failure.index || 0,
    url: extra.url || failure.url || extra.image?.url || "",
    filename: extra.filename || extra.image?.filename || "",
    downloadUrl: extra.downloadUrl || "",
    interruptReason: extra.interruptReason || "",
    image: extra.image || failure.image || null
  }, error);
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
  const descriptor = classifyFailure(error);
  const normalizedImage = createTransferImage(image);
  return {
    image: normalizedImage,
    images: normalizedImage ? [normalizedImage] : [],
    index,
    url: normalizedImage?.url || "",
    status: getErrorStatus(error),
    kind: descriptor.kind,
    retryPolicy: descriptor.retryPolicy,
    label: descriptor.label,
    code: descriptor.code || "",
    message: error?.message || String(error)
  };
}

function createTransferImage(image) {
  if (!image) return null;
  return {
    id: image.id || "",
    url: String(image.url || "").trim(),
    originalUrl: String(image.originalUrl || image.url || "").trim(),
    editedUrl: String(image.editedUrl || image.url || "").trim(),
    ext: image.ext || "",
    width: Number(image.width || 0) || 0,
    height: Number(image.height || 0) || 0,
    naturalWidth: Number(image.naturalWidth || 0) || 0,
    naturalHeight: Number(image.naturalHeight || 0) || 0,
    bytes: Number(image.bytes || 0) || 0,
    alt: image.alt || "",
    title: image.title || "",
    source: image.source || "",
    node: image.node || "",
    hash: image.hash || "",
    site: image.site || ""
  };
}

function createDownloadResponseSummary(result) {
  return {
    id: result?.id || "",
    url: String(result?.url || "").trim(),
    originalUrl: String(result?.originalUrl || result?.url || "").trim(),
    filename: result?.filename || "",
    ext: result?.ext || "",
    bytes: Number(result?.bytes || 0) || 0,
    pageIndex: Number(result?.pageIndex || 0) || 0,
    downloadId: Number(result?.downloadId || 0) || 0
  };
}

function createFailureResponseSummary(failure) {
  return {
    index: Number(failure?.index || 0) || 0,
    url: String(failure?.url || "").trim(),
    status: Number(failure?.status || 0) || 0,
    kind: failure?.kind || "",
    retryPolicy: failure?.retryPolicy || "",
    label: failure?.label || "",
    code: failure?.code || "",
    message: failure?.message || "",
    image: createTransferImage(failure?.image),
    images: Array.isArray(failure?.images) ? failure.images.map(createTransferImage).filter(Boolean) : []
  };
}

function summarizeFailures(failures) {
  const rateLimitedFailures = failures.filter((failure) => failure.kind === "rate-limited");
  const timeoutFailures = failures.filter((failure) => failure.kind === "timeout");
  const transientNetworkFailures = failures.filter((failure) => failure.kind === "network-transient");
  const interruptedTransientFailures = failures.filter((failure) => failure.kind === "download-interrupted-temporary");
  const autoRetryFailures = failures.filter((failure) => failure.retryPolicy === "auto");
  const manualRetryFailures = failures.filter((failure) => failure.retryPolicy === "manual");
  const promptOnlyFailures = failures.filter((failure) => failure.retryPolicy === "none");
  return {
    rateLimitedCount: rateLimitedFailures.length,
    rateLimitedImages: uniqueFailureImages(rateLimitedFailures),
    timeoutCount: timeoutFailures.length,
    timeoutImages: uniqueFailureImages(timeoutFailures),
    transientNetworkCount: transientNetworkFailures.length,
    interruptedTransientCount: interruptedTransientFailures.length,
    autoRetryCount: autoRetryFailures.length,
    autoRetryImages: uniqueFailureImages(autoRetryFailures),
    manualRetryCount: manualRetryFailures.length,
    manualRetryImages: uniqueFailureImages(manualRetryFailures),
    promptOnlyCount: promptOnlyFailures.length,
    promptOnlyMessages: uniqueFailureMessages(promptOnlyFailures),
    autoRetryLabels: uniqueFailureLabels(autoRetryFailures),
    manualRetryLabels: uniqueFailureLabels(manualRetryFailures)
  };
}

function getErrorStatus(error) {
  if (Number.isFinite(error?.status)) return Number(error.status);
  const match = String(error?.message || error).match(/\bHTTP\s+(\d{3})\b/);
  return match ? Number(match[1]) : 0;
}

function classifyFailure(error) {
  const status = getErrorStatus(error);
  const message = String(error?.message || error || "");
  if (status === 429) {
    return { kind: "rate-limited", retryPolicy: "auto", label: "429", code: "HTTP_429" };
  }
  if (isTimeoutError(error)) {
    return { kind: "timeout", retryPolicy: "auto", label: "超时", code: "TIMEOUT" };
  }
  if (isTransientNetworkError(error)) {
    return { kind: "network-transient", retryPolicy: "auto", label: "网络波动", code: "NETWORK_TRANSIENT" };
  }
  if (status === 403) {
    return { kind: "http-403", retryPolicy: "manual", label: "403", code: "HTTP_403" };
  }
  if (status === 404) {
    return { kind: "http-404", retryPolicy: "manual", label: "404", code: "HTTP_404" };
  }
  if (isFilenameError(message)) {
    return { kind: "filename", retryPolicy: "manual", label: "命名异常", code: "FILENAME_ERROR" };
  }
  if (isFormatConversionError(error)) {
    return { kind: "format-conversion", retryPolicy: "manual", label: "格式转换失败", code: "FORMAT_CONVERSION_ERROR" };
  }
  if (isInvalidParameterError(error)) {
    return { kind: "invalid-params", retryPolicy: "none", label: "参数错误", code: "INVALID_PARAMS" };
  }
  return { kind: "other", retryPolicy: "manual", label: "其他失败", code: "OTHER" };
}

function isTimeoutError(error) {
  const status = getErrorStatus(error);
  if (status === 408 || status === 504) return true;
  const message = String(error?.message || error || "");
  return /\b(ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|NETWORK_TIMEOUT)\b/i.test(message)
    || /\b(connection timed out|request timed out|timed out|timeout after \d+ms)\b/i.test(message);
}

function isTransientNetworkError(error) {
  const message = String(error?.message || error || "");
  return /\b(ERR_(NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_(RESET|ABORTED|CLOSED)|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|NETWORK_IO_SUSPENDED))\b/i.test(message)
    || /\b(network changed|internet disconnected|connection reset|connection aborted|connection closed|dns lookup failed|network error)\b/i.test(message);
}

function isFilenameError(message) {
  return /\b(invalid filename|filename.*(invalid|too long)|path too long|file name too long)\b/i.test(message)
    || /(文件名异常|命名异常|命名模板|文件名过长)/.test(message);
}

function isFormatConversionError(error) {
  const message = String(error?.message || error || "");
  return error?.code === "FORMAT_CONVERSION_ERROR"
    || /\b(createImageBitmap|convertToBlob|OffscreenCanvas|canvas conversion|image decode)\b/i.test(message)
    || /(格式转换失败|图像转换失败|图片解码失败)/.test(message);
}

function isInvalidParameterError(error) {
  const message = String(error?.message || error || "");
  return /\b(No images selected|No active tab)\b/i.test(message)
    || /(图片地址格式无效|远程下载地址必须是 HTTP 或 HTTPS|当前图片需要页面上下文取图，但未获取到可用标签页上下文|当前页面不支持内容脚本|下载内容必须是 Blob|参数错误)/.test(message);
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
    preSubmitFailures: [],
    runtimeFailures: [],
    downloadMeta: new Map(),
    interruptedIds: new Set(),
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

function registerDownloadId(sessionId, downloadId, temporaryBlobUrl = "", meta = null) {
  if (!downloadId) {
    if (temporaryBlobUrl) revokeOffscreenDownloadUrl(temporaryBlobUrl).catch(() => { });
    return;
  }
  if (temporaryBlobUrl) downloadBlobUrls.set(downloadId, temporaryBlobUrl);
  if (!sessionId) return;
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  session.downloadIds.add(downloadId);
  if (meta) session.downloadMeta.set(downloadId, meta);
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

export function registerDownloadIdForSession(sessionId, downloadId, temporaryBlobUrl = "", meta = null) {
  registerDownloadId(sessionId, downloadId, temporaryBlobUrl, meta);
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

function setSessionPreSubmitFailures(sessionId, failures) {
  if (!sessionId) return;
  const session = downloadSessions.get(sessionId);
  if (!session) return;
  session.preSubmitFailures = Array.isArray(failures) ? [...failures] : [];
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
      if (state === "interrupted" && !session.interruptedIds.has(delta.id)) {
        const failure = createInterruptedFailure(session.downloadMeta.get(delta.id), delta.error?.current);
        if (failure) {
          logDownloadFailure("downloads-interrupted", new Error(failure.message), {
            failure,
            index: failure.index,
            image: failure.image,
            url: failure.url,
            interruptReason: delta.error?.current || ""
          });
          session.runtimeFailures.push(failure);
        }
        session.interruptedIds.add(delta.id);
        sendSessionStatus(sessionId, { failureSummary: summarizeSessionFailures(session) });
      }
      session.completedIds.add(delta.id);
      sendSessionStatus(sessionId);
      if (session.schedulingDone && session.completedIds.size >= session.downloadIds.size) {
        sendSessionStatus(sessionId, {
          state: session.aborted ? "aborted" : "finished",
          failureSummary: summarizeSessionFailures(session)
        });
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
      failureSummary: override.failureSummary,
      ...override
    }
  }).catch(() => { });
}

function summarizeSessionFailures(session) {
  return summarizeFailures([
    ...(session?.preSubmitFailures || []),
    ...(session?.runtimeFailures || [])
  ]);
}

function createInterruptedFailure(meta, interruptReason = "") {
  const descriptor = classifyInterruptedDownload(meta, interruptReason);
  if (!descriptor) return null;
  return {
    image: descriptor.images[0] || null,
    images: descriptor.images,
    index: meta?.index || 0,
    url: descriptor.images[0]?.url || "",
    status: 0,
    kind: descriptor.kind,
    retryPolicy: descriptor.retryPolicy,
    label: descriptor.label,
    code: descriptor.code,
    message: descriptor.message
  };
}

function classifyInterruptedDownload(meta, interruptReason = "") {
  const reason = String(interruptReason || "").trim().toUpperCase();
  const images = meta?.kind === "archive"
    ? Array.isArray(meta.images) ? meta.images : []
    : meta?.kind === "image" && meta.image ? [meta.image] : [];
  if (meta?.kind === "metadata") {
    return {
      kind: "metadata-interrupted",
      retryPolicy: "none",
      label: "metadata 下载失败",
      code: reason || "METADATA_INTERRUPTED",
      images: [],
      message: `metadata 下载被浏览器中断${reason ? `（${reason}）` : ""}，请手动检查下载目录后按需重新导出。`
    };
  }
  if (/^(NETWORK_(FAILED|TIMEOUT|DISCONNECTED)|SERVER_(FAILED|UNREACHABLE)|FILE_TRANSIENT_ERROR)$/.test(reason)) {
    return {
      kind: "download-interrupted-temporary",
      retryPolicy: "auto",
      label: "浏览器中断",
      code: reason || "DOWNLOAD_INTERRUPTED_TEMPORARY",
      images,
      message: `浏览器下载阶段被临时中断${reason ? `（${reason}）` : ""}。`
    };
  }
  if (/^(SERVER_FORBIDDEN|SERVER_UNAUTHORIZED)$/.test(reason)) {
    return {
      kind: "download-interrupted-auth",
      retryPolicy: "manual",
      label: reason === "SERVER_FORBIDDEN" ? "403" : "鉴权失败",
      code: reason,
      images,
      message: `浏览器下载阶段被服务端拒绝${reason ? `（${reason}）` : ""}。`
    };
  }
  if (/^(FILE_NAME_TOO_LONG|FILE_TOO_LARGE)$/.test(reason)) {
    return {
      kind: "filename",
      retryPolicy: "manual",
      label: "命名异常",
      code: reason,
      images,
      message: `浏览器下载阶段因文件名或路径问题被中断${reason ? `（${reason}）` : ""}。`
    };
  }
  if (/^(NETWORK_INVALID_REQUEST|USER_CANCELED)$/.test(reason)) {
    return {
      kind: "invalid-params",
      retryPolicy: "none",
      label: "参数错误",
      code: reason,
      images: [],
      message: reason === "USER_CANCELED"
        ? "浏览器侧已取消下载，本次不自动重试。"
        : `浏览器下载请求参数无效${reason ? `（${reason}）` : ""}，请检查地址、命名模板或下载配置。`
    };
  }
  return {
    kind: "download-interrupted-other",
    retryPolicy: "manual",
    label: "浏览器中断",
    code: reason || "DOWNLOAD_INTERRUPTED",
    images,
    message: `浏览器下载阶段被中断${reason ? `（${reason}）` : ""}。`
  };
}

function uniqueFailureImages(failures) {
  const unique = new Map();
  for (const failure of failures) {
    const images = Array.isArray(failure?.images)
      ? failure.images
      : failure?.image ? [failure.image] : [];
    for (const image of images) {
      if (!image) continue;
      const key = image.id || image.url || image.originalUrl || JSON.stringify(image);
      if (!unique.has(key)) unique.set(key, image);
    }
  }
  return [...unique.values()];
}

function uniqueFailureMessages(failures) {
  return [...new Set(
    failures
      .map((failure) => String(failure?.message || "").trim())
      .filter(Boolean)
  )];
}

function uniqueFailureLabels(failures) {
  return [...new Set(
    failures
      .map((failure) => String(failure?.label || "").trim())
      .filter(Boolean)
  )];
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
