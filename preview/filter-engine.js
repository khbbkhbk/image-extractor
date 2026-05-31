function list(value = "") {
  return String(value).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

export function filterImages(images, filters = {}) {
  const search = String(filters.search || "").toLowerCase().trim();
  const includes = list(filters.includeKeywords);
  const excludes = list(filters.excludeKeywords);
  const domain = String(filters.domain || "").toLowerCase().trim();
  const formats = new Set(filters.formats || []);
  const minKb = Number(filters.minKb || 0);
  const maxMb = Number(filters.maxMb || 0);

  return images.filter((image) => {
    const haystack = `${image.url} ${image.filename || ""} ${image.node || ""} ${image.alt || ""}`.toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (domain && !image.url.toLowerCase().includes(domain)) return false;
    if (includes.length && !includes.some((word) => haystack.includes(word))) return false;
    if (excludes.length && excludes.some((word) => haystack.includes(word))) return false;
    if (formats.size && !formats.has((image.ext || image.format || "").toLowerCase())) return false;
    if (minKb > 0 && image.bytes > 0 && image.bytes < minKb * 1024) return false;
    if (maxMb > 0 && image.bytes > 0 && image.bytes > maxMb * 1024 * 1024) return false;
    return true;
  });
}

export function sortImages(images, sortBy = "pageIndex") {
  const sorted = [...images];
  if (sortBy === "resolution") {
    sorted.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  } else if (sortBy === "width") {
    sorted.sort((a, b) => b.width - a.width);
  } else if (sortBy === "height") {
    sorted.sort((a, b) => b.height - a.height);
  } else if (sortBy === "url") {
    sorted.sort((a, b) => a.url.localeCompare(b.url));
  } else {
    sorted.sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));
  }
  return sorted;
}
