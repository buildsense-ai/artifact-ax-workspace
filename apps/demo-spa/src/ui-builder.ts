import { TRIGGER_CONTRACT_VERSION, type ContextBundle } from '@artifact-ax/trigger';
import {
  isExecutableText,
  UI_DOCUMENT_CONTRACT_VERSION,
  UI_DOCUMENT_PATCH_CONTRACT_VERSION,
  type UiDocument,
  type UiDocumentPatch,
  type UiPrimitive,
} from '@artifact-ax/ui-document';
import { applyUiDocumentPatch, checkUiDocument } from './ui/ui-draft.js';

/**
 * The formal, standalone XiaoBa UI Builder path.
 *
 * An explicit user action in the Builder panel sends the compose-ui task only
 * through the injected Cloud Artifact Host port (the same `ArtifactHostPort`
 * seam used by `CloudHostOutbox`). The page never invents a page-to-Agent
 * endpoint, a Bridge, AG-UI, DOM automation, browser secret, or cats-company
 * dependency. The new result sink accepts an untrusted `UiDocumentPatch`
 * proposal; the page validates its declared schema, document id, base
 * revision, operation constraints, stable anchors, and closed catalog, then
 * durably stages the proposal — a human, not the Agent, decides whether to
 * apply or discard it.
 *
 * The compose-ui task payload is deliberately minimal: the current final UI
 * document/configuration, the current application revision/identity, and the
 * user's requested UI intent. It never carries event history, task refs,
 * writeback refs, or credentials.
 */

export const CLOUD_UI_TASK_INTENT_ID = 'lesson-report.compose-ui.v1' as const;
export const CLOUD_UI_RESULT_SINK_ID = 'lesson-report.ui-document-patch.propose.v1' as const;
export const UI_PROPOSAL_STORAGE_KEY = 'artifact-ax:lesson-report:ui-proposal:v1' as const;
export const UI_ACTIVE_DOCUMENT_STORAGE_KEY = 'artifact-ax:lesson-report:ui-document:v1' as const;
export const MAX_UI_PROPOSALS = 10;
const MAX_UI_PATCH_OPS = 32;
const MAX_UI_INTENT_LENGTH = 500;
const MAX_STORED_SUMMARY_CHARS = 2_000;
const MAX_STORED_MESSAGE_CHARS = 500;
const MAX_STORED_TIMESTAMP_CHARS = 64;
const MAX_STORED_PATCH_CHARS = 8_192;
const INSERT_OP_KEYS = new Set(['op', 'index', 'node']);
const UPDATE_OP_KEYS = new Set(['op', 'id', 'update']);
const REMOVE_OP_KEYS = new Set(['op', 'id']);
const UPDATE_FIELDS = new Set(['props', 'bindings', 'events']);

/** A staged (or applied/discarded) UI-document patch proposal. */
export interface UiProposalRecord {
  proposal_id: string;
  document_id: string;
  base_revision: number;
  patch: UiDocumentPatch;
  op_count: number;
  summary: string;
  state: 'staged' | 'applied' | 'discarded' | 'stale';
  created_at: string;
  applied_revision?: number;
  applied_at?: string;
  discarded_at?: string;
  error?: string;
}

/** The bounded compose-ui task payload (what the Agent receives). */
export interface UiComposeTaskPayload {
  view: 'lesson-report';
  task: 'compose-ui';
  intent: { text: string };
  application: {
    workspace_id: string;
    artifact_id: string;
    revision: number;
    actor_id: string;
  };
  document: UiComposeDocumentMeta;
}

/** Compact, bounded representation of the current UI document/configuration. */
export interface UiComposeDocumentMeta {
  contract_version: typeof UI_DOCUMENT_CONTRACT_VERSION;
  id: string;
  revision: number;
  nodes: Array<UiComposeDocumentMetaNode>;
}

export interface UiComposeDocumentMetaNode {
  id: string;
  kind: string;
  placement?: 'main' | 'side' | 'full';
  props?: Record<string, UiPrimitive>;
  bindings?: Record<string, string>;
  events?: Record<string, string>;
}

