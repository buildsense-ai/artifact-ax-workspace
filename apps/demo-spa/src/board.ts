import * as Y from 'yjs';
import type { ReviewRow, RowStatus } from '@artifact-ax/lesson-report';
import type { CollabRoom } from '@artifact-ax/collab';
import { applyPatch, validatePatch, UI_DOCUMENT_CONTRACT_VERSION } from '@artifact-ax/ui-document';
import type { UiDocument, UiDocumentPatch } from '@artifact-ax/ui-document';
import {
  MAX_WORK_ITEM_ROWS,
  boundedText,
  clone,
  cloneScope,
  ensureSubset,
  failure,
  invalid,
  isNonNegativeInteger,
  isPositiveInteger,
  privateRecipeStorageKey,
  reopenRecipe,
  requireText,
  uniqueIds,
  validateScope,
  type CollaborationScope,
  type CanvasPatchProposal,
  type ComparisonViewProposal,
  type DomainResult,
  type FindingFeedback,
  type FindingRevision,
  type PrivateViewRecipe,
  type ReopenedRecipe,
  type UiAnnotation,
  type ViewJudgment,
  type WorkItem,
  normalizeRecipe,
} from './domain.js';

/**
 * The collaborative board: all shared domain state lives in one Yjs document
 * inside the room's `shared` namespace. Maps are plain-JSON-valued, so every
 * record below is exactly what the semantic mirror and journals describe —
 * the document is the record, not a private model behind it.
 */

export const BOARD_SCHEMA_VERSION = 'lesson-report.board.v1' as const;

export interface BoardState {
  schemaVersion: string;
  seeded: boolean;
  rows: ReviewRow[];
  filter: RowStatus | 'all';
  revision: number;
}

export interface BoardSnapshot {
  state: BoardState;
  workItems: WorkItem[];
  findings: FindingRevision[];
  feedback: FindingFeedback[];
  proposals: ComparisonViewProposal[];
  /** JEV verdicts keyed by proposal id — evidence, never authorization. */
  judgments: ViewJudgment[];
  /** Human annotations anchored to rendered surfaces. */
  annotations: UiAnnotation[];
  /** Staged canvas patches — agent-proposed, human-authorized. */
  patchProposals: CanvasPatchProposal[];
}

export class CollabBoard {
  readonly scope: CollaborationScope;
  private readonly room: CollabRoom;
  private readonly doc: Y.Doc;
  private readonly listeners = new Set<() => void>();
  private recipeStorage: Storage | null;
  /**
   * CRDT undo: tracks ONLY local transactions (origin 'local') — remote
   * merges ('remote' applyUpdate) are never undone. Undo is per-actor by
   * construction: I revert my own ops while everyone else's edits survive,
   * which is the only sane semantics for shared state.
   */
  private readonly undoManager: Y.UndoManager;

  /** Root maps the undo manager scopes — every mutating entity collection. */
  private static readonly UNDO_SCOPE = [
    'meta', 'review', 'workitems', 'findings', 'feedback',
    'proposals', 'judgments', 'annotations', 'patchproposals',
    'canvasdocs', 'results', 'agentnotes',
  ];

  constructor(room: CollabRoom, scope: CollaborationScope, storage: Storage | null = null) {
    validateScope(scope);
    this.room = room;
    this.scope = scope;
    this.doc = room.doc.doc;
    this.recipeStorage = storage ?? safeStorage();
    this.undoManager = new Y.UndoManager(
      CollabBoard.UNDO_SCOPE.map((name) => this.doc.getMap(name)),
      { trackedOrigins: new Set(['local']) },
    );
    this.doc.on('update', (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
      // Notes-only edits are served by live textarea bindings — a full board
      // re-render per keystroke would destroy textarea focus and caret.
      const onlyNotes = tr.changed.size > 0 && [...tr.changed.keys()].every((type) => type instanceof Y.Text);
      if (!onlyNotes) this.notify();
    });
  }

  /** One local mutation — tagged 'local' so the undo manager can scope it. */
  private tx(fn: () => void): void {
    this.doc.transact(fn, 'local');
  }

  /** Drop captured history after seeding — ⌘Z must never un-seed a room. */
  clearUndoHistory(): void {
    this.undoManager.clear();
  }

  undo(): boolean {
    if (this.undoManager.undoStack.length === 0) return false;
    this.undoManager.undo();
    void this.room.record('ui.undo', 'undid the last local change');
    return true;
  }

  redo(): boolean {
    if (this.undoManager.redoStack.length === 0) return false;
    this.undoManager.redo();
    void this.room.record('ui.redo', 'redid the last local change');
    return true;
  }

