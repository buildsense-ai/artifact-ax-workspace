import {
  RESULT_RECEIPT_CONTRACT,
  isRecord,
  type ResultReceipt,
  type TaskStatusUpdate,
} from '@artifact-ax/contract';
import {
  createMockSession,
  devIdentity,
  openRuntimeSession,
  resolveIdentity,
  type RuntimeSession,
} from '@artifact-ax/runtime-client';
import { AgentLoop, CollabRoom, Journal, bindTextarea, type JournalEntry } from '@artifact-ax/collab';
import { seedReviewTable, type RowStatus } from '@artifact-ax/lesson-report';
import { createAnnotateOverlay, type PendingAnnotation } from './annotate-ui.js';
import type { AnchorPick } from './annotate-anchor.js';
import type { UiDocumentPatch } from '@artifact-ax/ui-document';
import { CollabBoard } from './board.js';
import {
  AGENT_CARD_KEY,
  AGENT_NAMESPACE,
  ANNOTATE_ASK_INTENT_ID,
  COLLAB_REVIEW_INTENT_ID,
  JUDGE_VIEW_INTENT_ID,
  buildAnnotateAskInput,
  buildCollabReviewInput,
  buildJudgeViewInput,
  isAgentFeedbackKey,
  isAgentNoteKey,
  isAgentPatchKey,
  normalizeAgentCardDoc,
  normalizeAgentFeedbackDoc,
  normalizeAgentNoteDoc,
  normalizeCanvasPatchDoc,
  normalizeAgentNotePayload,
  normalizeCollabResultDoc,
  normalizeViewJudgmentDoc,
} from './contracts.js';
import { prepareInputContext } from './domain.js';
import type { JudgeViewTaskInput } from './contracts.js';
import { buildPageContext, buildRuntimeView } from './projection.js';
import { colleagueDecider, type ViewComposer, type ViewJudge } from './colleague.js';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { App, type AppHandlers, type AppView } from './app.js';
import './index.css';

/**
 * Bootstrap: resolve identity → open a session (real host or BroadcastChannel
 * mock) → open the collab room → seed → wire the app. The same page works
 * standalone (guest, local-only), in mock mode (two-tab local collab), and
 * embedded in the platform.
 */

const ARTIFACT_ID = 'lesson-report';
const WORKSPACE_ID = 'ws_demo';
const RESULT_NAMESPACE = 'result';

const params = new URLSearchParams(location.search);
const roomKey = (params.get('room') ?? 'default').slice(0, 48);
// Mock when asked, or when the page runs standalone (no embedding host):
// a lone page can never reach a real runtime anyway.
const embedded = window.parent !== window;
const useMock = params.get('mock') === '1' || !embedded;
/** `?agent=1` scripted colleague · `?agent=jev` adds the real sidecar judge. */
const agentParam = params.get('agent') === '1' || params.get('agent') === 'jev'
  ? params.get('agent')!
  : undefined;

interface UiState {
  selectedRowIds: Set<string>;
  journal: JournalEntry[];
  agentNotes: Array<{ summary: string; row_ids: string[]; at: string }>;
  taskStatuses: TaskStatusUpdate[];
  notice: string | null;
  /** Canvas annotate mode: pick elements/regions, attach notes. */
  annotateMode: boolean;
  reopened: import('./domain.js').ReopenedRecipe | null;
}

let boardRef: CollabBoard | null = null;

/**
 * The colleague agent (`?agent=1`) runs a real perceive → decide → act loop:
 * AgentLoop wakes it on tasks and on room events (reactive wake), assembles
 * the semantic projection + merged journal tail as context, and executes the
 * decider's typed actions. The decider sees only the AgentContext — never
 * the page's board object.
 */
