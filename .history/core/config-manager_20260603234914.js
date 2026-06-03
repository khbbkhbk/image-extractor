import { storage } from "../storage/storage.js";
import { clampNumber } from "../utils/format.js";

export const PRESET_EXCLUDE_KEYWORDS = ["logo", "icon", "sprite", "avatar", "ads", "ad", "banner", "thumb", "cover-small"];

export const DEFAULT_CONFIG = {
  profileName: "comic",
  scan: {
    customLazyAttributes: [],
    includeBackground: true,
    includeInvisible: false,
    autoObserve: true,
    autoScroll: false,
    minWidth: 0,
    minHeight: 0,
    maxChapterPages: 30
  },
  preview: {
    layout: "grid",
    size: "medium",
    sortBy: "pageIndex",
    dedupeMode: "keep-one",
    search: "",
    excludeKeywords: "",
    includeKeywords: "",
    domain: "",
    formats: [],
    sizeFilteringEnabled: false,
    minWidth: 0,
    minHeight: 0,
    maxWidth: 0,
    maxHeight: 0,
    minKb: 0,
    maxMb: 0
  },
  download: {
    mode: "single",
    concurrency: 5,
    retries: 2,
    timeoutMs: 25000,
    requestIntervalMs: 800,
    conflictAction: "uniquify",
    filenameTemplate: "{comic}/{chapter}/{index:3}.{ext}",
    singleUseSourceFilename: true,
    includeMetadata: false,
    format: "original",
    quality: 0.92,
    antiHotlink: {
      enabled: true,
      includeOrigin: false,
      includeCookies: true,
      userAgent: ""
    }
  },
  logging: {
    level: "info"
  },
  ui: {
    displayMode: "sidePanel"
  },
  settingsVersion: 6
};

export const CONFIG_PROFILES = {
  comic: {
    profileName: "comic",
    scan: { minWidth: 0, minHeight: 0, includeBackground: false },
    preview: { excludeKeywords: "" },
    download: { mode: "single", singleUseSourceFilename: true, filenameTemplate: "{comic}/{chapter}/{index:3}.{ext}" }
  },
  generic: {
    profileName: "generic",
    scan: { minWidth: 0, minHeight: 0, includeBackground: true },
    download: { mode: "single", filenameTemplate: "{site}/{pageTitle}/{index:3}.{ext}" }
  },
  ecommerce: {
    profileName: "ecommerce",
    scan: { minWidth: 0, minHeight: 0, includeBackground: true },
    preview: { excludeKeywords: "" },
    download: { mode: "zip", filenameTemplate: "{site}/{pageTitle}/{index:3}.{ext}" }
  },
  minimal: {
    profileName: "minimal",
    scan: { minWidth: 0, minHeight: 0, includeBackground: false },
    preview: { excludeKeywords: "" },
    download: { mode: "single", filenameTemplate: "{index:3}.{ext}" }
  }
};

function mergeDeep(base, patch) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) output[key] = mergeDeep(output[key] || {}, value);
    else output[key] = value;
  }
  return output;
}

export class ConfigManager {
  async getConfig() {
    const saved = await storage.get("config", {});
    return this.normalize(mergeDeep(DEFAULT_CONFIG, this.migrate(saved)));
  }

  async saveConfig(config) {
    const normalized = this.normalize(mergeDeep(DEFAULT_CONFIG, config));
    await storage.set({ config: normalized });
    return normalized;
  }

  async applyProfile(name) {
    const current = await this.getConfig();
    const config = mergeDeep(DEFAULT_CONFIG, CONFIG_PROFILES[name] || CONFIG_PROFILES.comic);
    config.ui = current.ui || DEFAULT_CONFIG.ui;
    return this.saveConfig(config);
  }

  async reset() {
    await storage.set({ config: DEFAULT_CONFIG });
    return DEFAULT_CONFIG;
  }

