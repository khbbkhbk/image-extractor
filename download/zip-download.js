import JSZip from "../vendor/jszip.min.js";
import { TaskQueue } from "../core/task-queue.js";
import { buildFilename, buildMetadata, buildMetadataFilename, buildZipFilename } from "./filename-builder.js";
import { convertImageBlob } from "../preview/image-meta.js";
import { blobToDataUrl, fetchImageBlob, normalizeConflict } from "./single-download.js";

export async function downloadZip(images, context, config) {
  const zip = new JSZip();
  const queue = new TaskQueue({ concurrency: config.concurrency });
  const completed = [];

  await Promise.all(images.map((image, itemIndex) => queue.add(async () => {
    const index = itemIndex + 1;
    const sourceBlob = await fetchImageBlob(image.url, config);
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
  const downloadId = await chrome.downloads.download({
    url: await blobToDataUrl(blob),
    filename: buildZipFilename(context),
    conflictAction: normalizeConflict(config.conflictAction),
    saveAs: false
  });

  return { mode: "zip", count: ordered.length, downloadId, bytes: blob.size, results: ordered };
}
