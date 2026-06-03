import JSZip from "../vendor/jszip.min.js";
import { TaskQueue } from "../core/task-queue.js";
import { buildFilename, buildMetadata, buildMetadataFilename, buildZipFilename } from "./filename-builder.js";
import { convertImageBlob } from "../preview/image-meta.js";
import {
  abortDownloadSession,
  blobToDataUrl,
  ensureDownloadSession,
  fetchImageBlob,
  isDownloadSessionAborted,
  markDownloadSessionSchedulingDone,
  normalizeConflict,
  registerDownloadIdForSession
} from "./single-download.js";

export async function downloadZip(images, context, config) {
  ensureDownloadSession(config.sessionId);
  const zip = new JSZip();
  const queue = new TaskQueue({ concurrency: config.concurrency });
  const completed = [];

  await Promise.all(images.map((image, itemIndex) => queue.add(async () => {
    if (isDownloadSessionAborted(config.sessionId)) throw new Error("下载已中止");
    const index = itemIndex + 1;
    const sourceBlob = await fetchImageBlob(image.url, config);
    if (isDownloadSessionAborted(config.sessionId)) throw new Error("下载已中止");
    const converted = await convertImageBlob(sourceBlob, config.format, config.quality);
    const filename = buildFilename(image, context, index, { ...config, ext: converted.ext });
    zip.file(filename, converted.blob);
    completed.push({ ...image, pageIndex: index, filename, bytes: converted.blob.size, ext: converted.ext, hash: converted.hash });
  })));

  const ordered = completed.sort((a, b) => a.pageIndex - b.pageIndex);
  if (config.includeMetadata) {
    zip.file(buildMetadataFilename(context), JSON.stringify(buildMetadata(context, ordered), null, 2));
  }

  const blob = await zip.generateAsync({ type: "blob" });
  if (isDownloadSessionAborted(config.sessionId)) throw new Error("下载已中止");
  const downloadId = await chrome.downloads.download({
    url: await blobToDataUrl(blob),
    filename: buildZipFilename(context),
    conflictAction: normalizeConflict(config.conflictAction),
    saveAs: false
  });
  registerDownloadIdForSession(config.sessionId, downloadId);
  markDownloadSessionSchedulingDone(config.sessionId);
  if (isDownloadSessionAborted(config.sessionId)) await abortDownloadSession(config.sessionId);

  return { mode: "zip", count: ordered.length, downloadId, bytes: blob.size, results: ordered };
}
