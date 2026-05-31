import { storage } from "../storage/storage.js";
import { clampNumber } from "../utils/format.js";

export const DEFAULT_CONFIG = {
  profileName: "comic",
  scan: {
    customLazyAttributes: [],
    includeBackground: true,
    includeInvisible: false,
    autoObserve: true,
    autoScroll: false,
    minWidth: 120,
    minHeight: 120,
    maxChapterPages: 30
  },
  preview: {
    layout: "grid",
    size: "medium",
    sortBy: "pageIndex",
    search: "",
    excludeKeywords: "logo,icon,sprite,avatar,ads,ad,banner,thumb",
    includeKeywords: "",
    domain: "",
    formats: ["jpg", "png", "webp", "gif", "avif", "svg"],
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
  settingsVersion: 5
};

export const CONFIG_PROFILES = {
  comic: {
    profileName: "comic",
    scan: { minWidth: 240, minHeight: 240, includeBackground: false },
    preview: { excludeKeywords: "logo,icon,sprite,avatar,ads,ad,banner,thumb,cover-small" },
    download: { mode: "single", singleUseSourceFilename: true, filenameTemplate: "{comic}/{chapter}/{index:3}.{ext}" }
  },
  generic: {
    profileName: "generic",
    scan: { minWidth: 120, minHeight: 120, includeBackground: true },
    download: { mode: "single", filenameTemplate: "{site}/{pageTitle}/{index:3}.{ext}" }
  },
  ecommerce: {
    profileName: "ecommerce",
    scan: { minWidth: 300, minHeight: 300, includeBackground: true },
    preview: { excludeKeywords: "sprite,icon,logo,avatar" },
    download: { mode: "zip", filenameTemplate: "{site}/{pageTitle}/{index:3}.{ext}" }
  },
  minimal: {
    profileName: "minimal",
    scan: { minWidth: 1, minHeight: 1, includeBackground: false },
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
    return migrated;
  }
}

export const configManager = new ConfigManager();
