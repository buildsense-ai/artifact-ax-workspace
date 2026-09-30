/**
 * The mock colleague's decider — the part a real agent replaces.
 *
 * It perceives ONLY through AgentContext: the task input (what a real agent
 * receives), the semantic projection, the merged journal tail, and bounded
 * doc reads. It never touches the page's board object. What it returns is a
 * list of typed actions the AgentLoop executes — including 'wait' when
 * there is nothing worth doing.
 *
 * Reactive path: a `finding.create` journal entry from a human wakes the
 * colleague without any task — it leaves a pad note and structured feedback
 * (unless already done), then goes idle. That is the difference between a
 * scripted responder and a colleague.
 */

import type { AgentAction, AgentContext } from '@artifact-ax/collab';
import { isRecord } from '@artifact-ax/contract';
import {
  AGENT_FEEDBACK_DOC_CONTRACT,
  AGENT_NAMESPACE,
  AGENT_NOTE_DOC_CONTRACT,
  ANNOTATE_ASK_INTENT_ID,
  CANVAS_PATCH_DOC_CONTRACT,
  COLLAB_RESULT_CONTRACT,
  COLLAB_REVIEW_INTENT_ID,
  JUDGE_RESULT_CONTRACT,
  JUDGE_VIEW_INTENT_ID,
  agentFeedbackKey,
  agentNoteKey,
  agentPatchKey,
} from './contracts.js';
import type { AnnotateAskTaskInput, CollabReviewTaskInput, JudgeViewTaskInput, ViewVerdict } from './contracts.js';
import type { UiNode } from '@artifact-ax/ui-document';
import { AGENT_CARD_DOC_CONTRACT, AGENT_CARD_KEY } from './contracts.js';
import { UI_DOCUMENT_PATCH_CONTRACT_VERSION } from '@artifact-ax/ui-document';

const PAUSE_MS = 350;

/**
 * Self-declaration (`agent:card`): the live, server-attested agent
 * participant registry — no manifest field or platform change needed.
 * Written once per loop; viewers discover colleagues from `agent:` docs
 * whose `updated_by` proves the writer really is the bot.
 */
function cardActions(ctx: AgentContext): AgentAction[] {
  return [{
    kind: 'state-put',
    namespace: AGENT_NAMESPACE,
    key: AGENT_CARD_KEY,
    value: {
      contract_version: AGENT_CARD_DOC_CONTRACT,
      name: ctx.session.identity.username || 'agent',
      kind: 'agent',
      role: 'reviews findings, stages comparison views, judges staged docs',
      at: new Date().toISOString(),
    },
  }];
}

/**
 * The real judgment hook — in dev it calls the JEV sidecar (`/jev/judge`),
 * on the platform it is the bot runner's `JevClient.judgeViewDocument`.
 * Returns null on transport failure: the caller falls back to a typed
 * 'abstain' (judge unavailable), never to a guessed verdict.
 */
export interface ViewJudge {
  (input: JudgeViewTaskInput): Promise<{ verdict: ViewVerdict; confidence: number; rationale: string } | null>;
}

/**
 * Candidate-based spec composition — the json-render Jev discipline:
 * the app supplies atomic element candidates, the decision model picks
 * which belong in the view. Returns the selected nodes in candidate
 * order, or null (abstained / unavailable → canned fallback).
 */
export interface ViewComposer {
  (input: {
    prompt: string;
    contextSummary: string;
    candidates: Array<{ id: string; description: string; node: UiNode }>;
  }): Promise<UiNode[] | null>;
}

