import { storage } from "./storage.js";

const CACHE_KEY = "scanCache";

export async function saveScanCache(tabId, payload) {
  const cache = await storage.get(CACHE_KEY, {});
  cache[String(tabId)] = { ...payload, savedAt: Date.now() };
  await storage.set({ [CACHE_KEY]: cache });
}

export async function getScanCache(tabId) {
  const cache = await storage.get(CACHE_KEY, {});
  return cache[String(tabId)] || null;
}