  private meta(): Y.Map<unknown> {
    return this.doc.getMap('meta');
  }

  private reviewMap(): Y.Map<unknown> {
    return this.doc.getMap('review');
  }

  private entities<T>(name: string): Y.Map<T> {
    return this.doc.getMap(name) as Y.Map<T>;
  }

  /** True once any client has seeded the shared review table. */
  get seeded(): boolean {
    return this.meta().get('seeded') === true;
  }

  /** Seed the review table once; a no-op when the room already has rows. */
  seed(rows: ReviewRow[]): void {
    if (this.seeded) return;
    this.tx(() => {
      if (this.meta().get('seeded') === true) return;
      this.meta().set('schema_version', BOARD_SCHEMA_VERSION);
      this.meta().set('seeded', true);
      this.meta().set('revision', 0);
      this.reviewMap().set('rows', rows.map((row) => ({ ...row })));
      this.reviewMap().set('filter', 'pending');
    });
    void this.room.record('report.seed', `seeded ${rows.length} review rows`, 'review-table');
  }

  state(): BoardState {
    return {
      schemaVersion: String(this.meta().get('schema_version') ?? BOARD_SCHEMA_VERSION),
      seeded: this.seeded,
      rows: clone((this.reviewMap().get('rows') as ReviewRow[] | undefined) ?? []),
      filter: (this.reviewMap().get('filter') as RowStatus | 'all' | undefined) ?? 'all',
      revision: Number(this.meta().get('revision') ?? 0),
    };
  }