let colleagueLoop: AgentLoop | null = null;
const colleagueJudge: ViewJudge | undefined = agentParam === 'jev' ? sidecarJudge : undefined;
const colleagueComposer: ViewComposer | undefined = agentParam === 'jev' ? sidecarCompose : undefined;
function colleague(session: RuntimeSession): AgentLoop {
  if (!colleagueLoop) {
    colleagueLoop = new AgentLoop({
      session,
      decider: colleagueDecider({ judge: colleagueJudge, compose: colleagueComposer }),
      onError: (error) => console.error('[colleague]', error),
    });
  }
  return colleagueLoop;
}

/**
 * Dev judge hook (`?agent=jev`): the page delegates the staged-document
 * judgment to the local sidecar, which holds the JEV API key and calls
 * TypeSafe System One. Returns null on any transport/malformed failure —
 * the decider falls back to a typed abstention, never a guessed verdict.
 */
async function sidecarJudge(input: JudgeViewTaskInput): ReturnType<ViewJudge> {
  try {
    const response = await fetch('/jev/judge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proposalId: input.proposal.proposal_id,
        baseRevision: input.proposal.base_revision,
        rowIds: input.proposal.row_ids,
        documentJson: JSON.stringify(input.proposal.document),
        contextSummary:
          `room ${input.room} · proposal ${input.proposal.proposal_id}`
          + ` · base rev ${input.proposal.base_revision}`
          + ` · rows ${input.proposal.row_ids.join(', ')}`,
      }),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isRecord(data)
      || (data.verdict !== 'allow' && data.verdict !== 'flag' && data.verdict !== 'abstain')) {
      return null;
    }
    return {
      verdict: data.verdict,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
      rationale: typeof data.rationale === 'string' ? data.rationale : '',
    };
  } catch {
    return null;
  }
}

/**
 * Dev composer hook (`?agent=jev`): candidate-based composition via the
 * sidecar's Jev evaluation — the decision model selects which candidate
 * nodes the staged view gets. Null → canned document fallback.
 */