/** The manifest-bound sink schema for the UI-document patch proposal envelope. */
export const UI_PATCH_RESULT_SCHEMA = {
  type: 'object',
  required: ['contract_version', 'document_id', 'base_revision', 'ops'],
  additionalProperties: false,
  properties: {
    contract_version: { type: 'string', enum: [UI_DOCUMENT_PATCH_CONTRACT_VERSION] },
    document_id: { type: 'string', minLength: 1, maxLength: 64 },
    base_revision: { type: 'integer', minimum: 0 },
    ops: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_UI_PATCH_OPS,
      // Exact op validation happens at the page boundary with the ui-document
      // validator; the manifest layer validates only the array/object bounds.
      items: { type: 'object' },
    },
  },
} as const;

/**
 * Scope browser-local UI proposals to the logical workspace + Artifact only.
 * They are deliberately *not* actor-scoped: a proposal and the active document
 * belong to the Artifact/workspace, not to the acting user. Browser-local storage
 * is explicitly not cross-browser collaboration.
 */
export function uiProposalStorageKey(workspaceId: string, artifactId: string): string {
  return [workspaceId, artifactId]
    .map((value) => encodeStoragePart(value))
    .reduce((key, part) => `${key}:${part}`, UI_PROPOSAL_STORAGE_KEY);
}

/** Scope the persisted active UiDocument to the logical workspace + Artifact only. */
export function activeDocumentStorageKey(workspaceId: string, artifactId: string): string {
  return [workspaceId, artifactId]
    .map((value) => encodeStoragePart(value))
    .reduce((key, part) => `${key}:${part}`, UI_ACTIVE_DOCUMENT_STORAGE_KEY);
}

/** Compact metadata of the current UI document, used for the task payload. */
export function buildUiDocumentMeta(document: UiDocument): UiComposeDocumentMeta {
  return {
    contract_version: document.contract_version,
    id: document.id,
    revision: document.revision,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      ...(node.placement !== undefined ? { placement: node.placement } : {}),
      ...(node.props !== undefined ? { props: { ...node.props } } : {}),
      ...(node.bindings !== undefined ? { bindings: { ...node.bindings } } : {}),
      ...(node.events !== undefined ? { events: { ...node.events } } : {}),
    })),
  };
}

/** Build a synthetic ContextBundle that carries the compose-ui request. */
export function buildUiComposeBundle(input: {
  actorId: string;
  artifactId: string;
  revision: number;
  sessionId: string;
  intentText: string;
}): ContextBundle {
  return {
    contract_version: TRIGGER_CONTRACT_VERSION,
    bundle_id: `ui-${crypto.randomUUID()}`,
    session_id: input.sessionId,
    actor_id: input.actorId,
    artifact_id: input.artifactId,
    revision: input.revision,
    selections: [],
    intent: { text: input.intentText.slice(0, MAX_UI_INTENT_LENGTH) },
    assessment: {
      intent_kind: 'change',
      confidence: 1,
      risk: 'medium',
      rationale: ['explicit UI-document patch request'],
      complete: true,
    },
    decision: 'send',
    delivery: 'sent',
    created_at: new Date().toISOString(),
  };
}

/** Build the bounded compose-ui task payload from a bundle + current document. */
export function buildUiComposePayload(input: {
  bundle: ContextBundle;
  document: UiDocument;
  workspaceId: string;
}): UiComposeTaskPayload {
  return {
    view: 'lesson-report',
    task: 'compose-ui',
    intent: { text: input.bundle.intent.text.slice(0, MAX_UI_INTENT_LENGTH) },
    application: {
      workspace_id: input.workspaceId.slice(0, 128),
      artifact_id: input.bundle.artifact_id.slice(0, 64),
      revision: input.bundle.revision,
      actor_id: input.bundle.actor_id.slice(0, 128),
    },
    document: buildUiDocumentMeta(input.document),
  };
}

