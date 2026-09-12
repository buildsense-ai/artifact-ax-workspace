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
  uiProposalDeliveryStatus,
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

  it('rejects a proposal carrying unknown envelope fields', () => {
    const smuggled = {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [{ op: 'remove', id: 'event-log' }],
      authority: 'grant-me',
    };
    const result = validateUiDocumentPatchProposal(smuggled, LESSON_REPORT_DOCUMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_patch');
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
    // Once the newest proposal reaches a terminal state, older stale records
    // are history and must never become actionable again.
    expect(currentStagedProposal([older, applied])).toBeNull();
    expect(currentStagedProposal([applied])).toBeNull();
  });

  it('supersedes any unresolved proposal when a newer one is staged', () => {
    const a = staged({ proposal_id: 'arr_'.concat('E'.repeat(43)), summary: 'a' });
    const b = staged({ proposal_id: 'arr_'.concat('F'.repeat(43)), summary: 'b', state: 'stale', error: 'old' });
    const resolved = staged({ proposal_id: 'arr_'.concat('G'.repeat(43)), summary: 'applied', state: 'applied', applied_revision: 2, applied_at: '2026-09-03T00:00:00.000Z' });
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

  it('does not reactivate a superseded proposal after the newer proposal completes', () => {
    const mgr = manager();
    const first = mgr.stage({ result_id: 'arr_'.concat('Y'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(first.ok).toBe(true);
    const secondPatch = validPatch({ ops: [{ op: 'remove', id: 'event-log' }] });
    const second = mgr.stage({ result_id: 'arr_'.concat('Z'.repeat(43)), payload: secondPatch, document: LESSON_REPORT_DOCUMENT });
    expect(second.ok).toBe(true);
    const applied = mgr.apply(LESSON_REPORT_DOCUMENT);
    expect(applied.ok).toBe(true);
    expect(mgr.current()).toBeNull();
    expect(mgr.list().map((proposal) => proposal.state)).toEqual(['stale', 'applied']);
  });

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
    if (!applied.ok) {
      expect(applied.code).toBe('storage_failed');
      // Even this failure branch must return a detached snapshot.
      applied.record!.state = 'discarded';
      applied.record!.patch.ops.push({ op: 'remove', id: 'event-log' });
    }
    expect(mgr.current()?.patch.ops).toHaveLength(1);
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
    // The document write landed but proposal metadata did not. This is NOT
    // an atomic two-key transaction. Retry on the old in-memory base converges.
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

  it('never retains caller-owned payload references when staging', () => {
    const mgr = manager();
    const resultId = 'arr_'.concat('T'.repeat(43));
    const payload = validPatch();
    const stage = mgr.stage({ result_id: resultId, payload, document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    // Mutate the caller's object after staging: change a prop and add an op.
    const first = payload.ops[0] as { update: { props: Record<string, string> } };
    first.update.props.emptyText = 'MUTATED BY CALLER';
    payload.ops.push({ op: 'remove', id: 'event-log' });
    // The staged record still holds the validated, canonical patch...
    expect(mgr.current()?.op_count).toBe(1);
    expect(JSON.stringify(mgr.current()?.patch)).not.toContain('MUTATED BY CALLER');
    expect(mgr.current()?.patch.ops).toHaveLength(1);
    // ...and apply behavior uses the validated patch, not the mutated payload.
    const applied = mgr.apply(LESSON_REPORT_DOCUMENT);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      const reviewTable = applied.document.nodes.find((node) => node.id === 'review-table');
      expect((reviewTable?.props as Record<string, string>).emptyText).toBe('No rows.');
    }
  });

  it('does not expose mutable proposal state through stage, current, or list snapshots', () => {
    const mgr = manager();
    const stage = mgr.stage({ result_id: 'arr_'.concat('W'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    if (!stage.ok) return;

    stage.record.state = 'applied';
    const stagedOp = stage.record.patch.ops[0] as { update: { props: Record<string, string> } };
    stagedOp.update.props.emptyText = 'tampered stage result';

    const current = mgr.current();
    expect(current?.state).toBe('staged');
    expect((current?.patch.ops[0] as { update: { props: Record<string, string> } }).update.props.emptyText).toBe('No rows.');

    const listed = mgr.list();
    listed[0]!.state = 'discarded';
    (listed[0]!.patch.ops[0] as { update: { props: Record<string, string> } }).update.props.emptyText = 'tampered list result';
    expect(mgr.current()?.state).toBe('staged');
    expect((mgr.current()?.patch.ops[0] as { update: { props: Record<string, string> } }).update.props.emptyText).toBe('No rows.');
  });

  it('fingerprints canonically: reordered re-delivery is idempotent, a different valid patch conflicts', () => {
    const mgr = manager();
    const resultId = 'arr_'.concat('V'.repeat(43));
    const stage = mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(stage.ok).toBe(true);
    // Same content, different property order and nesting order.
    const reordered = {
      ops: [{ update: { props: { emptyText: 'No rows.', regionTitle: 'Review table', regionId: 'review-table' } }, id: 'review-table', op: 'update' }],
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      document_id: 'lesson-report.v1',
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
    };
    const replay = mgr.stage({ result_id: resultId, payload: reordered, document: LESSON_REPORT_DOCUMENT });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.record.proposal_id).toBe(resultId);
    // A different but fully valid patch for the same result id conflicts.
    const different = validPatch({ ops: [{ op: 'update', id: 'review-table', update: { props: { regionId: 'review-table', regionTitle: 'Review table', emptyText: 'Changed.' } } }] });
    const conflict = mgr.stage({ result_id: resultId, payload: different, document: LESSON_REPORT_DOCUMENT });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('idempotency_conflict');
  });
});

// Application-service integration: real stage/apply/discard and persistence
// helpers with a synthetic Storage adapter. This is not browser/Host E2E.
describe('compose-ui · apply/reload integration', () => {
  const proposalKey = uiProposalStorageKey('ws_demo', 'lesson-report');
  const docKey = activeDocumentStorageKey('ws_demo', 'lesson-report');
  const resultId = 'arr_'.concat('0'.repeat(43));
  const open = (storage: Storage) => new UiProposalManager({
    storage, storageKey: proposalKey, documentStorageKey: docKey,
    initial: loadUiProposals(storage, proposalKey),
  });

  it.each(['apply', 'discard'] as const)('roundtrips stage -> reload -> %s -> reload without reactivating history', (action) => {
    const storage = mockStorage();
    const mgr = open(storage);
    expect(mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT }).ok).toBe(true);
    const latestId = 'arr_'.concat('1'.repeat(43));
    const patch = validPatch({ ops: [{ op: 'remove', id: 'event-log' }] });
    expect(mgr.stage({ result_id: latestId, payload: patch, document: LESSON_REPORT_DOCUMENT }).ok).toBe(true);
    expect(loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT)).toEqual(LESSON_REPORT_DOCUMENT);
    expect(loadUiProposals(storage, proposalKey)).toEqual(mgr.list());

    const reopened = open(storage);
    const result = action === 'apply' ? reopened.apply(LESSON_REPORT_DOCUMENT) : reopened.discard();
    expect(result.ok).toBe(true);
    const finalDocument = loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT);
    expect(finalDocument.revision).toBe(action === 'apply' ? 2 : 1);
    expect(finalDocument.nodes.some((node) => node.id === 'event-log')).toBe(action !== 'apply');
    expect(missingProtectedNodes(finalDocument)).toEqual([]);
    const final = open(storage);
    expect(final.list()).toEqual(reopened.list());
    expect(final.current()).toBeNull();
    expect(final.apply(finalDocument)).toMatchObject({ ok: false, code: 'no_proposal' });
    expect(final.discard()).toMatchObject({ ok: false, code: 'no_proposal' });
    // Same delivery is a receipt replay even after apply advanced the document.
    const replay = final.stage({ result_id: latestId, payload: patch, document: finalDocument });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(uiProposalDeliveryStatus(replay.record)).toContain('no new proposal was staged');
    expect(final.current()).toBeNull();
    expect(final.stage({ result_id: latestId, payload: validPatch(), document: finalDocument }))
      .toMatchObject({ ok: false, code: 'idempotency_conflict' });
    expect(loadUiProposals(storage, uiProposalStorageKey('other', 'lesson-report'))).toEqual([]);
    expect(loadActiveDocument(storage, activeDocumentStorageKey('other', 'lesson-report'), LESSON_REPORT_DOCUMENT)).toEqual(LESSON_REPORT_DOCUMENT);
  });

  it('keeps the older staged proposal actionable when staging its replacement fails', () => {
    const armed = new Set<string>();
    const storage = mockStorage({}, armed);
    const mgr = open(storage);
    expect(mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT }).ok).toBe(true);
    const before = mgr.list();
    armed.add(proposalKey);
    expect(mgr.stage({ result_id: 'arr_'.concat('3'.repeat(43)), payload: validPatch(), document: LESSON_REPORT_DOCUMENT }))
      .toMatchObject({ ok: false, code: 'storage_failed' });
    expect(mgr.list()).toEqual(before);
    expect(open(storage).current()).toEqual(before[0]);
  });

  it('roundtrips a mixed remove/insert/update patch without losing validated node fields', () => {
    const storage = mockStorage();
    const mgr = open(storage);
    const eventLog = LESSON_REPORT_DOCUMENT.nodes.find((node) => node.id === 'event-log')!;
    const patch = validPatch({ ops: [
      { op: 'remove', id: 'event-log' },
      { op: 'insert', index: 0, node: eventLog },
      ...validPatch().ops,
    ] });
    expect(mgr.stage({ result_id: resultId, payload: patch, document: LESSON_REPORT_DOCUMENT }).ok).toBe(true);
    expect(open(storage).list()).toEqual(mgr.list());
    const result = open(storage).apply(LESSON_REPORT_DOCUMENT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.nodes[0]).toEqual(eventLog);
      expect(loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT)).toEqual(result.document);
    }
  });

  it('handles reload after the document write lands but metadata fails; stale cannot reapply and remains discardable', () => {
    const armed = new Set<string>();
    const storage = mockStorage({}, armed);
    const mgr = open(storage);
    expect(mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT }).ok).toBe(true);
    armed.add(proposalKey);
    const failed = mgr.apply(LESSON_REPORT_DOCUMENT);
    expect(failed).toMatchObject({ ok: false, code: 'storage_failed' });
    if (!failed.ok) failed.record!.patch.ops.length = 0;
    expect(mgr.current()?.patch.ops).toHaveLength(1);
    const durableDocument = loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT);
    expect(durableDocument.revision).toBe(2);
    const reopened = open(storage);
    expect(reopened.current()?.state).toBe('staged');
    expect(reopened.apply(durableDocument)).toMatchObject({ ok: false, code: 'invalid_patch' });
    expect(loadUiProposals(storage, proposalKey)[0]?.state).toBe('stale');
    // Even supplying an older document cannot turn a known stale proposal active.
    expect(reopened.apply(LESSON_REPORT_DOCUMENT)).toMatchObject({ ok: false, code: 'stale_patch' });
    armed.add(proposalKey);
    expect(reopened.discard()).toMatchObject({ ok: false, code: 'storage_failed' });
    expect(reopened.current()?.state).toBe('stale');
    expect(reopened.discard().ok).toBe(true);
    expect(open(storage).list()[0]).toMatchObject({ state: 'discarded', error: expect.any(String) });
    expect(open(storage).current()).toBeNull();
    expect(loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT)).toEqual(durableDocument);
  });

  it('isolates constructor records and all failed-operation snapshots', () => {
    const armed = new Set<string>();
    const storage = mockStorage({}, armed);
    const mgr = open(storage);
    expect(mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT }).ok).toBe(true);
    const initial = mgr.list();
    const next = new UiProposalManager({ storage, storageKey: proposalKey, documentStorageKey: docKey, initial });
    initial[0]!.patch.ops.length = 0;
    initial[0]!.state = 'applied';
    expect(next.current()?.patch.ops).toHaveLength(1);
    const current = next.current()!;
    current.patch.ops.length = 0;
    current.state = 'discarded';
    expect(next.current()?.state).toBe('staged');
    armed.add(proposalKey);
    const discardFailure = next.discard();
    if (!discardFailure.ok) discardFailure.record!.state = 'applied';
    expect(next.current()?.state).toBe('staged');
    armed.add(proposalKey);
    const staleFailure = next.apply({ ...LESSON_REPORT_DOCUMENT, revision: 2 });
    if (!staleFailure.ok) staleFailure.record!.patch.ops.length = 0;
    expect(next.current()?.patch.ops).toHaveLength(1);
    expect(next.current()?.state).toBe('staged');
    expect(next.apply(LESSON_REPORT_DOCUMENT).ok).toBe(true);
  });

  it('uses the same closed shape and size checks for stage, save, reload and apply', () => {
    const badPatches = [
      { ...validPatch(), extra: true },
      validPatch({ ops: [{ op: 'remove', id: 'event-log', extra: true } as unknown as UiDocumentPatch['ops'][number]] }),
      validPatch({ ops: [{ op: 'update', id: 'review-table', update: { props: { emptyText: 'x'.repeat(9000) } } }] }),
      { ...validPatch(), ops: [{ op: 'insert', index: 0, node: { id: 'event-log', kind: 'event-log', children: [{ id: 'child', kind: 'event-log', extra: true }] } }] },
    ];
    const storage = mockStorage();
    const mgr = open(storage);
    const staged = mgr.stage({ result_id: resultId, payload: validPatch(), document: LESSON_REPORT_DOCUMENT });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    for (const patch of badPatches) {
      expect(mgr.stage({ result_id: 'arr_'.concat('2'.repeat(43)), payload: patch, document: LESSON_REPORT_DOCUMENT }).ok).toBe(false);
      const record = { ...staged.record, patch } as UiProposalRecord;
      expect(saveUiProposals(storage, [record], proposalKey)).toBe(false);
      const fixture = mockStorage({ [proposalKey]: JSON.stringify([record]) });
      expect(loadUiProposals(fixture, proposalKey)).toEqual([]);
      expect(applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, patch).ok).toBe(false);
    }
    expect(loadUiProposals(storage, proposalKey)).toEqual([staged.record]);
  });

  it('rejects invalid documents before saving rather than writing data reload would discard', () => {
    const storage = mockStorage();
    expect(saveActiveDocument(storage, LESSON_REPORT_DOCUMENT, docKey)).toBe(true);
    const stripped = { ...LESSON_REPORT_DOCUMENT, nodes: LESSON_REPORT_DOCUMENT.nodes.filter((node) => node.id !== 'ui-builder') };
    expect(saveActiveDocument(storage, stripped, docKey)).toBe(false);
    expect(applyUiDocumentPatch(stripped, validPatch())).toMatchObject({ ok: false, code: 'protected_surface' });
    expect(loadActiveDocument(storage, docKey, LESSON_REPORT_DOCUMENT)).toEqual(LESSON_REPORT_DOCUMENT);
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

describe('compose-ui · persisted proposal reload fails closed', () => {
  const key = uiProposalStorageKey('ws_demo', 'lesson-report');
  const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    proposal_id: 'arr_'.concat('U'.repeat(43)),
    document_id: 'lesson-report.v1',
    base_revision: LESSON_REPORT_DOCUMENT.revision,
    patch: validPatch(),
    op_count: 1,
    summary: '1 op: update review-table',
    state: 'staged',
    created_at: '2026-09-03T00:00:00.000Z',
    ...over,
  });
  const patchWithRawOps = (ops: unknown[]): UiDocumentPatch => ({ ...validPatch(), ops: ops as UiDocumentPatch['ops'] });
  const stored = (records: unknown[]): Storage => mockStorage({ [key]: JSON.stringify(records) });
  const rejects = (label: string, over: Record<string, unknown>): void => {
    expect(loadUiProposals(stored([record(over)]), key), label).toEqual([]);
  };

  it('accepts a well-formed stored record', () => {
    expect(loadUiProposals(stored([record()]), key)).toHaveLength(1);
  });

  it('rejects malformed, oversized, executable, or contract-breaking stored records', () => {
    rejects('unknown record field', { sneaky: true });
    rejects('non-integer base_revision', { base_revision: 1.5 });
    rejects('op_count mismatch', { op_count: 2 });
    rejects('document mismatch', { document_id: 'other.v1' });
    rejects('revision mismatch', { base_revision: 9 });
    rejects('misleading summary', { summary: 'Approved all reports' });
    rejects('staged with applied metadata', { applied_revision: 2, applied_at: '2026-09-03T00:00:00.000Z' });
    rejects('stale without diagnostic', { state: 'stale' });
    rejects('applied without metadata', { state: 'applied' });
    rejects('applied with wrong revision', { state: 'applied', applied_revision: 7, applied_at: '2026-09-03T00:00:00.000Z' });
    rejects('discarded without timestamp', { state: 'discarded' });
    rejects('discarded with applied metadata', { state: 'discarded', discarded_at: '2026-09-03T00:00:00.000Z', applied_revision: 2 });
    rejects('oversized summary', { summary: 'x'.repeat(2001) });
    rejects('executable summary', { summary: 'no <script>alert(1)</script> please' });
    rejects('executable error', { error: 'onerror= alert(1)' });
    rejects('oversized created_at', { created_at: 'x'.repeat(65) });
    rejects('negative applied_revision', { applied_revision: -1 });
    rejects('wrong patch contract version', { patch: { ...validPatch(), contract_version: 'nope' } });
    rejects('unknown patch envelope field', { patch: { ...validPatch(), authority: 'grant' } });
    rejects('empty patch ops', { patch: { ...validPatch({ ops: [] }) } });
    rejects('too many patch ops', { patch: patchWithRawOps(Array.from({ length: 33 }, () => ({ op: 'remove', id: 'event-log' }))) });
    rejects('unknown op discriminant', { patch: patchWithRawOps([{ op: 'publish', id: 'review-table' }]) });
    rejects('unknown update field', { patch: patchWithRawOps([{ op: 'update', id: 'review-table', update: { props: {}, bindings: {}, evil: {} } }]) });
    rejects('non-object update field value', { patch: patchWithRawOps([{ op: 'update', id: 'review-table', update: { props: 'x' } }]) });
    rejects('serialized patch over the byte bound', {
      patch: patchWithRawOps([{ op: 'update', id: 'review-table', update: { props: { regionId: 'review-table', regionTitle: 'Review table', emptyText: 'x'.repeat(9000) } } }]),
    });
  });

  it('does not resurrect old proposals by filtering malformed or duplicate records out of history', () => {
    expect(loadUiProposals(stored([record(), record({ state: 'corrupt' })]), key)).toEqual([]);
    expect(loadUiProposals(stored([record(), record()]), key)).toEqual([]);
  });

  it('keeps legacy discarded stale diagnostics reloadable', () => {
    const legacy = record({ state: 'discarded', discarded_at: '2026-09-03T00:00:00.000Z', error: 'Stale: re-request.' });
    expect(loadUiProposals(stored([legacy]), key)).toEqual([legacy]);
  });

  it('still revalidates a loaded proposal against the then-current document at apply', () => {
    const proposalKey = uiProposalStorageKey('ws_demo', 'lesson-report');
    const docKey = activeDocumentStorageKey('ws_demo', 'lesson-report');
    const storage = stored([record()]);
    const mgr = new UiProposalManager({
      storage,
      storageKey: proposalKey,
      documentStorageKey: docKey,
      initial: loadUiProposals(storage, proposalKey),
    });
    expect(mgr.current()?.state).toBe('staged');
    const moved = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, validPatch({ ops: [{ op: 'remove', id: 'event-log' }] }));
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const result = mgr.apply(moved.document);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_patch');
    expect(mgr.current()?.state).toBe('stale');
  });
});
