import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseArtifactManifest } from '@artifact-ax/contract';
import { CloudHostOutbox } from '@artifact-ax/trigger';
import { UI_DOCUMENT_PATCH_CONTRACT_VERSION, type UiDocumentPatch } from '@artifact-ax/ui-document';
import { LESSON_REPORT_DOCUMENT } from './ui/lesson-report.document.js';
import { applyUiDocumentPatch, missingProtectedNodes } from './ui/ui-draft.js';
import {
  CLOUD_UI_RESULT_SINK_ID,
  CLOUD_UI_TASK_INTENT_ID,
  UiProposalManager,
  activeDocumentStorageKey,
  buildUiComposeBundle,
  buildUiComposePayload,
  buildUiDocumentMeta,
  currentStagedProposal,
  loadActiveDocument,
  loadUiProposals,
  saveActiveDocument,
  saveUiProposals,
  summarizeUiPatch,
  supersedePendingProposals,
  uiProposalStorageKey,
  validateUiDocumentPatchProposal,
  type UiProposalRecord,
} from './ui-builder.js';

function validPatch(over: Partial<UiDocumentPatch> = {}): UiDocumentPatch {
  return {
    contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
    document_id: 'lesson-report.v1',
    base_revision: LESSON_REPORT_DOCUMENT.revision,
    ops: [
      {
        op: 'update',
        id: 'review-table',
        update: { props: { regionId: 'review-table', regionTitle: 'Review table', emptyText: 'No rows.' } },
      },
    ],
    ...over,
  };
}

/**
 * A Storage shim. Keys listed in `failOnceKeys` (or added later to a shared
 * `Set`) throw on their next write, then succeed — one-shot write failures.
 */
function mockStorage(initial: Record<string, string> = {}, failOnceKeys: readonly string[] | Set<string> = []): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  const armed = failOnceKeys instanceof Set ? failOnceKeys : new Set<string>(failOnceKeys);
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      if (armed.has(key)) {
        armed.delete(key);
        throw new Error('storage write failed');
      }
      map.set(key, String(value));
    },
  };
}

