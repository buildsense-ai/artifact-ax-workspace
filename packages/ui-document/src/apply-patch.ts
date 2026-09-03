import type { Catalog, UiDocument, UiNode, UiNodeUpdate, UiPatchOp } from './types.js';
import { UI_DOCUMENT_PATCH_CONTRACT_VERSION } from './types.js';
import { validateDocument, validateNode, UiDocumentError } from './validate.js';
import { CATALOG as catalogDef, catalogComponent } from './catalog.js';

/**
 * Validated patch application for the UI-document contract.
 *
 * A builder may propose a patch; this module validates every op against the
 * catalog allowlists and a base document revision before producing a new
 * document. The V1 boundary is draft-only: patches are validated and applied to
 * the in-memory document (a local builder surface), never written into a
 * production manifest or task/result contract.
 */

export type PatchResult =
  | { ok: true; document: UiDocument; applied: number }
  | { ok: false; code: string; message: string };

function cloneNode(node: UiNode): UiNode {
  return JSON.parse(JSON.stringify(node)) as UiNode;
}

/** Validate a single op in isolation, returning errors for the offending node. */
function validateOp(op: UiPatchOp, document: UiDocument, catalog: Catalog): string[] {
  if (op.op === 'insert') {
    if (!Number.isInteger(op.index) || op.index < 0 || op.index > document.nodes.length) {
      return ['insert index is out of range'];
    }
    return validateNode(op.node, catalog);
  }
  if (op.op === 'update') {
    const target = document.nodes.find((node) => node.id === op.id);
    if (!target) return [`update: node "${op.id}" does not exist`];
    const def = catalogComponent(target.kind);
    if (!def) return [`update: node "${op.id}" has an unknown catalog kind "${target.kind}"`];
    const errors: string[] = [];
    // Allowlist enforcement for the update fields, matching validate.ts checks.
    if (op.update !== undefined && op.update !== null && typeof op.update !== 'object') {
      return ['update must be an object'];
    }
    const update = op.update ?? {};
    const allowedProps = new Set(Object.keys(def.props));
    const newProps = { ...(target.props ?? {}) , ...(update.props ?? {}) };
    for (const key of Object.keys(update.props ?? {})) {
      if (!allowedProps.has(key)) errors.push(`update: unknown prop "${key}" is not allowed for ${target.kind}`);
    }
    const allowedBindings = new Set(Object.keys(def.bindings));
    for (const key of Object.keys(update.bindings ?? {})) {
      if (!allowedBindings.has(key)) errors.push(`update: unknown binding "${key}" is not allowed for ${target.kind}`);
    }
    const allowedEvents = Object.keys(def.events);
    for (const key of Object.keys(update.events ?? {})) {
      if (!allowedEvents.includes(key)) errors.push(`update: unknown event "${key}" is not allowed for ${target.kind}`);
    }
    // Re-validate the merged node to catch value-level / executable / path issues.
    const candidate = { ...target, props: newProps, bindings: { ...(target.bindings ?? {}), ...(update.bindings ?? {}) }, events: { ...(target.events ?? {}), ...(update.events ?? {}) } };
    errors.push(...validateNode(candidate, catalog));
    return errors;
  }
  if (op.op === 'remove') {
    if (!document.nodes.some((node) => node.id === op.id)) return [`remove: node "${op.id}" does not exist`];
    return [];
  }
  return [`unknown patch op`];
}

export function validatePatch(patch: unknown, document: UiDocument, catalog: Catalog = catalogDef): string[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['patch must be an object'];
  const p = patch as { contract_version: unknown; document_id: unknown; base_revision: unknown; ops: unknown };
  if (p.contract_version !== UI_DOCUMENT_PATCH_CONTRACT_VERSION) {
    return [`patch.contract_version must be ${UI_DOCUMENT_PATCH_CONTRACT_VERSION}`];
  }
  if (typeof p.document_id !== 'string' || p.document_id !== document.id) {
    return ['patch.document_id must match the target document id'];
  }
  if (p.base_revision !== document.revision) {
    return [`patch.base_revision ${String(p.base_revision)} does not match document revision ${document.revision}`];
  }
  if (!Array.isArray(p.ops) || p.ops.length === 0) {
    return ['patch.ops must be a non-empty array'];
  }
  const errors: string[] = [];
  for (const op of p.ops) {
    errors.push(...validateOp(op, document, catalog));
  }
  return errors;
}

/**
 * Apply a validated patch to a document, producing a new document at
 * `revision + 1`. The original is not mutated.
 */
export function applyPatch(document: UiDocument, patch: unknown, catalog: Catalog = catalogDef): PatchResult {
  const errors = validatePatch(patch, document, catalog);
  if (errors.length > 0) return { ok: false, code: 'invalid_patch', message: errors[0]! };
  const p = patch as { ops: UiPatchOp[] };  let nodes = document.nodes.map(cloneNode);
  let applied = 0;
  for (const op of p.ops) {
    if (op.op === 'insert') {
      nodes = [...nodes.slice(0, op.index), cloneNode(op.node), ...nodes.slice(op.index)];
      applied += 1;
    } else if (op.op === 'update') {
      nodes = nodes.map((node) => {
        if (node.id !== op.id) return node;
        const update: UiNodeUpdate = op.update ?? {};
        return {
          ...node,
          ...(update.props !== undefined ? { props: { ...(node.props ?? {}), ...update.props } } : {}),
          ...(update.bindings !== undefined ? { bindings: { ...(node.bindings ?? {}), ...update.bindings } } : {}),
          ...(update.events !== undefined ? { events: { ...(node.events ?? {}), ...update.events } } : {}),
        };
      });
      applied += 1;
    } else if (op.op === 'remove') {
      nodes = nodes.filter((node) => node.id !== op.id);
      applied += 1;
    }
  }
  const next: UiDocument = { ...document, revision: document.revision + 1, nodes };
  try {
    validateDocument(next, catalog);
  } catch (error) {
    const message = error instanceof UiDocumentError ? error.message : error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'invalid_patch', message };
  }
  return { ok: true, document: next, applied };
}
