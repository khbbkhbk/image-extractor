import JSZip from "../vendor/jszip.min.js";
import { TaskQueue } from "../core/task-queue.js";
import { buildFilename, buildMetadata, buildMetadataFilename, buildZipFilename } from "./filename-builder.js";
import { convertImageBlob } from "../preview/image-meta.js";
import {
  abortDownloadSession,
  ensureDownloadSession,
  fetchImageBlob,
  isDownloadSessionAborted,
  logDownloadFailure,
  markDownloadSessionSchedulingDone,
  normalizeConflict,
  registerDownloadIdForSession,
  registerPendingFilenameSuggestion
} from "./single-download.js";
import { createOffscreenDownloadUrl, revokeOffscreenDownloadUrl } from "./offscreen-download.js";

export async function downloadZip(images, context, config) {
  ensureDownloadSession(config.sessionId);
  const zip = new JSZip();
  const queue = new TaskQueue({ concurrency: config.concurrency });
  const completed = [];

  await Promise.all(images.map((image, itemIndex) => queue.add(async () => {
    const index = itemIndex + 1;
    try {
      if (isDownloadSessionAborted(config.sessionId)) throw new Error("下载已中止");
      console.info("[CIE:download] Zip image:", {
        index,
        url: image.url,
        originalUrl: image.originalUrl,
        editedUrl: image.editedUrl
      });
      const sourceBlob = await fetchImageBlob(image.url, config);
      if (isDownloadSessionAborted(config.sessionId)) throw new Error("下载已中止");
      let converted;
      try {
        converted = await convertImageBlob(sourceBlob, config.format, config.quality);
      } catch (error) {
        const conversionError = new Error(`格式转换失败：${error?.message || error}`);
        conversionError.code = "FORMAT_CONVERSION_ERROR";
        throw conversionError;
      }
      const filename = buildFilename(image, context, index, { ...config, ext: converted.ext });
      zip.file(filename, converted.blob);
      completed.push({ ...image, pageIndex: index, filename, bytes: converted.blob.size, ext: converted.ext, hash: converted.hash });
    } catch (error) {
      logDownloadFailure("zip-image", error, {
        index,
        image
      });
      throw error;
    }
  })));

  const ordered = completed.sort((a, b) => a.pageIndex - b.pageIndex);
  if (config.includeMetadata) {
    zip.file(buildMetadataFilename(context), JSON.stringify(buildMetadata(context, ordered), null, 2));
  }

  let blob;
  try {
    blob = await zip.generateAsync({ type: "blob" });
  } catch (error) {
    logDownloadFailure("zip-generate", error, {
      filename: buildZipFilename(context)
    });
    throw error;
  }
  if (isDownloadSessionAborted(config.sessionId)) throw new Error("下载已中止");
  let downloadUrl = "";
  try {
    downloadUrl = await createOffscreenDownloadUrl(blob);
  } catch (error) {
    logDownloadFailure("zip-offscreen-url", error, {
      filename: buildZipFilename(context)
    });
    throw error;
  }
  const zipFilename = buildZipFilename(context);
  registerPendingFilenameSuggestion(downloadUrl, zipFilename, config.conflictAction);
  let downloadId = 0;
  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename: zipFilename,
      conflictAction: normalizeConflict(config.conflictAction),
      saveAs: false
    });
  } catch (error) {
    await revokeOffscreenDownloadUrl(downloadUrl);
    logDownloadFailure("zip-submit", error, {
      filename: zipFilename,
      downloadUrl
    });
    throw error;
  }
  registerDownloadIdForSession(config.sessionId, downloadId, downloadUrl, {
    kind: "archive",
    images
  });
  markDownloadSessionSchedulingDone(config.sessionId);
  if (isDownloadSessionAborted(config.sessionId)) await abortDownloadSession(config.sessionId);

  return { mode: "zip", count: ordered.length, downloadId, bytes: blob.size, results: ordered };
}
