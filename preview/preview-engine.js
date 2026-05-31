import { formatBytes } from "../utils/format.js";

export function renderPreview(container, images, state) {
  container.className = `preview ${state.layout || "grid"} ${state.size || "medium"}`;
  container.replaceChildren();

  const fragment = document.createDocumentFragment();
  for (const image of images) {
    const card = document.createElement("article");
    card.className = "image-card";
    card.dataset.id = image.id;
    card.innerHTML = `
      <label class="check">
        <input type="checkbox" ${state.selected.has(image.id) ? "checked" : ""} aria-label="Select image">
      </label>
      <img loading="lazy" src="${escapeAttr(image.previewUrl || placeholderDataUrl())}" alt="${escapeAttr(image.alt || image.filename || "image")}">
      <div class="meta">
        <strong>${escapeHtml(image.filename || `#${image.pageIndex}`)}</strong>
        <span>${image.width || "?"}x${image.height || "?"} · ${(image.ext || "").toUpperCase()} · ${formatBytes(image.bytes)}</span>
        <small title="${escapeAttr(image.url)}">${escapeHtml(image.url)}</small>
      </div>
    `;
    card.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) state.selected.add(image.id);
      else state.selected.delete(image.id);
      state.onSelectionChange?.();
    });
    fragment.append(card);
  }
  container.append(fragment);
}

function placeholderDataUrl() {
  return "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='220' viewBox='0 0 320 220'%3E%3Crect width='320' height='220' fill='%2305070a'/%3E%3Cpath d='M48 154l58-66 46 52 28-31 92 97H48z' fill='%231f2937'/%3E%3Ccircle cx='235' cy='65' r='24' fill='%232d3a4b'/%3E%3Ctext x='160' y='194' text-anchor='middle' fill='%238ea0b5' font-family='Segoe UI, sans-serif' font-size='15'%3EPreview loading%3C/text%3E%3C/svg%3E";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
