import { applyPatch, validateDocument, type UiDocument } from '@artifact-ax/ui-document';
import { LESSON_REPORT_DOCUMENT } from './lesson-report.document.js';

/**
 * The V1 draft/patch boundary for a builder.
 *
 * This is purely local/draft-only: it validates a proposed patch against the
 * fixed catalog and applies it to the in-memory document, then the SPA
 * re-renders. It never writes into the production manifest, the XiaoBa task/
 * result contract, or any cats-company surface. Because every op must pass the
 * catalog allowlists (props/bindings/events) and reject raw executable inputs,
 * a builder cannot introduce arbitrary HTML/JS/CSS through this path.
 *
 * Additionally, the patch cannot drift the *stable anchors* away from the
 * deployed lesson-report document: the resulting document's node ids and region
 * ids must stay within the known set. Under the fixed-catalog promise a builder
 * may update or remove existing surfaces, but may not invent arbitrary unknown
 * stable regions/nodes.
 */

export type DraftApplyResult =
  | { ok: true; document: UiDocument; applied: number }
  | { ok: false; code: string; message: string };

/** Known stable node ids from the deployed lesson-report document. */
export const KNOWN_NODE_IDS = new Set(LESSON_REPORT_DOCUMENT.nodes.map((node) => node.id));
/** Known stable region ids from the deployed lesson-report document. */
export const KNOWN_REGION_IDS = new Set(
  LESSON_REPORT_DOCUMENT.nodes.map((node) => String((node.props as { regionId?: string } | undefined)?.regionId ?? node.id)),
);

/** Errors if a document introduces node/region anchors outside the deployed set. */
export function anchorDriftErrors(document: UiDocument): string[] {
  const errors: string[] = [];
  for (const node of document.nodes) {
    if (!KNOWN_NODE_IDS.has(node.id)) {
      errors.push(`node id "${node.id}" is not a known deployed lesson-report node`);
    }
    const regionId = (node.props as { regionId?: string } | undefined)?.regionId;
    if (typeof regionId === 'string' && !KNOWN_REGION_IDS.has(regionId)) {
      errors.push(`region id "${regionId}" is not a known deployed lesson-report region`);
    }
  }
  return errors;
}

/**
 * Node ids a formal patch must always retain. These are the governance
 * surfaces of the application: the human review table, the human approval
 * panel, and the Builder panel that gates Agent patches behind a human
 * apply/discard decision. A proposal that would remove any of them is rejected
 * with code `protected_surface` — never silently applied or staged.
 */
export const PROTECTED_NODE_IDS: readonly string[] = ['review-table', 'approval-list', 'ui-builder'];

/** Protected node ids missing from a document (empty means all retained). */
export function missingProtectedNodes(document: UiDocument): string[] {
  const present = new Set(document.nodes.map((node) => node.id));
  return PROTECTED_NODE_IDS.filter((id) => !present.has(id));
}

/** Errors for every protected governance surface a patch would remove. */
export function protectedSurfaceErrors(base: UiDocument, patch: unknown): string[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return [];
  const ops = (patch as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return [];
  const present = new Set(base.nodes.map((node) => node.id));
  const removed = new Set<string>();
  for (const op of ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
    const candidate = op as { op?: unknown; id?: unknown };
    if (candidate.op !== 'remove' || typeof candidate.id !== 'string') continue;
    if (PROTECTED_NODE_IDS.includes(candidate.id) && present.has(candidate.id)) removed.add(candidate.id);
  }
  return [...removed].map((id) => `node "${id}" is a protected governance surface and cannot be removed`);
}

/** Apply a UI-document patch to a base document; the base is never mutated. */
export function applyUiDocumentPatch(base: UiDocument, patch: unknown): DraftApplyResult {
  // Governance surfaces are protected before any other validation so a patch
  // that would hide them is always rejected, with a specific code.
  const protectedErrors = protectedSurfaceErrors(base, patch);
  if (protectedErrors.length > 0) return { ok: false, code: 'protected_surface', message: protectedErrors[0]! };
  const result = applyPatch(base, patch);
  if (!result.ok) return result;
  const drift = anchorDriftErrors(result.document);
  if (drift.length > 0) return { ok: false, code: 'anchor_drift', message: drift[0]! };
  return result;
}

/** Validate a proposed document (used when a builder hands over a full draft). */
export function checkUiDocument(document: UiDocument): string[] {
  return [...validateDocument(document), ...anchorDriftErrors(document)];
}

/** Read a draft patch from the `?ui_patch=<urlencoded JSON>` query, if present. */
export function readDraftPatchParam(): unknown {
  if (typeof window === 'undefined') return undefined;
  try {
    const encoded = new URLSearchParams(window.location.search).get('ui_patch');
    if (!encoded) return undefined;
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return undefined;
  }
}
