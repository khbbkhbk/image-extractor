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

export function isExtensionContextInvalidated(error) {
  return String(error?.message || error).includes("Extension context invalidated");
}