export function colleagueDecider(opts: { judge?: ViewJudge; compose?: ViewComposer } = {}): (ctx: AgentContext) => Promise<AgentAction[]> {
  let declared = false;
  return async (ctx) => {
    const intro = declared ? [] : cardActions(ctx);
    declared = true;
    const task = ctx.wake.task;
    if (task) {
      if (task.intentId === JUDGE_VIEW_INTENT_ID) return [...intro, ...await judgeActions(task, opts.judge)];
      if (task.intentId === COLLAB_REVIEW_INTENT_ID) return [...intro, ...await reviewActions(ctx, task, opts.compose)];
      if (task.intentId === ANNOTATE_ASK_INTENT_ID) return [...intro, ...annotateAskActions(task)];
      return [...intro, { kind: 'wait', reason: `unhandled intent ${task.intentId}` }];
    }
    if (ctx.wake.event) return [...intro, ...await reactiveActions(ctx)];
    return [...intro, { kind: 'wait', reason: 'idle wake' }];
  };
}

async function reviewActions(
  ctx: AgentContext,
  task: { task_id: string; payload: unknown },
  compose?: ViewComposer,
): Promise<AgentAction[]> {
  const input = task.payload as CollabReviewTaskInput;
  if (!isRecord(input) || !isRecord(input.finding) || !isRecord(input.work_item)) {
    return [{ kind: 'wait', reason: 'malformed collab-review input' }];
  }
  const findingId = typeof input.finding.id === 'string' ? input.finding.id : null;
  const workItemId = typeof input.work_item.id === 'string' ? input.work_item.id : null;
  const revision = typeof input.finding.revision === 'number' ? input.finding.revision : null;
  const rowIds = Array.isArray(input.finding.row_ids)
    ? input.finding.row_ids.filter((id): id is string => typeof id === 'string')
    : [];
  const summary = typeof input.finding.summary === 'string' ? input.finding.summary : '';
  if (!findingId || !workItemId || revision === null) {
    return [{ kind: 'wait', reason: 'collab-review input missing fields' }];
  }
  const proposalId = `pr-${findingId}-r${revision + 1}`;
  // Base revision from the leader's semantic mirror — the same signal a
  // real agent reads, never the page's live board object.
  const baseRevision = isRecord(ctx.projection) && typeof ctx.projection.board_revision === 'number'
    ? ctx.projection.board_revision
    : 0;
  return [
    { kind: 'presence', focus: `reviewing ${findingId}`, ttlMs: 15_000 },
    { kind: 'pause', ms: PAUSE_MS },
    {
      kind: 'state-put',
      namespace: AGENT_NAMESPACE,
      key: agentNoteKey(workItemId),
      value: {
        contract_version: AGENT_NOTE_DOC_CONTRACT,
        work_item_id: workItemId,
        text: `rev ${revision} consistent overall — watch sign slips on rows ${rowIds.join(', ')}`,
        at: new Date().toISOString(),
      },
    },
    { kind: 'journal', entryKind: 'agent.note', summary: `left a note on ${workItemId}`, target: workItemId },
    { kind: 'pause', ms: PAUSE_MS },
    {
      kind: 'state-put',
      namespace: AGENT_NAMESPACE,
      key: agentFeedbackKey(findingId),
      value: {
        contract_version: AGENT_FEEDBACK_DOC_CONTRACT,
        finding_id: findingId,
        finding_revision: revision,
        text: 'setup divergence is systematic, not arithmetic slips',
        at: new Date().toISOString(),
      },
    },
    { kind: 'journal', entryKind: 'agent.feedback', summary: `added structured feedback on ${findingId}`, target: findingId },
    { kind: 'pause', ms: PAUSE_MS },
    {
      kind: 'result',
      taskId: task.task_id,
      value: {
        contract_version: COLLAB_RESULT_CONTRACT,
        task_id: task.task_id,
        finding: {
          finding_id: findingId,
          expected_revision: revision,
          summary: `${summary} — revised by mock agent`,
          row_ids: rowIds,
        },
        comparison_view: {
          proposal_id: proposalId,
          base_revision: baseRevision,
          row_ids: rowIds,
          document: await agentViewDocument(proposalId, {
            compose,
            contextSummary: `finding ${findingId} rev ${revision} in work item ${workItemId} — rows ${rowIds.join(', ')} — summary: ${summary.slice(0, 200)}`,
          }),
        },
      },
    },
    {
      kind: 'journal',
      entryKind: 'agent.review',
      summary: `revised ${findingId} and staged ${proposalId}`,
      target: findingId,
    },
    { kind: 'presence', ttlMs: 4_000 },
  ];
}

