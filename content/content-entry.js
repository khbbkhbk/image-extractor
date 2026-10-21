(async () => {
  if (window.__CIE_CONTENT_ENTRY_LOADED__) return;
  window.__CIE_CONTENT_ENTRY_LOADED__ = true;

  const [{ ImageScanner }, { PageObserver }] = await Promise.all([
    import(chrome.runtime.getURL("content/scanner.js")),
    import(chrome.runtime.getURL("content/observer.js"))
  ]);

  const scanner = new ImageScanner(document);
  const CAPTURED_IMAGE_LIMIT = 120;
  const capturedImageBlobs = new Map();
  const capturingImageUrls = new Set();
  const persistedImageUrls = new Set();
  let observer = null;
  let lastPayload = null;
  let active = true;
  let autoScrollController = { aborted: false };

  async function runScan(reason = "manual") {
    if (!active || !isRuntimeAvailable()) return lastPayload;
    try {
      lastPayload = await scanner.scan();
      safeSendMessage({ type: "IMAGES_UPDATED", reason, payload: lastPayload });
      // 虚拟化阅读器随时会卸载图片，扫描后立即缓存像素，供后续下载与预览使用
      captureScannedImages(lastPayload.images).catch(() => { });
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
      fetchImageToDataUrl(message.url).then(sendResponse).catch((error) => sendResponse({
        ok: false,
        error: error.message,
        status: error.status || 0
      }));
      return true;
    }
    if (message.type === "CAPTURE_RENDERED_IMAGE") {
      captureRenderedImageToDataUrl(message.url, message.options).then(sendResponse).catch((error) => sendResponse({
        ok: false,
        error: error.message
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

  // 扫描阶段缓存 blob 图片：优先取页面原始 Blob，取不到再截取已解码像素
  async function captureScannedImages(images = []) {
    const pendingUrls = images
      .map((image) => String(image?.url || ""))
      .filter((url) => url.startsWith("blob:"))
      .filter((url) => !capturedImageBlobs.has(url) && !capturingImageUrls.has(url));
    await Promise.all(pendingUrls.map((url) => captureScannedImage(url)));
  }

  async function captureScannedImage(url) {
    capturingImageUrls.add(url);
    try {
      const originalBlob = await requestOriginalImageBlob(url);
      if (originalBlob) {
        rememberCapturedImage(url, originalBlob);
        persistCapturedImage(url, originalBlob);
        return;
      }
      const target = findRenderedImage(url);
      if (!target) return;
      const blob = await renderImageBlob(target, { type: "image/webp", quality: 0.95 });
      if (blob) {
        rememberCapturedImage(url, blob);
        persistCapturedImage(url, blob);
      }
    } finally {
      capturingImageUrls.delete(url);
    }
  }

  // 原始字节同时落盘到扩展 IndexedDB，页面内存淘汰或刷新后仍能下载
  function persistCapturedImage(url, blob) {
    if (!url || persistedImageUrls.has(url)) return;
    persistedImageUrls.add(url);
    blobToDataUrl(blob)
      .then((dataUrl) => chrome.runtime.sendMessage({ type: "STORE_CAPTURED_IMAGE", url, dataUrl }))
      .then((response) => {
        // 后台空间不足时不再重试；其他失败允许后续扫描再次尝试
        if (response?.ok || response?.full) return;
        persistedImageUrls.delete(url);
      })
      .catch(() => persistedImageUrls.delete(url));
  }

  // 主世界脚本持有站点创建的原始 Blob，跨世界通过 postMessage 请求
  function requestOriginalImageBlob(url) {
    return new Promise((resolve) => {
      const id = `cie-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timer = setTimeout(() => finish(""), 800);
      const onMessage = (event) => {
        const data = event.data;
        if (!data || data.__cieBlobResponse !== true || data.id !== id) return;
        finish(data.ok && data.dataUrl ? data.dataUrl : "");
      };
      function finish(dataUrl) {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (!dataUrl) {
          resolve(null);
          return;
        }
        fetch(dataUrl)
          .then((response) => response.blob())
          .then((blob) => resolve(blob.type.startsWith("image/") ? blob : null))
          .catch(() => resolve(null));
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ __cieBlobRequest: true, id, url }, "*");
    });
  }

  function findRenderedImage(url) {
    return [...document.images].find((image) => (image.currentSrc || image.src) === url && image.naturalWidth > 0);
  }

  function rememberCapturedImage(url, blob) {
    capturedImageBlobs.set(url, blob);
    while (capturedImageBlobs.size > CAPTURED_IMAGE_LIMIT) {
      const oldestUrl = capturedImageBlobs.keys().next().value;
      capturedImageBlobs.delete(oldestUrl);
    }
  }

  async function renderImageBlob(element, options = {}) {
    const width = Number(element?.naturalWidth || 0);
    const height = Number(element?.naturalHeight || 0);
    if (!width || !height) return null;
    const maxEdge = Number(options.maxEdge || 0);
    const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(element, 0, 0, outWidth, outHeight);
    try {
      return await new Promise((resolve) => canvas.toBlob(
        resolve,
        options.type || "image/png",
        options.quality
      ));
    } catch {
      return null;
    }
  }

  // 已缓存的图片按需缩放，避免预览时回传整张大图
  async function cachedImageToDataUrl(blob, options = {}) {
    const maxEdge = Number(options.maxEdge || 0);
    if (maxEdge > 0) {
      try {
        const bitmap = await createImageBitmap(blob);
        try {
          const scale = Math.min(1, maxEdge / Math.max(bitmap.width || 1, bitmap.height || 1));
          const width = Math.max(1, Math.round((bitmap.width || 1) * scale));
          const height = Math.max(1, Math.round((bitmap.height || 1) * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (context) {
            context.drawImage(bitmap, 0, 0, width, height);
            const resized = await new Promise((resolve) => canvas.toBlob(
              resolve,
              options.type || "image/webp",
              options.quality
            ));
            if (resized) {
              return { ok: true, dataUrl: await blobToDataUrl(resized), type: resized.type, size: resized.size };
            }
          }
        } finally {
          bitmap.close?.();
        }
      } catch {
        // 缩放失败时回退原图
      }
    }
    return { ok: true, dataUrl: await blobToDataUrl(blob), type: blob.type, size: blob.size };
  }

  // 页面内抓取图片：先带凭据请求，遇到返回通配符 ACAO 的 CDN 时去掉凭据重试
  async function fetchImageToDataUrl(url) {
    const cached = capturedImageBlobs.get(url);
    if (cached) return cachedImageToDataUrl(cached);
    if (url.startsWith("blob:")) {
      const original = await requestOriginalImageBlob(url);
      if (original) {
        rememberCapturedImage(url, original);
        persistCapturedImage(url, original);
        return cachedImageToDataUrl(original);
      }
    }
    const response = await requestImage(url, "include").catch((error) => {
      if (error?.name !== "TypeError") throw error;
      return requestImage(url, "omit");
    });
    if (!response.ok) {
      const error = new Error(`Page fetch failed: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const blob = await response.blob();
    if (url.startsWith("blob:")) persistCapturedImage(url, blob);
    return {
      ok: true,
      dataUrl: await blobToDataUrl(blob),
      type: blob.type,
      size: blob.size
    };
  }

  function requestImage(url, credentials) {
    return fetch(url, {
      credentials,
      cache: "force-cache",
      mode: "cors",
      referrer: location.href,
      referrerPolicy: "unsafe-url"
    });
  }

  // 部分站点在图片渲染后立即回收 blob: 地址，优先使用扫描时缓存的像素
  async function captureRenderedImageToDataUrl(url, options = {}) {
    const cached = capturedImageBlobs.get(url);
    if (cached) return cachedImageToDataUrl(cached, options);
    if (url.startsWith("blob:")) {
      const original = await requestOriginalImageBlob(url);
      if (original) {
        rememberCapturedImage(url, original);
        persistCapturedImage(url, original);
        return cachedImageToDataUrl(original, options);
      }
    }
    const target = findRenderedImage(url);
    if (!target) throw new Error("页面中已找不到该图片元素，请重新扫描页面后重试；若刚更新过扩展，请刷新页面。");
    const blob = await renderImageBlob(target, options);
    if (!blob) throw new Error("页面图片截取失败，请重新扫描页面后重试。");
    if (url.startsWith("blob:")) persistCapturedImage(url, blob);
    return {
      ok: true,
      dataUrl: await blobToDataUrl(blob),
      type: blob.type,
      size: blob.size
    };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取图片内容失败。"));
      reader.readAsDataURL(blob);
    });
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
