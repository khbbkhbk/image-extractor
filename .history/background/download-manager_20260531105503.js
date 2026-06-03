import { configManager } from "../core/config-manager.js";
import { downloadSingleImages } from "../download/single-download.js";
import { downloadZip } from "../download/zip-download.js";
import { addHistory } from "../storage/history.js";
import { antiHotlinkManager } from "./anti-hotlink.js";

export class DownloadManager {
  async download({ images = [], context = {}, options = {}, tabId = 0 } = {}) {
    if (!Array.isArray(images) || images.length === 0) throw new Error("No images selected");
    const savedConfig = await configManager.getConfig();
    const config = {
      ...savedConfig.download,
      ...options,
      antiHotlink: {
        ...(savedConfig.download.antiHotlink || {}),
        ...(options.antiHotlink || {})
      },
      hotlinkReferer: context.sourceUrl || context.url || ""
    };
    if (tabId) config.tabId = tabId;
    const mode = this.resolveMode(config.mode, images.length);
    const result = await antiHotlinkManager.withRules(images, context, config, async () => (
      mode === "zip"
        ? downloadZip(images, context, config)
        : downloadSingleImages(images, context, config)
    ));
    await addHistory({ mode, count: images.length, context, result: { bytes: result.bytes, downloadId: result.downloadId } });
    return result;
  }

  resolveMode(mode, count) {
    if (mode === "zip" || mode === "single") return mode;
    return count < 50 ? "zip" : "single";
  }
}

export const downloadManager = new DownloadManager();
