import { storage } from "./storage.js";

const HISTORY_KEY = "downloadHistory";

export async function addHistory(entry) {
  const history = await storage.get(HISTORY_KEY, []);
  history.unshift({ ...entry, createdAt: new Date().toISOString() });
  await storage.set({ [HISTORY_KEY]: history.slice(0, 100) });
}

export async function getHistory() {
  return storage.get(HISTORY_KEY, []);
}
