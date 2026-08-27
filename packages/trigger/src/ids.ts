let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  const entropy =
    typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${entropy}`;
}

export function newBundleId(): string {
  return nextId('bdl');
}

export function newSelectionId(): string {
  return nextId('sel');
}
