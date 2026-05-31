const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(scope = "app", level = "info") {
    this.scope = scope;
    this.level = level;
  }

  child(scope) {
    return new Logger(`${this.scope}:${scope}`, this.level);
  }

  setLevel(level) {
    if (LEVELS[level]) this.level = level;
  }

  shouldLog(level) {
    return LEVELS[level] >= LEVELS[this.level];
  }

  debug(...args) {
    if (this.shouldLog("debug")) console.debug(this.prefix("debug"), ...args);
  }

  info(...args) {
    if (this.shouldLog("info")) console.info(this.prefix("info"), ...args);
  }

  warn(...args) {
    if (this.shouldLog("warn")) console.warn(this.prefix("warn"), ...args);
  }

  error(...args) {
    if (this.shouldLog("error")) console.error(this.prefix("error"), ...args);
  }

  prefix(level) {
    return `[CIE:${this.scope}:${level}]`;
  }
}

export const logger = new Logger("root");
