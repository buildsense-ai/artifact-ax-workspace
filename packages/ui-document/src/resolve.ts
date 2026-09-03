import type { UiDocument, UiNode } from './types.js';

/**
 * Resolve a data-binding dot-path against a projection-derived view model.
 *
 * Binding paths are validated by `validate.ts` to be safe identifier paths, so
 * this resolver only walks plain segments. It never touches `__proto__`,
 * `prototype`, or `constructor`, and never executes anything.
 */

function isSafeSegment(segment: string): boolean {
  return segment !== '__proto__' && segment !== 'prototype' && segment !== 'constructor';
}

export function resolvePath(model: unknown, path: string): unknown {
  if (!path) return undefined;
  if (model === null || model === undefined) return undefined;
  const segments = path.split('.');
  let current: unknown = model;
  for (const segment of segments) {
    if (!isSafeSegment(segment)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Resolve every binding declared on a node into a `{ bindingName: value }` map. */
export function resolveNodeBindings(node: UiNode, model: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!node.bindings) return out;
  for (const [name, path] of Object.entries(node.bindings)) {
    out[name] = resolvePath(model, path);
  }
  return out;
}

/** Resolve bindings for every node in a document, keyed by node id. */
export function resolveDocumentBindings(document: UiDocument, model: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const node of document.nodes) {
    out[node.id] = resolveNodeBindings(node, model);
  }
  return out;
}

/** A resolved binding value guaranteed to be a list (or an empty list). */
export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A resolved binding value guaranteed to be a record (or an empty record). */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

/** A resolved binding value guaranteed to be a string (numbers/booleans stringify). */
export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}
