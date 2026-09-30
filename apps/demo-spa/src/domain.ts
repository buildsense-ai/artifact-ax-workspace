import type { ReviewRow } from '@artifact-ax/lesson-report';

/**
 * Collaboration domain core — types and pure helpers.
 *
 * State lives in the shared Yjs document (see board.ts); these types are the
 * record shapes the document carries and the validators mutations pass
 * through. Task refs, writeback refs, credentials, and transport envelopes
 * have no place in these records.
 */

export const MAX_WORK_ITEM_ROWS = 3;
export const MAX_TEXT_LENGTH = 500;

export interface CollaborationScope {
  workspaceId: string;
  artifactId: string;
  actorId: string;
}

export interface InputPreparation {
  id: string;
  scope: CollaborationScope;
  stateRevision: number;
  selectedRowIds: string[];
  applicationPreparedRowIds: string[];
  contextTruncatedRowIds: string[];
  filteredOutRowIds: string[];
  missingTargetRowIds: string[];
  platformCoverage: 'unknown';
}

export interface WorkItem {
  id: string;
  scope: CollaborationScope;
  title: string;
  rowIds: string[];
  baselineRevision: number;
  state: 'active' | 'completed' | 'archived';
}

export interface FindingRevision {
  findingId: string;
  workItemId: string;
  revision: number;
  summary: string;
  rowIds: string[];
  evidence: 'missing';
  feedbackIds: string[];
}

export interface FindingFeedback {
  id: string;
  findingId: string;
  findingRevision: number;
  text: string;
  actorId?: string;
}

export interface ComparisonViewProposal {
  id: string;
  workItemId: string;
  baseRevision: number;
  rowIds: string[];
  /**
   * Optional agent-authored declarative view (json-render UiDocument,
   * catalog-validated before staging). Rendered read-only; `Use` still
   * applies only the row-selection recipe.
   */
  document?: import('@artifact-ax/ui-document').UiDocument;
  state: 'staged' | 'used' | 'discarded' | 'stale';
  origin?: 'human' | 'agent';
}

/**
 * A JEV verdict attached to a staged proposal — supplementary evidence for
 * the human Use/Discard decision, never an authorization itself.
 */
export interface ViewJudgment {
  proposalId: string;
  resultId: string;
  verdict: 'allow' | 'flag' | 'abstain';
  rationale: string;
  /** System One confidence (0-1); abstentions carry 1-noul. */
  confidence?: number;
  at: string;
}

/**
 * A human annotation anchored to a rendered surface — the "select a
 * component and comment" channel. Anchors prefer stable semantic ids
 * (ui-document node / row / work item via `data-node-id`) and degrade to a
 * a unique-verified generated selector. Annotations are shared room state +
 * journal entries, so the agent reads them like any other legible signal.
 */
export interface UiAnnotation {
  id: string;
  /** element = click-picked node; region = drag-selected rect. */
  kind?: 'element' | 'region';
  nodeId?: string;
  regionId?: string;
  /** Fallback generated selector (unique-verified, Codex-style). */
  selector?: string;
  /** Viewport rect — always present for regions; elements keep it as evidence. */
  rect?: { x: number; y: number; w: number; h: number };
  /** Region only: rect offset vs the enclosing anchor node at pick time. */
  deltas?: { dx: number; dy: number; dw: number; dh: number };
  excerpt?: string;
  /** Bounded element context (tag/role/name/size) — agent-legible evidence. */
  context?: string;
  text: string;
  actorUid: string;
  at: string;
}

/**
 * A staged agent canvas patch — the agent's answer to an annotation is a
 * UiDocumentPatch against the shared canvas document, validated at
 * materialization and landed only on explicit human Use (never silently).
 */
export interface CanvasPatchProposal {
  id: string;
  /** The `agent/patch:*` state key the proposal materialized from — idempotency. */
  resultKey?: string;
  patch: import('@artifact-ax/ui-document').UiDocumentPatch;
  annotationId?: string;
  rationale?: string;
  state: 'staged' | 'applied' | 'discarded';
  actorUid: string;
  at: string;
}

