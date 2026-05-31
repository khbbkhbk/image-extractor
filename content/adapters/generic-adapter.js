import { BaseAdapter } from "./base-adapter.js";

export class GenericAdapter extends BaseAdapter {
  match() {
    return true;
  }

  scoreImage(image, element) {
    let score = 0;
    if (image.width >= 300 && image.height >= 200) score += 20;
    if (image.visible) score += 10;
    const text = `${image.url} ${element?.className || ""} ${element?.id || ""}`.toLowerCase();
    if (/logo|icon|sprite|avatar/.test(text)) score -= 20;
    return score;
  }
}