export type UiPatchProposalValidation =
  | { ok: true; patch: UiDocumentPatch; summary: string }
  | { ok: false; code: string; message: string };

/**
 * Validate an untrusted UI-document patch proposal against the *current*
 * document. This is the security-critical boundary: it enforces the closed
 * catalog (props/bindings/events allowlists), rejects raw executable
 * presentation inputs, rejects malformed/no-op/stale patches, and keeps the
 * result within the deployed stable node/region anchors. It never mutates the
 * source document.
 */
export function validateUiDocumentPatchProposal(payload: unknown, document: UiDocument): UiPatchProposalValidation {
  if (!isPlainRecord(payload)) return invalid('invalid_patch', 'patch proposal must be an object');
  const envelopeKeys = new Set(['contract_version', 'document_id', 'base_revision', 'ops']);
  if (Object.keys(payload).some((key) => !envelopeKeys.has(key))) {
    return invalid('invalid_patch', 'patch proposal contains an unsupported field');
  }
  if (payload.contract_version !== UI_DOCUMENT_PATCH_CONTRACT_VERSION) {
    return invalid('invalid_patch', `patch.contract_version must be ${UI_DOCUMENT_PATCH_CONTRACT_VERSION}`);
  }
  if (typeof payload.document_id !== 'string' || payload.document_id !== document.id) {
    return invalid('invalid_patch', 'patch.document_id must match the target document id');
  }
  if (payload.base_revision !== document.revision) {
    return invalid('stale_patch', `patch.base_revision ${String(payload.base_revision)} does not match current document revision ${document.revision}`);
  }
  if (!Array.isArray(payload.ops) || payload.ops.length === 0) {
    return invalid('invalid_patch', 'patch.ops must be a non-empty array');
  }
  if (payload.ops.length > MAX_UI_PATCH_OPS) {
    return invalid('invalid_patch', `patch.ops must have at most ${MAX_UI_PATCH_OPS} operations`);
  }
  // Delegate the exact catalog/op/anchor validation to the ui-document patch
  // boundary (validatePatch + anchorDriftErrors, atomically, no mutation).
  const result = applyUiDocumentPatch(document, payload);
  if (!result.ok) return invalid(result.code, result.message);
  // Never retain caller-owned references: clone the validated patch so later
  // mutation of the delivered payload cannot change the record or apply behavior.
  const patch = canonicalClone(payload) as unknown as UiDocumentPatch;
  return { ok: true, patch, summary: summarizeUiPatch(patch) };
}

/**
 * Deep-clone a JSON-safe value with deterministically sorted object keys, so
 * staged records and idempotency fingerprints are independent of the caller's
 * object identity and property order.
 */
function canonicalClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalClone);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalClone(source[key]);
    return out;
  }
  return value;
}

/** Return a detached proposal snapshot at the Manager's public API boundary. */
function cloneProposalRecord(record: UiProposalRecord): UiProposalRecord {
  return canonicalClone(record) as UiProposalRecord;
}

/** A compact, human-readable one-line summary of the ops in a patch. */
export function summarizeUiPatch(patch: UiDocumentPatch): string {
  const parts = patch.ops.map((op) => {
    if (op.op === 'insert') return `insert ${op.node.id}`;
    if (op.op === 'update') return `update ${op.id}`;
    return `remove ${op.id}`;
  });
  return `${patch.ops.length} ${patch.ops.length === 1 ? 'op' : 'ops'}: ${parts.join(', ')}`;
}

/** A sink-scoped receipt envelope returned after the page durably stages a proposal. */
export interface UiProposalReceiptPayload {
  sink_id: string;
  result_id: string;
  document_id: string;
  base_revision: number;
  op_count: number;
  state: string;
}

/** Build the compact receipt payload for a staged/applied proposal record. */
export function buildUiProposalReceipt(record: UiProposalRecord): UiProposalReceiptPayload {
  return {
    sink_id: CLOUD_UI_RESULT_SINK_ID,
    result_id: record.proposal_id,
    document_id: record.document_id,
    base_revision: record.base_revision,
    op_count: record.op_count,
    state: record.state,
  };
}

