import { debounce } from "../utils/dom.js";

const SCROLL_SCAN_INTERVAL_MS = 400;

export class PageObserver {
  constructor({ onChange, onRouteChange } = {}) {
    this.rawOnChange = onChange || (() => {});
    this.onChange = debounce(this.rawOnChange, 500);
    this.onRouteChange = debounce(onRouteChange || (() => {}), 300);
    this.onScrollChange = debounce(() => this.rawOnChange({ reason: "scroll" }), 850);
    this.lastScrollScanAt = 0;
    this.observer = null;
    this.lastUrl = location.href;
  }

  start() {
    if (this.observer) return;
    this.observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.addedNodes.length || mutation.type === "attributes")) {
        this.onChange({ reason: "mutation" });
      }
    });
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style", "data-src", "data-original", "data-lazy-src"]
    });
    this.patchHistory();
    window.addEventListener("popstate", this.handleRouteChange, true);
    window.addEventListener("scroll", this.handleScroll, { passive: true });
    // 图片解码完成不会改动 DOM，需要监听捕获阶段的 load 事件补一次扫描
    document.addEventListener("load", this.handleImageLoad, true);
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener("popstate", this.handleRouteChange);
    window.removeEventListener("scroll", this.handleScroll);
    document.removeEventListener("load", this.handleImageLoad, true);
  }

  handleImageLoad = (event) => {
    if (event.target?.tagName !== "IMG") return;
    this.onChange({ reason: "image-load" });
  };

  // 虚拟化阅读器只在滚动过程中短暂挂载图片，只等停止滚动会漏图
  handleScroll = () => {
    const now = Date.now();
    if (now - this.lastScrollScanAt >= SCROLL_SCAN_INTERVAL_MS) {
      this.lastScrollScanAt = now;
      this.rawOnChange({ reason: "scroll" });
    }
    this.onScrollChange();
  };

  handleRouteChange = () => {
    if (this.lastUrl === location.href) return;
    this.lastUrl = location.href;
    this.onRouteChange({ url: location.href });
    this.onChange({ reason: "route" });
  };

  patchHistory() {
    if (window.__CIE_HISTORY_PATCHED__) return;
    window.__CIE_HISTORY_PATCHED__ = true;
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = (...args) => {
        const result = original.apply(history, args);
        window.dispatchEvent(new Event("popstate"));
        return result;
      };
    }
  }
}