  snapshot(): BoardSnapshot {
    return {
      state: this.state(),
      workItems: [...this.entities<WorkItem>('workitems').values()].map(clone),
      findings: [...this.entities<FindingRevision>('findings').values()].map(clone),
      feedback: [...this.entities<FindingFeedback>('feedback').values()].map(clone),
      proposals: [...this.entities<ComparisonViewProposal>('proposals').values()].map(clone),
      judgments: [...this.entities<ViewJudgment>('judgments').values()].map(clone),
      annotations: [...this.entities<UiAnnotation>('annotations').values()].map(clone),
      patchProposals: [...this.entities<CanvasPatchProposal>('patchproposals').values()].map(clone),
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private bumpRevision(): number {
    const next = Number(this.meta().get('revision') ?? 0) + 1;
    this.meta().set('revision', next);
    return next;
  }

  // --- Review rows --------------------------------------------------------

  setFilter(status: RowStatus | 'all'): void {
    this.tx(() => {
      this.reviewMap().set('filter', status);
      this.bumpRevision();
    });
  }

  approveRows(rowIds: readonly string[]): DomainResult<{ approved: number }> {
    try {
      const ids = uniqueIds(rowIds, 'row ids');
      const state = this.state();
      const known = new Set(state.rows.map((row) => row.id));
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length > 0) return failure('unknown_target', `unknown rows: ${missing.join(', ')}`);
      this.tx(() => {
        const rows = (this.reviewMap().get('rows') as ReviewRow[]).map((row) => (
          ids.includes(row.id) ? { ...row, status: 'approved' as const } : row
        ));
        this.reviewMap().set('rows', rows);
        this.bumpRevision();
      });
      void this.room.record('rows.approve', `approved ${ids.length} row${ids.length === 1 ? '' : 's'}`, 'review-table', { row_ids: ids });
      return { ok: true, value: { approved: ids.length } };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid rows');
    }
  }

  // --- Work items -----------------------------------------------------------

  createWorkItem(input: { id: string; title?: string; rowIds: readonly string[]; baselineRevision: number }): DomainResult<WorkItem> {
    try {
      const id = requireText(input.id, 'work item id');
      const rowIds = ensureSubset(uniqueIds(input.rowIds, 'work item row ids'), this.state().rows.map((row) => row.id), 'work item rows');
      if (!isNonNegativeInteger(input.baselineRevision) || rowIds.length === 0 || rowIds.length > MAX_WORK_ITEM_ROWS) {
        return invalid(`a work item must contain 1-${MAX_WORK_ITEM_ROWS} rows and a non-negative baseline revision`);
      }
      if (this.entities<WorkItem>('workitems').has(id)) {
        return failure('invalid_state', `work item ${id} already exists`);
      }
      const item: WorkItem = {
        id,
        scope: cloneScope(this.scope),
        title: input.title?.trim() || `Compare ${rowIds.length} selected ${rowIds.length === 1 ? 'row' : 'rows'}`,
        rowIds,
        baselineRevision: input.baselineRevision,
        state: 'active',
      };
      this.tx(() => {
        this.entities<WorkItem>('workitems').set(id, clone(item));
      });
      void this.room.record('workitem.create', `created work item "${item.title}"`, id, { row_ids: rowIds });
      return { ok: true, value: clone(item) };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid work item');
    }
  }

  workItem(id: string): WorkItem | null {
    const item = this.entities<WorkItem>('workitems').get(id);
    return item ? clone(item) : null;
  }

  // --- Shared notes (live Y.Text — the actual concurrent-editing surface) -----

  /** The shared notes text for one work item; created lazily per room. */
  notesText(workItemId: string): Y.Text {
    return this.doc.getText(`notes:${workItemId}`);
  }

  /** Bounded preview for projections and UI chrome. */
  notesExcerpt(workItemId: string, maxChars = 200): { chars: number; excerpt: string } {
    const text = this.doc.getText(`notes:${workItemId}`).toString();
    return { chars: text.length, excerpt: text.slice(0, maxChars) };
  }

  /**
   * Splice an agent-authored note into the work item's shared notes pad —
   * the agent literally types into the room like a colleague. Idempotent by
   * (key, revision): concurrent appliers converge because the first applied
   * revision lands in the `agentnotes` map inside the same transaction.
   * Only the room leader should call this (see room.isLeader()).
   */
  applyAgentNote(input: { key: string; revision: number; workItemId: string; text: string; actor?: string }): DomainResult<{ applied: boolean }> {
    try {
      const item = this.workItem(requireText(input.workItemId, 'work item id'));
      if (!item) return failure('unknown_target', `unknown work item ${input.workItemId}`);
      const applied = this.entities<number>('agentnotes');
      const prior = applied.get(input.key);
      if (prior !== undefined && prior >= input.revision) {
        return { ok: true, value: { applied: true }, replayed: true };
      }
      const text = boundedText(input.text, 'agent note');
      this.tx(() => {
        const ytext = this.notesText(item.id);
        if (ytext.length > 0) ytext.insert(ytext.length, '\n');
        ytext.insert(ytext.length, `[${boundedText(input.actor ?? 'agent', 'actor').split('\n')[0]}] ${text}`);
        applied.set(input.key, input.revision);
      });
      void this.room.record('agent.note', `applied agent note on ${item.id}`, item.id);
      return { ok: true, value: { applied: true } };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid agent note');
    }
  }

  /** True when this agent doc revision already landed in shared state. */
  agentNoteApplied(key: string, revision: number): boolean {
    const applied = this.entities<number>('agentnotes').get(key);
    return applied !== undefined && applied >= revision;
  }

  /**
   * Materialize an agent feedback doc into a first-class FindingFeedback
   * entity — the structured counterpart of the pad note. Same leader-only,
   * (key, revision)-idempotent materialization rule as applyAgentNote.
   */
  applyAgentFeedback(input: { key: string; revision: number; findingId: string; findingRevision: number; text: string; actor?: string }): DomainResult<FindingFeedback> {
    const applied = this.entities<number>('agentnotes');
    const id = `fb-${input.key.replace(/[^A-Za-z0-9._:-]+/g, '_')}-r${input.revision}`;
    const prior = applied.get(input.key);
    if (prior !== undefined && prior >= input.revision) {
      const existing = this.entities<FindingFeedback>('feedback').get(id);
      return existing
        ? { ok: true, value: clone(existing), replayed: true }
        : failure('invalid_state', `agent doc ${input.key}@${prior} already applied`);
    }
    const result = this.addFeedback({
      id,
      findingId: input.findingId,
      findingRevision: input.findingRevision,
      text: input.text,
      actorId: input.actor ?? 'agent',
    });
    if (!result.ok) return result;
    this.tx(() => {
      applied.set(input.key, input.revision);
    });
    return result;
  }

  // --- Findings ---------------------------------------------------------------

  createFinding(input: { id: string; workItemId: string; summary: string; rowIds: readonly string[] }): DomainResult<FindingRevision> {
    try {
      const id = requireText(input.id, 'finding id');
      const item = this.workItem(requireText(input.workItemId, 'work item id'));
      if (!item) return failure('unknown_target', `unknown work item ${input.workItemId}`);
      if (item.state !== 'active') return failure('invalid_state', `work item ${item.id} is not active`);
      if (this.entities<FindingRevision>('findings').has(id)) {
        return failure('invalid_state', `finding ${id} already exists`);
      }
      const rowIds = ensureSubset(uniqueIds(input.rowIds, 'finding row ids'), item.rowIds, 'finding rows');
      const finding: FindingRevision = {
        findingId: id,
        workItemId: item.id,
        revision: 1,
        summary: boundedText(input.summary, 'finding summary'),
        rowIds,
        evidence: 'missing',
        feedbackIds: [],
      };
      this.tx(() => {
        this.entities<FindingRevision>('findings').set(id, clone(finding));
      });
      void this.room.record('finding.create', `opened finding on ${item.id}`, id, { work_item_id: item.id });
      return { ok: true, value: clone(finding) };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid finding');
    }
  }

  finding(id: string): FindingRevision | null {
    const finding = this.entities<FindingRevision>('findings').get(id);
    return finding ? clone(finding) : null;
  }

  addFeedback(input: { id: string; findingId: string; findingRevision: number; text: string; actorId?: string }): DomainResult<FindingFeedback> {
    try {
      const finding = this.finding(requireText(input.findingId, 'finding id'));
      if (!finding) return failure('unknown_target', `unknown finding ${input.findingId}`);
      if (!isPositiveInteger(input.findingRevision) || finding.revision !== input.findingRevision) {
        return failure('stale', `finding ${finding.findingId} is at revision ${finding.revision}`);
      }
      const id = requireText(input.id, 'feedback id');
      if (this.entities<FindingFeedback>('feedback').has(id)) {
        return failure('invalid_state', `feedback ${id} already exists`);
      }
      const feedback: FindingFeedback = {
        id,
        findingId: finding.findingId,
        findingRevision: finding.revision,
        text: boundedText(input.text, 'feedback'),
        actorId: input.actorId ?? this.scope.actorId,
      };
      this.tx(() => {
        this.entities<FindingFeedback>('feedback').set(id, clone(feedback));
        const current = this.entities<FindingRevision>('findings').get(finding.findingId);
        if (current) {
          this.entities<FindingRevision>('findings').set(finding.findingId, {
            ...current,
            feedbackIds: [...current.feedbackIds, id],
          });
        }
      });
      void this.room.record('feedback.add', `feedback on ${finding.findingId} rev ${finding.revision}`, finding.findingId);
      return { ok: true, value: clone(feedback) };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid feedback');
    }
  }

  /**
   * Apply an agent result: revise exactly one finding and stage one
   * comparison view. Idempotent by `resultId` — a replayed delivery returns
   * the stored finding rather than double-applying.
   */
  applyAgentResult(input: {
    resultId: string;
    findingId: string;
    expectedRevision: number;
    summary: string;
    rowIds: readonly string[];
    proposalId: string;
    baseRevision: number;
    /** Optional agent-authored UiDocument — already catalog-validated. */
    document?: import('@artifact-ax/ui-document').UiDocument;
  }): DomainResult<{ finding: FindingRevision; proposal: ComparisonViewProposal }> {
    try {
      const resultId = requireText(input.resultId, 'result id');
      const results = this.entities<{ payload: string; finding: FindingRevision; proposal: ComparisonViewProposal }>('results');
      const canonical = JSON.stringify({
        findingId: input.findingId,
        expectedRevision: input.expectedRevision,
        summary: input.summary.trim(),
        rowIds: [...input.rowIds],
        proposalId: input.proposalId,
        baseRevision: input.baseRevision,
        ...(input.document ? { document: input.document } : {}),
      });
      const prior = results.get(resultId);
      if (prior) {
        if (prior.payload !== canonical) {
          return failure('duplicate_result_conflict', `result id ${resultId} was already used for a different payload`);
        }
        return { ok: true, value: { finding: clone(prior.finding), proposal: clone(prior.proposal) }, replayed: true };
      }
      const current = this.finding(requireText(input.findingId, 'finding id'));
      if (!current) return failure('unknown_target', `unknown finding ${input.findingId}`);
      if (!isPositiveInteger(input.expectedRevision) || current.revision !== input.expectedRevision) {
        return failure('stale', `finding ${current.findingId} is at revision ${current.revision}`);
      }
      const item = this.workItem(current.workItemId);
      if (!item) return failure('unknown_target', `unknown work item ${current.workItemId}`);
      const next: FindingRevision = {
        ...current,
        revision: current.revision + 1,
        summary: boundedText(input.summary, 'revised finding summary'),
        rowIds: ensureSubset(uniqueIds(input.rowIds, 'revised finding row ids'), item.rowIds, 'finding rows'),
        feedbackIds: [],
      };
      const proposal: ComparisonViewProposal = {
        id: requireText(input.proposalId, 'proposal id'),
        workItemId: item.id,
        baseRevision: input.baseRevision,
        rowIds: [...next.rowIds],
        ...(input.document ? { document: input.document } : {}),
        state: 'staged',
        origin: 'agent',
      };
      if (!isNonNegativeInteger(input.baseRevision)) return invalid('baseRevision must be non-negative');
      this.tx(() => {
        this.entities<FindingRevision>('findings').set(next.findingId, clone(next));
        this.entities<ComparisonViewProposal>('proposals').set(proposal.id, clone(proposal));
        results.set(resultId, { payload: canonical, finding: clone(next), proposal: clone(proposal) });
      });
      void this.room.record('result.apply', `agent revised ${next.findingId} to rev ${next.revision} and staged ${proposal.id}`, next.findingId, { result_id: resultId });
      return { ok: true, value: { finding: clone(next), proposal: clone(proposal) } };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid agent result');
    }
  }

  /**
   * Anchor a human annotation to a rendered surface — the "select and
   * comment" channel. Writes a shared entity + journal entry; the agent
   * reads it through the same legible channels as everything else.
   */
  annotate(input: {
    id: string;
    kind?: 'element' | 'region';
    nodeId?: string;
    regionId?: string;
    selector?: string;
    rect?: { x: number; y: number; w: number; h: number };
    deltas?: { dx: number; dy: number; dw: number; dh: number };
    excerpt?: string;
    /** Bounded element context summary (tag/role/name/size). */
    context?: string;
    text: string;
    actorUid: string;
  }): DomainResult<UiAnnotation> {
    try {
      const id = requireText(input.id, 'annotation id');
      const annotation: UiAnnotation = {
        id,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.nodeId ? { nodeId: boundedText(input.nodeId, 'annotation node id') } : {}),
        ...(input.regionId ? { regionId: boundedText(input.regionId, 'annotation region id') } : {}),
        ...(input.selector ? { selector: boundedText(input.selector, 'annotation selector') } : {}),
        ...(input.rect ? { rect: { x: Math.round(input.rect.x), y: Math.round(input.rect.y), w: Math.round(input.rect.w), h: Math.round(input.rect.h) } } : {}),
        ...(input.deltas ? { deltas: { dx: Math.round(input.deltas.dx), dy: Math.round(input.deltas.dy), dw: Math.round(input.deltas.dw), dh: Math.round(input.deltas.dh) } } : {}),
        ...(input.excerpt ? { excerpt: boundedText(input.excerpt, 'annotation excerpt') } : {}),
        ...(input.context ? { context: boundedText(input.context, 'annotation context') } : {}),
        text: boundedText(input.text, 'annotation text'),
        actorUid: boundedText(input.actorUid, 'annotation actor'),
        at: new Date().toISOString(),
      };
      const annotations = this.entities<UiAnnotation>('annotations');
      const prior = annotations.get(id);
      if (prior) return { ok: true, value: clone(prior), replayed: true };
      this.tx(() => {
        annotations.set(id, clone(annotation));
      });
      void this.room.record('ui.annotate', `annotated ${annotation.kind === 'region' ? `region ${annotation.rect?.x ?? ''},${annotation.rect?.y ?? ''}` : annotation.nodeId ?? annotation.regionId ?? annotation.selector ?? 'element'}`, annotation.nodeId ?? id, {
        annotation_id: id,
        kind: annotation.kind,
        node_id: annotation.nodeId,
        region_id: annotation.regionId,
        selector: annotation.selector,
        rect: annotation.rect,
        excerpt: annotation.excerpt?.slice(0, 120),
        ...(annotation.context ? { context: annotation.context.slice(0, 160) } : {}),
        text: annotation.text.slice(0, 200),
      });
      return { ok: true, value: clone(annotation) };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid annotation');
    }
  }

