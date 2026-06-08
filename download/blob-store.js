const DB_NAME = "cie-download-cache";
const STORE_NAME = "temp-download-blobs";
const DB_VERSION = 1;
const MAX_TEMP_BLOB_AGE_MS = 10 * 60 * 1000;
const MAX_TEMP_BLOB_COUNT = 160;
const CLEANUP_INTERVAL_MS = 60 * 1000;

let openDbPromise = null;
let cleanupPromise = null;
let lastCleanupAt = 0;

function openDatabase() {
  if (openDbPromise) return openDbPromise;
  openDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error("无法打开下载缓存数据库"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
  return openDbPromise;
}

async function withStore(mode, executor) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    executor(store, resolve, reject);
    transaction.onerror = () => reject(transaction.error || new Error("访问下载缓存失败"));
  });
}

export async function putTempBlob(key, blob) {
  if (!key) throw new Error("临时下载键不能为空");
  await withStore("readwrite", (store, resolve, reject) => {
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
  return withStore("readonly", (store, resolve, reject) => {
    const request = store.get(key);
    request.onerror = () => reject(request.error || new Error("读取临时下载内容失败"));
    request.onsuccess = () => resolve(request.result?.blob || null);
  });
}

export async function deleteTempBlob(key) {
  if (!key) return;
  await withStore("readwrite", (store, resolve, reject) => {
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
  cleanupPromise = withStore("readwrite", (store, resolve, reject) => {
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

async function scheduleTempBlobCleanup() {
  return cleanupTempBlobs({ force: false });
}