async function judgeActions(
  task: { task_id: string; payload: unknown },
  judge?: ViewJudge,
): Promise<AgentAction[]> {
  const input = task.payload as JudgeViewTaskInput;
  const proposalId = isRecord(input) && isRecord(input.proposal) && typeof input.proposal.proposal_id === 'string'
    ? input.proposal.proposal_id
    : null;
  if (!proposalId) return [{ kind: 'wait', reason: 'judge input missing proposal_id' }];
  // With a real judge wired the verdict comes from TypeSafe System One;
  // without it the mock colleague keeps its deterministic canned answer.
  let verdict: ViewVerdict = 'allow';
  let confidence = 0.9;
  let rationale = 'composition matches the review intent; bindings resolve to proposal rows and counts';
  if (judge) {
    const judged = await judge(input);
    if (judged) {
      verdict = judged.verdict;
      confidence = judged.confidence;
      rationale = judged.rationale;
    } else {
      verdict = 'abstain';
      confidence = 1;
      rationale = 'judge unavailable — typed abstention, deterministic path preserved';
    }
  }
  return [
    { kind: 'presence', focus: `judging ${proposalId}`, ttlMs: 8_000 },
    { kind: 'pause', ms: 300 },
    {
      kind: 'result',
      taskId: task.task_id,
      value: {
        contract_version: JUDGE_RESULT_CONTRACT,
        proposal_id: proposalId,
        verdict,
        confidence,
        rationale,
      },
    },
    { kind: 'journal', entryKind: 'agent.judge', summary: `judged ${proposalId}: ${verdict}`, target: proposalId },
    { kind: 'presence', ttlMs: 4_000 },
  ];
}

/**
 * Annotate-ask: the embedded chat-reference path — the platform delivered
 * the annotation as a task; the colleague answers through the room. The
 * standalone path reaches the same behaviour via the `ui.annotate` journal
 * wake instead of a task.
 */
function annotateAskActions(task: { task_id: string; payload: unknown }): AgentAction[] {
  const input = task.payload as AnnotateAskTaskInput;
  const annotation = isRecord(input) && isRecord(input.annotation) ? input.annotation : null;
  const nodeId = annotation && typeof annotation.node_id === 'string' ? annotation.node_id : null;
  const text = annotation && typeof annotation.text === 'string' ? annotation.text : '';
  const annotationId = annotation && typeof annotation.id === 'string' ? annotation.id : task.task_id;
  const region = isRecord(annotation?.rect) ? `region ${annotation.rect.x},${annotation.rect.y}` : null;
  const anchor = annotation?.kind === 'region' && region ? region
    : nodeId ?? (typeof annotation?.region_id === 'string' ? annotation.region_id
      : typeof annotation?.selector === 'string' ? annotation.selector : 'element');
  return [
    { kind: 'presence', focus: `answering annotation on ${anchor}`, ttlMs: 10_000 },
    { kind: 'pause', ms: 300 },
    {
      kind: 'journal',
      entryKind: 'agent.annotate-answer',
      summary: `answered annotation on ${anchor}${text ? ` — “${text.slice(0, 80)}”` : ''}`,
      target: annotationId,
    },
    {
      kind: 'result',
      taskId: task.task_id,
      value: {
        contract_version: 'lesson-report.annotate-answer.v1',
        annotation_id: annotationId,
        answer: `noted ${anchor}: ${text.slice(0, 200)}`,
      },
    },
    { kind: 'presence', ttlMs: 4_000 },
  ];
}

/**
 * Reactive wake: a room event, not a task. A `finding.create` journal entry
 * from another actor triggers proactive feedback — unless the colleague has
 * already left feedback on that finding (checked via the `agent/fb:` doc).
 */
