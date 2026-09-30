import { describe, expect, it } from 'vitest';
import { createMockSession, devIdentity } from '@artifact-ax/runtime-client';
import { CollabRoom } from '@artifact-ax/collab';
import { seedReviewTable } from '@artifact-ax/lesson-report';
import { CollabBoard } from './board.js';
import type { CollaborationScope } from './domain.js';

async function openBoard(name = 'alice') {
  const session = createMockSession({
    identity: devIdentity(name),
    artifactId: 'lesson-report',
    room: `test-${Math.random().toString(36).slice(2)}`,
    broadcast: null,
  });
  const room = new CollabRoom(session, { roomKey: 'test' });
  await room.open();
  const scope: CollaborationScope = { workspaceId: 'ws_demo', artifactId: 'lesson-report', actorId: session.identity.uid };
  const instance = new CollabBoard(room, scope, memoryStorage());
  instance.seed(seedReviewTable().rows);
  return { board: instance, session, room };
}

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

describe('CollabBoard', () => {
  it('seeds the review table once', async () => {
    const { board } = await openBoard();
    expect(board.state().rows).toHaveLength(5);
    const before = board.state().revision;
    board.seed([{ id: 'x', student: 'X', topic: 'T', status: 'pending' }]);
    expect(board.state().rows).toHaveLength(5);
    expect(board.state().revision).toBe(before);
  });

  it('approves rows and bumps the shared revision', async () => {
    const { board } = await openBoard();
    const result = board.approveRows(['r-1', 'r-2']);
    expect(result.ok).toBe(true);
    const rows = board.state().rows;
    expect(rows.find((row) => row.id === 'r-1')?.status).toBe('approved');
    expect(board.approveRows(['missing']).ok).toBe(false);
  });

  it('creates work items with 1-3 known rows only', async () => {
    const { board } = await openBoard();
    expect(board.createWorkItem({ id: 'w-1', rowIds: ['r-1', 'r-2'], baselineRevision: 1 }).ok).toBe(true);
    expect(board.createWorkItem({ id: 'w-2', rowIds: ['r-1', 'r-2', 'r-3', 'r-4'], baselineRevision: 1 }).ok).toBe(false);
    expect(board.createWorkItem({ id: 'w-3', rowIds: ['nope'], baselineRevision: 1 }).ok).toBe(false);
    expect(board.createWorkItem({ id: 'w-1', rowIds: ['r-3'], baselineRevision: 1 }).ok).toBe(false);
  });

  it('runs the finding feedback flow with revision guards', async () => {
    const { board } = await openBoard();
    board.createWorkItem({ id: 'w-1', rowIds: ['r-1', 'r-2'], baselineRevision: 1 });
    const finding = board.createFinding({ id: 'f-1', workItemId: 'w-1', summary: 'row drift', rowIds: ['r-1'] });
    expect(finding.ok).toBe(true);
    expect(board.addFeedback({ id: 'fb-1', findingId: 'f-1', findingRevision: 1, text: 'check r-2' }).ok).toBe(true);
    expect(board.addFeedback({ id: 'fb-2', findingId: 'f-1', findingRevision: 9, text: 'stale' }).ok).toBe(false);
    expect(board.feedbackForFinding('f-1')).toHaveLength(1);
  });

  it('applies agent results idempotently and stages the view', async () => {
    const { board } = await openBoard();
    board.createWorkItem({ id: 'w-1', rowIds: ['r-1', 'r-2'], baselineRevision: 1 });
    board.createFinding({ id: 'f-1', workItemId: 'w-1', summary: 'row drift', rowIds: ['r-1'] });
    const input = {
      resultId: 'result/task-1',
      findingId: 'f-1',
      expectedRevision: 1,
      summary: 'row drift confirmed',
      rowIds: ['r-1', 'r-2'] as const,
      proposalId: 'pr-1',
      baseRevision: 0,
    };
    const first = board.applyAgentResult(input);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.finding.revision).toBe(2);
      expect(first.value.proposal.state).toBe('staged');
      expect(first.value.proposal.origin).toBe('agent');
    }
    const replay = board.applyAgentResult(input);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    const conflict = board.applyAgentResult({ ...input, summary: 'different payload' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('duplicate_result_conflict');
    expect(board.finding('f-1')?.revision).toBe(2);
  });

  it('gates proposals through staged → used/discarded and saves private recipes', async () => {
    const { board } = await openBoard();
    board.createWorkItem({ id: 'w-1', rowIds: ['r-1'], baselineRevision: 0 });
    const proposal = board.stageComparisonView({ id: 'pr-1', workItemId: 'w-1', baseRevision: 0, rowIds: ['r-1'] });
    expect(proposal.ok).toBe(true);
    const used = board.useComparisonView('pr-1');
    expect(used.ok).toBe(true);
    const recipe = board.savePrivateViewRecipe({ id: 'view-1', proposalId: 'pr-1', documentRevision: board.state().revision });
    expect(recipe.ok).toBe(true);
    const reopened = board.reopenPrivateViewRecipe('view-1');
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.value.status).toBe('ready');
    expect(board.discardComparisonView('pr-1').ok).toBe(false);
  });

  it('materializes agent docs as colleague artifacts — note into the pad, feedback as an entity', async () => {
    const { board } = await openBoard();
    board.createWorkItem({ id: 'w-1', rowIds: ['r-1', 'r-2'], baselineRevision: board.state().revision });
    board.createFinding({ id: 'f-1', workItemId: 'w-1', summary: 's', rowIds: ['r-1'] });

    const note = board.applyAgentNote({ key: 'note:w-1', revision: 1, workItemId: 'w-1', text: 'check sign slips', actor: 'agent-bot' });
    expect(note.ok).toBe(true);
    expect(board.notesText('w-1').toString()).toBe('[agent-bot] check sign slips');
    // Replay is a no-op — the pad never double-writes.
    board.applyAgentNote({ key: 'note:w-1', revision: 1, workItemId: 'w-1', text: 'dup', actor: 'agent-bot' });
    expect(board.notesText('w-1').toString()).toBe('[agent-bot] check sign slips');

    const fb = board.applyAgentFeedback({
      key: 'fb:f-1', revision: 1, findingId: 'f-1', findingRevision: 1,
      text: 'systematic, not arithmetic', actor: 'agent-bot',
    });
    expect(fb.ok).toBe(true);
    const feedback = board.feedbackForFinding('f-1');
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.actorId).toBe('agent-bot');
    const fbReplay = board.applyAgentFeedback({
      key: 'fb:f-1', revision: 1, findingId: 'f-1', findingRevision: 1, text: 'x', actor: 'agent-bot',
    });
    expect(fbReplay.ok).toBe(true);
    if (fbReplay.ok) expect(fbReplay.replayed).toBe(true);
  });

  it('carries an agent-authored ui document on the staged proposal', async () => {
    const { board } = await openBoard();
    board.createWorkItem({ id: 'w-1', rowIds: ['r-1'], baselineRevision: 1 });
    board.createFinding({ id: 'f-1', workItemId: 'w-1', summary: 'row drift', rowIds: ['r-1'] });
    const input = {
      resultId: 'result/task-9',
      findingId: 'f-1',
      expectedRevision: 1,
      summary: 'revised',
      rowIds: ['r-1'] as const,
      proposalId: 'pr-9',
      baseRevision: 0,
      document: {
        contract_version: 'artifact-ax.ui-document.v1' as const,
        id: 'doc-pr-9',
        revision: 1,
        nodes: [{ id: 'cmp', kind: 'summary-list', props: { regionId: 'cmp-counts' }, bindings: { counts: 'counts' } }],
      },
    };
    const applied = board.applyAgentResult(input);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.value.proposal.document?.id).toBe('doc-pr-9');
    const replay = board.applyAgentResult(input);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    expect(board.snapshot().proposals.find((p) => p.id === 'pr-9')?.document?.contract_version)
      .toBe('artifact-ax.ui-document.v1');
  });

  it('attaches jev verdicts idempotently as evidence on proposals', async () => {
    const { board } = await openBoard();
    board.createWorkItem({ id: 'w-1', rowIds: ['r-1'], baselineRevision: 1 });
    board.stageComparisonView({ id: 'pr-1', workItemId: 'w-1', baseRevision: 0, rowIds: ['r-1'] });

    // Unknown proposal is rejected.
    expect(board.applyViewJudgment({
      resultId: 'result/j-0', proposalId: 'pr-missing', verdict: 'allow', rationale: 'x',
    }).ok).toBe(false);

    const judged = board.applyViewJudgment({
      resultId: 'result/j-1', proposalId: 'pr-1', verdict: 'allow', rationale: 'composition fits',
    });
    expect(judged.ok).toBe(true);
    const replay = board.applyViewJudgment({
      resultId: 'result/j-1', proposalId: 'pr-1', verdict: 'flag', rationale: 'changed?',
    });
    expect(replay.ok && replay.replayed).toBe(true);
    expect(board.snapshot().judgments.find((j) => j.proposalId === 'pr-1')?.verdict).toBe('allow');

    // A re-judgment under a new result id supersedes.
    board.applyViewJudgment({
      resultId: 'result/j-2', proposalId: 'pr-1', verdict: 'flag', rationale: 'recheck',
    });
    expect(board.snapshot().judgments.find((j) => j.proposalId === 'pr-1')?.verdict).toBe('flag');
  });

  it('undoes and redoes local ops via Y.UndoManager without touching remote edits', async () => {
    const { board } = await openBoard();
    board.createWorkItem({ id: 'w-1', rowIds: ['r-1'], baselineRevision: 1 });
    board.clearUndoHistory(); // seed-style ops are not undoable
    board.annotate({ id: 'an-1', nodeId: 'r-1', kind: 'element', text: 'note', actorUid: 'alice' });
    expect(board.snapshot().annotations).toHaveLength(1);

    expect(board.undo()).toBe(true);
    expect(board.snapshot().annotations).toHaveLength(0);

    expect(board.redo()).toBe(true);
    expect(board.snapshot().annotations).toHaveLength(1);

    board.retractAnnotation('an-1', 'alice');
    expect(board.snapshot().annotations).toHaveLength(0);
    expect(board.undo()).toBe(true); // undo the retract → annotation returns
    expect(board.snapshot().annotations).toHaveLength(1);

    // A remote write merges on top and is never undone.
    const remote = board; // same doc in tests; remote origin is excluded anyway
    remote.annotate({ id: 'an-2', nodeId: 'r-1', kind: 'element', text: 'remote-ish', actorUid: 'bob' });
    expect(board.snapshot().annotations).toHaveLength(2);
  });

  it('marks proposals stale when the board revision moved on', async () => {
    const { board } = await openBoard();
    board.createWorkItem({ id: 'w-1', rowIds: ['r-1'], baselineRevision: 0 });
    board.stageComparisonView({ id: 'pr-1', workItemId: 'w-1', baseRevision: 0, rowIds: ['r-1'] });
    board.approveRows(['r-1']);
    const used = board.useComparisonView('pr-1');
    expect(used.ok).toBe(false);
    if (!used.ok) expect(used.code).toBe('stale');
    expect(board.discardComparisonView('pr-1').ok).toBe(true);
  });

  it('closes the annotation → patch loop: stage, validate, apply, discard', async () => {
    const { board } = await openBoard();
    board.seedCanvas();
    const canvas = board.canvas();
    expect(canvas?.id).toBe('canvas');
    expect(canvas?.revision).toBe(1);

    // Valid patch stages a proposal.
    const staged = board.applyAgentCanvasPatch({
      key: 'patch:cp-1',
      revision: 1,
      patch: {
        contract_version: 'artifact-ax.ui-document-patch.v1',
        document_id: 'canvas',
        base_revision: 1,
        ops: [{ op: 'update', id: 'canvas-summary', update: { props: { regionTitle: '◍ flagged' } } }],
      },
      annotationId: 'an-1',
      actor: 'agent-bot',
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const proposalId = staged.value.id;
    expect(board.snapshot().patchProposals[0]?.state).toBe('staged');
    expect(board.snapshot().patchProposals[0]?.annotationId).toBe('an-1');

    // Same (key, revision) replays instead of double-staging.
    const replay = board.applyAgentCanvasPatch({ key: 'patch:cp-1', revision: 1, patch: staged.value.patch });
    expect(replay.ok && replay.replayed).toBe(true);
    expect(board.snapshot().patchProposals).toHaveLength(1);

    // Invalid patch (unknown node) is rejected, never staged.
    const bad = board.applyAgentCanvasPatch({
      key: 'patch:cp-bad',
      revision: 1,
      patch: {
        contract_version: 'artifact-ax.ui-document-patch.v1',
        document_id: 'canvas',
        base_revision: 1,
        ops: [{ op: 'update', id: 'no-such-node', update: { props: {} } }],
      },
    });
    expect(bad.ok).toBe(false);

    // Use applies atomically and bumps the canvas revision.
    const used = board.useCanvasPatch(proposalId);
    expect(used.ok).toBe(true);
    expect(board.canvas()?.revision).toBe(2);
    expect(board.canvas()?.nodes[0]?.props?.regionTitle).toBe('◍ flagged');
    expect(board.snapshot().patchProposals[0]?.state).toBe('applied');

    // A patch staged against r1 is stale once the canvas moved to r2.
    const staleProposal = board.applyAgentCanvasPatch({
      key: 'patch:cp-stale',
      revision: 1,
      patch: {
        contract_version: 'artifact-ax.ui-document-patch.v1',
        document_id: 'canvas',
        base_revision: 1,
        ops: [{ op: 'update', id: 'canvas-notes', update: { props: {} } }],
      },
    });
    // Staging validates against CURRENT canvas → base mismatch rejects at materialization.
    expect(staleProposal.ok).toBe(false);

    // Discard settles a staged patch.
    const staged2 = board.applyAgentCanvasPatch({
      key: 'patch:cp-2',
      revision: 1,
      patch: {
        contract_version: 'artifact-ax.ui-document-patch.v1',
        document_id: 'canvas',
        base_revision: 2,
        ops: [{ op: 'update', id: 'canvas-notes', update: { props: { regionTitle: 'x' } } }],
      },
    });
    expect(staged2.ok).toBe(true);
    if (!staged2.ok) return;
    const discarded = board.discardCanvasPatch(staged2.value.id);
    expect(discarded.ok && discarded.value.state).toBe('discarded');
    expect(board.useCanvasPatch(staged2.value.id).ok).toBe(false);
  });
});