  /**
   * Retract an annotation — a real entity delete propagated through the
   * shared doc, plus a `ui.unannotate` journal entry attributing the
   * retraction to its actor. The agent reads the removal the same way it
   * read the original note.
   */
  retractAnnotation(id: string, actorUid: string): DomainResult<UiAnnotation> {
    const annotations = this.entities<UiAnnotation>('annotations');
    const prior = annotations.get(id);
    if (!prior) return failure('unknown_target', `unknown annotation ${id}`);
    this.tx(() => {
      annotations.delete(id);
    });
    void this.room.record('ui.unannotate', `retracted annotation on ${prior.kind === 'region' ? `region ${prior.rect?.x ?? ''},${prior.rect?.y ?? ''}` : prior.nodeId ?? prior.regionId ?? prior.selector ?? 'element'}`, prior.nodeId ?? id, {
      annotation_id: id,
      retracted_by: actorUid,
      original_actor: prior.actorUid,
    });
    return { ok: true, value: clone(prior) };
  }

  /**
   * The live canvas — a shared UiDocument the agent can patch. This is the
   * surface annotations turn into action: annotate a canvas node and the
   * colleague can stage a UiDocumentPatch; a human Use applies it.
   */
  canvas(): UiDocument | null {
    return this.entities<UiDocument>('canvasdocs').get('canvas') ?? null;
  }

