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
      <div class="image-shell">
        <img loading="lazy" src="${escapeAttr(image.previewUrl || placeholderDataUrl())}" alt="${escapeAttr(image.alt || image.filename || "image")}">
        <button class="icon-btn zoom-btn" type="button" aria-label="放大预览" title="放大预览">
          ${zoomIcon()}
        </button>
      </div>
      <div class="meta">
        <strong>${escapeHtml(image.filename || `#${image.pageIndex}`)}</strong>
        <span>${image.width || "?"}x${image.height || "?"} · ${(image.ext || "").toUpperCase()} · ${formatBytes(image.bytes)}</span>
        <label class="url-editor">
          <span>图片地址</span>
          <input class="url-input" type="text" value="${escapeAttr(image.editedUrl || image.url)}" spellcheck="false">
        </label>
        <div class="card-actions">
          <button class="icon-btn copy-url-btn" type="button" aria-label="复制图片地址" title="复制图片地址">
            ${copyIcon()}
          </button>
          <button class="icon-btn open-url-btn" type="button" aria-label="打开图片地址" title="打开图片地址">
            ${openIcon()}
          </button>
        </div>
        <small title="${escapeAttr(image.url)}">${escapeHtml(image.url)}</small>
      </div>
    `;
    card.querySelector(".check input").addEventListener("change", (event) => {
      if (event.target.checked) state.selected.add(image.id);
      else state.selected.delete(image.id);
      state.onSelectionChange?.();
    });
    card.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("button, a, input, textarea, select, .check, .url-editor, .card-actions")) return;
      const checkbox = card.querySelector(".check input");
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    });
    card.querySelector(".url-input").addEventListener("input", (event) => state.onUrlChange?.(image.id, event.target.value));
    card.querySelector(".copy-url-btn").addEventListener("click", () => state.onCopyUrl?.(image.id));
    card.querySelector(".open-url-btn").addEventListener("click", () => state.onOpenUrl?.(image.id));
    card.querySelector(".zoom-btn").addEventListener("click", () => state.onZoom?.(image.id));
    fragment.append(card);
  }
  container.append(fragment);
}

function placeholderDataUrl() {
  return "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='220' viewBox='0 0 320 220'%3E%3Crect width='320' height='220' fill='%2305070a'/%3E%3Cpath d='M48 154l58-66 46 52 28-31 92 97H48z' fill='%231f2937'/%3E%3Ccircle cx='235' cy='65' r='24' fill='%232d3a4b'/%3E%3Ctext x='160' y='194' text-anchor='middle' fill='%238ea0b5' font-family='Segoe UI, sans-serif' font-size='15'%3EPreview loading%3C/text%3E%3C/svg%3E";
}

function copyIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 9h9v11H9z"></path>
      <path d="M6 5h9v2H8v9H6z"></path>
    </svg>
  `;
}

function openIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M14 5h5v5h-2V8.41l-6.29 6.3-1.42-1.42L15.59 7H14z"></path>
      <path d="M6 7h5v2H8v7h7v-3h2v5H6z"></path>
    </svg>
  `;
}

function zoomIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 4a6 6 0 104.47 10.03l4.25 4.24 1.41-1.41-4.24-4.25A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z"></path>
      <path d="M10 8h1v2h2v1h-2v2h-1v-2H8v-1h2z"></path>
    </svg>
  `;
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
