(async () => {
  if (window.__CIE_CONTENT_ENTRY_LOADED__) return;
  window.__CIE_CONTENT_ENTRY_LOADED__ = true;

  const [{ ImageScanner }, { PageObserver }] = await Promise.all([
    import(chrome.runtime.getURL("content/scanner.js")),
    import(chrome.runtime.getURL("content/observer.js"))
  ]);

  const scanner = new ImageScanner(document);
  let observer = null;
  let lastPayload = null;
  let active = true;

  async function runScan(reason = "manual") {
    if (!active || !isRuntimeAvailable()) return lastPayload;
    try {
      lastPayload = await scanner.scan();
      safeSendMessage({ type: "IMAGES_UPDATED", reason, payload: lastPayload });
      return lastPayload;
    } catch (error) {
      if (isContextInvalidated(error)) {
        deactivate();
        return lastPayload;
      }
      throw error;
    }
  }

  async function autoScroll(maxSteps = 12) {
    let previousHeight = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      await new Promise((resolve) => setTimeout(resolve, 900));
      const height = document.documentElement.scrollHeight;
      if (height === previousHeight) break;
      previousHeight = height;
    }
    return runScan("auto-scroll");
  }

  function startObserve() {
    if (observer || !active) return;
    observer = new PageObserver({
      onChange: () => runScan("observe").catch(console.error),
      onRouteChange: () => runScan("route").catch(console.error)
    });
    observer.start();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return false;
    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "SCAN_IMAGES") {
      runScan("manual").then(sendResponse).catch((error) => sendResponse({ error: error.message }));
      return true;
    }
    if (message.type === "GET_LAST_SCAN") {
      sendResponse(lastPayload);
      return false;
    }
    if (message.type === "START_OBSERVE") {
      startObserve();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "STOP_OBSERVE") {
      observer?.stop();
      observer = null;
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "AUTO_SCROLL_SCAN") {
      autoScroll(message.maxSteps).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
      return true;
    }
    if (message.type === "FETCH_IMAGE_BLOB") {
      fetchImageAsDataUrl(message.url).then(sendResponse).catch((error) => sendResponse({
        ok: false,
        error: error.message,
        status: error.status || 0
      }));
      return true;
    }
    return false;
  });

  startObserve();
  runScan("initial").catch(console.error);

  function safeSendMessage(message) {
    try {
      chrome.runtime.sendMessage(message).catch((error) => {
        if (isContextInvalidated(error)) deactivate();
      });
    } catch (error) {
      if (isContextInvalidated(error)) deactivate();
      else throw error;
    }
  }

  function deactivate() {
    active = false;
    observer?.stop();
    observer = null;
  }

  function isRuntimeAvailable() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidated(error) {
    return String(error?.message || error).includes("Extension context invalidated");
  }

  async function fetchImageAsDataUrl(url) {
    const response = await fetch(url, {
      credentials: "include",
      cache: "force-cache",
      mode: "cors"
    });
    if (!response.ok) {
      const error = new Error(`Page fetch failed: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const blob = await response.blob();
    return {
      ok: true,
      dataUrl: await blobToDataUrl(blob),
      type: blob.type,
      size: blob.size
    };
  }

  async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
  }
})();
