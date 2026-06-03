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
  return { dataUrl: await blobToDataUrl(blob), type: blob.type || "" };
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
