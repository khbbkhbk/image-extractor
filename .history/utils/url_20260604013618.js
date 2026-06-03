export function resolveUrl(value, base = location.href) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return trimmed;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return "";
  }
}

export function normalizeUserUrl(value = "") {
  let next = String(value ?? "");
  for (let i = 0; i < 4; i += 1) {
    const prev = next;
    next = next
      .trim()
      .replace(/^`([\s\S]+)`$/u, "$1")
      .replace(/^"([\s\S]+)"$/u, "$1")
      .replace(/^'([\s\S]+)'$/u, "$1")
      .trim();
    if (next === prev) break;
  }
  return next;
}

export function getSiteName(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown-site";
  }
}

export function getExtensionFromUrl(url = "", contentType = "") {
  const byType = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg"
  };
  if (byType[contentType]) return byType[contentType];
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  } catch {
    return "jpg";
  }
}

export function stripUrlNoise(url = "") {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((key) => parsed.searchParams.delete(key));
    return parsed.href;
  } catch {
    return url;
  }
}

export function isLikelyImageUrl(url = "") {
  return /\.(jpe?g|png|webp|gif|avif|svg)(\?|#|$)/i.test(url) || /^data:image\//i.test(url);
}
