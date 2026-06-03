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
  try {
    const parsed = new URL(url);
    const fromParam = ["filename", "file", "name", "path", "url"]
      .map((key) => parsed.searchParams.get(key))
      .find(Boolean);
    const candidate = fromParam || parsed.pathname.split("/").filter(Boolean).at(-1);
    if (candidate) return decodeURIComponent(candidate.split("/").filter(Boolean).at(-1));
  } catch {
    const candidate = String(url).split("?")[0].split("#")[0].split("/").filter(Boolean).at(-1);
    if (candidate) return candidate;
  }
  return `${padNumber(index, 3)}.${ext}`;
}

function ensureExtension(filename, ext) {
  if (/\.[a-z0-9]{2,5}$/i.test(filename)) return filename;
  return `${filename}.${ext || "jpg"}`;
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