  /** Seed an initial canvas document once; no-op when already present. */
  seedCanvas(): void {
    const docs = this.entities<UiDocument>('canvasdocs');
    if (docs.has('canvas')) return;
    this.tx(() => {
      if (docs.has('canvas')) return;
      docs.set('canvas', {
        contract_version: UI_DOCUMENT_CONTRACT_VERSION,
        id: 'canvas',
        title: 'Canvas',
        revision: 1,
        nodes: [
          {
            id: 'canvas-summary',
            kind: 'summary-list',
            props: { regionId: 'canvas-summary', regionTitle: 'Board status' },
            bindings: { counts: 'counts' },
          },
          {
            id: 'canvas-notes',
            kind: 'agent-notes',
            props: { regionId: 'canvas-notes', regionTitle: 'Agent notes' },
            bindings: { notes: 'notes' },
          },
        ],
      } satisfies UiDocument);
    });
    void this.room.record('canvas.seed', 'seeded canvas document', 'canvas');
  }

  /**
   * Materialize an agent `agent/patch:*` doc into a staged canvas patch
   * proposal. Validates against the CURRENT canvas at materialization — an
   * invalid patch is rejected (journal), never staged. Idempotent by
   * (key, revision), same rule as agent notes.
   */
  applyAgentCanvasPatch(input: {
    key: string;
    revision: number;
    patch: UiDocumentPatch;
    annotationId?: string;
    rationale?: string;
    actor?: string;
  }): DomainResult<CanvasPatchProposal> {
    const applied = this.entities<number>('agentnotes');
    const prior = applied.get(input.key);
    const id = `patch-${input.key.replace(/[^A-Za-z0-9._:-]+/g, '_')}-r${input.revision}`;
    if (prior !== undefined && prior >= input.revision) {
      const existing = this.entities<CanvasPatchProposal>('patchproposals').get(id);
      return existing
        ? { ok: true, value: clone(existing), replayed: true }
        : failure('invalid_state', `agent doc ${input.key}@${prior} already applied`);
    }
    const canvas = this.canvas();
    if (!canvas) return failure('invalid_state', 'no canvas document');
    const errors = validatePatch(input.patch, canvas);
    if (errors.length > 0) {
      this.tx(() => applied.set(input.key, input.revision));
      void this.room.record('agent.patch-rejected', `rejected canvas patch ${id}: ${errors[0]}`, id);
      return failure('invalid_state', `canvas patch invalid: ${errors.join('; ')}`);
    }
    const proposal: CanvasPatchProposal = {
      id,
      resultKey: input.key,
      patch: clone(input.patch),
      ...(input.annotationId ? { annotationId: input.annotationId } : {}),
      ...(input.rationale ? { rationale: input.rationale.slice(0, 200) } : {}),
      state: 'staged',
      actorUid: input.actor ?? 'agent',
      at: new Date().toISOString(),
    };
    this.tx(() => {
      applied.set(input.key, input.revision);
      this.entities<CanvasPatchProposal>('patchproposals').set(id, clone(proposal));
    });
    void this.room.record('agent.patch', `staged canvas patch (${input.patch.ops.length} ops)${input.annotationId ? ` for annotation ${input.annotationId}` : ''}`, id);
    return { ok: true, value: clone(proposal) };
  }

