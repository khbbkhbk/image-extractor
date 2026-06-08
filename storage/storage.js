export const storage = {
  async get(key, fallback = undefined) {
    try {
      const result = await chrome.storage.local.get(key);
      return Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
    } catch (error) {
      if (isExtensionContextInvalidated(error)) return fallback;
      throw error;
    }
  },

  async set(values) {
    try {
      await chrome.storage.local.set(values);
    } catch (error) {
      if (!isExtensionContextInvalidated(error)) throw error;
    }
  },

  async remove(key) {
    try {
      await chrome.storage.local.remove(key);
    } catch (error) {
      if (!isExtensionContextInvalidated(error)) throw error;
    }
  },

  async all() {
    try {
      return await chrome.storage.local.get(null);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) return {};
      throw error;
    }
  }
};

export const sessionStorage = {
  async get(key, fallback = undefined) {
    try {
      const area = getSessionArea();
      if (!area) return fallback;
      const result = await area.get(key);
      return Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
    } catch (error) {
      if (isExtensionContextInvalidated(error)) return fallback;
      throw error;
    }
  },

  async set(values) {
    try {
      const area = getSessionArea();
      if (!area) return;
      await area.set(values);
    } catch (error) {
      if (!isExtensionContextInvalidated(error)) throw error;
    }
  },

  async remove(key) {
    try {
      const area = getSessionArea();
      if (!area) return;
      await area.remove(key);
    } catch (error) {
      if (!isExtensionContextInvalidated(error)) throw error;
    }
  },

  async all() {
    try {
      const area = getSessionArea();
      if (!area) return {};
      return await area.get(null);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) return {};
      throw error;
    }
  }
};

function getSessionArea() {
  return chrome?.storage?.session || null;
}

export function isExtensionContextInvalidated(error) {
  return String(error?.message || error).includes("Extension context invalidated");
}
