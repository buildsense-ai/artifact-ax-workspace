import type { ReviewRow, ReviewTableState } from '@artifact-ax/lesson-report';
import { summarize } from '@artifact-ax/lesson-report';
import type { Selection } from '@artifact-ax/trigger';
import type { UiComposeDocumentMeta } from './ui-builder.js';

/**
 * The two ids are application contracts, not Agent prompts.  They are kept
 * next to the page adapter so the manifest and `applyResult()` cannot drift.
 */
export const CLOUD_TASK_INTENT_ID = 'lesson-report.review-selection.v1';
export const CLOUD_RESULT_SINK_ID = 'lesson-report.agent-notes.upsert.v1';
export const AGENT_NOTES_STORAGE_KEY = 'artifact-ax:lesson-report:agent-notes:v1';

/**
 * Keep browser-local writeback scoped to the logical workspace, Artifact, and
 * actor. The unscoped constant remains the backwards-compatible default for
 * callers that do not have an identity boundary yet.
 */
export function agentNotesStorageKey(workspaceId: string, artifactId: string, actorId: string): string {
  return [workspaceId, artifactId, actorId]
    .map((value) => encodeStoragePart(value))
    .reduce((key, part) => `${key}:${part}`, AGENT_NOTES_STORAGE_KEY);
}

/** Kept in code as well as artifact-manifest.json so the application validates
 * the same sink shape at the final persistence boundary. */
export const AGENT_NOTE_RESULT_SCHEMA = {
  type: 'object',
  required: ['summary'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 2_000 },
    row_ids: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
    recommendations: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
} as const;

const MAX_SELECTIONS = 50;
const MAX_CONTEXT_SELECTIONS = 20;
const MAX_VISIBLE_ROWS = 12;
const MAX_NOTES = 20;
const MAX_CONTEXT_NOTES = 5;
const MAX_CONTEXT_EVENTS = 5;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_RECOMMENDATION_LENGTH = 500;
const MAX_EVENT_SUMMARY_LENGTH = 200;
const MAX_ROW_ID_LENGTH = 64;
const RESULT_ID_PATTERN = /^arr_[A-Za-z0-9_-]{43}$/;

export interface AgentNoteRecord {
  result_id: string;
  summary: string;
  row_ids: string[];
  recommendations: string[];
  state_revision: string;
  applied_at: string;
}

export interface AgentNotePayload {
  summary: string;
  row_ids?: string[];
  recommendations?: string[];
}

/** A bounded, one-line reference to an intermediate event (opt-in only). */
export interface CloudContextEventRef {
  seq: number;
  type: string;
  actor_id: string;
  summary: string;
}

export interface CloudContextInput {
  revision: number;
  table: ReviewTableState;
  visibleRows: readonly ReviewRow[];
  selections: readonly Selection[];
  notes: readonly AgentNoteRecord[];
  /** Bounded optional intermediate event history. Never included by default. */
  events?: readonly CloudContextEventRef[];
  includeEvents?: boolean;
  maxEvents?: number;
  /** Optional compact UI-document metadata exposed as final state (no history). */
  documentMeta?: UiComposeDocumentMeta;
}

export type PayloadValidation =
  | { ok: true; value: AgentNotePayload }
  | { ok: false; code: string; message: string };

/**
 * Build the final-state-first page-authored semantic snapshot.
 *
 * The default payload is the latest final projection/result summary plus
 * stable refs only (`state_revision`, `summary`, `filter`, `visible_rows`,
 * `agent_notes`, and the stable selection/node refs). It deliberately contains
 * no intermediate event/state history. Intermediate events are retained and
 * exposed only through an explicit, bounded opt-in (`includeEvents` + bound
 * `events`), never automatically injected and never required for a task.
 *
 * Identity, permissions, credentials, and transport references officially stay
 * outside this object.
 */
