import { takeTempBlob } from "../download/blob-store.js";

const activeBlobUrls = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_CREATE_BLOB_URL") {
    createBlobUrl(message.blobKey)
      .then((url) => sendResponse({ ok: true, url }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OFFSCREEN_FETCH_REMOTE_BLOB_URL") {
    fetchRemoteBlobUrl(message.url)
      .then((url) => sendResponse({ ok: true, url }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OFFSCREEN_REVOKE_BLOB_URL") {
    revokeBlobUrl(message.url);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function createBlobUrl(blobKey) {
  const blob = await takeTempBlob(blobKey);
  if (!(blob instanceof Blob)) throw new Error("未找到待下载的临时文件");
  return rememberBlobUrl(blob);
}

async function fetchRemoteBlobUrl(url) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "force-cache"
  });
  if (!response.ok) {
    throw new Error(`远程抓取失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return rememberBlobUrl(blob);
}

function rememberBlobUrl(blob) {
  const url = URL.createObjectURL(blob);
  activeBlobUrls.add(url);
  return url;
}

function revokeBlobUrl(url) {
  if (!url || !activeBlobUrls.has(url)) return;
  URL.revokeObjectURL(url);
  activeBlobUrls.delete(url);
}