describe('compose-ui · manifest contract (two task-to-sink mappings)', () => {
  it('keeps the checked-in v3 manifest wired to both formal tasks and sinks', () => {
    const text = readFileSync(new URL('../public/artifact-manifest.json', import.meta.url), 'utf8');
    const manifest = parseArtifactManifest(text);
    expect(manifest.contract_version).toBe('catsco.artifact-manifest.v3');
    const sinkIds = (manifest.result_sinks ?? []).map((sink) => sink.id);
    expect(sinkIds).toContain('lesson-report.agent-notes.upsert.v1');
    expect(sinkIds).toContain(CLOUD_UI_RESULT_SINK_ID);
    // The original review task is preserved unchanged.
    expect(manifest.task_intents?.find((intent) => intent.id === 'lesson-report.review-selection.v1')?.result_sink)
      .toBe('lesson-report.agent-notes.upsert.v1');
    // The new compose-ui task points only at the declared UI patch proposaland stage sink.
    expect(manifest.task_intents?.find((intent) => intent.id === CLOUD_UI_TASK_INTENT_ID)?.result_sink)
      .toBe(CLOUD_UI_RESULT_SINK_ID);
  });

  it('exposes the compose-ui sink as a bounded envelope that defers op validation to the page', () => {
    const text = readFileSync(new URL('../public/artifact-manifest.json', import.meta.url), 'utf8');
    const manifest = parseArtifactManifest(text);
    const sink = manifest.result_sinks?.find((s) => s.id === CLOUD_UI_RESULT_SINK_ID);
    expect(sink).toBeDefined();
    const schema = sink!.input_schema as { type: string; required: string[]; properties: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('ops');
    expect((schema.properties.ops as { type: string }).type).toBe('array');
  });
});

describe('compose-ui · patch proposal validation (security boundary)', () => {
  it('accepts a valid, bounded patch proposal against the current document', () => {
    const result = validateUiDocumentPatchProposal(validPatch(), LESSON_REPORT_DOCUMENT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.document_id).toBe('lesson-report.v1');
      expect(result.summary).toContain('1 op');
    }
  });

  it('rejects a proposal that smuggles raw executable presentation code', () => {
    const raw = validPatch({
      ops: [
        {
          op: 'insert',
          index: 0,
          node: { id: 'evil', kind: 'review-table', placement: 'main', props: { regionId: 'review-table', regionTitle: '<script>alert(1)</script>' } },
        },
      ],
    });
    const result = validateUiDocumentPatchProposal(raw, LESSON_REPORT_DOCUMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_patch');
  });

  it('rejects a proposal that introduces a blocked executable presentation prop', () => {
    const raw = validPatch({
      ops: [{ op: 'update', id: 'review-table', update: { props: { innerHTML: '<b>hi</b>' } } }],
    });
    const result = validateUiDocumentPatchProposal(raw, LESSON_REPORT_DOCUMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_patch');
  });

  it('rejects a proposal that drifts a stable anchor outside the deployed document', () => {
    const raw = validPatch({
      ops: [{ op: 'update', id: 'review-table', update: { props: { regionId: 'admin-panel', regionTitle: 'Review table' } } }],
    });
    const result = validateUiDocumentPatchProposal(raw, LESSON_REPORT_DOCUMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('anchor_drift');
  });

  it('rejects a proposal that removes a protected governance surface, and never stages it', () => {
    for (const id of ['review-table', 'approval-list', 'ui-builder'] as const) {
      const raw = validPatch({ ops: [{ op: 'remove', id }] });
      const result = validateUiDocumentPatchProposal(raw, LESSON_REPORT_DOCUMENT);
      expect(result.ok, `removing ${id} must be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('protected_surface');
        expect(result.message).toContain(id);
      }
    }
    // A non-protected removal is still stageable.
    const removable = validateUiDocumentPatchProposal(
      validPatch({ ops: [{ op: 'remove', id: 'event-log' }] }),
      LESSON_REPORT_DOCUMENT,
    );
    expect(removable.ok).toBe(true);
  });

  it('rejects a stale proposal whose base revision no longer matches the document', () => {
    const raw = validPatch({ base_revision: LESSON_REPORT_DOCUMENT.revision + 9 });
    const result = validateUiDocumentPatchProposal(raw, LESSON_REPORT_DOCUMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('stale_patch');
  });

  it('rejects an unknown catalog kind and a no-op update', () => {
    const unknownKind = validPatch({
      ops: [{ op: 'insert', index: 0, node: { id: 'x', kind: 'wacky-widget', placement: 'main' } }],
    });
    expect(validateUiDocumentPatchProposal(unknownKind, LESSON_REPORT_DOCUMENT).ok).toBe(false);

    const noOp = validPatch({
      ops: [{ op: 'update', id: 'summary-list', update: { props: {} } }],
    });
    const noOpResult = validateUiDocumentPatchProposal(noOp, LESSON_REPORT_DOCUMENT);
    expect(noOpResult.ok).toBe(false);
    if (!noOpResult.ok) expect(noOpResult.code).toBe('invalid_patch');
  });

  it('rejects a malformed envelope (wrong contract version, wrong document id, empty ops)', () => {
    expect(validateUiDocumentPatchProposal({ contract_version: 'nope', document_id: 'x', base_revision: 1, ops: [] }, LESSON_REPORT_DOCUMENT).ok).toBe(false);
    expect(validateUiDocumentPatchProposal(validPatch({ document_id: 'other.v1' }), LESSON_REPORT_DOCUMENT).ok).toBe(false);
    expect(validateUiDocumentPatchProposal(validPatch({ ops: [] }), LESSON_REPORT_DOCUMENT).ok).toBe(false);
    expect(validateUiDocumentPatchProposal('not-an-object', LESSON_REPORT_DOCUMENT).ok).toBe(false);
  });
});

describe('compose-ui · task payload builder (minimal, final-state-first)', () => {
  it('builds a bounded payload with the current document/config plus app revision and intent only', () => {
    const bundle = buildUiComposeBundle({
      actorId: 'human_teacher',
      artifactId: 'lesson-report',
      revision: 3,
      sessionId: 'topic_lesson_report',
      intentText: 'Add a top-students summary card',
    });
    const payload = buildUiComposePayload({ bundle, document: buildUiDocumentMeta(LESSON_REPORT_DOCUMENT), workspaceId: 'ws_demo' });
    expect(payload.view).toBe('lesson-report');
    expect(payload.task).toBe('compose-ui');
    expect(payload.intent.text).toBe('Add a top-students summary card');
    expect(payload.application).toMatchObject({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', revision: 3, actor_id: 'human_teacher' });
    expect(payload.document.id).toBe('lesson-report.v1');
    expect(payload.document.nodes.some((node) => node.id === 'ui-builder')).toBe(true);
    // No event history, task refs, writeback refs, credentials, or context refs.
    expect('events' in payload).toBe(false);
    expect('context_ref' in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('token');
    expect(JSON.stringify(payload)).not.toContain('credential');
  });

  it('caps the intent text and keeps the payload serializable and bounded', () => {
    const bundle = buildUiComposeBundle({
      actorId: 'a',
      artifactId: 'lesson-report',
      revision: 1,
      sessionId: 'topic',
      intentText: 'x'.repeat(2000),
    });
    expect(bundle.intent.text.length).toBeLessThanOrEqual(500);
    const payload = buildUiComposePayload({ bundle, document: buildUiDocumentMeta(LESSON_REPORT_DOCUMENT), workspaceId: 'ws' });
    expect(JSON.stringify(payload).length).toBeLessThan(8 * 1024);
  });
});

describe('compose-ui · staged proposal persistence and state transitions', () => {
  const staged = (over: Partial<UiProposalRecord> = {}): UiProposalRecord => ({
    proposal_id: 'arr_'.concat('A'.repeat(43)),
    document_id: 'lesson-report.v1',
    base_revision: LESSON_REPORT_DOCUMENT.revision,
    patch: validPatch(),
    op_count: 1,
    summary: '1 op: update review-table',
    state: 'staged',
    created_at: '2026-09-03T00:00:00.000Z',
    ...over,
  });

  it('persists and reloads staged proposals in a scoped browser store, failing closed on malformed data', () => {
    const storage = mockStorage();
    const key = uiProposalStorageKey('ws/demo', 'lesson report');
    const record = staged();
    expect(saveUiProposals(storage, [record], key)).toBe(true);
    expect(key).toMatch(/^artifact-ax:lesson-report:ui-proposal:v1:/);
    expect(loadUiProposals(storage, key)).toEqual([record]);
    // Malformed / oversized storage never bricks the SPA.
    expect(loadUiProposals(mockStorage(), key)).toEqual([]);
    const bad = mockStorage({ [key]: JSON.stringify({ not: 'an array' }) });
    expect(loadUiProposals(bad, key)).toEqual([]);
    const oversized = mockStorage({ [key]: 'x'.repeat(200 * 1024) });
    expect(loadUiProposals(oversized, key)).toEqual([]);
    expect(saveUiProposals(undefined, [record])).toBe(false);
  });

  it('exposes only the latest unresolved proposal as the current staged proposal', () => {
    const older = staged({ proposal_id: 'arr_'.concat('B'.repeat(43)), summary: 'old' });
    const newer = staged({ proposal_id: 'arr_'.concat('C'.repeat(43)), summary: 'new' });
    const applied = staged({ proposal_id: 'arr_'.concat('D'.repeat(43)), summary: 'applied', state: 'applied' });
    expect(currentStagedProposal([older, newer])?.summary).toBe('new');
    expect(currentStagedProposal([older, applied])?.summary).toBe('old');
    expect(currentStagedProposal([applied])).toBeNull();
  });

  it('supersedes any unresolved proposal when a newer one is staged', () => {
    const a = staged({ proposal_id: 'arr_'.concat('E'.repeat(43)), summary: 'a' });
    const b = staged({ proposal_id: 'arr_'.concat('F'.repeat(43)), summary: 'b', state: 'stale' });
    const resolved = staged({ proposal_id: 'arr_'.concat('G'.repeat(43)), summary: 'applied', state: 'applied' });
    const next = supersedePendingProposals([a, b, resolved]);
    expect(next[0]!.state).toBe('stale');
    expect(next[1]!.state).toBe('stale');
    expect(next[2]!.state).toBe('applied');
  });

  it('produces a compact op summary', () => {
    expect(summarizeUiPatch(validPatch())).toBe('1 op: update review-table');
  });

  it('scopes proposals and the active document by workspace + artifact, not by actor', () => {
    // Actor-independent: switching the acting user must not re-scope the store.
    expect(uiProposalStorageKey('ws_demo', 'lesson-report')).toBe('artifact-ax:lesson-report:ui-proposal:v1:ws_demo:lesson-report');
    expect(activeDocumentStorageKey('ws_demo', 'lesson-report')).toBe('artifact-ax:lesson-report:ui-document:v1:ws_demo:lesson-report');
    expect(uiProposalStorageKey('ws_demo', 'lesson-report')).not.toContain('human_teacher');
    expect(activeDocumentStorageKey('ws_demo', 'lesson-report')).not.toContain('human_teacher');
    expect(uiProposalStorageKey('ws_other', 'lesson-report')).not.toBe(uiProposalStorageKey('ws_demo', 'lesson-report'));
    expect(activeDocumentStorageKey('ws_demo', 'other-artifact')).not.toBe(activeDocumentStorageKey('ws_demo', 'lesson-report'));
  });

  it('persists the active document and fails closed on malformed, wrong-id, or drifting data', () => {
    const docKey = activeDocumentStorageKey('ws_demo', 'lesson-report');
    const applied = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, validPatch());
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const storage = mockStorage();
    expect(saveActiveDocument(storage, applied.document, docKey)).toBe(true);
    expect(loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT)).toEqual(applied.document);
    // Fail closed: malformed / wrong-id / drifting / oversized storage falls back.
    expect(loadActiveDocument(mockStorage({ [docKey]: '{not json' }), docKey, LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
    expect(loadActiveDocument(mockStorage({ [docKey]: JSON.stringify({ not: 'a doc' }) }), docKey, LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
    const wrongId = mockStorage({ [docKey]: JSON.stringify({ ...applied.document, id: 'other.v1' }) });
    expect(loadActiveDocument(wrongId, docKey, LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
    const wrongContract = mockStorage({ [docKey]: JSON.stringify({ ...applied.document, contract_version: 'artifact-ax.ui-document.v2' }) });
    expect(loadActiveDocument(wrongContract, docKey, LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
    const drifted = mockStorage({ [docKey]: JSON.stringify({ ...applied.document, nodes: [...applied.document.nodes, { id: 'rogue', kind: 'review-table' }] }) });
    expect(loadActiveDocument(drifted, docKey, LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
    const oversized = mockStorage({ [docKey]: 'x'.repeat(200 * 1024) });
    expect(loadActiveDocument(oversized, docKey, LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
    // A stored document missing a protected governance surface fails closed.
    const stripped = { ...applied.document, nodes: applied.document.nodes.filter((node) => node.id !== 'ui-builder') };
    expect(missingProtectedNodes(stripped)).toContain('ui-builder');
    const withoutBuilder = mockStorage({ [docKey]: JSON.stringify(stripped) });
    expect(loadActiveDocument(withoutBuilder, docKey, LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
    expect(saveActiveDocument(undefined, applied.document, docKey)).toBe(false);
    expect(loadActiveDocument(undefined, docKey, LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
  });
});

describe('compose-ui · UiProposalManager stage/apply/discard + sink-scoped idempotency', () => {
  const storage = () => mockStorage();
  const manager = (initial?: UiProposalRecord[]) => new UiProposalManager({ storage: storage(), storageKey: uiProposalStorageKey('ws_demo', 'lesson-report'), initial });

  it('stages a delivered patch durably and re-staging the same result_id is idempotent', () => {
    const mgr = manager();
    const first = mgr.stage({ result_id: 'arr_'.concat('H'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.record.state).toBe('staged');
    expect(first.receipt.sink_id).toBe(CLOUD_UI_RESULT_SINK_ID);
    expect(first.receipt.state).toBe('staged');
    // A repeated delivery replays the same staged proposal without a conflict.
    const replay = mgr.stage({ result_id: 'arr_'.concat('H'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.record.proposal_id).toBe(first.record.proposal_id);
  });

  it('rejects a conflicting re-delivery for the same result_id (sink-scoped idempotency)', () => {
    const mgr = manager();
    const resultId = 'arr_'.concat('I'.repeat(43));
    const first = mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(first.ok).toBe(true);
    const other = validPatch({ ops: [{ op: 'remove', id: 'event-log' }] });
    const conflict = mgr.stage({ result_id: resultId, payload: other, document: LESSON_REPORT_DOCUMENT });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('idempotency_conflict');
  });

  it('applies a staged proposal to the current document, never on delivery alone', () => {
    const mgr = manager();
    const stage = mgr.stage({ result_id: 'arr_'.concat('J'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    // Delivery alone never mutates the document.
    expect(LESSON_REPORT_DOCUMENT.revision).toBe(1);
    const applied = mgr.apply(LESSON_REPORT_DOCUMENT);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.document.revision).toBe(LESSON_REPORT_DOCUMENT.revision + 1);
    expect(applied.record.state).toBe('applied');
    // After apply the proposal is resolved; a further apply has nothing to do.
    expect(mgr.current()).toBeNull();
  });

  it('handles stale conflicts safely: a proposal whose base revision moved is not applied', () => {
    const mgr = manager();
    const stage = mgr.stage({ result_id: 'arr_'.concat('K'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    // A different patch is applied first, moving the document past the staged base.
    const moved = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, validPatch({ ops: [{ op: 'remove', id: 'event-log' }] }));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.document.revision).toBe(LESSON_REPORT_DOCUMENT.revision + 1);
    const result = mgr.apply(moved.document);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Stale');
    expect(mgr.current()?.state).toBe('stale');
  });

  it('discards a staged proposal (never applied merely because it was delivered)', () => {
    const mgr = manager();
    const stage = mgr.stage({ result_id: 'arr_'.concat('L'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    const discarded = mgr.discard();
    expect(discarded.ok).toBe(true);
    expect(discarded.message).toContain('Discarded');
    expect(mgr.current()).toBeNull();
    // Discarding again reports no staged proposal.
    expect(mgr.discard().ok).toBe(false);
  });

  it('stages only a validated patch: a malformed or stale patch is rejected, never staged', () => {
    const mgr = manager();
    const stale = mgr.stage({ result_id: 'arr_'.concat('M'.repeat(43)), payload: validPatch({ base_revision: 99 }), document: LESSON_REPORT_DOCUMENT });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('stale_patch');
    expect(mgr.current()).toBeNull();
    const malicious = mgr.stage({ result_id: 'arr_'.concat('N'.repeat(43)), payload: validPatch({ ops: [{ op: 'update', id: 'review-table', update: { props: { innerHTML: '<script>x</script>' } } }] }), document: LESSON_REPORT_DOCUMENT });
    expect(malicious.ok).toBe(false);
    expect(mgr.current()).toBeNull();
  });

  it('rolls back in-memory and idempotency state when staging cannot be persisted, then retries', () => {
    const proposalKey = uiProposalStorageKey('ws_demo', 'lesson-report');
    const storage = mockStorage({}, [proposalKey]);
    const mgr = new UiProposalManager({
      storage,
      storageKey: proposalKey,
      documentStorageKey: activeDocumentStorageKey('ws_demo', 'lesson-report'),
    });
    const resultId = 'arr_'.concat('O'.repeat(43));
    const failed = mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe('storage_failed');
    // Rollback: nothing was committed to memory and the result id is not consumed.
    expect(mgr.current()).toBeNull();
    expect(mgr.list()).toEqual([]);
    const retried = mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.proposal_id).toBe(resultId);
    expect(mgr.current()?.state).toBe('staged');
  });

  it('does not report applied when the active document cannot be persisted, then retries', () => {
    const proposalKey = uiProposalStorageKey('ws_demo', 'lesson-report');
    const docKey = activeDocumentStorageKey('ws_demo', 'lesson-report');
    const storage = mockStorage({}, [docKey]);
    const mgr = new UiProposalManager({ storage, storageKey: proposalKey, documentStorageKey: docKey });
    const stage = mgr.stage({ result_id: 'arr_'.concat('P'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    const applied = mgr.apply(LESSON_REPORT_DOCUMENT);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.code).toBe('storage_failed');
    // Rollback: the proposal is still staged and the base document is unchanged.
    expect(mgr.current()?.state).toBe('staged');
    expect(LESSON_REPORT_DOCUMENT.revision).toBe(1);
    // Retry succeeds now that the one-shot failure is consumed.
    const retried = mgr.apply(LESSON_REPORT_DOCUMENT);
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.document.revision).toBe(LESSON_REPORT_DOCUMENT.revision + 1);
      expect(retried.record.state).toBe('applied');
    }
    expect(loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT).revision).toBe(LESSON_REPORT_DOCUMENT.revision + 1);
  });

  it('restores the proposal and reports storage_failed when metadata persistence fails after the document is durable', () => {
    const proposalKey = uiProposalStorageKey('ws_demo', 'lesson-report');
    const docKey = activeDocumentStorageKey('ws_demo', 'lesson-report');
    const armed = new Set<string>();
    const storage = mockStorage({}, armed);
    const mgr = new UiProposalManager({ storage, storageKey: proposalKey, documentStorageKey: docKey });
    const stage = mgr.stage({ result_id: 'arr_'.concat('Q'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    armed.add(proposalKey);
    const applied = mgr.apply(LESSON_REPORT_DOCUMENT);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.code).toBe('storage_failed');
    // The proposal record is restored, never left half-applied.
    expect(mgr.current()?.state).toBe('staged');
    expect(mgr.current()?.error).toBeUndefined();
    // The document write itself did land; the edge is explicit and the still-
    // staged record matches it, so a retry re-applies the same patch.
    expect(loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT).revision).toBe(LESSON_REPORT_DOCUMENT.revision + 1);
    const retried = mgr.apply(LESSON_REPORT_DOCUMENT);
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.record.state).toBe('applied');
  });

  it('restores prior state when stale-marking cannot be persisted, then retries', () => {
    const proposalKey = uiProposalStorageKey('ws_demo', 'lesson-report');
    const docKey = activeDocumentStorageKey('ws_demo', 'lesson-report');
    const armed = new Set<string>();
    const storage = mockStorage({}, armed);
    const mgr = new UiProposalManager({ storage, storageKey: proposalKey, documentStorageKey: docKey });
    const stage = mgr.stage({ result_id: 'arr_'.concat('R'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    const moved = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, validPatch({ ops: [{ op: 'remove', id: 'event-log' }] }));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    armed.add(proposalKey);
    const failed = mgr.apply(moved.document);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe('storage_failed');
    expect(mgr.current()?.state).toBe('staged');
    expect(mgr.current()?.error).toBeUndefined();
    const retried = mgr.apply(moved.document);
    expect(retried.ok).toBe(false);
    if (!retried.ok) expect(retried.code).not.toBe('storage_failed');
    expect(mgr.current()?.state).toBe('stale');
    expect(mgr.current()?.error).toContain('Stale');
  });

  it('leaves the prior staged state when a discard cannot be persisted, then retries', () => {
    const proposalKey = uiProposalStorageKey('ws_demo', 'lesson-report');
    const docKey = activeDocumentStorageKey('ws_demo', 'lesson-report');
    const armed = new Set<string>();
    const storage = mockStorage({}, armed);
    const mgr = new UiProposalManager({ storage, storageKey: proposalKey, documentStorageKey: docKey });
    const stage = mgr.stage({ result_id: 'arr_'.concat('S'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    armed.add(proposalKey);
    const failed = mgr.discard();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe('storage_failed');
    expect(mgr.current()?.state).toBe('staged');
    const retried = mgr.discard();
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.code).toBe('discarded');
    expect(mgr.current()).toBeNull();
  });
});

describe('compose-ui · no-Host behavior', () => {
  it('does not dispatch a compose-ui task when no Host is present', async () => {
    const outbox = new CloudHostOutbox({
      host: undefined,
      taskIntentId: CLOUD_UI_TASK_INTENT_ID,
      payloadMapper: (bundle) => buildUiComposePayload({ bundle, document: buildUiDocumentMeta(LESSON_REPORT_DOCUMENT), workspaceId: 'ws_demo' }),
    });
    const bundle = buildUiComposeBundle({
      actorId: 'human_teacher',
      artifactId: 'lesson-report',
      revision: LESSON_REPORT_DOCUMENT.revision,
      sessionId: 'topic_lesson_report',
      intentText: 'Add a card',
    });
    const receipt = await outbox.send(bundle);
    expect(receipt.ok).toBe(false);
    expect(receipt.task_status).toBe('unavailable');
    expect(receipt.code).toBe('host_unavailable');
  });
});
