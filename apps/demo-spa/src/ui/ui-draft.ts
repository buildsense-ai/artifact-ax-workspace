import { applyPatch, validateDocument, type UiDocument } from '@artifact-ax/ui-document';

/**
 * The V1 draft/patch boundary for a builder.
 *
 * This is purely local/draft-only: it validates a proposed patch against the
 * fixed catalog and applies it to the in-memory document, then the SPA
 * re-renders. It never writes into the production manifest, the XiaoBa task/
 * result contract, or any cats-company surface. Because every op must pass the
 * catalog allowlists (props/bindings/events) and reject raw executable inputs,
 * a builder cannot introduce arbitrary HTML/JS/CSS through this path.
 */

export type DraftApplyResult =
  | { ok: true; document: UiDocument; applied: number }
  | { ok: false; code: string; message: string };

/** Apply a UI-document patch to a base document; the base is never mutated. */
export function applyUiDocumentPatch(base: UiDocument, patch: unknown): DraftApplyResult {
  return applyPatch(base, patch);
}

/** Validate a proposed document (used when a builder hands over a full draft). */
export function checkUiDocument(document: UiDocument): string[] {
  return validateDocument(document);
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