export function buildSemanticContext(input: CloudContextInput): Record<string, unknown> {
  const selections = input.selections.slice(0, MAX_CONTEXT_SELECTIONS).map((selection) => ({
    artifact_id: selection.artifact_id,
    revision: selection.revision,
    region_id: selection.region_id,
    ...(selection.node_id ? { node_id: selection.node_id } : {}),
    ...(selection.note ? { note: limitText(selection.note, 200) } : {}),
    label: limitText(selection.label, 120),
  }));
  const selectedRows = unique(
    input.selections
      .filter((selection) => selection.region_id === 'review-table' && selection.node_id)
      .map((selection) => selection.node_id as string),
  ).slice(0, MAX_CONTEXT_SELECTIONS);
  const visibleRows = input.visibleRows.slice(0, MAX_VISIBLE_ROWS).map((row) => ({
    id: row.id,
    student: limitText(row.student, 80),
    topic: limitText(row.topic, 120),
    status: row.status,
    ...(row.score !== undefined ? { score: row.score } : {}),
  }));
  const notes = input.notes.slice(-MAX_CONTEXT_NOTES).map((note) => ({
    result_id: note.result_id,
    summary: limitText(note.summary, 300),
    row_ids: note.row_ids.slice(0, MAX_SELECTIONS),
    applied_at: note.applied_at,
  }));
  const context: Record<string, unknown> = {
    view: 'lesson-report',
    // Mark the payload as final-state-first: latest final summary + stable refs.
    semantic_mode: 'final-state',
    state_revision: String(input.revision),
    summary: summarize(input.table),
    filter: { status: input.table.filter.status ?? 'all' },
    selected_rows: selectedRows,
    focus_set: selections,
    visible_rows: visibleRows,
    agent_notes: notes,
    // Focus/textarea state is intentional context, not unsaved application
    // data.  Do not make every click or filter change look like a dirty draft.
    dirty: false,
  };
  // Expose compact UI-document metadata as final state (never event history).
  if (input.documentMeta !== undefined) context.ui_document = input.documentMeta;
  // Optional, bounded event/state history: only when explicitly requested.
  if (input.includeEvents === true) {
    const eventCount = normalizeMaxEvents(input.maxEvents);
    const eventRefs = eventCount > 0
      ? (input.events ?? []).slice(-eventCount).map((event) => ({
          seq: event.seq,
          type: event.type,
          actor_id: event.actor_id,
          summary: limitText(event.summary, MAX_EVENT_SUMMARY_LENGTH),
        }))
      : [];
    if (eventRefs.length > 0) context.events = eventRefs;
  }
  // The official bridge accepts at most 8 KiB of semantic state. Optional
  // history is dropped first; then the final-state summary is trimmed.
  if (utf8Bytes(context) > 7_500) {
    delete context.events;
  }
  if (utf8Bytes(context) > 7_500) {
    context.visible_rows = visibleRows.slice(0, 6);
    context.agent_notes = notes.slice(-2);
  }
  if (utf8Bytes(context) > 7_500) {
    context.visible_rows = [];
    context.agent_notes = [];
  }
  return context;
}