async function sidecarCompose(input: Parameters<ViewComposer>[0]): ReturnType<ViewComposer> {
  try {
    const response = await fetch('/jev/compose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!isRecord(data) || data.abstained === true || !Array.isArray(data.composed)) return null;
    return data.composed as ReturnType<ViewComposer> extends Promise<infer T> ? T : never;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  const reactRoot: Root = createRoot(root);

  const { identity: resolved, via } = await resolveIdentity(location.search);
  // A standalone visitor who isn't even a launch guest gets a stable local
  // dev identity so editing still works in the dev loop.
  const identity = via === 'guest' && !embedded ? devIdentity('local') : resolved;

  const session: RuntimeSession = useMock
    ? createMockSession({
        identity,
        room: roomKey,
        artifactId: ARTIFACT_ID,
        agent: agentParam !== undefined
          ? (task, taskInput, agentSession) => void colleague(agentSession).wakeTask({
              task_id: task.task_id,
              intentId: taskInput.intentId,
              payload: taskInput.payload,
            })
          : undefined,
        agentEvents: agentParam !== undefined
          ? (event, agentSession) => colleague(agentSession).wakeEvent(event)
          : undefined,
      })
    : await openRuntimeSession({ identity, awaitHostConnect: true });

  const ui: UiState = {
    selectedRowIds: new Set(),
    journal: [],
    agentNotes: [],
    taskStatuses: [],
    notice: null,
    annotateMode: false,
    reopened: null,
  };

  let presenceSnapshot: import('@artifact-ax/collab').PresenceSnapshot | null = null;
  let renderQueued = false;

  // Manifest-declared agent colleagues: uids are excluded from leadership
  // and used for chip labels; room.open() will connect again (read op).
  const connect = await session.connect();
  const participants = connect.runtime.agent_participants ?? [];
  const agentUids = new Set(participants.map((participant) => participant.uid).filter((uid): uid is string => Boolean(uid)));
  // Live name: manifest-declared → then overwritten by agent:card on arrival.
  let agentName = participants[0]?.name ?? 'agent';

  const room = new CollabRoom(session, {
    roomKey,
    agentUids,
    project: () => boardRef ? buildRuntimeView(boardRef, presenceSnapshot, ui.journal) : null,
    onEvent: (event) => {
      void handleResultEvent(event);
      void handleAgentEvent(event);
    },
    onJournal: () => void refreshJournal(),
    onError: (error) => {
      ui.notice = error.message;
      render();
    },
  });
  const board = new CollabBoard(room, {
    workspaceId: WORKSPACE_ID,
    artifactId: ARTIFACT_ID,
    actorId: identity.uid,
  });
  boardRef = board;

  const render = () => {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      // Preserve the focused field + caret across the full re-render: a
      // remote structural change must not interrupt local typing.
      const active = document.activeElement;
      const focusKey = active instanceof HTMLElement ? active.dataset.focus : undefined;
      const selection = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
        ? { start: active.selectionStart ?? 0, end: active.selectionEnd ?? 0 }
        : null;
      const latestTask = ui.taskStatuses.at(-1);
      const agentActivity = presenceSnapshot?.entries.some((entry) => entry.kind === 'agent')
        ? null
        : latestTask && (latestTask.status === 'submitted' || latestTask.status === 'running')
          ? `${agentName} · task ${latestTask.status}`
          : null;
      const view: AppView = {
        identity,
        via: via === 'guest' && !embedded ? 'dev' : via,
        embedded,
        hostConnected: session.hostConnected,
        roomKey,
        presence: presenceSnapshot,
        agentActivity,
        board: board.snapshot(),
        canvas: board.canvas(),
        selectedRowIds: ui.selectedRowIds,
        journal: ui.journal,
        recipes: board.loadRecipes(),
        reopened: ui.reopened,
        agentNotes: ui.agentNotes,
        taskStatuses: ui.taskStatuses,
        notice: ui.notice,
        annotateMode: ui.annotateMode,
      };
      flushSync(() => {
        reactRoot.render(createElement(App, { view, handlers }));
      });
      // Mark annotated anchors so the canvas shows where notes hang.
      // Element annotations outline their node; region annotations draw a
      // dashed rect reprojected onto the enclosing node's CURRENT bounds
      // plus the stored deltas (Codex-style — survives layout shifts).
      const annotations = board.snapshot().annotations;
      const annotated = new Set(annotations.filter((a) => a.kind !== 'region').map((a) => a.nodeId).filter(Boolean));
      for (const node of root.querySelectorAll<HTMLElement>('[data-node-id]')) {
        if (annotated.has(node.dataset.nodeId ?? '')) node.classList.add('annotated');
      }
      for (const marker of root.querySelectorAll<HTMLElement>('.region-marker')) marker.remove();
      for (const annotation of annotations) {
        if (annotation.kind !== 'region' || !annotation.deltas || !annotation.nodeId) continue;
        const anchorEl = root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(annotation.nodeId)}"]`);
        if (!anchorEl) continue;
        const bounds = anchorEl.getBoundingClientRect();
        const marker = document.createElement('div');
        marker.className = 'region-marker';
        marker.style.left = `${bounds.x + annotation.deltas.dx}px`;
        marker.style.top = `${bounds.y + annotation.deltas.dy}px`;
        marker.style.width = `${bounds.width + annotation.deltas.dw}px`;
        marker.style.height = `${bounds.height + annotation.deltas.dh}px`;
        root.appendChild(marker);
      }
      if (focusKey && selection) {
        const next = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          `[data-focus="${CSS.escape(focusKey)}"]`,
        );
        if (next) {
          next.focus();
          try {
            next.setSelectionRange(selection.start, selection.end);
          } catch {
            // Non-text input types throw on setSelectionRange; harmless.
          }
        }
      }
    });
  };

  const refreshJournal = async () => {
    ui.journal = await Journal.readAll(session).catch(() => ui.journal);
    render();
  };

  /**
   * Agent self-declaration: `agent:card` docs discovered live —
   * `updated_by` is the server-attested bot uid (unforgeable), so the
   * participant registry needs no manifest field or platform support.
   * Every viewer applies cards (not just the leader).
   */
  const agentCards = new Map<string, { name: string; role?: string }>();
  const applyAgentCard = (doc: { value?: unknown; updated_by?: string }) => {
    const card = normalizeAgentCardDoc(doc.value);
    const uid = doc.updated_by;
    if (!card || !uid) return;
    agentCards.set(uid, { name: card.name, ...(card.role ? { role: card.role } : {}) });
    agentUids.add(uid); // mutable Set shared with Presence — exclusion is live
    agentName = card.name;
    render();
  };

  /**
   * Agent-colleague channel: `agent/note:*` docs are proactive writes the
   * room leader splices into the shared notes pad. Only the leader applies
   * (deterministic, no double-insert); followers receive the text through
   * the shared doc merge like any other edit.
   */
  const handleAgentEvent = async (event: import('@artifact-ax/contract').RuntimeEvent) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type !== 'state.updated' || data.namespace !== AGENT_NAMESPACE || typeof data.key !== 'string') return;
    // Self-declaration applies on every viewer — before the leader gate.
    if (data.key === AGENT_CARD_KEY) {
      const doc = await session.stateGet(AGENT_NAMESPACE, AGENT_CARD_KEY).catch(() => null);
      if (doc?.exists) applyAgentCard(doc);
      return;
    }
    if (!room.isLeader()) return;
    const doc = await session.stateGet(AGENT_NAMESPACE, data.key).catch(() => null);
    if (!doc?.exists || board.agentNoteApplied(data.key, doc.revision)) return;
    if (isAgentNoteKey(data.key)) {
      const note = normalizeAgentNoteDoc(doc.value);
      if (note) {
        board.applyAgentNote({
          key: data.key,
          revision: doc.revision,
          workItemId: note.work_item_id,
          text: note.text,
          actor: doc.updated_by ?? 'agent',
        });
      }
      return;
    }
    if (isAgentFeedbackKey(data.key)) {
      const feedback = normalizeAgentFeedbackDoc(doc.value);
      if (feedback) {
        board.applyAgentFeedback({
          key: data.key,
          revision: doc.revision,
          findingId: feedback.finding_id,
          findingRevision: feedback.finding_revision,
          text: feedback.text,
          actor: doc.updated_by ?? 'agent',
        });
      }
      return;
    }
    if (isAgentPatchKey(data.key)) {
      const patch = normalizeCanvasPatchDoc(doc.value);
      if (patch) {
        board.applyAgentCanvasPatch({
          key: data.key,
          revision: doc.revision,
          patch: patch.patch as UiDocumentPatch,
          ...(patch.annotation_id ? { annotationId: patch.annotation_id } : {}),
          ...(patch.rationale ? { rationale: patch.rationale } : {}),
          actor: doc.updated_by ?? 'agent',
        });
      }
    }
  };

  /** Every viewer's initial card scan — viewers joining after the agent
   *  declared still discover it, leader or not. */
  const discoverAgentCards = async () => {
    const list = await session.stateList().catch(() => null);
    if (!list) return;
    for (const ref of list.refs) {
      if (ref.namespace === AGENT_NAMESPACE && ref.key === AGENT_CARD_KEY) {
        const doc = await session.stateGet(AGENT_NAMESPACE, ref.key).catch(() => null);
        if (doc?.exists) applyAgentCard(doc);
      }
    }
  };

  /** Leader sweep: apply any agent notes missed before this page led. */
  const reconcileAgentNotes = async () => {
    if (!room.isLeader()) return;
    const list = await session.stateList().catch(() => null);
    if (!list) return;
    for (const ref of list.refs) {
      if (ref.namespace !== AGENT_NAMESPACE || board.agentNoteApplied(ref.key, ref.revision)) continue;
      if (isAgentNoteKey(ref.key)) {
        const doc = await session.stateGet(AGENT_NAMESPACE, ref.key).catch(() => null);
        const note = doc?.exists ? normalizeAgentNoteDoc(doc.value) : null;
        if (note) {
          board.applyAgentNote({ key: ref.key, revision: doc!.revision, workItemId: note.work_item_id, text: note.text, actor: doc!.updated_by ?? 'agent' });
        }
      } else if (isAgentFeedbackKey(ref.key)) {
        const doc = await session.stateGet(AGENT_NAMESPACE, ref.key).catch(() => null);
        const feedback = doc?.exists ? normalizeAgentFeedbackDoc(doc.value) : null;
        if (feedback) {
          board.applyAgentFeedback({ key: ref.key, revision: doc!.revision, findingId: feedback.finding_id, findingRevision: feedback.finding_revision, text: feedback.text, actor: doc!.updated_by ?? 'agent' });
        }
      } else if (isAgentPatchKey(ref.key)) {
        const doc = await session.stateGet(AGENT_NAMESPACE, ref.key).catch(() => null);
        const patch = doc?.exists ? normalizeCanvasPatchDoc(doc.value) : null;
        if (patch) {
          board.applyAgentCanvasPatch({ key: ref.key, revision: doc!.revision, patch: patch.patch as UiDocumentPatch, ...(patch.annotation_id ? { annotationId: patch.annotation_id } : {}), ...(patch.rationale ? { rationale: patch.rationale } : {}), actor: doc!.updated_by ?? 'agent' });
        }
      }
    }
  };

  const handleResultEvent = async (event: import('@artifact-ax/contract').RuntimeEvent) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type !== 'state.updated' || data.namespace !== RESULT_NAMESPACE || typeof data.key !== 'string') return;
    const doc = await session.stateGet(RESULT_NAMESPACE, data.key).catch(() => null);
    if (!doc?.exists) return;

    // JEV judgment docs: attach the verdict to the proposal as evidence.
    const judgment = normalizeViewJudgmentDoc(doc.value);
    if (judgment) {
      const judged = board.applyViewJudgment({
        resultId: data.key,
        proposalId: judgment.proposal_id,
        verdict: judgment.verdict,
        rationale: judgment.rationale,
        ...(judgment.confidence !== undefined ? { confidence: judgment.confidence } : {}),
      });
      if (judged.ok && !judged.replayed) {
        ui.notice = `jev ${judgment.verdict} on ${judgment.proposal_id}`;
        render();
      }
      return;
    }

    const payload = normalizeCollabResultDoc(doc.value);
    if (!payload) {
      // A malformed/unvalidatable result doc must not vanish silently —
      // this is the exact "task completed, result missing" signature that
      // cost a debug cycle on the first real deploy.
      console.warn('[result] doc failed validation, dropped:', data.key,
        JSON.stringify(doc.value).slice(0, 400));
      return;
    }
    const applied = board.applyAgentResult({
      resultId: data.key,
      findingId: payload.finding.finding_id,
      expectedRevision: payload.finding.expected_revision,
      summary: payload.finding.summary,
      rowIds: payload.finding.row_ids,
      proposalId: payload.comparison_view.proposal_id,
      baseRevision: payload.comparison_view.base_revision,
      document: payload.comparison_view.document,
    });
    ui.notice = applied.ok
      ? (applied.replayed ? 'Agent result already applied.' : `Agent revised ${payload.finding.finding_id} and staged ${payload.comparison_view.proposal_id}.`)
      : `Agent result not applied: ${applied.message}`;
    render();

    // Every viewer sees the staged doc; only the leader submits the JEV
    // judge task — one judgment per proposal, not one per open tab.
    if (applied.ok && !applied.replayed && payload.comparison_view.document && room.isLeader()) {
      void session.taskSubmit(JUDGE_VIEW_INTENT_ID, buildJudgeViewInput({
        room: roomKey,
        proposalId: payload.comparison_view.proposal_id,
        baseRevision: payload.comparison_view.base_revision,
        rowIds: payload.comparison_view.row_ids,
        document: payload.comparison_view.document,
      })).then(() => {
        void room.record('task.submit', `submitted judge-view for ${payload.comparison_view.proposal_id}`, payload.comparison_view.proposal_id);
      }).catch(() => {});
    }
  };

  // One live binding per work-item notes pad; re-rendered textareas rebind
  // here (the previous binding is disposed to avoid observer leaks).
  const notesBindings = new Map<string, () => void>();
  const notesAtFocus = new Map<string, string>();

  const handlers: AppHandlers = {
    bindNotes(textarea: HTMLTextAreaElement, workItemId: string) {
      notesBindings.get(workItemId)?.();
      notesBindings.set(workItemId, bindTextarea(textarea, board.notesText(workItemId), {
        onFocusChange: (focused) => {
          if (focused) {
            notesAtFocus.set(workItemId, board.notesText(workItemId).toString());
            room.presence.setFocus(`notes:${workItemId}`);
          } else {
            room.presence.setFocus(undefined);
            const before = notesAtFocus.get(workItemId);
            const after = board.notesText(workItemId).toString();
            // Journal the edit, not the keystrokes: one semantic entry per
            // blur when the text actually changed.
            if (after.length > 0 && after !== before) {
              void room.record('notes.update', `edited shared notes on ${workItemId} (${after.length} chars)`, workItemId);
            }
          }
        },
      }));
    },
    setFilter(status: RowStatus | 'all') {
      board.setFilter(status);
    },
    toggleRow(id: string) {
      if (ui.selectedRowIds.has(id)) ui.selectedRowIds.delete(id);
      else ui.selectedRowIds.add(id);
      room.presence.setFocus(ui.selectedRowIds.size > 0 ? `${ui.selectedRowIds.size} row(s) selected` : undefined);
      render();
    },
    approveSelected() {
      const result = board.approveRows([...ui.selectedRowIds]);
      ui.notice = result.ok ? null : result.message;
      render();
    },
    createWorkItem() {
      const ids = [...ui.selectedRowIds];
      const result = board.createWorkItem({
        id: `w-${Date.now().toString(36)}`,
        rowIds: ids,
        baselineRevision: board.state().revision,
      });
      if (result.ok) ui.selectedRowIds.clear();
      ui.notice = result.ok ? null : result.message;
      render();
    },
    createFinding(workItemId: string, summary: string) {
      const item = board.workItem(workItemId);
      const result = board.createFinding({
        id: `f-${Date.now().toString(36)}`,
        workItemId,
        summary,
        rowIds: item?.rowIds ?? [],
      });
      ui.notice = result.ok ? null : result.message;
      render();
    },
    addFeedback(findingId: string, revision: number, text: string) {
      const result = board.addFeedback({
        id: `fb-${Date.now().toString(36)}`,
        findingId,
        findingRevision: revision,
        text,
      });
      ui.notice = result.ok ? null : result.message;
      render();
    },
    askAgent(findingId: string) {
      const finding = board.finding(findingId);
      const item = finding ? board.workItem(finding.workItemId) : null;
      if (!finding || !item) {
        ui.notice = 'Finding is unavailable.';
        render();
        return;
      }
      const preparation = prepareInputContext({
        id: `prep-${Date.now().toString(36)}`,
        scope: board.scope,
        stateRevision: board.state().revision,
        selectedRowIds: item.rowIds,
        currentRowIds: board.state().rows.map((row) => row.id),
        filteredOutRowIds: board.state().rows
          .filter((row) => board.state().filter !== 'all' && row.status !== board.state().filter)
          .map((row) => row.id),
        preparedRowLimit: 3,
      });
      if (!preparation.ok) {
        ui.notice = preparation.message;
        render();
        return;
      }
      void session.taskSubmit(COLLAB_REVIEW_INTENT_ID, buildCollabReviewInput({
        room: roomKey,
        workItem: item,
        finding,
        feedback: board.feedbackForFinding(finding.findingId),
        preparation: preparation.value,
      })).then(() => {
        void room.record('task.submit', `submitted collab-review for ${finding.findingId}`, finding.findingId);
      }).catch((error: Error) => {
        ui.notice = error.message;
        render();
      });
    },
    useProposal(id: string) {
      const result = board.useComparisonView(id);
      ui.notice = result.ok ? null : result.message;
      render();
    },
    discardProposal(id: string) {
      const result = board.discardComparisonView(id);
      ui.notice = result.ok ? null : result.message;
      render();
    },
    saveRecipe(proposalId: string) {
      const result = board.savePrivateViewRecipe({
        id: `view-${Date.now().toString(36)}`,
        proposalId,
        documentRevision: board.state().revision,
      });
      ui.notice = result.ok ? null : result.message;
      render();
    },
    useCanvasPatch(id: string) {
      const result = board.useCanvasPatch(id);
      ui.notice = result.ok ? `Canvas updated → revision ${result.value.revision}` : result.message;
      render();
    },
    discardCanvasPatch(id: string) {
      const result = board.discardCanvasPatch(id);
      ui.notice = result.ok ? null : result.message;
      render();
    },
    reopenRecipe(recipeId: string) {
      const result = board.reopenPrivateViewRecipe(recipeId);
      ui.reopened = result.ok ? result.value : null;
      ui.notice = result.ok ? null : result.message;
      render();
    },
    toggleAnnotate() {
      if (annotateOverlay.isActive()) annotateOverlay.exit();
      else annotateOverlay.enter();
    },
    /** Batch submit from the annotate overlay — one entity per note. */
    submitAnnotations(items: PendingAnnotation[]) {
      let ok = 0;
      let first: { id: string; anchor: AnchorPick; text: string } | null = null;
      for (const [index, item] of items.entries()) {
        const id = `an-${Date.now().toString(36)}-${index}`;
        const result = board.annotate({
          id,
          ...item.anchor,
          text: item.text,
          actorUid: session.identity.uid,
        });
        if (result.ok) {
          ok += 1;
          first ??= { id, anchor: item.anchor, text: item.text };
        }
      }
      if (ok === 0 || !first) {
        ui.notice = 'No annotations saved.';
        render();
        return;
      }
      // Environment split: embedded → one task lands the batch leader in
      // chat as an artifact reference (the rest stay legible via journal);
      // standalone → the colleague reads every ui.annotate entry on its
      // reactive wake.
      if (embedded && session.hostConnected) {
        void session.taskSubmit(ANNOTATE_ASK_INTENT_ID, buildAnnotateAskInput({
          room: roomKey,
          annotation: { id: first.id, ...first.anchor, text: first.text },
        })).then(() => {
          ui.notice = `${ok} annotation${ok === 1 ? '' : 's'} saved; first sent to chat as an artifact reference.`;
          render();
        }).catch((error: Error) => {
          ui.notice = `Annotations saved; chat submit failed: ${error.message}`;
          render();
        });
        ui.notice = `${ok} annotation${ok === 1 ? '' : 's'} saved; sending to chat…`;
      } else {
        ui.notice = `${ok} annotation${ok === 1 ? '' : 's'} saved — the colleague reads them from the journal.`;
      }
      render();
    },
    retractAnnotation(id: string) {
      const result = board.retractAnnotation(id, session.identity.uid);
      ui.notice = result.ok ? 'Annotation retracted.' : result.message;
      render();
    },
    /** Flash + scroll to the annotation's anchor — the list↔canvas loop. */
    locateAnnotation(id: string) {
      const annotation = board.snapshot().annotations.find((a) => a.id === id);
      if (!annotation) return;
      let target: HTMLElement | null = null;
      try {
        target = annotation.nodeId
          ? root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(annotation.nodeId)}"]`)
          : annotation.regionId
            ? root.querySelector<HTMLElement>(`[data-region-id="${CSS.escape(annotation.regionId)}"]`)
            : annotation.kind !== 'region' && annotation.selector
              ? root.querySelector<HTMLElement>(annotation.selector)
              : null;
      } catch {
        target = null; // fallback pseudo-selectors like '[region x,y]' are not valid CSS
      }
      if (target) {
        const top = target.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        target.classList.add('ann-flash');
        setTimeout(() => target.classList.remove('ann-flash'), 1000);
        return;
      }
      // No live element — flash a ghost at the stored rect.
      if (annotation.rect) {
        const ghost = document.createElement('div');
        ghost.className = 'region-ghost ann-flash';
        ghost.style.left = `${annotation.rect.x}px`;
        ghost.style.top = `${annotation.rect.y}px`;
        ghost.style.width = `${annotation.rect.w}px`;
        ghost.style.height = `${annotation.rect.h}px`;
        document.body.appendChild(ghost);
        setTimeout(() => ghost.remove(), 1000);
      }
    },
  };
  // click picks the nearest semantic anchor (data-node-id → data-region-id
  // → unique-verified selector), drag picks a region rect, Alt+scroll cycles
  // ancestors. Each pick spawns a badge + floating note card + connector;
  // Done submits the batch.
  const annotateOverlay = createAnnotateOverlay({
    onSubmit: (items) => handlers.submitAnnotations(items),
    onModeChange: (on) => {
      ui.annotateMode = on;
      render();
    },
  });

  // CRDT undo/redo (Y.UndoManager): ⌘Z undoes MY last board change —
  // remote edits are untouchable. Skipped inside text fields (native
  // semantics there) and while the annotate overlay owns ⌘Z itself.
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    if (annotateOverlay.isActive()) return;
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    const applied = event.shiftKey || key === 'y' ? board.redo() : board.undo();
    ui.notice = applied
      ? (event.shiftKey || key === 'y' ? 'Redone.' : 'Undone.')
      : 'Nothing to undo.';
    render();
  });

  (window as unknown as { __ax?: unknown }).__ax = { session, board, room, colleague };
  session.onTaskStatus((status) => {
    ui.taskStatuses.push(status);
    render();
  });

  // OBSERVE: the page synthesizes the final-state runtime view on request.
  session.servePageContext(() => buildPageContext(board, presenceSnapshot, ui.journal, {
    title: document.title,
    location: location.pathname,
  }));

  // Result sink deliveries (e.g. agent notes) apply through this handler.
  session.serveResult((request): ResultReceipt => {
    const note = normalizeAgentNotePayload(request.result.payload);
    if (!note) {
      return {
        contract_version: RESULT_RECEIPT_CONTRACT,
        result_id: request.result.result_id,
        status: 'rejected',
        code: 'invalid_payload',
      };
    }
    ui.agentNotes.push({ summary: note.summary, row_ids: note.row_ids ?? [], at: new Date().toISOString() });
    void room.record('note.apply', `applied agent note for ${note.row_ids?.length ?? 0} rows`, request.result.result_id);
    render();
    return {
      contract_version: RESULT_RECEIPT_CONTRACT,
      result_id: request.result.result_id,
      status: 'applied',
      receipt: { applied: true },
    };
  });

  await room.open();
  void discoverAgentCards();
  board.seed(seedReviewTable().rows);
  board.seedCanvas();
  // Seeding is setup, not an edit — ⌘Z must never un-seed a room.
  board.clearUndoHistory();
  room.presence.onChange((snapshot) => {
    presenceSnapshot = snapshot;
    void reconcileAgentNotes();
    render();
  });
  board.onChange(() => {
    room.mirror?.notifyChanged();
    render();
  });
  await refreshJournal();
  render();
}

void start().catch((error) => {
  const root = document.getElementById('app');
  if (root) {
    const message = document.createElement('p');
    message.className = 'notice';
    message.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
    root.replaceChildren(message);
  }
});
