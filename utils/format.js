export function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function padNumber(value, width = 3) {
  return String(value).padStart(width, "0");
}

export function formatDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function formatTime(date = new Date()) {
  return date.toTimeString().slice(0, 8).replaceAll(":", "");
}

export function sanitizePathSegment(value = "") {
  return String(value)
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
