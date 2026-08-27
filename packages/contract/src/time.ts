/** RFC3339 timestamp helpers shared by the contract and adapters. */

const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** True when the value parses as an RFC3339 timestamp (with optional ms). */
export function isRFC3339(value: unknown): value is string {
  if (typeof value !== 'string' || !RFC3339_MS.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** Current time as RFC3339 with milliseconds (UTC). */
export function nowRFC3339(): string {
  return new Date().toISOString();
}

/**
 * Parse a timestamp that also tolerates CatsCo-style millisecond precision
 * ("2026-07-22T06:00:00.000Z"). Returns epoch ms.
 */
export function parseRFC3339(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`invalid RFC3339 timestamp: ${value}`);
  }
  return ms;
}

/** Convert an epoch ms to RFC3339 with milliseconds (UTC). */
export function fromEpochMs(ms: number): string {
  return new Date(ms).toISOString();
}