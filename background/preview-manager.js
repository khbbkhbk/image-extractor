import { TaskQueue } from "../core/task-queue.js";
import { fetchWithRetry } from "../download/retry-manager.js";
import { antiHotlinkManager } from "./anti-hotlink.js";

export class PreviewManager {
  async fetchPreviews({ images = [], context = {}, config = {}, limit = 24 } = {}) {
    const selected = images.slice(0, limit);
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
          const preview = await createPreviewDataUrl(blob, image.url);
          results.push({
            id: image.id,
            ok: true,
            previewUrl: preview.dataUrl,
            bytes: blob.size,
            type: preview.type
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

async function createPreviewDataUrl(blob, url) {
  if (!canConvertPreview(blob, url)) {
    return { dataUrl: await blobToDataUrl(blob), type: blob.type };
  }

  try {
    const bitmap = await createImageBitmap(blob);
    const maxSide = 640;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: true });
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const previewBlob = await canvas.convertToBlob({ type: "image/png" });
    return { dataUrl: await blobToDataUrl(previewBlob), type: previewBlob.type };
  } catch (error) {
    console.warn("[CIE:preview] Failed to convert preview image, fallback to original data URL.", error);
    return { dataUrl: await blobToDataUrl(blob), type: blob.type };
  }
}

function canConvertPreview(blob, url = "") {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") return false;
  const type = blob.type || "";
  if (/image\/(svg\+xml|gif)/i.test(type)) return false;
  if (/^image\//i.test(type)) return true;
  return /\.(avif|webp|png|jpe?g)(\?|#|$)/i.test(url);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

export const previewManager = new PreviewManager();
