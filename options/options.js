let config;

const $ = (selector) => document.querySelector(selector);
const status = $("#status");

document.addEventListener("DOMContentLoaded", init);

async function init() {
  await load();
  $("#saveBtn").addEventListener("click", save);
  $("#applyProfileBtn").addEventListener("click", applyProfile);
  $("#resetBtn").addEventListener("click", reset);
  $("#exportBtn").addEventListener("click", exportConfig);
  $("#importInput").addEventListener("change", importConfig);
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
  if (!response.ok) throw new Error(response.error);
  config = response.config;
  bindToForm();
}

function bindToForm() {
  $("#profileSelect").value = config.profileName || "comic";
  $("#displayMode").value = config.ui?.displayMode || "popup";
  $("#minWidth").value = config.scan.minWidth;
  $("#minHeight").value = config.scan.minHeight;
  $("#includeBackground").checked = config.scan.includeBackground;
  $("#customLazyAttributes").value = (config.scan.customLazyAttributes || []).join(",");
  $("#mode").value = config.download.mode;
  $("#concurrency").value = config.download.concurrency;
  $("#retries").value = config.download.retries;
  $("#timeoutMs").value = config.download.timeoutMs;
  $("#requestIntervalMs").value = config.download.requestIntervalMs;
  $("#conflictAction").value = config.download.conflictAction;
  $("#format").value = config.download.format;
  $("#filenameTemplate").value = config.download.filenameTemplate;
  $("#includeMetadata").checked = config.download.includeMetadata;
  $("#singleUseSourceFilename").checked = config.download.singleUseSourceFilename !== false;
  $("#antiHotlinkEnabled").checked = config.download.antiHotlink?.enabled !== false;
}

function readForm() {
  return {
    ...config,
    ui: {
      ...(config.ui || {}),
      displayMode: $("#displayMode").value
    },
    profileName: $("#profileSelect").value,
    scan: {
      ...config.scan,
      minWidth: Number($("#minWidth").value),
      minHeight: Number($("#minHeight").value),
      includeBackground: $("#includeBackground").checked,
      customLazyAttributes: $("#customLazyAttributes").value.split(",").map((item) => item.trim()).filter(Boolean)
    },
    download: {
      ...config.download,
      mode: $("#mode").value,
      concurrency: Number($("#concurrency").value),
      retries: Number($("#retries").value),
      timeoutMs: Number($("#timeoutMs").value),
      requestIntervalMs: Number($("#requestIntervalMs").value),
      conflictAction: $("#conflictAction").value,
      format: $("#format").value,
      filenameTemplate: $("#filenameTemplate").value,
      includeMetadata: $("#includeMetadata").checked,
      singleUseSourceFilename: $("#singleUseSourceFilename").checked,
      antiHotlink: {
        ...(config.download.antiHotlink || {}),
        enabled: $("#antiHotlinkEnabled").checked
      }
    }
  };
}

async function save() {
  const response = await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: readForm() });
  if (!response.ok) throw new Error(response.error);
  config = response.config;
  setStatus("已保存");
}

async function applyProfile() {
  const response = await chrome.runtime.sendMessage({ type: "APPLY_PROFILE", name: $("#profileSelect").value });
  if (!response.ok) throw new Error(response.error);
  config = response.config;
  bindToForm();
  setStatus("模板已应用");
}

async function reset() {
  const response = await chrome.runtime.sendMessage({ type: "APPLY_PROFILE", name: "comic" });
  if (!response.ok) throw new Error(response.error);
  config = response.config;
  bindToForm();
  setStatus("已重置为漫画模式");
}

function exportConfig() {
  const blob = new Blob([JSON.stringify(readForm(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "comic-image-extractor-profile.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

async function importConfig(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const imported = JSON.parse(await file.text());
  const response = await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: imported });
  if (!response.ok) throw new Error(response.error);
  config = response.config;
  bindToForm();
  setStatus("已导入配置");
}

function setStatus(text) {
  status.textContent = text;
  setTimeout(() => {
    if (status.textContent === text) status.textContent = "";
  }, 2500);
}

window.addEventListener("unhandledrejection", (event) => setStatus(event.reason?.message || String(event.reason)));
window.addEventListener("error", (event) => setStatus(event.message));
