const RULE_ID_BASE = 41000;
const PREVIEW_RULE_ID_BASE = 43000;
const MAX_RULES = 80;

export class AntiHotlinkManager {
  async withRules(images, context, config, task) {
    if (!config.antiHotlink?.enabled) return task();
    const rules = await this.buildRules(images, context, config, RULE_ID_BASE);
    if (!rules.length) return task();

    const ruleIds = rules.map((rule) => rule.id);
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: ruleIds,
        addRules: rules
      });
    } catch (error) {
      console.warn("[CIE:anti-hotlink] Failed to install full request header rules, retry without Cookie.", error);
      const fallbackConfig = {
        ...config,
        antiHotlink: { ...config.antiHotlink, includeCookies: false }
      };
      const fallbackRules = await this.buildRules(images, context, fallbackConfig, RULE_ID_BASE);
      try {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: ruleIds,
          addRules: fallbackRules
        });
      } catch (fallbackError) {
        console.warn("[CIE:anti-hotlink] Failed to install request header rules, fallback to normal download.", fallbackError);
        return task();
      }
    }

    try {
      return await task();
    } finally {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds }).catch(console.warn);
    }
  }

  async installPreviewRules(images, context, config) {
    await this.clearPreviewRules();
    if (!config.antiHotlink?.enabled) return { installed: 0 };

    const rules = await this.buildRules(images, context, config, PREVIEW_RULE_ID_BASE);
    if (!rules.length) return { installed: 0 };

    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: this.previewRuleIds(),
        addRules: rules
      });
      return { installed: rules.length };
    } catch (error) {
      console.warn("[CIE:anti-hotlink] Failed to install preview rules, retry without Cookie.", error);
      const fallbackConfig = {
        ...config,
        antiHotlink: { ...config.antiHotlink, includeCookies: false }
      };
      const fallbackRules = await this.buildRules(images, context, fallbackConfig, PREVIEW_RULE_ID_BASE);
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: this.previewRuleIds(),
        addRules: fallbackRules
      });
      return { installed: fallbackRules.length, cookieFallback: true };
    }
  }

  async clearPreviewRules() {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: this.previewRuleIds()
    }).catch(() => {});
  }

  previewRuleIds() {
    return Array.from({ length: MAX_RULES }, (_, index) => PREVIEW_RULE_ID_BASE + index);
  }

  async buildRules(images, context, config, baseId = RULE_ID_BASE) {
    const sourceUrl = this.getSourceUrl(context);
    if (!sourceUrl) return [];

    const sourceOrigin = new URL(sourceUrl).origin;
    const hosts = [...new Set(images.map((image) => this.getHost(image.url)).filter(Boolean))].slice(0, MAX_RULES);

    return Promise.all(hosts.map(async (host, index) => ({
      id: baseId + index,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: await this.buildHeaders(sourceUrl, sourceOrigin, host, config)
      },
      condition: {
        requestDomains: [host],
        resourceTypes: ["main_frame", "sub_frame", "image", "media", "xmlhttprequest", "other"]
      }
    })));
  }

  async buildHeaders(sourceUrl, sourceOrigin, host, config) {
    const headers = [{ header: "Referer", operation: "set", value: sourceUrl }];
    if (config.antiHotlink?.includeOrigin) {
      headers.push({ header: "Origin", operation: "set", value: sourceOrigin });
    }
    const cookie = await this.getCookieHeader(host, config);
    if (cookie) headers.push({ header: "Cookie", operation: "set", value: cookie });
    const userAgent = config.antiHotlink?.userAgent;
    if (userAgent) headers.push({ header: "User-Agent", operation: "set", value: userAgent });
    return headers;
  }

  async getCookieHeader(host, config) {
    if (!config.antiHotlink?.includeCookies || !chrome.cookies?.getAll) return "";
    try {
      const cookies = await chrome.cookies.getAll({ domain: host });
      return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    } catch (error) {
      console.warn("[CIE:anti-hotlink] Failed to read cookies for request header fallback.", error);
      return "";
    }
  }

  getSourceUrl(context) {
    try {
      const url = context.sourceUrl || context.url || "";
      if (!/^https?:\/\//i.test(url)) return "";
      return new URL(url).href;
    } catch {
      return "";
    }
  }

  getHost(url) {
    try {
      const parsed = new URL(url);
      return /^https?:$/i.test(parsed.protocol) ? parsed.hostname : "";
    } catch {
      return "";
    }
  }
}

export const antiHotlinkManager = new AntiHotlinkManager();
