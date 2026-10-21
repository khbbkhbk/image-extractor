const DB_NAME = "cie-download-cache";
const TEMP_STORE_NAME = "temp-download-blobs";
const CAPTURE_STORE_NAME = "captured-images";
const DB_VERSION = 2;
const MAX_TEMP_BLOB_AGE_MS = 10 * 60 * 1000;
const MAX_TEMP_BLOB_COUNT = 160;
const CAPTURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTA_PRUNE_BYTES = 128 * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const CAPTURE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

let openDbPromise = null;
let cleanupPromise = null;
let lastCleanupAt = 0;
let captureCleanupPromise = null;
let lastCaptureCleanupAt = 0;

function openDatabase() {
  if (openDbPromise) return openDbPromise;
  openDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error("无法打开下载缓存数据库"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TEMP_STORE_NAME)) {
        database.createObjectStore(TEMP_STORE_NAME);
      }
      if (!database.objectStoreNames.contains(CAPTURE_STORE_NAME)) {
        database.createObjectStore(CAPTURE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
  return openDbPromise;
}

async function withStore(storeName, mode, executor) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    executor(store, resolve, reject);
    transaction.onerror = () => reject(transaction.error || new Error("访问下载缓存失败"));
  });
}

export async function putTempBlob(key, blob) {
  if (!key) throw new Error("临时下载键不能为空");
  await withStore(TEMP_STORE_NAME, "readwrite", (store, resolve, reject) => {
    const request = store.put({
      blob,
      createdAt: Date.now()
    }, key);
    request.onerror = () => reject(request.error || new Error("写入临时下载内容失败"));
    request.onsuccess = () => resolve();
  });
  scheduleTempBlobCleanup().catch(() => { });
}

export async function getTempBlob(key) {
  if (!key) return null;
  return withStore(TEMP_STORE_NAME, "readonly", (store, resolve, reject) => {
    const request = store.get(key);
    request.onerror = () => reject(request.error || new Error("读取临时下载内容失败"));
    request.onsuccess = () => resolve(request.result?.blob || null);
  });
}

export async function deleteTempBlob(key) {
  if (!key) return;
  await withStore(TEMP_STORE_NAME, "readwrite", (store, resolve, reject) => {
    const request = store.delete(key);
    request.onerror = () => reject(request.error || new Error("删除临时下载内容失败"));
    request.onsuccess = () => resolve();
  });
}

export async function takeTempBlob(key) {
  const blob = await getTempBlob(key);
  await deleteTempBlob(key);
  return blob;
}

