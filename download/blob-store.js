const DB_NAME = "cie-download-cache";
const STORE_NAME = "temp-download-blobs";
const DB_VERSION = 1;

let openDbPromise = null;

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