export type UiProposalStageInput = {
  result_id: string;
  payload: unknown;
  document: UiDocument;
};

export type UiProposalStageResult =
  | { ok: true; record: UiProposalRecord; receipt: UiProposalReceiptPayload }
  | { ok: false; code: string; message: string };

export type UiProposalApplyResult =
  | { ok: true; document: UiDocument; record: UiProposalRecord; receipt: UiProposalReceiptPayload }
  | { ok: false; code: string; message: string; record: UiProposalRecord | null };

export type UiProposalDiscardResult =
  | { ok: true; code: 'discarded'; message: string; record: UiProposalRecord }
  | { ok: false; code: 'no_proposal' | 'storage_failed'; message: string; record: UiProposalRecord | null };

/**
 * Pure state machine for the formal compose-ui UI-proposal lifecycle. It owns
 * staging/apply/discard, sink-scoped idempotency, and browser-local persistence
 * and is fully dependency-injectable (so it is unit-testable without a DOM).
 * Every state change is transactional: the proposal store is written first and
 * in-memory/idempotency state is committed only when that write succeeds, so a
 * persistence failure leaves the prior state and is reported, never swallowed.
 * Proposal records cross the public API as defensive snapshots, preventing a
 * caller from mutating staged patch/state without going through this manager.
 * It never applies a patch merely because it was delivered: `stage` only
 * validates and durably stores a proposal; a human `apply`/`discard` decides.
 */
export class UiProposalManager {
  private proposals: UiProposalRecord[];
  private readonly storage?: Storage;
  private readonly storageKey: string;
  private readonly documentStorageKey: string;
  private readonly receipts = new Map<string, string>();

  constructor(options: {
    storage?: Storage;
    storageKey?: string;
    /** Workspace/artifact-scoped key for the persisted active UiDocument. */
    documentStorageKey?: string;
    initial?: readonly UiProposalRecord[];
  } = {}) {
    this.proposals = (options.initial ?? []).map(cloneProposalRecord);
    this.storage = options.storage;
    this.storageKey = options.storageKey ?? UI_PROPOSAL_STORAGE_KEY;
    this.documentStorageKey = options.documentStorageKey ?? UI_ACTIVE_DOCUMENT_STORAGE_KEY;
  }

  stage(input: UiProposalStageInput): UiProposalStageResult {
    const checked = validateUiDocumentPatchProposal(input.payload, input.document);
    if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
    // Work only with the validated, canonical clone from here on: the caller's
    // payload object is never retained, so mutating it after staging cannot
    // change the stored record, the fingerprint, or later apply behavior.
    const patch = checked.patch;
    const fingerprint = JSON.stringify(patch);

    const prior = this.proposals.find((proposal) => proposal.proposal_id === input.result_id);
    if (prior) {
      // Compare canonical forms so property order or a tampered store cannot
      // make an equivalent re-delivery look like a conflict (or vice versa).
      if (JSON.stringify(canonicalClone(prior.patch)) !== fingerprint) {
        return { ok: false, code: 'idempotency_conflict', message: 'result id was already applied with a different patch proposal' };
      }
      this.receipts.set(input.result_id, fingerprint);
      return { ok: true, record: cloneProposalRecord(prior), receipt: buildUiProposalReceipt(prior) };
    }

    const record: UiProposalRecord = {
      proposal_id: input.result_id,
      document_id: patch.document_id,
      base_revision: patch.base_revision,
      patch,
      op_count: patch.ops.length,
      summary: checked.summary,
      state: 'staged',
      created_at: new Date().toISOString(),
    };
    // Persist-before-success: only commit the in-memory + idempotency state after
    // the staged proposal is durably stored. On failure, roll back completely.
    const nextRecords = [...supersedePendingProposals(this.proposals), record].slice(-MAX_UI_PROPOSALS);
    if (!saveUiProposals(this.storage, nextRecords, this.storageKey)) {
      return { ok: false, code: 'storage_failed', message: 'the application could not persist the staged UI proposal' };
    }
    this.proposals = nextRecords;
    this.receipts.set(input.result_id, fingerprint);
    return { ok: true, record: cloneProposalRecord(record), receipt: buildUiProposalReceipt(record) };
  }