/** Validate the payload a Cloud Artifact result sink accepts. */
export function validateAgentNotePayload(value: unknown, knownRowIds: ReadonlySet<string>): PayloadValidation {
  if (!isPlainRecord(value)) return invalid('invalid_payload', 'result payload must be an object');
  const keys = Object.keys(value);
  if (keys.some((key) => !new Set(['summary', 'row_ids', 'recommendations']).has(key))) {
    return invalid('invalid_payload', 'result payload contains an unsupported field');
  }
  const summary = boundedText(value.summary, MAX_SUMMARY_LENGTH);
  if (summary === null) return invalid('invalid_payload', 'summary must be a non-empty bounded string');

  const rowIds = parseStringList(value.row_ids, MAX_SELECTIONS, MAX_ROW_ID_LENGTH, 'row_ids');
  if (!rowIds.ok) return rowIds;
  const unknown = rowIds.value.filter((id) => !knownRowIds.has(id));
  if (unknown.length > 0) return invalid('unknown_row', `result references unknown row${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);

  const recommendations = parseStringList(
    value.recommendations,
    20,
    MAX_RECOMMENDATION_LENGTH,
    'recommendations',
  );
  if (!recommendations.ok) return recommendations;
  return {
    ok: true,
    value: {
      summary,
      ...(rowIds.value.length > 0 ? { row_ids: rowIds.value } : {}),
      ...(recommendations.value.length > 0 ? { recommendations: recommendations.value } : {}),
    },
  };
}

export function isCloudResultId(value: unknown): value is string {
  return typeof value === 'string' && RESULT_ID_PATTERN.test(value);
}

/** Read previously applied notes without allowing malformed storage to brick the SPA. */
export function loadAgentNotes(storage: Storage | undefined, storageKey = AGENT_NOTES_STORAGE_KEY): AgentNoteRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKey);
    if (!raw || raw.length > 64 * 1024) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isStoredNote)
      .slice(-MAX_NOTES)
      .map((note) => ({
        result_id: note.result_id,
        summary: limitText(note.summary, MAX_SUMMARY_LENGTH),
        row_ids: note.row_ids.slice(0, MAX_SELECTIONS),
        recommendations: note.recommendations.slice(0, 20).map((item) => limitText(item, MAX_RECOMMENDATION_LENGTH)),
        state_revision: note.state_revision,
        applied_at: note.applied_at,
      }));
  } catch {
    return [];
  }
}

/** Persist notes atomically from the page's point of view; callers map false to `failed`. */
export function saveAgentNotes(
  storage: Storage | undefined,
  notes: readonly AgentNoteRecord[],
  storageKey = AGENT_NOTES_STORAGE_KEY,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(storageKey, JSON.stringify(notes.slice(-MAX_NOTES)));
    return true;
  } catch {
    return false;
  }
}

export function noteFingerprint(payload: AgentNotePayload): string {
  return JSON.stringify({
    summary: payload.summary,
    row_ids: payload.row_ids ?? [],
    recommendations: payload.recommendations ?? [],
  });
}

function parseStringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
  field: string,
): { ok: true; value: string[] } | { ok: false; code: string; message: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > maxItems) {
    return invalid('invalid_payload', `${field} must be an array with at most ${maxItems} items`);
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = boundedText(item, maxLength);
    if (text === null) return invalid('invalid_payload', `${field} items must be bounded strings`);
    if (seen.has(text)) return invalid('invalid_payload', `${field} must not contain duplicates`);
    seen.add(text);
    values.push(text);
  }
  return { ok: true, value: values };
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) return null;
  return text;
}

function limitText(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}

/**
 * Normalize a caller-supplied event cap to `0 | 1..MAX_CONTEXT_EVENTS`.
 * `0` means "no events" (so `slice(-0)` is never used, which would return the
 * full list); non-numeric, non-finite, non-integer, or negative values fall back
 * to the default cap `MAX_CONTEXT_EVENTS`; any value above the cap is hard-capped
 * at `MAX_CONTEXT_EVENTS`. The opt-in event channel therefore never grows
 * unbounded and never has an ambiguous "zero == whole list" behavior.
 */
function normalizeMaxEvents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return MAX_CONTEXT_EVENTS;
  if (value < 1) return 0;
  if (value > MAX_CONTEXT_EVENTS) return MAX_CONTEXT_EVENTS;
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function utf8Bytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStoredNote(value: unknown): value is AgentNoteRecord {
  if (!isPlainRecord(value)) return false;
  try {
    const allowed = new Set(['result_id', 'summary', 'row_ids', 'recommendations', 'state_revision', 'applied_at']);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    return (
      isCloudResultId(value.result_id) &&
      boundedText(value.summary, MAX_SUMMARY_LENGTH) !== null &&
      Array.isArray(value.row_ids) && value.row_ids.length <= MAX_SELECTIONS && value.row_ids.every((id) => boundedText(id, MAX_ROW_ID_LENGTH) !== null) &&
      Array.isArray(value.recommendations) && value.recommendations.length <= 20 && value.recommendations.every((item) => boundedText(item, MAX_RECOMMENDATION_LENGTH) !== null) &&
      typeof value.state_revision === 'string' && value.state_revision.length <= 128 &&
      typeof value.applied_at === 'string' && value.applied_at.length <= 64
    );
  } catch {
    return false;
  }
}

function invalid(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function encodeStoragePart(value: string): string {
  try {
    return encodeURIComponent(limitText(String(value), 128));
  } catch {
    return 'invalid';
  }
}