  /**
   * Human Use: apply a staged canvas patch. The base revision must still
   * match — a stale patch never silently lands on a moved document.
   */
  useCanvasPatch(id: string): DomainResult<UiDocument> {
    const proposals = this.entities<CanvasPatchProposal>('patchproposals');
    const proposal = proposals.get(id);
    if (!proposal) return failure('invalid_state', `no canvas patch ${id}`);
    if (proposal.state === 'applied') return { ok: true, value: clone(this.canvas()!), replayed: true };
    if (proposal.state !== 'staged') return failure('invalid_state', `patch ${id} is ${proposal.state}`);
    const canvas = this.canvas();
    if (!canvas) return failure('invalid_state', 'no canvas document');
    if (proposal.patch.base_revision !== canvas.revision) {
      return failure('stale', `patch targets revision ${proposal.patch.base_revision}, canvas is at ${canvas.revision}`);
    }
    const result = applyPatch(canvas, proposal.patch);
    if (!result.ok) return failure('invalid_state', result.message);
    this.tx(() => {
      this.entities<UiDocument>('canvasdocs').set('canvas', clone(result.document));
      proposals.set(id, { ...proposal, state: 'applied' });
    });
    void this.room.record('canvas.patch-applied', `applied canvas patch ${id} → revision ${result.document.revision}`, 'canvas');
    return { ok: true, value: clone(result.document) };
  }