  /** Human Apply: revalidate against the then-current document and apply. */
  apply(document: UiDocument): UiProposalApplyResult {
    const proposal = this.currentRecord();
    if (!proposal) return { ok: false, code: 'no_proposal', message: 'no staged UI proposal to apply', record: null };
    // Snapshot the mutable proposal fields so a failed persistence step can
    // restore the exact prior state instead of leaving a half-applied record.
    const prior = {
      state: proposal.state,
      error: proposal.error,
      applied_revision: proposal.applied_revision,
      applied_at: proposal.applied_at,
    };
    const restore = (): void => {
      proposal.state = prior.state;
      proposal.error = prior.error;
      if (prior.applied_revision === undefined) delete proposal.applied_revision;
      else proposal.applied_revision = prior.applied_revision;
      if (prior.applied_at === undefined) delete proposal.applied_at;
      else proposal.applied_at = prior.applied_at;
    };
    const result = applyUiDocumentPatch(document, proposal.patch);
    if (!result.ok) {
      const stale = document.revision !== proposal.base_revision;
      proposal.state = 'stale';
      proposal.error = stale
        ? `Stale: the document moved to revision ${document.revision}; re-request or discard this proposal.`
        : result.message;
      if (!this.persist()) {
        // The stale marking is not durable: leave the prior record untouched.
        restore();
        return { ok: false, code: 'storage_failed', message: 'the application could not persist the updated proposal state', record: cloneProposalRecord(proposal) };
      }
      return { ok: false, code: result.code, message: proposal.error, record: cloneProposalRecord(proposal) };
    }
    // Persist-before-report-success: the updated active UiDocument must be
    // durable before we report applied or leave an in-memory mutation.
    if (!saveActiveDocument(this.storage, result.document, this.documentStorageKey)) {
      return { ok: false, code: 'storage_failed', message: 'the application could not persist the updated UI document', record: proposal };
    }
    proposal.state = 'applied';
    proposal.applied_revision = result.document.revision;
    proposal.applied_at = new Date().toISOString();
    proposal.error = undefined;
    // The document is durable, but the proposal record must still agree with it.
    // If the metadata write fails, restore the record and report the failure
    // instead of silently ignoring it; a retry re-applies the same patch.
    if (!this.persist()) {
      restore();
      return { ok: false, code: 'storage_failed', message: 'the application could not persist the updated proposal state', record: cloneProposalRecord(proposal) };
    }
    return { ok: true, document: result.document, record: cloneProposalRecord(proposal), receipt: buildUiProposalReceipt(proposal) };
  }

  /** Human Discard: remove the staged proposal (never apply merely because it was delivered). */
  discard(): UiProposalDiscardResult {
    const proposal = this.currentRecord();
    if (!proposal) return { ok: false, code: 'no_proposal', message: 'no staged UI proposal to discard', record: null };
    const prior = {
      state: proposal.state,
      error: proposal.error,
      discarded_at: proposal.discarded_at,
    };
    proposal.state = 'discarded';
    proposal.discarded_at = new Date().toISOString();
    if (!this.persist()) {
      // The discard is not durable: leave the prior record untouched.
      proposal.state = prior.state;
      proposal.error = prior.error;
      if (prior.discarded_at === undefined) delete proposal.discarded_at;
      else proposal.discarded_at = prior.discarded_at;
      return { ok: false, code: 'storage_failed', message: 'the application could not persist the proposal store', record: cloneProposalRecord(proposal) };
    }
    return { ok: true, code: 'discarded', message: `Discarded ${proposal.summary}.`, record: cloneProposalRecord(proposal) };
  }

  current(): UiProposalRecord | null {
    const proposal = this.currentRecord();
    return proposal ? cloneProposalRecord(proposal) : null;
  }

