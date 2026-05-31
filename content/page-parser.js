import { MangaAdapter } from "./adapters/manga-adapter.js";
import { GenericAdapter } from "./adapters/generic-adapter.js";

export class PageParser {
  constructor(documentRef = document) {
    this.document = documentRef;
    this.adapters = [new MangaAdapter(documentRef), new GenericAdapter(documentRef)];
  }

  getAdapter() {
    return this.adapters.find((adapter) => adapter.match()) || this.adapters.at(-1);
  }

  getContext() {
    return this.getAdapter().getContext();
  }

  sortImages(images) {
    return this.getAdapter().sortImages(images);
  }

  scoreImage(image, element) {
    return this.getAdapter().scoreImage(image, element);
  }

  findNextPageTarget() {
    return this.document.querySelector('a[rel="next"],a.next,.next-page,button.next,[data-next],a:has(span.next)');
  }
}
