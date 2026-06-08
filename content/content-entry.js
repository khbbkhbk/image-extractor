(async () => {
  if (window.__CIE_CONTENT_ENTRY_LOADED__) return;
  window.__CIE_CONTENT_ENTRY_LOADED__ = true;

  const [{ ImageScanner }, { PageObserver }, { putTempBlob }] = await Promise.all([
    import(chrome.runtime.getURL("content/scanner.js")),
    import(chrome.runtime.getURL("content/observer.js")),
    import(chrome.runtime.getURL("download/blob-store.js"))
  ]);

  const scanner = new ImageScanner(document);
  let observer = null;
  let lastPayload = null;
  let active = true;
  let autoScrollController = { aborted: false };

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

  async function autoScroll(maxSteps = 0, direction = "down") {
    autoScrollController = { aborted: false };
    const steps = Number(maxSteps) > 0 ? Number(maxSteps) : 80;
    let previousSnapshot = getScrollSnapshot(direction);

    for (let step = 0; step < steps; step += 1) {
      if (!active || autoScrollController.aborted) break;
      await waitForViewportImages(6500);
      if (!active || autoScrollController.aborted) break;
      scrollByStep(direction);
      await waitFor(420);
      const pendingBeforeWait = getPendingEdgeImages(direction).length;
      await waitForEdgeImages(direction, 9000);
      await waitForScrollableGrowth(direction, previousSnapshot, 2600);

      const nextSnapshot = getScrollSnapshot(direction);
      const imageCountIncreased = nextSnapshot.imageCount > previousSnapshot.imageCount;
      const layoutChanged = !isScrollStable(previousSnapshot, nextSnapshot, direction);
      const hasPending = pendingBeforeWait > 0;
      previousSnapshot = nextSnapshot;

      if (!imageCountIncreased && !layoutChanged && !hasPending) break;
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
      autoScroll(message.maxSteps, message.direction).then(sendResponse).catch((error) => sendResponse({ error: error.message }));
      return true;
    }
    if (message.type === "ABORT_AUTO_SCROLL") {
      autoScrollController.aborted = true;
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "SCROLL_TO_EDGE") {
      scrollToEdge(message.edge);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "FETCH_IMAGE_BLOB") {
      fetchImageToTempBlob(message.url).then(sendResponse).catch((error) => sendResponse({
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

  function scrollToEdge(edge) {
    const root = document.scrollingElement || document.documentElement;
    const maxTop = Math.max(0, (root.scrollHeight || 0) - window.innerHeight);
    const prefersReduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const behavior = prefersReduceMotion ? "auto" : "smooth";
    window.scrollTo({ top: edge === "bottom" ? maxTop : 0, behavior });
  }

  async function fetchImageToTempBlob(url) {
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
    const blobKey = `page-fetch:${Date.now()}:${crypto.randomUUID()}`;
    await putTempBlob(blobKey, blob);
    return {
      ok: true,
      blobKey,
      type: blob.type,
      size: blob.size
    };
  }

  function scrollByStep(direction) {
    const root = document.scrollingElement || document.documentElement;
    const minStep = 180;
    const verticalStep = Math.max(minStep, Math.round(window.innerHeight * 0.55));
    const horizontalStep = Math.max(minStep, Math.round(window.innerWidth * 0.55));
    const maxTop = Math.max(0, (root.scrollHeight || 0) - window.innerHeight);
    const maxLeft = Math.max(0, (root.scrollWidth || 0) - window.innerWidth);
    const currentTop = Number(root.scrollTop || window.scrollY || 0);
    const currentLeft = Number(root.scrollLeft || window.scrollX || 0);

    const next = {
      top: currentTop,
      left: currentLeft
    };

    if (direction === "up") next.top = Math.max(0, currentTop - verticalStep);
    else if (direction === "left") next.left = Math.max(0, currentLeft - horizontalStep);
    else if (direction === "right") next.left = Math.min(maxLeft, currentLeft + horizontalStep);
    else next.top = Math.min(maxTop, currentTop + verticalStep);

    window.scrollTo({ top: Math.round(next.top), left: Math.round(next.left), behavior: "smooth" });
  }

  function getScrollSnapshot(direction) {
    const root = document.scrollingElement || document.documentElement;
    return {
      top: Math.round(root.scrollTop || window.scrollY || 0),
      left: Math.round(root.scrollLeft || window.scrollX || 0),
      scrollHeight: Math.round(root.scrollHeight || 0),
      scrollWidth: Math.round(root.scrollWidth || 0),
      imageCount: document.images.length,
      axis: direction === "left" || direction === "right" ? Math.round(root.scrollLeft || window.scrollX || 0) : Math.round(root.scrollTop || window.scrollY || 0)
    };
  }

  function isScrollStable(previousSnapshot, nextSnapshot, direction) {
    if (!previousSnapshot) return false;
    const axisChanged = previousSnapshot.axis !== nextSnapshot.axis;
    const heightChanged = previousSnapshot.scrollHeight !== nextSnapshot.scrollHeight;
    const widthChanged = previousSnapshot.scrollWidth !== nextSnapshot.scrollWidth;
    const imageCountChanged = previousSnapshot.imageCount !== nextSnapshot.imageCount;
    const horizontal = direction === "left" || direction === "right";
    return !axisChanged && !imageCountChanged && !(horizontal ? widthChanged : heightChanged);
  }

  async function waitForEdgeImages(direction, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const pending = getPendingEdgeImages(direction);
      if (!pending.length) return;
      await Promise.race([
        Promise.allSettled(pending.map((image) => waitForImage(image))),
        waitFor(600)
      ]);
      await waitFor(120);
    }
  }

  async function waitForViewportImages(timeoutMs = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!active || autoScrollController.aborted) return;
      const pending = getPendingViewportImages();
      if (!pending.length) return;
      await Promise.race([
        Promise.allSettled(pending.map((image) => waitForImage(image))),
        waitFor(600)
      ]);
      await waitFor(120);
    }
  }

  function getPendingEdgeImages(direction) {
    const threshold = 240;
    return [...document.images].filter((image) => {
      if (!image || image.complete || !image.currentSrc) return false;
      const rect = image.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      if (direction === "up") return rect.top <= threshold && rect.bottom >= -threshold;
      if (direction === "left") return rect.left <= threshold && rect.right >= -threshold;
      if (direction === "right") return rect.right >= window.innerWidth - threshold && rect.left <= window.innerWidth + threshold;
      return rect.bottom >= window.innerHeight - threshold && rect.top <= window.innerHeight + threshold;
    });
  }

  function getPendingViewportImages() {
    const threshold = 160;
    return [...document.images].filter((image) => {
      if (!image || image.complete || !image.currentSrc) return false;
      const rect = image.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const inViewport = rect.bottom >= -threshold
        && rect.top <= window.innerHeight + threshold
        && rect.right >= -threshold
        && rect.left <= window.innerWidth + threshold;
      return inViewport;
    });
  }

  function waitForImage(image) {
    if (!image || image.complete) return Promise.resolve();
    return new Promise((resolve) => {
      const cleanup = () => {
        image.removeEventListener("load", cleanup);
        image.removeEventListener("error", cleanup);
        resolve();
      };
      image.addEventListener("load", cleanup, { once: true });
      image.addEventListener("error", cleanup, { once: true });
    });
  }

  async function waitForScrollableGrowth(direction, previousSnapshot, timeoutMs = 1600) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const current = getScrollSnapshot(direction);
      if (!isScrollStable(previousSnapshot, current, direction)) return;
      await waitFor(180);
    }
  }

  function waitFor(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