export interface PrivateViewRecipe {
  id: string;
  scope: CollaborationScope;
  workItemId: string;
  proposalId: string;
  documentRevision: number;
  rowIds: string[];
  schemaVersion: 'lesson-report.view-recipe.local.v1';
}

export interface ReopenedRecipe {
  recipe: PrivateViewRecipe;
  rows: ReviewRow[];
  missingRowIds: string[];
  revisionChanged: boolean;
  status: 'ready' | 'changed' | 'missing';
}

export type DomainFailureCode = 'invalid_input' | 'unknown_target' | 'stale' | 'duplicate_result_conflict' | 'invalid_state';

export type DomainResult<T> =
  | { ok: true; value: T; replayed?: boolean }
  | { ok: false; code: DomainFailureCode; message: string };

export function invalid<T>(message: string): DomainResult<T> {
  return { ok: false, code: 'invalid_input', message };
}

export function failure<T>(code: Exclude<DomainFailureCode, 'invalid_input'>, message: string): DomainResult<T> {
  return { ok: false, code, message };
}

export function requireText(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} must be a non-empty string`);
  return text;
}

export function uniqueIds(values: readonly unknown[], name: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const id = requireText(value, name);
    if (seen.has(id)) throw new Error(`${name} must not contain duplicates`);
    seen.add(id);
  }
  return [...seen];
}

export function boundedText(value: unknown, name: string): string {
  const text = requireText(value, name);
  if (text.length > MAX_TEXT_LENGTH || /[\0\r\n]/.test(text)) {
    throw new Error(`${name} must be a single-line string up to ${MAX_TEXT_LENGTH} characters`);
  }
  return text;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function ensureSubset(values: string[], allowed: readonly string[], name: string): string[] {
  const allowedIds = new Set(allowed);
  const unknown = values.filter((value) => !allowedIds.has(value));
  if (unknown.length > 0) throw new Error(`${name} contain values outside the work item: ${unknown.join(', ')}`);
  return values;
}

export function validateScope(scope: CollaborationScope): void {
  requireText(scope.workspaceId, 'workspaceId');
  requireText(scope.artifactId, 'artifactId');
  requireText(scope.actorId, 'actorId');
}

export function cloneScope(scope: CollaborationScope): CollaborationScope {
  return { workspaceId: scope.workspaceId, artifactId: scope.artifactId, actorId: scope.actorId };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Disclose what the application prepared before a task can decide to omit
 * values. Not evidence that an Agent saw or reviewed any of those rows.
 */
export function prepareInputContext(input: {
  id: string;
  scope: CollaborationScope;
  stateRevision: number;
  selectedRowIds: readonly string[];
  currentRowIds: readonly string[];
  filteredOutRowIds?: readonly string[];
  preparedRowLimit: number;
}): DomainResult<InputPreparation> {
  if (!isNonNegativeInteger(input.stateRevision) || !isPositiveInteger(input.preparedRowLimit)) {
    return invalid('stateRevision and preparedRowLimit must be non-negative/positive integers');
  }
  try {
    validateScope(input.scope);
    const selectedRowIds = uniqueIds(input.selectedRowIds, 'selectedRowIds');
    const current = new Set(uniqueIds(input.currentRowIds, 'currentRowIds'));
    const filtered = new Set(uniqueIds(input.filteredOutRowIds ?? [], 'filteredOutRowIds'));
    const missingTargetRowIds = selectedRowIds.filter((id) => !current.has(id));
    const filteredOutRowIds = selectedRowIds.filter((id) => current.has(id) && filtered.has(id));
    const candidates = selectedRowIds.filter((id) => current.has(id) && !filtered.has(id));
    const applicationPreparedRowIds = candidates.slice(0, input.preparedRowLimit);
    const contextTruncatedRowIds = candidates.slice(input.preparedRowLimit);
    return {
      ok: true,
      value: {
        id: requireText(input.id, 'input preparation id'),
        scope: cloneScope(input.scope),
        stateRevision: input.stateRevision,
        selectedRowIds,
        applicationPreparedRowIds,
        contextTruncatedRowIds,
        filteredOutRowIds,
        missingTargetRowIds,
        platformCoverage: 'unknown',
      },
    };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'invalid input preparation');
  }
}

/** Output references are intentionally separate from input coverage. */
export function outputReferencedRowIds(rowIds: readonly string[], currentRowIds: readonly string[]): DomainResult<string[]> {
  try {
    const output = uniqueIds(rowIds, 'output row ids');
    const current = new Set(uniqueIds(currentRowIds, 'currentRowIds'));
    const unknown = output.filter((id) => !current.has(id));
    return unknown.length > 0
      ? failure('unknown_target', `output references unknown row${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
      : { ok: true, value: output };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'invalid output reference');
  }
}