  /** Human Discard: drop a staged canvas patch without applying. */
  discardCanvasPatch(id: string): DomainResult<CanvasPatchProposal> {
    const proposals = this.entities<CanvasPatchProposal>('patchproposals');
    const proposal = proposals.get(id);
    if (!proposal) return failure('invalid_state', `no canvas patch ${id}`);
    if (proposal.state !== 'staged') return failure('invalid_state', `patch ${id} is ${proposal.state}`);
    const next = { ...proposal, state: 'discarded' as const };
    this.tx(() => proposals.set(id, next));
    void this.room.record('canvas.patch-discarded', `discarded canvas patch ${id}`, id);
    return { ok: true, value: clone(next) };
  }

  /**
   * Apply a JEV verdict doc to a proposal — supplementary evidence only.
   * Idempotent by resultId; a re-judgment (new result id) supersedes.
   */
  applyViewJudgment(input: {
    resultId: string;
    proposalId: string;
    verdict: ViewJudgment['verdict'];
    rationale: string;
    confidence?: number;
    at?: string;
  }): DomainResult<ViewJudgment> {
    try {
      const resultId = requireText(input.resultId, 'result id');
      const proposalId = requireText(input.proposalId, 'proposal id');
      if (!this.entities<ComparisonViewProposal>('proposals').has(proposalId)) {
        return failure('unknown_target', `unknown view proposal ${proposalId}`);
      }
      const judgments = this.entities<ViewJudgment>('judgments');
      const prior = judgments.get(proposalId);
      if (prior?.resultId === resultId) {
        return { ok: true, value: clone(prior), replayed: true };
      }
      const judgment: ViewJudgment = {
        proposalId,
        resultId,
        verdict: input.verdict,
        rationale: boundedText(input.rationale, 'judgment rationale'),
        ...(input.confidence !== undefined && Number.isFinite(input.confidence)
          && input.confidence >= 0 && input.confidence <= 1
          ? { confidence: input.confidence } : {}),
        at: input.at ?? new Date().toISOString(),
      };
      this.tx(() => {
        judgments.set(proposalId, clone(judgment));
      });
      void this.room.record('view.judge', `jev judged ${proposalId}: ${judgment.verdict}`, proposalId);
      return { ok: true, value: clone(judgment) };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid view judgment');
    }
  }

  // --- Comparison view proposals ------------------------------------------------

  stageComparisonView(input: { id: string; workItemId: string; baseRevision: number; rowIds: readonly string[]; origin?: 'human' | 'agent' }): DomainResult<ComparisonViewProposal> {
    try {
      const item = this.workItem(requireText(input.workItemId, 'work item id'));
      if (!item) return failure('unknown_target', `unknown work item ${input.workItemId}`);
      if (!isNonNegativeInteger(input.baseRevision)) return invalid('baseRevision must be non-negative');
      const id = requireText(input.id, 'view proposal id');
      const rowIds = ensureSubset(uniqueIds(input.rowIds, 'comparison row ids'), item.rowIds, 'comparison rows');
      const proposals = this.entities<ComparisonViewProposal>('proposals');
      const prior = proposals.get(id);
      if (prior) {
        const same = prior.workItemId === item.id && prior.baseRevision === input.baseRevision
          && JSON.stringify(prior.rowIds) === JSON.stringify(rowIds);
        return same
          ? { ok: true, value: clone(prior), replayed: true }
          : failure('duplicate_result_conflict', `view proposal ${id} already exists with different content`);
      }
      const proposal: ComparisonViewProposal = {
        id,
        workItemId: item.id,
        baseRevision: input.baseRevision,
        rowIds,
        state: 'staged',
        origin: input.origin ?? 'human',
      };
      this.tx(() => {
        proposals.set(id, clone(proposal));
      });
      void this.room.record('view.stage', `staged comparison view on ${item.id}`, id);
      return { ok: true, value: clone(proposal) };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid comparison view');
    }
  }

