import { isRecord } from '@artifact-ax/contract';
import { checkDocument } from '@artifact-ax/ui-document';
import type { UiDocument } from '@artifact-ax/ui-document';
import type { InputPreparation, WorkItem, FindingRevision, FindingFeedback } from './domain.js';

/**
 * The concrete application task/result contracts. Task inputs are bounded
 * projections of the shared board — entity ids and revisions, never event
 * history, credentials, or transport refs. Agent results arrive either as a
 * Runtime State document (runtime_state completion) or as a declared
 * result-sink delivery to the page.
 */

export const COLLAB_REVIEW_INTENT_ID = 'lesson-report.collab-review.v1' as const;
export const REVIEW_SELECTION_INTENT_ID = 'lesson-report.review-selection.v1' as const;
export const JUDGE_VIEW_INTENT_ID = 'lesson-report.judge-view.v1' as const;
export const ANNOTATE_ASK_INTENT_ID = 'lesson-report.annotate-ask.v1' as const;
export const AGENT_NOTES_SINK_ID = 'lesson-report.agent-notes.upsert.v1' as const;

export const COLLAB_TASK_CONTRACT = 'lesson-report.collaboration-task.v2' as const;
export const COLLAB_RESULT_CONTRACT = 'lesson-report.collaboration-result.v1' as const;
export const JUDGE_TASK_CONTRACT = 'lesson-report.judge-task.v1' as const;
export const JUDGE_RESULT_CONTRACT = 'lesson-report.view-judgment.v1' as const;
export const ANNOTATE_TASK_CONTRACT = 'lesson-report.annotate-task.v1' as const;
export const AGENT_NOTE_CONTRACT = 'lesson-report.agent-note.v1' as const;

export interface CollabReviewTaskInput {
  contract_version: typeof COLLAB_TASK_CONTRACT;
  view: 'lesson-report';
  room: string;
  work_item: {
    id: string;
    baseline_revision: number;
    row_ids: string[];
  };
  finding: {
    id: string;
    revision: number;
    summary: string;
    row_ids: string[];
    feedback: Array<{ id: string; finding_revision: number; text: string }>;
  };
  input_preparation: {
    selected_row_ids: string[];
    application_prepared_row_ids: string[];
    context_truncated_row_ids: string[];
    filtered_out_row_ids: string[];
    missing_target_row_ids: string[];
    platform_coverage: 'unknown';
  };
}

export interface CollabResultDoc {
  contract_version: typeof COLLAB_RESULT_CONTRACT;
  task_id?: string;
  finding: {
    finding_id: string;
    expected_revision: number;
    summary: string;
    row_ids: string[];
  };
  comparison_view: {
    proposal_id: string;
    base_revision: number;
    row_ids: string[];
    /**
     * Optional agent-authored declarative view (json-render): a bounded
     * UiDocument rendered through the fixed catalog as a read-only staged
     * preview. `Use` still applies the row-selection recipe — document
     * events never wire.
     */
    document?: UiDocument;
  };
}

/**
 * JEV judge task input: the staged document plus the bounded context needed
 * to judge semantic fit — never event history or credentials. The verdict
 * is supplementary evidence on the proposal; the human Use/Discard remains
 * the only authorization path (CatsLog JEV discipline).
 */
export interface JudgeViewTaskInput {
  contract_version: typeof JUDGE_TASK_CONTRACT;
  room: string;
  proposal: {
    proposal_id: string;
    base_revision: number;
    row_ids: string[];
    document: UiDocument;
  };
}

export type ViewVerdict = 'allow' | 'flag' | 'abstain';

/**
 * JEV judgment result document — typed verdict, rationale, abstains allowed.
 * `confidence` mirrors the System One answer confidence (0-1); abstentions
 * carry `1 - noul`.
 */
export interface ViewJudgmentDoc {
  contract_version: typeof JUDGE_RESULT_CONTRACT;
  proposal_id: string;
  verdict: ViewVerdict;
  rationale: string;
  confidence?: number;
}

export function buildJudgeViewInput(input: {
  room: string;
  proposalId: string;
  baseRevision: number;
  rowIds: readonly string[];
  document: UiDocument;
}): JudgeViewTaskInput {
  return {
    contract_version: JUDGE_TASK_CONTRACT,
    room: input.room,
    proposal: {
      proposal_id: input.proposalId,
      base_revision: input.baseRevision,
      row_ids: [...input.rowIds],
      document: input.document,
    },
  };
}