  list(): UiProposalRecord[] {
    return this.proposals.map(cloneProposalRecord);
  }

  private currentRecord(): UiProposalRecord | null {
    return currentStagedProposal(this.proposals);
  }

  private persist(): boolean {
    return saveUiProposals(this.storage, this.proposals, this.storageKey);
  }
}

/** The current actionable proposal: the latest staged or stale (unresolved) record. */
export function currentStagedProposal(proposals: readonly UiProposalRecord[]): UiProposalRecord | null {
  for (let index = proposals.length - 1; index >= 0; index -= 1) {
    const proposal = proposals[index]!;
    if (proposal.state === 'staged' || proposal.state === 'stale') return proposal;
  }
  return null;
}

/** Mark any unresolved proposal as superseded when a newer proposal is staged. */
export function supersedePendingProposals(
  proposals: readonly UiProposalRecord[],
  message = 'Superseded by a newer UI proposal; discard this one.',
): UiProposalRecord[] {
  return proposals.map((proposal) => {
    if (proposal.state === 'staged' || proposal.state === 'stale') {
      return { ...proposal, state: 'stale' as const, error: message };
    }
    return proposal;
  });
}

/**
 * Load the persisted active UiDocument, failing closed on malformed or stale
 * data. A stored document is accepted only when it is a valid UiDocument under
 * the fixed catalog, carries the expected document id/contract, and stays within
 * the deployed stable anchors. Otherwise the shipped fallback document is used.
 */
export function loadActiveDocument(storage: Storage | undefined, storageKey: string, fallback: UiDocument): UiDocument {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw || raw.length > 128 * 1024) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return fallback;
    // It must be a lesson-report document (same id/contract) that stays in-anchor
    // and still carries every protected governance surface (enforced inside
    // checkUiDocument, so the invariant has exactly one source of truth).
    if (parsed.id !== fallback.id || parsed.contract_version !== UI_DOCUMENT_CONTRACT_VERSION) return fallback;
    if (checkUiDocument(parsed as unknown as UiDocument).length > 0) return fallback;
    return parsed as unknown as UiDocument;
  } catch {
    return fallback;
  }
}

/** Persist the active UiDocument atomically from the page's point of view. */
export function saveActiveDocument(storage: Storage | undefined, document: UiDocument, storageKey: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(storageKey, JSON.stringify(document));
    return true;
  } catch {
    return false;
  }
}

/** Read persisted UI proposals without allowing malformed storage to brick the SPA. */
export function loadUiProposals(storage: Storage | undefined, storageKey: string = UI_PROPOSAL_STORAGE_KEY): UiProposalRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKey);
    if (!raw || raw.length > 128 * 1024) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredProposal).slice(-MAX_UI_PROPOSALS);
  } catch {
    return [];
  }
}

/** Persist UI proposals atomically from the page's point of view. */
export function saveUiProposals(
  storage: Storage | undefined,
  proposals: readonly UiProposalRecord[],
  storageKey: string = UI_PROPOSAL_STORAGE_KEY,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(storageKey, JSON.stringify(proposals.slice(-MAX_UI_PROPOSALS)));
    return true;
  } catch {
    return false;
  }
}

