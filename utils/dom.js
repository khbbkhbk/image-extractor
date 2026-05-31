export const LAZY_ATTRIBUTES = [
  "data-src",
  "data-original",
  "data-lazy-src",
  "data-image",
  "data-url",
  "data-file",
  "data-bg"
];

export function isElementVisible(element) {
  if (!element || !(element instanceof Element)) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
}

export function parseSrcset(srcset = "") {
  return srcset
    .split(",")
    .map((item) => item.trim().split(/\s+/)[0])
    .filter(Boolean);
}

export function getImageCandidatesFromElement(element, customAttributes = []) {
  const attributes = ["src", "currentSrc", "srcset", ...LAZY_ATTRIBUTES, ...customAttributes];
  const values = [];
  for (const attr of attributes) {
    const value = attr === "currentSrc" ? element.currentSrc : element.getAttribute?.(attr);
    if (!value) continue;
    if (attr === "srcset") values.push(...parseSrcset(value));
    else values.push(value);
  }
  return values;
}

export function extractBackgroundUrls(element) {
  const style = getComputedStyle(element);
  const image = style.backgroundImage || "";
  const urls = [];
  const regexp = /url\((['"]?)(.*?)\1\)/g;
  let match;
  while ((match = regexp.exec(image))) {
    if (match[2]) urls.push(match[2]);
  }
  return urls;
}

export function debounce(fn, delay = 250) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
