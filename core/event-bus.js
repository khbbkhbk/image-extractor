export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    const handlers = this.listeners.get(event) || new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[CIE:event-bus] ${event}`, error);
      }
    }
  }
}
