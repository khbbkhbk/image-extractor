import { getSiteName } from "../../utils/url.js";

export class BaseAdapter {
  constructor(documentRef = document) {
    this.document = documentRef;
  }

  match() {
    return false;
  }

  scoreImage() {
    return 0;
  }

  getContext() {
    const title = this.document.title || "Untitled";
    return {
      comic: title,
      chapter: this.extractChapterFromTitle(title),
      pageTitle: title,
      site: getSiteName(location.href),
      sourceUrl: location.href,
      mode: "generic"
    };
  }

  sortImages(images) {
    return [...images].sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  extractChapterFromTitle(title = "") {
    const match = title.match(/(第\s*\d+\s*(话|章|回)|chapter\s*\d+|ep\.?\s*\d+)/i);
    return match ? match[0].replace(/\s+/g, "") : title;
  }
}