  useComparisonView(proposalId: string): DomainResult<ComparisonViewProposal> {
    const proposal = this.entities<ComparisonViewProposal>('proposals').get(proposalId);
    if (!proposal) return failure('unknown_target', `unknown view proposal ${proposalId}`);
    if (proposal.state !== 'staged') return failure('invalid_state', `view proposal ${proposalId} is ${proposal.state}`);
    if (proposal.baseRevision !== this.state().revision) {
      this.tx(() => {
        this.entities<ComparisonViewProposal>('proposals').set(proposalId, { ...proposal, state: 'stale' });
      });
      return failure('stale', `view proposal ${proposalId} targets revision ${proposal.baseRevision}`);
    }
    this.tx(() => {
      this.entities<ComparisonViewProposal>('proposals').set(proposalId, { ...proposal, state: 'used' });
    });
    void this.room.record('view.use', `used comparison view ${proposalId}`, proposalId);
    return { ok: true, value: { ...proposal, state: 'used' } };
  }

  discardComparisonView(proposalId: string): DomainResult<ComparisonViewProposal> {
    const proposal = this.entities<ComparisonViewProposal>('proposals').get(proposalId);
    if (!proposal) return failure('unknown_target', `unknown view proposal ${proposalId}`);
    if (proposal.state !== 'staged' && proposal.state !== 'stale') {
      return failure('invalid_state', `view proposal ${proposalId} is ${proposal.state}`);
    }
    this.tx(() => {
      this.entities<ComparisonViewProposal>('proposals').set(proposalId, { ...proposal, state: 'discarded' });
    });
    void this.room.record('view.discard', `discarded comparison view ${proposalId}`, proposalId);
    return { ok: true, value: { ...proposal, state: 'discarded' } };
  }

  // --- Private view recipes (browser-local) --------------------------------------

  savePrivateViewRecipe(input: { id: string; proposalId: string; documentRevision: number }): DomainResult<PrivateViewRecipe> {
    try {
      const proposal = this.entities<ComparisonViewProposal>('proposals').get(input.proposalId);
      if (!proposal) return failure('unknown_target', `unknown view proposal ${input.proposalId}`);
      if (proposal.state !== 'used') return failure('invalid_state', 'only a used view can be saved');
      if (!isNonNegativeInteger(input.documentRevision)) return invalid('documentRevision must be non-negative');
      const id = requireText(input.id, 'recipe id');
      const recipes = this.loadRecipes();
      if (recipes.some((recipe) => recipe.id === id)) return failure('invalid_state', `recipe ${id} already exists`);
      const recipe: PrivateViewRecipe = {
        id,
        scope: cloneScope(this.scope),
        workItemId: proposal.workItemId,
        proposalId: proposal.id,
        documentRevision: input.documentRevision,
        rowIds: [...proposal.rowIds],
        schemaVersion: 'lesson-report.view-recipe.local.v1',
      };
      this.storeRecipes([...recipes, recipe]);
      void this.room.record('recipe.save', `saved private view recipe ${id}`, id);
      return { ok: true, value: clone(recipe) };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'invalid view recipe');
    }
  }

  loadRecipes(): PrivateViewRecipe[] {
    if (!this.recipeStorage) return [];
    try {
      const raw = this.recipeStorage.getItem(privateRecipeStorageKey(this.scope));
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.map((item) => normalizeRecipe(item, this.scope)).filter((item): item is PrivateViewRecipe => item !== null)
        : [];
    } catch {
      return [];
    }
  }

  private storeRecipes(recipes: PrivateViewRecipe[]): void {
    try {
      this.recipeStorage?.setItem(privateRecipeStorageKey(this.scope), JSON.stringify(recipes.slice(-20)));
    } catch {
      // Storage full or unavailable — recipes are a convenience, not truth.
    }
  }

  reopenPrivateViewRecipe(recipeId: string): DomainResult<ReopenedRecipe> {
    const recipe = this.loadRecipes().find((item) => item.id === recipeId);
    if (!recipe) return failure('unknown_target', `unknown recipe ${recipeId}`);
    return reopenRecipe(recipe, { currentRows: this.state().rows, documentRevision: this.state().revision });
  }

  feedbackForFinding(findingId: string): FindingFeedback[] {
    return [...this.entities<FindingFeedback>('feedback').values()]
      .filter((item) => item.findingId === findingId)
      .map(clone);
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
