import { TaskQueue } from "../core/task-queue.js";
import { getCapturedImage, putTempBlob } from "../download/blob-store.js";
import { fetchWithRetry } from "../download/retry-manager.js";
import { antiHotlinkManager } from "./anti-hotlink.js";

export class PreviewManager {
  async fetchPreviews({ images = [], context = {}, config = {}, limit = 24, tabId = 0 } = {}) {
    const selected = images
      .slice(0, limit)
      .map(normalizePreviewImage)
      .filter((image) => image?.id && image?.url);
    const queue = new TaskQueue({ concurrency: 4 });
    const results = [];

    await antiHotlinkManager.withRules(selected, context, config, async () => {
      await Promise.all(selected.map((image) => queue.add(async () => {
        try {
          const blob = await loadPreviewSource(image.url, tabId);
          const previewBlob = await createPreviewBlob(blob);
          const blobKey = `preview:${Date.now()}:${crypto.randomUUID()}`;
          await putTempBlob(blobKey, previewBlob);
          results.push({
            id: image.id,
            ok: true,
            blobKey,
            bytes: blob.size
          });
        } catch (error) {
          results.push({
            id: image.id,
            ok: false,
            error: error.message || String(error),
            status: error.status || 0
          });
        }
      })));
    });

    return { results };
  }
}

async function loadPreviewSource(url, tabId) {
  if (url.startsWith("blob:")) {
    const stored = await getCapturedImage(url).catch(() => null);
    if (stored) return stored;
    if (!tabId) throw new Error("该图片位于页面上下文中，缺少标签页信息，无法生成预览");
    return capturePageImagePreview(tabId, url);
  }
  const response = url.startsWith("data:") ? await fetch(url) : await fetchWithRetry(url, {
    retries: 1,
    timeoutMs: 15000
  });
  return response.blob();
}

// blob: 图片只能在页面内读取，由内容脚本截取已解码的图片并缩成小尺寸预览
async function capturePageImagePreview(tabId, url) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "CAPTURE_RENDERED_IMAGE",
    url,
    options: { maxEdge: 960, type: "image/webp", quality: 0.82 }
  });
  if (!response?.ok || !response.dataUrl) {
    throw new Error(response?.error || "页面预览截取失败");
  }
  const dataResponse = await fetch(response.dataUrl);
  return dataResponse.blob();
}

function normalizePreviewImage(image) {
  if (!image) return null;
  return {
    id: image.id || "",
    url: String(image.url || "").trim()
  };
}

async function createPreviewBlob(blob) {
  const resized = await resizePreviewBlob(blob).catch(() => null);
  return resized || blob;
}

async function resizePreviewBlob(blob) {
  if (!blob || !/^image\//i.test(blob.type || "")) return null;
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  const bitmap = await createImageBitmap(blob);
  try {
    const longestEdge = Math.max(bitmap.width || 0, bitmap.height || 0);
    if (!longestEdge) return null;
    const maxEdge = 960;
    const scale = Math.min(1, maxEdge / longestEdge);
    if (scale >= 1 && blob.size <= 360 * 1024) return null;
    const width = Math.max(1, Math.round((bitmap.width || 1) * scale));
    const height = Math.max(1, Math.round((bitmap.height || 1) * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const type = pickPreviewBlobType(blob.type || "");
    const resizedBlob = await canvas.convertToBlob({
      type,
      quality: type === "image/png" ? undefined : 0.82
    });
    return resizedBlob.size < blob.size ? resizedBlob : null;
  } finally {
    bitmap.close?.();
  }
}

function pickPreviewBlobType(type) {
  const normalizedType = String(type || "").toLowerCase();
  if (normalizedType === "image/png") return "image/png";
  if (normalizedType === "image/webp") return "image/webp";
  if (normalizedType === "image/jpeg" || normalizedType === "image/jpg") return "image/jpeg";
  return "image/webp";
}

export const previewManager = new PreviewManager();
