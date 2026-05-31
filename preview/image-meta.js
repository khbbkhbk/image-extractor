import { getExtensionFromUrl } from "../utils/url.js";
import { hashBlob } from "../utils/hash.js";

export function inferImageMeta(image) {
  return {
    ...image,
    ext: image.ext || getExtensionFromUrl(image.url),
    format: image.format || image.ext || getExtensionFromUrl(image.url),
    resolution: image.width && image.height ? `${image.width}x${image.height}` : "Unknown"
  };
}

export async function convertImageBlob(blob, targetFormat = "original", quality = 0.92) {
  if (targetFormat === "original") return { blob, ext: getExtensionFromUrl("", blob.type), hash: await hashBlob(blob) };
  if (!blob.type.startsWith("image/") || /gif|svg/.test(blob.type)) {
    return { blob, ext: getExtensionFromUrl("", blob.type), hash: await hashBlob(blob), warning: "format-not-convertible" };
  }

  const mime = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp"
  }[targetFormat];
  if (!mime) return { blob, ext: getExtensionFromUrl("", blob.type), hash: await hashBlob(blob) };

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { alpha: mime !== "image/jpeg" });
  if (mime === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const converted = await canvas.convertToBlob({ type: mime, quality });
  return { blob: converted, ext: targetFormat === "jpeg" ? "jpg" : targetFormat, hash: await hashBlob(converted) };
}
