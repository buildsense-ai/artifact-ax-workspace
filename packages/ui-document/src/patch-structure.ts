import { UI_DOCUMENT_PATCH_CONTRACT_VERSION } from './types.js';

/** Shared limits for staging, storage, and application (UTF-16 serialized characters). */
export const UI_DOCUMENT_PATCH_MAX_OPS = 32;
export const UI_DOCUMENT_PATCH_MAX_SERIALIZED_CHARS = 8_192;

const PATCH_KEYS = new Set(['contract_version', 'document_id', 'base_revision', 'ops']);
const NODE_KEYS = new Set(['id', 'kind', 'placement', 'props', 'bindings', 'events', 'children']);
const OP_KEYS = {
  insert: new Set(['op', 'index', 'node']),
  update: new Set(['op', 'id', 'update']),
  remove: new Set(['op', 'id']),
};
const UPDATE_FIELDS = new Set(['props', 'bindings', 'events']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBoundedName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

/** Only primitive props and string bindings/events; catalog meaning is checked later. */
function validateFields(value: unknown, field: string): string[] {
  if (!isPlainObject(value)) return [`${field} must be an object`];
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return [`${field} contains an unsafe key`];
    const primitive = typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item));
    if (field === 'props' ? !primitive : typeof item !== 'string') return [`${field}.${key} has an invalid value`];
  }
  return [];
}

/** Closed node shape shared with document validation; no catalog/application policy. */
export function validateNodeStructure(node: unknown, depth = 0): string[] {
  if (depth > 32) return ['node children are too deeply nested'];
  if (!isPlainObject(node)) return ['node must be a plain object'];
  if (hasUnknownKeys(node, NODE_KEYS)) return ['node contains an unknown field'];
  if (!isBoundedName(node.id) || !isBoundedName(node.kind)) return ['node id and kind must be bounded non-empty strings'];
  if (node.placement !== undefined && node.placement !== 'main' && node.placement !== 'side' && node.placement !== 'full') return ['node.placement must be one of main/side/full'];
  for (const field of UPDATE_FIELDS) {
    if (node[field] === undefined) continue;
    const errors = validateFields(node[field], field);
    if (errors.length > 0) return errors;
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) return ['node.children must be an array'];
    for (const child of node.children) {
      const errors = validateNodeStructure(child, depth + 1);
      if (errors.length > 0) return errors;
    }
  }
  return [];
}

function validateOpStructure(op: unknown): string[] {
  if (!isPlainObject(op)) return ['each op must be a non-null plain object'];
  if (op.op !== 'insert' && op.op !== 'update' && op.op !== 'remove') return ['op.op must be one of insert/update/remove'];
  if (hasUnknownKeys(op, OP_KEYS[op.op])) return [`${op.op} op contains an unknown field`];
  if (op.op === 'insert') {
    if (typeof op.index !== 'number' || !Number.isSafeInteger(op.index) || op.index < 0) return ['insert op.index must be a non-negative integer'];
    return validateNodeStructure(op.node);
  }
  if (!isBoundedName(op.id)) return [`${op.op} op.id must be a bounded non-empty string`];
  if (op.op === 'remove') return [];
  if (!isPlainObject(op.update)) return ['update op requires an update object'];
  const update = op.update;
  const fields = Object.keys(update);
  if (hasUnknownKeys(update, UPDATE_FIELDS)) return ['update op.update contains an unknown field'];
  if (fields.length === 0) return ['update op.update is empty; provide at least one of props/bindings/events'];
  for (const field of fields) {
    const errors = validateFields(update[field], field);
    if (errors.length > 0) return errors;
  }
  if (fields.every((field) => Object.keys(update[field] as object).length === 0)) return ['update op must change at least one of props/bindings/events; no-op updates are rejected'];
  return [];
}

/** Shared closed patch shape; target revision and cumulative semantics are checked at apply. */
export function validatePatchStructure(patch: unknown): string[] {
  try {
    if (!isPlainObject(patch)) return ['patch must be an object'];
    if (hasUnknownKeys(patch, PATCH_KEYS)) return ['patch contains an unknown field'];
    if (patch.contract_version !== UI_DOCUMENT_PATCH_CONTRACT_VERSION) return [`patch.contract_version must be ${UI_DOCUMENT_PATCH_CONTRACT_VERSION}`];
    if (!isBoundedName(patch.document_id)) return ['patch.document_id must be a bounded non-empty string'];
    if (typeof patch.base_revision !== 'number' || !Number.isSafeInteger(patch.base_revision) || patch.base_revision < 0 || patch.base_revision === Number.MAX_SAFE_INTEGER) return ['patch.base_revision must allow a safe non-negative integer successor'];
    if (!Array.isArray(patch.ops) || patch.ops.length === 0) return ['patch.ops must be a non-empty array'];
    if (patch.ops.length > UI_DOCUMENT_PATCH_MAX_OPS) return [`patch.ops must have at most ${UI_DOCUMENT_PATCH_MAX_OPS} operations`];
    // Reject cycles and oversize data before traversing potentially nested nodes.
    if (JSON.stringify(patch).length > UI_DOCUMENT_PATCH_MAX_SERIALIZED_CHARS) return [`patch must be at most ${UI_DOCUMENT_PATCH_MAX_SERIALIZED_CHARS} serialized characters`];
    for (const op of patch.ops) {
      const errors = validateOpStructure(op);
      if (errors.length > 0) return errors;
    }
    return [];
  } catch {
    return ['patch must be bounded JSON-serializable data'];
  }
}
