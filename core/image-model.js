import { hashString } from "../utils/hash.js";
import { getExtensionFromUrl, getSiteName, stripUrlNoise } from "../utils/url.js";

export function createImageModel(input = {}) {
  const normalizedUrl = stripUrlNoise(input.url || "");
  const width = Number(input.width || 0);
  const height = Number(input.height || 0);
  const ext = (input.ext || getExtensionFromUrl(normalizedUrl)).toLowerCase();
  const dedupeKey = input.dedupeKey || hashString(`${normalizedUrl}:${width}:${height}:${input.source || ""}`);
  const id = input.id || hashString(`${normalizedUrl}:${width}:${height}:${input.source || ""}:${input.order || 0}:${input.node || ""}`);
  return {
    id,
    dedupeKey,
    url: normalizedUrl,
    originalUrl: input.originalUrl || input.url || "",
    width,
    height,
    naturalWidth: Number(input.naturalWidth || width || 0),
    naturalHeight: Number(input.naturalHeight || height || 0),
    ext,
    format: ext,
    bytes: Number(input.bytes || 0),
    source: input.source || "unknown",
    node: input.node || "",
    visible: Boolean(input.visible),
    pageIndex: Number(input.pageIndex || 0),
    order: Number(input.order || 0),
    hash: input.hash || hashString(normalizedUrl),
    site: input.site || getSiteName(normalizedUrl),
    title: input.title || "",
    alt: input.alt || "",
    filename: input.filename || ""
  };
}

export function dedupeImages(images = []) {
  const seen = new Set();
  const result = [];
  for (const image of images) {
    const key = image.url || image.hash;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(image);
  }
  return result;
}
