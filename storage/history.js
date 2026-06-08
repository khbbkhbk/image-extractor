import { storage } from "./storage.js";

const HISTORY_KEY = "downloadHistory";
const HISTORY_LIMIT = 100;
const HISTORY_FALLBACK_LIMIT = 20;

export async function addHistory(entry) {
  const history = await storage.get(HISTORY_KEY, []);
  const nextHistory = [createHistoryEntry(entry), ...history].slice(0, HISTORY_LIMIT);
  try {
    await storage.set({ [HISTORY_KEY]: nextHistory });
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error;
    // 历史记录属于附加信息，不应阻断已成功提交的下载流程。
    await storage.set({ [HISTORY_KEY]: nextHistory.slice(0, HISTORY_FALLBACK_LIMIT) }).catch(() => { });
  }
}

export async function getHistory() {
  return storage.get(HISTORY_KEY, []);
}

function createHistoryEntry(entry = {}) {
  return {
    mode: entry.mode || "single",
    count: Number(entry.count || 0) || 0,
    context: pickHistoryContext(entry.context || {}),
    result: pickHistoryResult(entry.result || {}),
    createdAt: new Date().toISOString()
  };
}

function pickHistoryContext(context) {
  return {
    comic: context.comic || "",
    chapter: context.chapter || "",
    pageTitle: context.pageTitle || "",
    sourceUrl: context.sourceUrl || "",
    site: context.site || "",
    mode: context.mode || ""
  };
}

function pickHistoryResult(result) {
  return {
    bytes: Number(result.bytes || 0) || 0,
    downloadId: Number(result.downloadId || 0) || 0
  };
}

function isQuotaExceededError(error) {
  return /quota/i.test(String(error?.message || error || ""));
}