export async function cleanupTempBlobs({ force = false } = {}) {
  if (!force && Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = withStore(TEMP_STORE_NAME, "readwrite", (store, resolve, reject) => {
    const entries = [];
    const request = store.openCursor();
    request.onerror = () => reject(request.error || new Error("清理临时下载内容失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        const now = Date.now();
        const freshEntries = [];
        const deleteKeys = [];
        for (const entry of entries) {
          const createdAt = Number(entry.createdAt || 0);
          if (!createdAt || now - createdAt > MAX_TEMP_BLOB_AGE_MS) deleteKeys.push(entry.key);
          else freshEntries.push(entry);
        }
        if (freshEntries.length > MAX_TEMP_BLOB_COUNT) {
          freshEntries
            .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
            .slice(0, freshEntries.length - MAX_TEMP_BLOB_COUNT)
            .forEach((entry) => deleteKeys.push(entry.key));
        }
        for (const key of new Set(deleteKeys)) store.delete(key);
        resolve();
        return;
      }
      entries.push({
        key: cursor.primaryKey,
        createdAt: cursor.value?.createdAt || 0
      });
      cursor.continue();
    };
  }).finally(() => {
    lastCleanupAt = Date.now();
    cleanupPromise = null;
  });
  return cleanupPromise;
}

// 原图缓存：blob 图片的原始字节落盘保存，不设条数上限，仅在浏览器配额不足时回收最旧条目
export async function putCapturedImage(key, blob, { retried = false } = {}) {
  if (!key) throw new Error("图片缓存键不能为空");
  if (!(blob instanceof Blob)) throw new Error("图片缓存内容必须是 Blob");
  try {
    await withStore(CAPTURE_STORE_NAME, "readwrite", (store, resolve, reject) => {
      const request = store.put({
        blob,
        bytes: Number(blob.size || 0),
        createdAt: Date.now()
      }, key);
      request.onerror = () => reject(request.error || new Error("写入图片缓存失败"));
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    if (!isQuotaExceeded(error)) throw error;
    const freedBytes = retried ? 0 : await pruneOldestCapturedImages(QUOTA_PRUNE_BYTES).catch(() => 0);
    if (freedBytes > 0) return putCapturedImage(key, blob, { retried: true });
    const quotaError = new Error("图片缓存空间不足");
    quotaError.name = "CaptureCacheFullError";
    throw quotaError;
  }
  scheduleCaptureCleanup().catch(() => { });
}

export async function getCapturedImage(key) {
  if (!key) return null;
  return withStore(CAPTURE_STORE_NAME, "readonly", (store, resolve, reject) => {
    const request = store.get(key);
    request.onerror = () => reject(request.error || new Error("读取图片缓存失败"));
    request.onsuccess = () => resolve(request.result?.blob || null);
  });
}

export async function deleteCapturedImage(key) {
  if (!key) return;
  await withStore(CAPTURE_STORE_NAME, "readwrite", (store, resolve, reject) => {
    const request = store.delete(key);
    request.onerror = () => reject(request.error || new Error("删除图片缓存失败"));
    request.onsuccess = () => resolve();
  });
}

// 只清理过期条目，不做条数限制；容量压力下的回收由配额异常触发
export async function cleanupCapturedImages({ force = false } = {}) {
  if (!force && Date.now() - lastCaptureCleanupAt < CAPTURE_CLEANUP_INTERVAL_MS) return;
  if (captureCleanupPromise) return captureCleanupPromise;
  captureCleanupPromise = withStore(CAPTURE_STORE_NAME, "readwrite", (store, resolve, reject) => {
    const deleteKeys = [];
    const request = store.openCursor();
    request.onerror = () => reject(request.error || new Error("清理图片缓存失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        for (const key of deleteKeys) store.delete(key);
        resolve();
        return;
      }
      const createdAt = Number(cursor.value?.createdAt || 0);
      if (!createdAt || Date.now() - createdAt > CAPTURE_MAX_AGE_MS) deleteKeys.push(cursor.primaryKey);
      cursor.continue();
    };
  }).finally(() => {
    lastCaptureCleanupAt = Date.now();
    captureCleanupPromise = null;
  });
  return captureCleanupPromise;
}

export async function pruneOldestCapturedImages(targetBytes) {
  const target = Number(targetBytes || 0);
  if (target <= 0) return 0;
  const entries = [];
  await withStore(CAPTURE_STORE_NAME, "readonly", (store, resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error || new Error("统计图片缓存失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      entries.push({
        key: cursor.primaryKey,
        bytes: Number(cursor.value?.bytes || 0),
        createdAt: Number(cursor.value?.createdAt || 0)
      });
      cursor.continue();
    };
  });
  entries.sort((left, right) => left.createdAt - right.createdAt);
  const deleteKeys = [];
  let freedBytes = 0;
  for (const entry of entries) {
    if (freedBytes >= target) break;
    deleteKeys.push(entry.key);
    freedBytes += entry.bytes;
  }
  if (!deleteKeys.length) return 0;
  await withStore(CAPTURE_STORE_NAME, "readwrite", (store, resolve, reject) => {
    for (const key of deleteKeys) store.delete(key);
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error || new Error("回收图片缓存失败"));
  });
  try {
    chrome.runtime.sendMessage({ type: "CAPTURE_CACHE_PRUNED", freedBytes }).catch(() => { });
  } catch {
    // 非扩展上下文（如测试环境）忽略通知失败
  }
  return freedBytes;
}

export async function estimateStorageUsage() {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

function isQuotaExceeded(error) {
  return error?.name === "QuotaExceededError" || Number(error?.code) === 22;
}

async function scheduleTempBlobCleanup() {
  return cleanupTempBlobs({ force: false });
}

async function scheduleCaptureCleanup() {
  return cleanupCapturedImages({ force: false });
}