function isStoredProposal(value: unknown): value is UiProposalRecord {
  if (!isPlainRecord(value)) return false;
  try {
    const allowed = new Set([
      'proposal_id',
      'document_id',
      'base_revision',
      'patch',
      'op_count',
      'summary',
      'state',
      'created_at',
      'applied_revision',
      'applied_at',
      'discarded_at',
      'error',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    if (typeof value.proposal_id !== 'string' || value.proposal_id.length === 0 || value.proposal_id.length > 128) return false;
    if (typeof value.document_id !== 'string' || value.document_id.length === 0 || value.document_id.length > 64) return false;
    if (typeof value.base_revision !== 'number' || !Number.isInteger(value.base_revision) || value.base_revision < 0) return false;
    if (!isValidStoredPatch(value.patch)) return false;
    const ops = (value.patch as { ops: unknown[] }).ops;
    if (typeof value.op_count !== 'number' || !Number.isInteger(value.op_count) || value.op_count !== ops.length) return false;
    if (typeof value.summary !== 'string' || value.summary.length === 0 || value.summary.length > MAX_STORED_SUMMARY_CHARS) return false;
    if (isExecutableText(value.summary)) return false;
    if (value.state !== 'staged' && value.state !== 'applied' && value.state !== 'discarded' && value.state !== 'stale') return false;
    if (typeof value.created_at !== 'string' || value.created_at.length === 0 || value.created_at.length > MAX_STORED_TIMESTAMP_CHARS) return false;
    if (value.applied_revision !== undefined && (typeof value.applied_revision !== 'number' || !Number.isInteger(value.applied_revision) || value.applied_revision < 0)) return false;
    for (const key of ['applied_at', 'discarded_at'] as const) {
      const stamp = value[key];
      if (stamp !== undefined && (typeof stamp !== 'string' || stamp.length === 0 || stamp.length > MAX_STORED_TIMESTAMP_CHARS)) return false;
    }
    if (value.error !== undefined) {
      if (typeof value.error !== 'string' || value.error.length === 0 || value.error.length > MAX_STORED_MESSAGE_CHARS) return false;
      if (isExecutableText(value.error)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Structural/contract validation for a stored `UiDocumentPatch`: known
 * envelope fields only, the exact patch contract version, and a bounded ops
 * array whose members have a valid discriminant and field shapes. Deep
 * catalog/anchor/stale validation stays at apply time against the
 * then-current document (a stored patch is never trusted on its own).
 */
function isValidStoredPatch(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const envelopeKeys = new Set(['contract_version', 'document_id', 'base_revision', 'ops']);
  if (Object.keys(value).some((key) => !envelopeKeys.has(key))) return false;
  if (value.contract_version !== UI_DOCUMENT_PATCH_CONTRACT_VERSION) return false;
  if (typeof value.document_id !== 'string' || value.document_id.length === 0 || value.document_id.length > 64) return false;
  if (typeof value.base_revision !== 'number' || !Number.isInteger(value.base_revision) || value.base_revision < 0) return false;
  if (!Array.isArray(value.ops) || value.ops.length === 0 || value.ops.length > MAX_UI_PATCH_OPS) return false;
  for (const op of value.ops) {
    if (!isPlainRecord(op)) return false;
    if (op.op === 'insert') {
      if (Object.keys(op).some((key) => !INSERT_OP_KEYS.has(key))) return false;
      if (typeof op.index !== 'number' || !Number.isInteger(op.index) || op.index < 0) return false;
      if (!isPlainRecord(op.node)) return false;
      if (typeof op.node.id !== 'string' || op.node.id.length === 0) return false;
      if (typeof op.node.kind !== 'string' || op.node.kind.length === 0) return false;
    } else if (op.op === 'update') {
      if (Object.keys(op).some((key) => !UPDATE_OP_KEYS.has(key))) return false;
      if (typeof op.id !== 'string' || op.id.length === 0) return false;
      if (!isPlainRecord(op.update)) return false;
      const fields = Object.keys(op.update);
      if (fields.length === 0 || fields.some((key) => !UPDATE_FIELDS.has(key))) return false;
      if (fields.some((key) => !isPlainRecord((op.update as Record<string, unknown>)[key]))) return false;
    } else if (op.op === 'remove') {
      if (Object.keys(op).some((key) => !REMOVE_OP_KEYS.has(key))) return false;
      if (typeof op.id !== 'string' || op.id.length === 0) return false;
    } else {
      return false;
    }
  }
  return JSON.stringify(value).length <= MAX_STORED_PATCH_CHARS;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalid(code: string, message: string): UiPatchProposalValidation {
  return { ok: false, code, message };
}

function encodeStoragePart(value: string): string {
  try {
    return encodeURIComponent(Array.from(String(value)).slice(0, 128).join(''));
  } catch {
    return 'invalid';
  }
}
