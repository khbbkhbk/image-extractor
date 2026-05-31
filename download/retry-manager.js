export class HttpStatusError extends Error {
  constructor(response) {
    super(`HTTP ${response.status} ${response.statusText}`);
    this.name = "HttpStatusError";
    this.status = response.status;
    this.statusText = response.statusText;
  }
}

export async function withRetry(task, { retries = 2, timeoutMs = 25000, onRetry } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(task(attempt), timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        onRetry?.(error, attempt + 1);
        await delay(400 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

export async function fetchWithRetry(url, options = {}) {
  return withRetry(async () => {
    const response = await fetch(url, { credentials: "include", cache: "force-cache" });
    if (!response.ok) throw new HttpStatusError(response);
    return response;
  }, options);
}

function withTimeout(promise, timeoutMs) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
