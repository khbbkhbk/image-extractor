import { BaseAdapter } from "./base-adapter.js";

const MANGA_HINTS = [
  "comic",
  "manga",
  "manhua",
  "manhwa",
  "chapter",
  "reader",
  "episode",
  "viewer",
  "webtoon",
  "cartoon"
];

export class MangaAdapter extends BaseAdapter {
  match() {
    const haystack = [
      location.hostname,
      location.pathname,
      this.document.title,
      this.document.body?.className || "",
      this.document.querySelector("main")?.className || ""
    ].join(" ").toLowerCase();
    const tallImages = [...this.document.images].filter((img) => img.naturalHeight > img.naturalWidth * 1.25 && img.naturalHeight > 600);
    return MANGA_HINTS.some((hint) => haystack.includes(hint)) || tallImages.length >= 3;
  }

  scoreImage(image, element) {
    let score = 0;
    const text = `${image.url} ${element?.className || ""} ${element?.id || ""}`.toLowerCase();
    if (image.height > image.width) score += 20;
    if (image.width >= 600 || image.height >= 900) score += 20;
    if (/chapter|comic|manga|page|reader|episode|webtoon/.test(text)) score += 20;
    if (/logo|avatar|icon|sprite|banner|ads?/.test(text)) score -= 40;
    return score;
  }

  getContext() {
    const title = this.document.title || "Untitled";
    const heading = this.document.querySelector("h1,h2,.title,.chapter-title,.comic-title")?.textContent?.trim();
    const pathParts = location.pathname.split("/").filter(Boolean);
    const chapter = this.extractChapterFromTitle(heading || title) || pathParts.at(-1) || "chapter";
    const comic = this.extractComicName(title, chapter);
    return {
      ...super.getContext(),
      comic,
      chapter,
      pageTitle: title,
      mode: this.detectMode()
    };
  }

  sortImages(images) {
    return [...images].sort((a, b) => {
      const aNumber = this.extractPageNumber(a.url) ?? a.pageIndex ?? a.order;
      const bNumber = this.extractPageNumber(b.url) ?? b.pageIndex ?? b.order;
      return aNumber - bNumber;
    });
  }

  extractComicName(title, chapter) {
    const cleaned = title.replace(chapter, "").replace(/[-_|].*$/, "").trim();
    return cleaned || title || "comic";
  }

  extractPageNumber(url = "") {
    const decoded = decodeURIComponent(url);
    const matches = [...decoded.matchAll(/(?:^|[^\d])(\d{1,5})(?=\D*(?:jpe?g|png|webp|gif|avif|$))/gi)];
    if (!matches.length) return null;
    return Number(matches.at(-1)[1]);
  }

  detectMode() {
    const images = [...this.document.images];
    const tallCount = images.filter((img) => img.naturalHeight > img.naturalWidth * 1.4).length;
    if (tallCount >= 3) return "long-strip";
    const next = this.document.querySelector('a[rel="next"],a.next,.next-page,button.next,[data-next]');
    return next ? "paged" : "scroll";
  }
}
