import { sessionStorage, storage } from "./storage.js";

const CACHE_KEY = "scanCache";
const CACHE_LIMIT = 5;
let legacyLocalCacheCleared = false;

export async function saveScanCache(tabId, payload) {
  await clearLegacyLocalCacheOnce();
  const cache = await sessionStorage.get(CACHE_KEY, {});
  const key = String(tabId || "");
  if (!key) return;
  cache[key] = createCacheEntry(payload);
  const nextCache = pruneCacheEntries(cache);
  await sessionStorage.set({ [CACHE_KEY]: nextCache });
}

export async function getScanCache(tabId) {
  await clearLegacyLocalCacheOnce();
  const cache = await sessionStorage.get(CACHE_KEY, {});
  return cache[String(tabId)] || null;
}

function createCacheEntry(payload = {}) {
  const images = Array.isArray(payload.images)
    ? payload.images.map(pickCachedImage).filter(Boolean)
    : [];
  return {
    context: pickCachedContext(payload.context || {}),
    images,
    scannedAt: payload.scannedAt || "",
    savedAt: Date.now()
  };
}

function pickCachedImage(image) {
  if (!image || !image.url) return null;
  return {
    id: image.id || "",
    dedupeKey: image.dedupeKey || "",
    url: String(image.url || "").trim(),
    originalUrl: String(image.originalUrl || image.url || "").trim(),
    width: Number(image.width || 0) || 0,
    height: Number(image.height || 0) || 0,
    naturalWidth: Number(image.naturalWidth || 0) || 0,
    naturalHeight: Number(image.naturalHeight || 0) || 0,
    ext: image.ext || "",
    format: image.format || image.ext || "",
    bytes: Number(image.bytes || 0) || 0,
    source: image.source || "",
    node: image.node || "",
    visible: Boolean(image.visible),
    pageIndex: Number(image.pageIndex || 0) || 0,
    order: Number(image.order || 0) || 0,
    hash: image.hash || "",
    site: image.site || "",
    title: image.title || "",
    alt: image.alt || "",
    filename: image.filename || ""
  };
}

function pickCachedContext(context) {
  return {
    comic: context.comic || "",
    chapter: context.chapter || "",
    pageTitle: context.pageTitle || "",
    sourceUrl: context.sourceUrl || "",
    site: context.site || "",
    mode: context.mode || ""
  };
}

function pruneCacheEntries(cache) {
  return Object.fromEntries(
    Object.entries(cache || {})
      .sort(([, left], [, right]) => Number(right?.savedAt || 0) - Number(left?.savedAt || 0))
      .slice(0, CACHE_LIMIT)
  );
}

async function clearLegacyLocalCacheOnce() {
  if (legacyLocalCacheCleared) return;
  legacyLocalCacheCleared = true;
  await storage.remove(CACHE_KEY);
}
