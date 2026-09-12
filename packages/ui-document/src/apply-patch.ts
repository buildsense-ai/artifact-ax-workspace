import type { Catalog, UiDocument, UiNode, UiNodeUpdate, UiPatchOp } from './types.js';
import { validatePatchStructure } from './patch-structure.js';
import { validateDocument, validateNode } from './validate.js';
import { CATALOG as catalogDef } from './catalog.js';

/**
 * Validated patch application for the UI-document contract.
 *
 * A builder may propose a patch; this module validates every op against the
 * *cumulative* document as it applies and runs `validateDocument` on the final
 * result. The whole patch is atomic: if any op would make the resulting
 * document invalid — whether a duplicate node/region id or an invalid
 * cross-op outcome — the entire patch is rejected with `invalid_patch` and the
 * source document is never mutated. The V1 boundary is draft-only: patches are
 * validated and applied to the in-memory document (a local builder surface),
 * never written into a production manifest or task/result contract.
 */

export type PatchResult =
  | { ok: true; document: UiDocument; applied: number }
  | { ok: false; code: string; message: string };

function cloneNode(node: UiNode): UiNode {
  return JSON.parse(JSON.stringify(node)) as UiNode;
}

function validatePatchShape(patch: unknown, document: UiDocument): string[] {
  const structureErrors = validatePatchStructure(patch);
  if (structureErrors.length > 0) return structureErrors;
  if ((patch as { document_id: string }).document_id !== document.id) return ['patch.document_id must match the target document id'];
  if ((patch as { base_revision: number }).base_revision !== document.revision) return [`patch.base_revision ${(patch as { base_revision: number }).base_revision} does not match document revision ${document.revision}`];
  return [];
}

/** Validate one op against the *current* (cumulative) working nodes. */
function validateOp(op: UiPatchOp, nodes: UiNode[], catalog: Catalog): string[] {
  if (op.op === 'insert') {
    if (!Number.isInteger(op.index) || op.index < 0 || op.index > nodes.length) {
      return ['insert index is out of range'];
    }
    if (nodes.some((n) => n.id === op.node.id)) {
      return [`insert: node id "${op.node.id}" already exists in the document`];
    }
    return validateNode(op.node, catalog);
  }
  if (op.op === 'update') {
    const target = nodes.find((node) => node.id === op.id);
    if (!target) return [`update: node "${op.id}" does not exist`];
    const def = catalog[target.kind];
    if (!def) return [`update: node "${op.id}" has an unknown catalog kind "${target.kind}"`];
    if (op.update !== undefined && op.update !== null && typeof op.update !== 'object') {
      return ['update must be an object'];
    }
    const errors: string[] = [];
    const update = op.update ?? {};
    const allowedProps = new Set(Object.keys(def.props));
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
    const candidate: UiNode = {
      ...target,
      props: { ...(target.props ?? {}), ...(update.props ?? {}) },
      bindings: { ...(target.bindings ?? {}), ...(update.bindings ?? {}) },
      events: { ...(target.events ?? {}), ...(update.events ?? {}) },
    };
    errors.push(...validateNode(candidate, catalog));
    return errors;
  }
  if (op.op === 'remove') {
    if (!nodes.some((node) => node.id === op.id)) return [`remove: node "${op.id}" does not exist`];
    return [];
  }
  return ['unknown patch op'];
}

/** Apply a patch against a cloned working copy, validating at each step and at the cumulative boundary. */
function simulateApply(
  document: UiDocument,
  ops: UiPatchOp[],
  catalog: Catalog,
): { nodes: UiNode[]; applied: number; errors: string[] } {
  let nodes = document.nodes.map(cloneNode);
  let applied = 0;
  for (const op of ops) {
    const opErrors = validateOp(op, nodes, catalog);
    if (opErrors.length > 0) return { nodes, applied, errors: opErrors };
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
  // The cumulative result must itself be a valid document (no duplicate node or
  // region ids, no invalid cross-op outcome). These errors were previously lost.
  const docErrors = validateDocument(next, catalog);
  return { nodes, applied, errors: docErrors };
}

/** Read-only validation; a patch is valid iff it applies cleanly to a cumulative result. */
export function validatePatch(patch: unknown, document: UiDocument, catalog: Catalog = catalogDef): string[] {
  const shapeErrors = validatePatchShape(patch, document);
  if (shapeErrors.length > 0) return shapeErrors;
  const ops = (patch as { ops: UiPatchOp[] }).ops;
  return simulateApply(document, ops, catalog).errors;
}

/**
 * Apply a validated patch atomically, producing a new document at
 * `revision + 1`. The original is never mutated; on any cumulative invalid
 * outcome the patch is rejected with `invalid_patch`.
 */
export function applyPatch(document: UiDocument, patch: unknown, catalog: Catalog = catalogDef): PatchResult {
  const shapeErrors = validatePatchShape(patch, document);
  if (shapeErrors.length > 0) return { ok: false, code: 'invalid_patch', message: shapeErrors[0]! };
  const ops = (patch as { ops: UiPatchOp[] }).ops;
  const { nodes, applied, errors } = simulateApply(document, ops, catalog);
  if (errors.length > 0) return { ok: false, code: 'invalid_patch', message: errors[0]! };
  return { ok: true, document: { ...document, revision: document.revision + 1, nodes }, applied };
}