export function normalizeViewJudgmentDoc(value: unknown): ViewJudgmentDoc | null {
  if (!isRecord(value) || value.contract_version !== JUDGE_RESULT_CONTRACT) return null;
  const proposalId = boundedText(value.proposal_id, 128);
  const verdict = value.verdict === 'allow' || value.verdict === 'flag' || value.verdict === 'abstain'
    ? value.verdict : null;
  const rationale = boundedText(value.rationale, 2000);
  const confidence = value.confidence === undefined ? undefined
    : (typeof value.confidence === 'number' && Number.isFinite(value.confidence)
        && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : null);
  if (confidence === null) return null;
  if (!proposalId || !verdict || !rationale) return null;
  return {
    contract_version: JUDGE_RESULT_CONTRACT,
    proposal_id: proposalId,
    verdict,
    rationale,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

/**
 * Annotate-ask task input: an anchored element + the human's note. In an
 * embedded artifact this is the chat-quote channel — the platform posts the
 * task's visible message into the topic with `artifact_task_ref`. The
 * annotation entity itself is already in shared state; this carries a
 * bounded projection so the task is self-contained.
 */
export interface AnnotateAskTaskInput {
  contract_version: typeof ANNOTATE_TASK_CONTRACT;
  room: string;
  annotation: {
    id: string;
    kind?: 'element' | 'region';
    node_id?: string;
    region_id?: string;
    selector?: string;
    rect?: { x: number; y: number; w: number; h: number };
    excerpt?: string;
    /** Bounded element context (tag/role/name/size). */
    context?: string;
    text: string;
  };
}

export function buildAnnotateAskInput(input: {
  room: string;
  annotation: {
    id: string;
    kind?: 'element' | 'region';
    nodeId?: string;
    regionId?: string;
    selector?: string;
    rect?: { x: number; y: number; w: number; h: number };
    excerpt?: string;
    /** Bounded element context (tag/role/name/size). */
    context?: string;
    text: string;
  };
}): AnnotateAskTaskInput {
  return {
    contract_version: ANNOTATE_TASK_CONTRACT,
    room: input.room,
    annotation: {
      id: input.annotation.id,
      ...(input.annotation.nodeId ? { node_id: input.annotation.nodeId } : {}),
      ...(input.annotation.regionId ? { region_id: input.annotation.regionId } : {}),
      ...(input.annotation.kind ? { kind: input.annotation.kind } : {}),
      ...(input.annotation.selector ? { selector: input.annotation.selector } : {}),
      ...(input.annotation.rect ? { rect: input.annotation.rect } : {}),
      ...(input.annotation.excerpt ? { excerpt: input.annotation.excerpt.slice(0, 200) } : {}),
      ...(input.annotation.context ? { context: input.annotation.context.slice(0, 240) } : {}),
      text: input.annotation.text.slice(0, 500),
    },
  };
}

export interface AgentNotePayload {
  contract_version?: string;
  summary: string;
  row_ids?: string[];
}

/**
 * Proactive agent note — a colleague artifact the Agent writes directly into
 * the `agent` runtime namespace (no task required). The room leader splices
 * it into the work item's shared notes pad as `[agent] …`.
 */
export const AGENT_NAMESPACE = 'agent' as const;
export const AGENT_NOTE_DOC_CONTRACT = 'lesson-report.agent-note-doc.v1' as const;

/**
 * Agent self-declaration card — the live, server-attested answer to
 * "who are the agent colleagues here". The agent writes `agent:card`
 * once on joining; `updated_by` (server-stamped) is the proof — a human
 * cannot impersonate an agent card because they cannot write `agent:`
 * docs under a bot identity. Viewers build the participant list from
 * cards, no manifest field or platform change required.
 */
export const AGENT_CARD_DOC_CONTRACT = 'lesson-report.agent-card.v1' as const;
export const AGENT_CARD_KEY = 'card' as const;

export interface AgentCardDoc {
  contract_version: typeof AGENT_CARD_DOC_CONTRACT;
  name: string;
  kind: 'agent';
  /** What this colleague does — bounded free text for chips/tooltips. */
  role?: string;
  at: string;
}

export function normalizeAgentCardDoc(value: unknown): AgentCardDoc | null {
  if (!isRecord(value) || value.contract_version !== AGENT_CARD_DOC_CONTRACT) return null;
  const name = boundedText(value.name, 64);
  if (!name || value.kind !== 'agent') return null;
  return {
    contract_version: AGENT_CARD_DOC_CONTRACT,
    name,
    kind: 'agent',
    ...(boundedText(value.role, 120) ? { role: value.role as string } : {}),
    at: typeof value.at === 'string' ? value.at : '',
  };
}

export interface AgentNoteDoc {
  contract_version: typeof AGENT_NOTE_DOC_CONTRACT;
  work_item_id: string;
  text: string;
  at: string;
}

export function agentNoteKey(workItemId: string): string {
  return `note:${workItemId.replace(/[^A-Za-z0-9._:-]+/g, '_')}`;
}

export function isAgentNoteKey(key: string): boolean {
  return key.startsWith('note:');
}

export function normalizeAgentNoteDoc(value: unknown): AgentNoteDoc | null {
  if (!isRecord(value) || value.contract_version !== AGENT_NOTE_DOC_CONTRACT) return null;
  const workItemId = boundedText(value.work_item_id, 128);
  const text = boundedText(value.text, 2000);
  const at = typeof value.at === 'string' ? value.at : '';
  if (!workItemId || !text) return null;
  return { contract_version: AGENT_NOTE_DOC_CONTRACT, work_item_id: workItemId, text, at };
}

/**
 * Structured agent feedback — the machine-readable counterpart of a pad
 * note: targets a specific finding revision, materializes as a real
 * FindingFeedback entity with the agent as actor.
 */
export const AGENT_FEEDBACK_DOC_CONTRACT = 'lesson-report.agent-feedback-doc.v1' as const;

export interface AgentFeedbackDoc {
  contract_version: typeof AGENT_FEEDBACK_DOC_CONTRACT;
  finding_id: string;
  finding_revision: number;
  text: string;
  at: string;
}

export function agentFeedbackKey(findingId: string): string {
  return `fb:${findingId.replace(/[^A-Za-z0-9._:-]+/g, '_')}`;
}

export function isAgentFeedbackKey(key: string): boolean {
  return key.startsWith('fb:');
}

export function normalizeAgentFeedbackDoc(value: unknown): AgentFeedbackDoc | null {
  if (!isRecord(value) || value.contract_version !== AGENT_FEEDBACK_DOC_CONTRACT) return null;
  const findingId = boundedText(value.finding_id, 128);
  const findingRevision = int(value.finding_revision);
  const text = boundedText(value.text, 2000);
  const at = typeof value.at === 'string' ? value.at : '';
  if (!findingId || findingRevision === null || !text) return null;
  return {
    contract_version: AGENT_FEEDBACK_DOC_CONTRACT,
    finding_id: findingId,
    finding_revision: findingRevision,
    text,
    at,
  };
}

/**
 * Canvas patch docs — the agent's answer to a canvas annotation. Written to
 * `agent/patch:<id>` (agent namespace, own key), materialized by the leader
 * page into a staged `CanvasPatchProposal` the human Uses or Discards.
 */
export const CANVAS_PATCH_DOC_CONTRACT = 'lesson-report.canvas-patch.v1' as const;

export interface CanvasPatchDoc {
  contract_version: typeof CANVAS_PATCH_DOC_CONTRACT;
  /** Full UiDocumentPatch against the canvas document. */
  patch: unknown;
  annotation_id?: string;
  rationale?: string;
  /** Bounded annotation context the agent reasoned from (anchor + evidence). */
  context?: {
    node_id?: string;
    region_id?: string;
    selector?: string;
    rect?: { x: number; y: number; w: number; h: number };
    excerpt?: string;
  };
  at: string;
}

export function agentPatchKey(proposalId: string): string {
  return `patch:${proposalId.replace(/[^A-Za-z0-9._:-]+/g, '_')}`;
}

export function isAgentPatchKey(key: string): boolean {
  return key.startsWith('patch:');
}

/** Shape-check only — the patch payload itself is validated by validatePatch at materialization. */
export function normalizeCanvasPatchDoc(value: unknown): CanvasPatchDoc | null {
  if (!isRecord(value) || value.contract_version !== CANVAS_PATCH_DOC_CONTRACT) return null;
  if (!isRecord(value.patch)) return null;
  const at = typeof value.at === 'string' ? value.at : '';
  const annotationId = typeof value.annotation_id === 'string' ? value.annotation_id.slice(0, 128) : undefined;
  const rationale = typeof value.rationale === 'string' ? value.rationale.slice(0, 500) : undefined;
  const context = isRecord(value.context) ? {
    ...(typeof value.context.node_id === 'string' ? { node_id: value.context.node_id.slice(0, 128) } : {}),
    ...(typeof value.context.region_id === 'string' ? { region_id: value.context.region_id.slice(0, 128) } : {}),
    ...(typeof value.context.selector === 'string' ? { selector: value.context.selector.slice(0, 256) } : {}),
    ...(isRecord(value.context.rect) ? { rect: {
      x: Math.round(Number(value.context.rect.x) || 0),
      y: Math.round(Number(value.context.rect.y) || 0),
      w: Math.round(Number(value.context.rect.w) || 0),
      h: Math.round(Number(value.context.rect.h) || 0),
    } } : {}),
    ...(typeof value.context.excerpt === 'string' ? { excerpt: value.context.excerpt.slice(0, 200) } : {}),
  } : undefined;
  return {
    contract_version: CANVAS_PATCH_DOC_CONTRACT,
    patch: value.patch,
    ...(annotationId ? { annotation_id: annotationId } : {}),
    ...(rationale ? { rationale } : {}),
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
    at,
  };
}

export function buildCollabReviewInput(input: {
  room: string;
  workItem: WorkItem;
  finding: FindingRevision;
  feedback: FindingFeedback[];
  preparation: InputPreparation;
}): CollabReviewTaskInput {
  const item = input.workItem;
  const finding = input.finding;
  return {
    contract_version: COLLAB_TASK_CONTRACT,
    view: 'lesson-report',
    room: input.room,
    work_item: {
      id: item.id,
      baseline_revision: item.baselineRevision,
      row_ids: [...item.rowIds],
    },
    finding: {
      id: finding.findingId,
      revision: finding.revision,
      summary: finding.summary.slice(0, 500),
      row_ids: [...finding.rowIds],
      feedback: input.feedback
        .filter((item2) => item2.findingId === finding.findingId)
        .slice(0, 10)
        .map((item2) => ({ id: item2.id, finding_revision: item2.findingRevision, text: item2.text.slice(0, 500) })),
    },
    input_preparation: {
      selected_row_ids: [...input.preparation.selectedRowIds],
      application_prepared_row_ids: [...input.preparation.applicationPreparedRowIds],
      context_truncated_row_ids: [...input.preparation.contextTruncatedRowIds],
      filtered_out_row_ids: [...input.preparation.filteredOutRowIds],
      missing_target_row_ids: [...input.preparation.missingTargetRowIds],
      platform_coverage: 'unknown',
    },
  };
}

function stringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 128) return null;
    out.push(item);
  }
  return out;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\0\r\n]/.test(value)
    ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Validate one agent result document payload; returns null when malformed. */