// --- Private view recipes (browser-local by design) -------------------------

export const PRIVATE_RECIPE_STORAGE_PREFIX = 'artifact-ax:lesson-report:view-recipe:v1';
export const PRIVATE_RECIPE_SCHEMA = 'lesson-report.view-recipe.local.v1' as const;

export function privateRecipeStorageKey(scope: CollaborationScope): string {
  return [scope.workspaceId, scope.artifactId, scope.actorId]
    .map((part) => encodeURIComponent(requireText(part, 'scope part')))
    .reduce((key, part) => `${key}:${part}`, PRIVATE_RECIPE_STORAGE_PREFIX);
}

export function normalizeRecipe(value: unknown, scope: CollaborationScope): PrivateViewRecipe | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const recipe = value as Record<string, unknown>;
  if (recipe.schemaVersion !== PRIVATE_RECIPE_SCHEMA || !recipe.scope || typeof recipe.scope !== 'object') return null;
  const candidate = recipe.scope as Record<string, unknown>;
  if (candidate.workspaceId !== scope.workspaceId || candidate.artifactId !== scope.artifactId
    || candidate.actorId !== scope.actorId) return null;
  try {
    return {
      id: requireText(recipe.id, 'recipe id'),
      scope: cloneScope(scope),
      workItemId: requireText(recipe.workItemId, 'recipe work item id'),
      proposalId: requireText(recipe.proposalId, 'recipe proposal id'),
      documentRevision: requireNonNegative(recipe.documentRevision, 'recipe document revision'),
      rowIds: uniqueIds(Array.isArray(recipe.rowIds) ? recipe.rowIds : [], 'recipe row ids'),
      schemaVersion: PRIVATE_RECIPE_SCHEMA,
    };
  } catch {
    return null;
  }
}

function requireNonNegative(value: unknown, name: string): number {
  if (!isNonNegativeInteger(value)) throw new Error(`${name} must be non-negative`);
  return value;
}

/** Reopen a saved private recipe against the current rows and revision. */
export function reopenRecipe(
  recipe: PrivateViewRecipe,
  input: { currentRows: readonly ReviewRow[]; documentRevision: number },
): DomainResult<ReopenedRecipe> {
  if (!isNonNegativeInteger(input.documentRevision)) return invalid('documentRevision must be non-negative');
  const rowsById = new Map(input.currentRows.map((row) => [row.id, row]));
  const rows = recipe.rowIds.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [{ ...row }] : [];
  });
  const missingRowIds = recipe.rowIds.filter((id) => !rowsById.has(id));
  const revisionChanged = recipe.documentRevision !== input.documentRevision;
  return {
    ok: true,
    value: {
      recipe: clone(recipe),
      rows,
      missingRowIds,
      revisionChanged,
      status: missingRowIds.length > 0 ? 'missing' : revisionChanged ? 'changed' : 'ready',
    },
  };
}
