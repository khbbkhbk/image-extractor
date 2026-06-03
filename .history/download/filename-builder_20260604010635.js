import { formatDate, formatTime, padNumber, sanitizePathSegment } from "../utils/format.js";
import { getExtensionFromUrl } from "../utils/url.js";

export function buildFilename(image, context, index, options = {}) {
  const template = options.filenameTemplate || "{comic}/{chapter}/{index:3}.{ext}";
  const now = new Date();
  const ext = (options.ext || image.ext || getExtensionFromUrl(image.url)).replace("jpeg", "jpg");
  const values = {
    comic: context.comic || context.pageTitle || "comic",
    chapter: context.chapter || "chapter",
    index,
    width: image.width || image.naturalWidth || 0,
    height: image.height || image.naturalHeight || 0,
    ext,
    site: context.site || image.site || "site",
    date: formatDate(now),
    time: formatTime(now),
    hash: image.hash || "",
    pageTitle: context.pageTitle || image.title || "page"
  };

  return template
    .replace(/\{index:(\d+)\}/g, (_, width) => padNumber(index, Number(width)))
    .replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "")
    .split("/")
    .map((segment) => sanitizePathSegment(segment))
    .join("/");
}

export function buildSourceFilename(image, index, options = {}) {
  const sourceUrl = image.originalUrl || image.url || "";
  const ext = (options.ext || image.ext || getExtensionFromUrl(sourceUrl)).replace("jpeg", "jpg");
  const sourceName = getSourceFilename(sourceUrl, index, ext);
  return sanitizePathSegment(ensureExtension(sourceName, ext));
}

export function getSourceFilename(url = "", index = 1, ext = "jpg") {
  const raw = String(url || "");
  const noHash = raw.split("#")[0];
  const lastSegment = noHash.split("/").filter(Boolean).at(-1) || "";
  const base = lastSegment.split("?")[0] || "";

  if (base) {
    try {
      const decoded = decodeURIComponent(base);
      // 检查是否有扩展名
      if (/\.[a-z0-9]{2,5}$/i.test(decoded)) {
        return decoded;
      }
      // 如果没有扩展名，添加扩展名
      return `${decoded}.${ext}`;
    } catch {
      // 解码失败，使用原始base
      if (/\.[a-z0-9]{2,5}$/i.test(base)) {
        return base;
      }
      return `${base}.${ext}`;
    }
  }

  // 如果URL中没有文件名，使用索引作为文件名
  return `${padNumber(index, 3)}.${ext}`;
}

function ensureExtension(filename, ext) {
  // 如果已经有扩展名，直接返回
  if (/\.[a-z0-9]{2,5}$/i.test(filename)) return filename;

  // 如果没有扩展名，添加扩展名
  const cleanExt = (ext || "jpg").replace(/^\./, ""); // 移除可能的前导点
  return `${filename}.${cleanExt}`;
}

export function buildMetadata(context, images) {
  return {
    comic: context.comic,
    chapter: context.chapter,
    pageTitle: context.pageTitle,
    sourceUrl: context.sourceUrl,
    site: context.site,
    mode: context.mode,
    downloadedAt: new Date().toISOString(),
    count: images.length,
    images: images.map((image, index) => ({
      index: index + 1,
      url: image.url,
      originalUrl: image.originalUrl,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
      format: image.format || image.ext,
      hash: image.hash,
      source: image.source,
      node: image.node,
      filename: image.filename
    }))
  };
}

export function buildMetadataFilename(context) {
  const site = sanitizePathSegment(context.site || "site");
  const comic = sanitizePathSegment(context.comic || context.pageTitle || "images");
  const chapter = sanitizePathSegment(context.chapter || "metadata");
  return [site, comic, chapter, "metadata.json"].join("/");
}

export function buildZipFilename(context) {
  const site = sanitizePathSegment(context.site || "site");
  const comic = sanitizePathSegment(context.comic || context.pageTitle || "images");
  const chapter = sanitizePathSegment(context.chapter || "chapter");
  return [site, comic, `${chapter}.zip`].join("/");
}