  normalize(config) {
    return {
      ...config,
      scan: {
        ...config.scan,
        minWidth: clampNumber(config.scan.minWidth, 0, 10000, DEFAULT_CONFIG.scan.minWidth),
        minHeight: clampNumber(config.scan.minHeight, 0, 10000, DEFAULT_CONFIG.scan.minHeight),
        maxChapterPages: clampNumber(config.scan.maxChapterPages, 1, 500, DEFAULT_CONFIG.scan.maxChapterPages)
      },
      preview: {
        ...config.preview,
        dedupeMode: ["none", "keep-one", "remove-all"].includes(config.preview?.dedupeMode)
          ? config.preview.dedupeMode
          : DEFAULT_CONFIG.preview.dedupeMode,
        excludeKeywords: String(config.preview?.excludeKeywords || ""),
        formats: Array.isArray(config.preview?.formats)
          ? [...new Set(config.preview.formats.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
          : [],
        sizeFilteringEnabled: Boolean(config.preview?.sizeFilteringEnabled),
        minWidth: clampNumber(config.preview?.minWidth, 0, 10000, DEFAULT_CONFIG.preview.minWidth),
        minHeight: clampNumber(config.preview?.minHeight, 0, 10000, DEFAULT_CONFIG.preview.minHeight),
        maxWidth: clampNumber(config.preview?.maxWidth, 0, 10000, DEFAULT_CONFIG.preview.maxWidth),
        maxHeight: clampNumber(config.preview?.maxHeight, 0, 10000, DEFAULT_CONFIG.preview.maxHeight),
        minKb: clampNumber(config.preview?.minKb, 0, 102400, DEFAULT_CONFIG.preview.minKb),
        maxMb: clampNumber(config.preview?.maxMb, 0, 102400, DEFAULT_CONFIG.preview.maxMb)
      },
      download: {
        ...config.download,
        concurrency: clampNumber(config.download.concurrency, 1, 20, DEFAULT_CONFIG.download.concurrency),
        retries: clampNumber(config.download.retries, 0, 10, DEFAULT_CONFIG.download.retries),
        timeoutMs: clampNumber(config.download.timeoutMs, 3000, 120000, DEFAULT_CONFIG.download.timeoutMs),
        requestIntervalMs: clampNumber(config.download.requestIntervalMs, 0, 60000, DEFAULT_CONFIG.download.requestIntervalMs),
        quality: clampNumber(config.download.quality, 0.1, 1, DEFAULT_CONFIG.download.quality)
      }
    };
  }

  migrate(saved) {
    const migrated = mergeDeep({}, saved || {});
    const savedVersion = Number(saved?.settingsVersion || 0);
    const isOldAutoDefault = !Object.prototype.hasOwnProperty.call(migrated.download || {}, "singleUseSourceFilename")
      && migrated.download?.mode === "auto";
    if (isOldAutoDefault) {
      migrated.download = {
        ...migrated.download,
        mode: "single",
        singleUseSourceFilename: true,
        requestIntervalMs: DEFAULT_CONFIG.download.requestIntervalMs
      };
    }
    migrated.settingsVersion = DEFAULT_CONFIG.settingsVersion;
    if (!saved?.ui?.displayMode || savedVersion < 4) {
      migrated.ui = { ...(migrated.ui || {}), displayMode: DEFAULT_CONFIG.ui.displayMode };
    }
    if (savedVersion < 5) {
      migrated.download = {
        ...(migrated.download || {}),
        includeMetadata: DEFAULT_CONFIG.download.includeMetadata
      };
    }
    if (savedVersion < 6) {
      migrated.scan = {
        ...(migrated.scan || {}),
        minWidth: DEFAULT_CONFIG.scan.minWidth,
        minHeight: DEFAULT_CONFIG.scan.minHeight
      };
      migrated.preview = {
        ...(migrated.preview || {}),
        excludeKeywords: DEFAULT_CONFIG.preview.excludeKeywords,
        formats: DEFAULT_CONFIG.preview.formats,
        sizeFilteringEnabled: DEFAULT_CONFIG.preview.sizeFilteringEnabled,
        minWidth: DEFAULT_CONFIG.preview.minWidth,
        minHeight: DEFAULT_CONFIG.preview.minHeight,
        maxWidth: DEFAULT_CONFIG.preview.maxWidth,
        maxHeight: DEFAULT_CONFIG.preview.maxHeight
      };
    }
    return migrated;
  }
}

export const configManager = new ConfigManager();
