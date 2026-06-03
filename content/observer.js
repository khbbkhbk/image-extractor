import { debounce } from "../utils/dom.js";

export class PageObserver {
  constructor({ onChange, onRouteChange } = {}) {
    this.onChange = debounce(onChange || (() => {}), 500);
    this.onRouteChange = debounce(onRouteChange || (() => {}), 300);
    this.onScrollChange = debounce(() => (onChange || (() => {}))({ reason: "scroll" }), 850);
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
    window.addEventListener("scroll", this.onScrollChange, { passive: true });
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener("popstate", this.handleRouteChange, true);
    window.removeEventListener("scroll", this.onScrollChange);
  }

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