export function normalizeCollabResultDoc(value: unknown): CollabResultDoc | null {
  if (!isRecord(value) || value.contract_version !== COLLAB_RESULT_CONTRACT) return null;
  const finding = value.finding;
  const view = value.comparison_view;
  if (!isRecord(finding) || !isRecord(view)) return null;
  const findingId = boundedText(finding.finding_id, 128);
  const expectedRevision = int(finding.expected_revision);
  const summary = boundedText(finding.summary, 2000);
  const rowIds = stringArray(finding.row_ids, 3);
  const proposalId = boundedText(view.proposal_id, 128);
  const baseRevision = int(view.base_revision);
  const viewRowIds = stringArray(view.row_ids, 3);
  if (!findingId || expectedRevision === null || expectedRevision <= 0 || !summary || !rowIds
    || !proposalId || baseRevision === null || !viewRowIds) return null;
  const document = view.document !== undefined ? normalizeUiDocument(view.document) : null;
  if (view.document !== undefined && document === null) return null;
  return {
    contract_version: COLLAB_RESULT_CONTRACT,
    ...(boundedText(value.task_id, 64) ? { task_id: value.task_id as string } : {}),
    finding: { finding_id: findingId, expected_revision: expectedRevision, summary, row_ids: rowIds },
    comparison_view: {
      proposal_id: proposalId,
      base_revision: baseRevision,
      row_ids: viewRowIds,
      ...(document ? { document } : {}),
    },
  };
}

/**
 * Validate an agent-authored UI document against the fixed catalog before it
 * may stage — the security boundary between agent output and the renderer.
 * Returns a JSON-purified copy on success, null on rejection.
 */
function normalizeUiDocument(value: unknown): UiDocument | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const candidate = JSON.parse(JSON.stringify(value)) as UiDocument;
    return checkDocument(candidate).length === 0 ? candidate : null;
  } catch {
    return null;
  }
}

/** Validate an agent note payload for the declared result sink. */
export function normalizeAgentNotePayload(value: unknown): AgentNotePayload | null {
  if (!isRecord(value)) return null;
  const summary = boundedText(value.summary, 2000);
  if (!summary) return null;
  const rowIds = value.row_ids === undefined ? [] : stringArray(value.row_ids, 50);
  if (rowIds === null) return null;
  return {
    ...(boundedText(value.contract_version, 64) ? { contract_version: value.contract_version as string } : {}),
    summary,
    row_ids: rowIds,
  };
}
