import { configManager } from "../core/config-manager.js";
import { createImageModel } from "../core/image-model.js";
import { getImageCandidatesFromElement, extractBackgroundUrls, isElementVisible } from "../utils/dom.js";
import { resolveUrl, isLikelyImageUrl } from "../utils/url.js";
import { hashString } from "../utils/hash.js";
import { PageParser } from "./page-parser.js";

export class ImageScanner {
  constructor(documentRef = document) {
    this.document = documentRef;
    this.parser = new PageParser(documentRef);
  }

  async scan() {
    const config = await configManager.getConfig();
    const context = this.parser.getContext();
    const images = [];
    const customAttributes = config.scan.customLazyAttributes || [];
    let order = 0;

    for (const element of this.document.querySelectorAll("img,source,[srcset]")) {
      const candidates = getImageCandidatesFromElement(element, customAttributes);
      for (const candidate of candidates) {
        const model = this.createModel(candidate, element, context, order, "html");
        if (model) images.push(model);
      }
      order += 1;
    }

    if (config.scan.includeBackground) {
      for (const element of this.document.querySelectorAll("[style],body,main,section,article,div")) {
        for (const candidate of extractBackgroundUrls(element)) {
          const model = this.createModel(candidate, element, context, order, "background");
          if (model) images.push(model);
        }
        order += 1;
      }
    }

    const filtered = images
      .map((image) => ({ ...image, score: this.parser.scoreImage(image, image.elementRef) }))
      .filter((image) => this.matchesConfig(image, config))
      .map(({ elementRef, ...image }) => image);

    const sorted = this.parser.sortImages(filtered).map((image, index) => ({
      ...image,
      pageIndex: index + 1
    }));

    return { images: sorted, context, scannedAt: new Date().toISOString() };
  }

  createModel(candidate, element, context, order, source) {
    const url = resolveUrl(candidate, location.href);
    if (!url || (!isLikelyImageUrl(url) && !url.startsWith("blob:"))) return null;
    const visualElement = element.tagName?.toLowerCase() === "source"
      ? element.closest("picture")?.querySelector("img") || element.parentElement || element
      : element;
    const rect = visualElement.getBoundingClientRect?.() || { width: 0, height: 0 };
    const width = Number(visualElement.naturalWidth || visualElement.videoWidth || rect.width || 0);
    const height = Number(visualElement.naturalHeight || visualElement.videoHeight || rect.height || 0);
    const visible = isElementVisible(visualElement);
    const node = this.describeNode(element);
    return {
      ...createImageModel({
        url,
        width,
        height,
        naturalWidth: width,
        naturalHeight: height,
        source,
        node,
        visible,
        order,
        pageIndex: order + 1,
        title: context.pageTitle,
        alt: element.getAttribute?.("alt") || "",
        hash: hashString(`${url}:${width}:${height}`)
      }),
      elementRef: element
    };
  }

  matchesConfig(image, config) {
    if (!config.scan.includeInvisible && !image.visible && image.source !== "background") return false;
    if (image.width && image.width < config.scan.minWidth) return false;
    if (image.height && image.height < config.scan.minHeight) return false;
    return true;
  }

  describeNode(element) {
    if (!element) return "unknown";
    const id = element.id ? `#${element.id}` : "";
    const className = typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    return `${element.tagName.toLowerCase()}${id}${className}`;
  }
}