async function reactiveActions(ctx: AgentContext): Promise<AgentAction[]> {
  const event = ctx.wake.event;
  if (!event || event.namespace !== 'journal' || typeof event.key !== 'string') {
    return [{ kind: 'wait', reason: 'not a journal event' }];
  }
  const doc = await ctx.get('journal', event.key);
  if (!doc?.exists) return [{ kind: 'wait', reason: 'journal doc missing' }];
  const entries = (doc.value as { entries?: Array<{
    actor?: { uid?: string };
    kind?: string;
    target?: string;
    detail?: Record<string, unknown>;
  }> }).entries;
  const latest = entries?.[entries.length - 1];
  const selfUid = ctx.session.identity.uid;
  if (!latest || latest.actor?.uid === selfUid) {
    return [{ kind: 'wait', reason: 'own journal entry or empty' }];
  }
  if (latest.kind === 'ui.annotate') {
    const nodeId = typeof latest.detail?.node_id === 'string' ? latest.detail.node_id : null;
    const text = typeof latest.detail?.text === 'string' ? latest.detail.text : '';
    const annotationId = typeof latest.detail?.annotation_id === 'string'
      ? latest.detail.annotation_id : typeof latest.target === 'string' ? latest.target : null;
    const anchor = nodeId ?? latest.target ?? 'element';
    // If the annotation anchors to a live canvas node, respond with a
    // staged canvas patch (agent/patch:* doc → leader materializes →
    // human Use/Discard). Otherwise just acknowledge.
    // The semantic mirror debounces ~800ms; the journal wake can race ahead
    // of it. Re-read the snapshot with a bounded retry so the patch path
    // isn't starved by mirror lag — the projection is the agent's only
    // legible channel for the canvas.
    let canvas: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snap = await ctx.get('semantic', 'snapshot');
      const view = snap?.exists && isRecord(snap.value) ? (snap.value as { view?: unknown }).view : null;
      canvas = isRecord(view) && isRecord(view.canvas) ? view.canvas : null;
      if (canvas || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const canvasNode = nodeId && canvas && Array.isArray(canvas.node_ids)
      && (canvas.node_ids as string[]).includes(nodeId);
    const actions: AgentAction[] = [
      { kind: 'presence', focus: `reading annotation on ${anchor}`, ttlMs: 10_000 },
      { kind: 'pause', ms: 300 },
    ];
    if (canvasNode) {
      const patchId = `cp-${(annotationId ?? 'x').replace(/[^A-Za-z0-9._:-]+/g, '_')}`;
      actions.push({
        kind: 'state-put',
        namespace: AGENT_NAMESPACE,
        key: agentPatchKey(patchId),
        value: {
          contract_version: CANVAS_PATCH_DOC_CONTRACT,
          patch: {
            contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
            document_id: typeof canvas?.id === 'string' ? canvas.id : 'canvas',
            base_revision: typeof canvas?.revision === 'number' ? canvas.revision : 0,
            ops: [
              { op: 'update', id: nodeId, update: { props: { regionTitle: `◍ reviewing — “${text.slice(0, 60)}”` } } },
            ],
          },
          ...(annotationId ? { annotation_id: annotationId } : {}),
          context: {
            ...(nodeId ? { node_id: nodeId } : {}),
            ...(typeof latest.detail?.region_id === 'string' ? { region_id: latest.detail.region_id } : {}),
            ...(typeof latest.detail?.selector === 'string' ? { selector: latest.detail.selector } : {}),
            ...(isRecord(latest.detail?.rect) ? { rect: latest.detail.rect } : {}),
            ...(typeof latest.detail?.excerpt === 'string' ? { excerpt: latest.detail.excerpt } : {}),
          },
          rationale: `responded to annotation “${text.slice(0, 120)}”`,
          at: new Date().toISOString(),
        },
      });
    }
    actions.push(
      {
        kind: 'journal',
        entryKind: 'agent.annotate-ack',
        summary: canvasNode
          ? `staged canvas patch for annotation on ${anchor} — “${text.slice(0, 80)}”`
          : `noted annotation on ${anchor}${text ? ` — “${text.slice(0, 80)}”` : ''}`,
        ...(latest.target ? { target: latest.target } : {}),
      },
      { kind: 'presence', ttlMs: 4_000 },
    );
    return actions;
  }
  if (latest.kind !== 'finding.create' || typeof latest.target !== 'string') {
    return [{ kind: 'wait', reason: `unhandled journal kind ${latest.kind ?? '?'}` }];
  }
  const findingId = latest.target;
  const workItemId = typeof latest.detail?.work_item_id === 'string' ? latest.detail.work_item_id : null;
  const fbKey = agentFeedbackKey(findingId);
  const existing = await ctx.get(AGENT_NAMESPACE, fbKey);
  if (existing?.exists) {
    return [{ kind: 'wait', reason: `already gave feedback on ${findingId}` }];
  }
  return [
    { kind: 'presence', focus: `proactively reviewing ${findingId}`, ttlMs: 12_000 },
    { kind: 'pause', ms: 400 },
    {
      kind: 'state-put',
      namespace: AGENT_NAMESPACE,
      key: fbKey,
      value: {
        contract_version: AGENT_FEEDBACK_DOC_CONTRACT,
        finding_id: findingId,
        finding_revision: 1,
        text: 'flagged early: check row coverage against the work item scope',
        at: new Date().toISOString(),
      },
    },
    ...(workItemId ? [{
      kind: 'state-put' as const,
      namespace: AGENT_NAMESPACE,
      key: agentNoteKey(workItemId),
      value: {
        contract_version: AGENT_NOTE_DOC_CONTRACT,
        work_item_id: workItemId,
        text: `noticed new finding ${findingId} — flagged row coverage`,
        at: new Date().toISOString(),
      },
    }] : []),
    {
      kind: 'journal',
      entryKind: 'agent.proactive',
      summary: `proactively flagged ${findingId} after it appeared`,
      target: findingId,
    },
    { kind: 'presence', ttlMs: 4_000 },
  ];
}

/**
 * The agent-authored view: with a composer wired (`?agent=jev`), the
 * decision model SELECTS which candidate nodes belong — same discipline
 * as json-render's experimental_composeSpec (app-supplied candidates,
 * decision-model selection, catalog order). Without it, all candidates
 * emit (the canned path).
 */
const VIEW_CANDIDATES: Array<{ id: string; description: string; node: UiNode }> = [
  {
    id: 'cmp-rows',
    description: 'Compared rows table — the flagged report rows with status',
    node: {
      id: 'cmp-rows',
      kind: 'review-table',
      props: { regionId: 'agent-cmp-rows', regionTitle: 'Compared rows' },
      bindings: { rows: 'rows' },
    },
  },
  {
    id: 'cmp-counts',
    description: 'Status counts — how the compared rows distribute by review status',
    node: {
      id: 'cmp-counts',
      kind: 'summary-list',
      props: { regionId: 'agent-cmp-counts', regionTitle: 'Status counts' },
      bindings: { counts: 'counts' },
    },
  },
  {
    id: 'cmp-notes',
    description: 'Findings feedback lines — prior feedback on this finding',
    node: {
      id: 'cmp-notes',
      kind: 'agent-notes',
      props: { regionId: 'agent-cmp-notes', regionTitle: 'Findings feedback' },
      bindings: { notes: 'notes' },
    },
  },
];

async function agentViewDocument(
  proposalId: string,
  opts: { compose?: ViewComposer; contextSummary?: string } = {},
) {
  let nodes = VIEW_CANDIDATES.map((c) => c.node);
  if (opts.compose) {
    const chosen = await opts.compose({
      prompt: 'Choose the elements for a staged comparison view of flagged report rows',
      contextSummary: opts.contextSummary ?? `comparison view ${proposalId}`,
      candidates: VIEW_CANDIDATES,
    });
    if (chosen && chosen.length > 0) nodes = chosen;
  }
  return {
    contract_version: 'artifact-ax.ui-document.v1' as const,
    id: `doc-${proposalId}`.slice(0, 64),
    title: 'Agent comparison view',
    revision: 1,
    nodes,
  };
}
