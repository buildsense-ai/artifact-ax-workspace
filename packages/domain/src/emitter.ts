/** Minimal typed emitter (browser-safe; no node dependencies). */

type Handler = (...args: unknown[]) => void;

export class TypedEmitter {
  private listeners = new Map<string, Set<Handler>>();

  on(type: string, handler: Handler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  off(type: string, handler: Handler): void {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type: string, ...args: unknown[]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      handler(...args);
    }
  }
}