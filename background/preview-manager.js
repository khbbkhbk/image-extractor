import { TaskQueue } from "../core/task-queue.js";
import { putTempBlob } from "../download/blob-store.js";
import { fetchWithRetry } from "../download/retry-manager.js";
import { antiHotlinkManager } from "./anti-hotlink.js";

export class PreviewManager {
  async fetchPreviews({ images = [], context = {}, config = {}, limit = 24 } = {}) {
    const selected = images
      .slice(0, limit)
      .map(normalizePreviewImage)
      .filter((image) => image?.id && image?.url);
    const queue = new TaskQueue({ concurrency: 4 });
    const results = [];

    await antiHotlinkManager.withRules(selected, context, config, async () => {
      await Promise.all(selected.map((image) => queue.add(async () => {
        try {
          const response = image.url.startsWith("data:") ? await fetch(image.url) : await fetchWithRetry(image.url, {
            retries: 1,
            timeoutMs: 15000
          });
          const blob = await response.blob();
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
