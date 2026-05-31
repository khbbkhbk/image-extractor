import { configManager } from "../core/config-manager.js";

const POPUP_PATH = "popup/popup.html";

export class DisplayModeManager {
  async applyFromConfig() {
    const config = await configManager.getConfig();
    return this.apply(config.ui?.displayMode || "popup");
  }

  async apply(displayMode = "popup") {
    const mode = displayMode === "sidePanel" ? "sidePanel" : "popup";
    if (mode === "sidePanel") {
      await chrome.action.setPopup({ popup: "" });
      await this.setPanelBehavior(true);
    } else {
      await chrome.action.setPopup({ popup: POPUP_PATH });
      await this.setPanelBehavior(false);
    }
    return mode;
  }

  async toggle() {
    const config = await configManager.getConfig();
    const current = config.ui?.displayMode || "popup";
    const next = current === "sidePanel" ? "popup" : "sidePanel";
    const saved = await configManager.saveConfig({
      ...config,
      ui: {
        ...(config.ui || {}),
        displayMode: next
      }
    });
    await this.apply(next);
    return saved.ui.displayMode;
  }

  async openSidePanel(tabId) {
    if (!chrome.sidePanel?.open || !tabId) return false;
    await chrome.sidePanel.open({ tabId });
    return true;
  }

  async setPanelBehavior(openPanelOnActionClick) {
    if (!chrome.sidePanel?.setPanelBehavior) return false;
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick });
      return true;
    } catch (error) {
      console.warn("[CIE:display-mode] sidePanel behavior is not available in this browser.", error);
      return false;
    }
  }
}

export const displayModeManager = new DisplayModeManager();
