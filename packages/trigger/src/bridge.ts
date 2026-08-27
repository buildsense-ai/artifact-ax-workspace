/**
 * External Agent Bridge protocol + store (transport-neutral core).
 *
 * This is the smallest usable bridge between the standalone SPA and an
 * external Agent. It is *not* a generic Artifact runtime and it never touches
 * cats-company. A `ContextBundle` (the transport-neutral trigger payload) is
 * submitted across a versioned protocol, the bridge tracks it through an
 * explicit receipt state machine, and an external CLI (artifactctl context)
 * fetches / acks / resumes it.
 *
 * The protocol states are explicit and stable:
 *   accepted, queued, needs_confirm, acknowledged, completed, rejected,
 *   expired.
 *
 * The store is a replaceable seam (see `BridgeStore`); the default
 * implementation keeps state in memory for this MVP. Swapping in a durable
 * store later must not change the protocol.
 */

import { TRIGGER_CONTRACT_VERSION, type ContextBundle } from './types.js';

export const BRIDGE_PROTOCOL_VERSION = 'artifact.ax.bridge.v1';

/** Receipt state of one delivered bundle across its lifecycle. */
export type BridgeReceiptState =
  | 'accepted' // submitted and held by the bridge; not yet opened by a receiver
  | 'queued' // held because a run/turn is active; delivered when resumed
  | 'needs_confirm' // gated; awaiting an explicit confirmation/ack
  | 'acknowledged' // a receiver opened it; awaiting completion
  | 'completed' // delivered and processed by the receiver
  | 'rejected' // refused (stale revision / malformed / policy)
  | 'expired'; // TTL elapsed without an ack

/** Hint from the sender about how the bridge should stage submission. */
export type BridgeSubmitMode = 'send' | 'queue' | 'confirm';

/**
 * Submission payload. Carries the existing transport-neutral ContextBundle
 * plus idempotency and staging hints. The bundle's own `delivery` state and
 * the `mode` hint converge on an initial receipt state.
 */
export interface BridgeSubmitRequest {
  bundle: ContextBundle;
  /** Explicit dedupe key; falls back to bundle.bundle_id. */
  idempotency_key?: string;
  /** Time-to-live in ms for staged (non-completed) receipts; 0 = no expiry. */
  ttl_ms?: number;
  /** Staging hint; defaults to a mapping of bundle.delivery. */
  mode?: BridgeSubmitMode;
}

/** Stable, machine-readable receipt for one bundle. */
export interface BridgeReceipt {
  protocol_version: typeof BRIDGE_PROTOCOL_VERSION;
  receipt_id: string;
  bundle_id: string;
  state: BridgeReceiptState;
  /** True when this submit or state mutation was an idempotent replay. */
  idempotent: boolean;
  /** Human-readable note describing the transition or refusal. */
  message: string;
  created_at: string;
  updated_at: string;
  /** Present when the receipt was rejected. */
  reason?: string;
}

/** Stable identifier of the field that made a stale submission stale. */
export type StaleCheck =
  | { field: 'revision'; artifact_id: string; at: number; submitted: number }
  | { field: 'artifact'; artifact_id: string };

export interface BridgeStore {
  /** Submit (or idempotently replay) a bundle; returns a receipt. */
  submit(req: BridgeSubmitRequest): Promise<BridgeReceipt>;
  /** Receipt by bundle id. */
  get(bundleId: string): Promise<BridgeReceipt | undefined>;
  /** Full context payload for an authorized receiver; optional for thin stores. */
  getBundle?(bundleId: string): Promise<ContextBundle | undefined>;
  /** All receipts, optionally filtered by state. */
  list(state?: BridgeReceiptState): Promise<BridgeReceipt[]>;
  /** Ack a staged receipt (needs_confirm / queued / accepted) -> acknowledged. */
  ack(bundleId: string): Promise<BridgeReceipt>;
  /** Resume a queued receipt (queue) -> acknowledged (same as ack). */
  resume(bundleId: string): Promise<BridgeReceipt>;
  /** Mark an acknowledged receipt as delivered/completed. */
  complete(bundleId: string): Promise<BridgeReceipt>;
  /** Refuse a submission (malformed / stale / policy). */
  reject(bundleId: string, reason: string): Promise<BridgeReceipt>;
  /**
   * Expire staged receipts whose TTL elapsed. Stores that do not implement
   * expiry may omit this method; the HTTP server calls it when available.
   */
  expireNow?(): BridgeReceipt[] | Promise<BridgeReceipt[]>;
}

export interface BridgeStoreOptions {
  now?: () => string;
  nextId?: () => string;
}

/** Version of the serialized bridge store snapshot (pure data, fs-free). */
export const BRIDGE_STORE_SNAPSHOT_VERSION = 1;

/**
 * Pure-data dump of one in-memory bridge store, safe to serialize (e.g. to a
 * JSON file by a Node-only adapter). Restoring a snapshot must reproduce the
 * store exactly: receipts, per-artifact revision high-water marks, explicit
 * idempotency-key bindings, and conflict refusals — so idempotent replays and
 * stale-revision rejection keep working across a restart. @artifact-ax/trigger
 * stays browser-safe; adapters own any file/transport I/O.
 */
export interface BridgeStoreSnapshot {
  format_version: typeof BRIDGE_STORE_SNAPSHOT_VERSION;
  /** Canonical state keyed by bundle id. */
  stores: Array<{ request: BridgeSubmitRequest; receipt: BridgeReceipt }>;
  /** Highest submitted revision per artifact id (stale-rejection bounds). */
  artifact_revision: Record<string, number>;
  /** Explicit idempotency keys -> bundle id. */
  idempotency: Record<string, string>;
  /** Refusals from idempotency-key collisions (key + bundle id) -> receipt. */
  conflict_receipts: Record<string, BridgeReceipt>;
}

function defaultNow(): string {
  return new Date().toISOString();
}

let bridgeCounter = 0;
function defaultNextId(): string {
  bridgeCounter += 1;
  const entropy =
    typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `rct_${Date.now().toString(36)}${bridgeCounter.toString(36)}${entropy}`;
}

/** Map a bundle's delivery state to an initial receipt state. */
export function initialStateForDelivery(
  delivery: ContextBundle['delivery'],
  mode?: BridgeSubmitMode,
): BridgeReceiptState {
  if (mode === 'queue') return 'queued';
  if (mode === 'confirm') return 'needs_confirm';
  if (mode === 'send') return 'accepted';
  switch (delivery) {
    case 'queued':
      return 'queued';
    case 'needs_confirm':
    case 'suggested':
      return 'needs_confirm';
    case 'collecting':
      return 'queued';
    case 'sent':
    default:
      return 'accepted';
  }
}

function safeInitialState(bundle: ContextBundle, mode?: BridgeSubmitMode): BridgeReceiptState {
  const initial = initialStateForDelivery(bundle.delivery, mode);
  // A transport hint cannot bypass the arbiter's safety boundary. High-risk,
  // proposed, ambiguous, low-confidence, or incomplete intent remains gated
  // until a receiver acknowledges it, even when the sender asks for `send`.
  if (
    bundle.assessment.risk === 'high' ||
    bundle.assessment.intent_kind === 'change' ||
    bundle.assessment.intent_kind === 'destructive' ||
    bundle.assessment.intent_kind === 'ambiguous' ||
    bundle.assessment.intent_kind === 'collect' ||
    bundle.decision === 'confirm' ||
    bundle.decision === 'suggest' ||
    !bundle.assessment.complete ||
    (bundle.decision === 'send' && bundle.assessment.confidence < 0.8)
  ) {
    return 'needs_confirm';
  }
  return initial;
}

const INTENT_KINDS = new Set<ContextBundle['assessment']['intent_kind']>([
  'collect',
  'inspect',
  'explain',
  'review',
  'compare',
  'change',
  'destructive',
  'ambiguous',
]);
const INTENT_RISKS = new Set<ContextBundle['assessment']['risk']>(['none', 'low', 'medium', 'high']);
const DECISIONS = new Set<ContextBundle['decision']>(['collect', 'suggest', 'send', 'confirm']);
const DELIVERIES = new Set<ContextBundle['delivery']>([
  'collecting',
  'suggested',
  'queued',
  'needs_confirm',
  'sent',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validSelection(value: unknown, artifactId: string, bundleRevision: number): boolean {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value['selection_id']) || value['artifact_id'] !== artifactId) return false;
  if (!revision(value['revision']) || value['revision'] !== bundleRevision) return false;
  if (!nonEmptyString(value['region_id']) || !nonEmptyString(value['label'])) return false;
  for (const key of ['region_title', 'node_id', 'note', 'ref']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  return true;
}

/**
 * Structural guard for a ContextBundle at an untrusted transport boundary.
 * It deliberately validates shape and enum values, not application-specific
 * policy; the arbiter/domain remains responsible for authorization.
 */
export function hasMinimalBundle(value: unknown): value is ContextBundle {
  if (!isRecord(value)) return false;
  const v = value;
  if (v['contract_version'] !== TRIGGER_CONTRACT_VERSION) return false;
  if (!nonEmptyString(v['bundle_id']) || !nonEmptyString(v['session_id'])) return false;
  if (!nonEmptyString(v['actor_id']) || !nonEmptyString(v['artifact_id'])) return false;
  if (!revision(v['revision'])) return false;
  if (!Array.isArray(v['selections']) || v['selections'].length === 0) return false;
  if (!v['selections'].every((selection) => validSelection(selection, v['artifact_id'] as string, v['revision'] as number))) {
    return false;
  }

  if (!isRecord(v['intent']) || typeof v['intent']['text'] !== 'string') return false;
  if (!isRecord(v['assessment'])) return false;
  const assessment = v['assessment'];
  if (
    typeof assessment['intent_kind'] !== 'string' ||
    !INTENT_KINDS.has(assessment['intent_kind'] as ContextBundle['assessment']['intent_kind']) ||
    typeof assessment['confidence'] !== 'number' ||
    !Number.isFinite(assessment['confidence']) ||
    assessment['confidence'] < 0 ||
    assessment['confidence'] > 1 ||
    typeof assessment['risk'] !== 'string' ||
    !INTENT_RISKS.has(assessment['risk'] as ContextBundle['assessment']['risk']) ||
    !Array.isArray(assessment['rationale']) ||
    !assessment['rationale'].every((item) => typeof item === 'string') ||
    typeof assessment['complete'] !== 'boolean'
  ) {
    return false;
  }
  if (typeof v['decision'] !== 'string' || !DECISIONS.has(v['decision'] as ContextBundle['decision'])) return false;
  if (typeof v['delivery'] !== 'string' || !DELIVERIES.has(v['delivery'] as ContextBundle['delivery'])) return false;
  if (!nonEmptyString(v['created_at']) || !Number.isFinite(Date.parse(v['created_at']))) return false;
  return v['context_ref'] === undefined || typeof v['context_ref'] === 'string';
}

/** Structural guard for a persisted submit request. */
function isValidSubmitRequest(value: unknown): value is BridgeSubmitRequest {
  if (!isRecord(value) || !hasMinimalBundle(value['bundle'])) return false;
  const idempotencyKey = value['idempotency_key'];
  if (
    idempotencyKey !== undefined &&
    (!nonEmptyString(idempotencyKey) || idempotencyKey.length > 256)
  ) {
    return false;
  }
  const ttl = value['ttl_ms'];
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 0)) return false;
  const mode = value['mode'];
  if (mode !== undefined && mode !== 'send' && mode !== 'queue' && mode !== 'confirm') return false;
  return true;
}

function isReceiptState(value: unknown): value is BridgeReceiptState {
  return (
    value === 'accepted' ||
    value === 'queued' ||
    value === 'needs_confirm' ||
    value === 'acknowledged' ||
    value === 'completed' ||
    value === 'rejected' ||
    value === 'expired'
  );
}

function isValidReceipt(value: unknown): value is BridgeReceipt {
  if (!isRecord(value)) return false;
  const v = value;
  if (v['protocol_version'] !== BRIDGE_PROTOCOL_VERSION) return false;
  if (!nonEmptyString(v['receipt_id']) || !nonEmptyString(v['bundle_id'])) return false;
  if (!isReceiptState(v['state'])) return false;
  if (typeof v['idempotent'] !== 'boolean' || typeof v['message'] !== 'string') return false;
  if (!nonEmptyString(v['created_at']) || !Number.isFinite(Date.parse(v['created_at']))) return false;
  if (!nonEmptyString(v['updated_at']) || !Number.isFinite(Date.parse(v['updated_at']))) return false;
  return v['reason'] === undefined || nonEmptyString(v['reason']);
}

function isValidSnapshot(value: unknown): value is BridgeStoreSnapshot {
  if (!isRecord(value)) return false;
  if (value['format_version'] !== BRIDGE_STORE_SNAPSHOT_VERSION) return false;
  if (!Array.isArray(value['stores'])) return false;
  const bundleIds = new Set<string>();
  const receiptIds = new Set<string>();
  const maxRevisionByArtifact = new Map<string, number>();
  for (const entry of value['stores']) {
    if (!isRecord(entry) || !isRecord(entry['request']) || !isRecord(entry['receipt'])) return false;
    if (!isValidSubmitRequest(entry['request'])) return false;
    if (!isValidReceipt(entry['receipt'])) return false;
    const request = entry['request'] as unknown as BridgeSubmitRequest;
    const receipt = entry['receipt'] as BridgeReceipt;
    if (receipt.bundle_id !== request.bundle.bundle_id) return false;
    if (bundleIds.has(receipt.bundle_id) || receiptIds.has(receipt.receipt_id)) return false;
    bundleIds.add(receipt.bundle_id);
    receiptIds.add(receipt.receipt_id);
    // A collision refusal is retained as a rejected canonical entry for
    // inspection, but it was never accepted and therefore must not advance
    // the stale-revision high-water mark (or require one on disk).
    if (receipt.state !== 'rejected') {
      const previous = maxRevisionByArtifact.get(request.bundle.artifact_id) ?? -1;
      maxRevisionByArtifact.set(request.bundle.artifact_id, Math.max(previous, request.bundle.revision));
    }
  }
  const artifactRevisions = value['artifact_revision'];
  if (!isRecord(artifactRevisions)) return false;
  for (const [artifactId, rev] of Object.entries(artifactRevisions)) {
    if (!nonEmptyString(artifactId)) return false;
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) return false;
    if (rev < (maxRevisionByArtifact.get(artifactId) ?? -1)) return false;
  }
  for (const [artifactId, maxRevision] of maxRevisionByArtifact) {
    const persistedRevision = artifactRevisions[artifactId];
    if (typeof persistedRevision !== 'number' || persistedRevision < maxRevision) return false;
  }
  if (!isRecord(value['idempotency'])) return false;
  for (const [idempotencyKey, bundleId] of Object.entries(value['idempotency'])) {
    if (!nonEmptyString(idempotencyKey) || idempotencyKey.length > 256) return false;
    if (!nonEmptyString(bundleId) || !bundleIds.has(bundleId)) return false;
  }
  if (!isRecord(value['conflict_receipts'])) return false;
  for (const receipt of Object.values(value['conflict_receipts'])) {
    if (!isValidReceipt(receipt)) return false;
    if (!bundleIds.has(receipt.bundle_id) || receipt.state !== 'rejected') return false;
  }
  return true;
}

interface StoredBundle {
  request: BridgeSubmitRequest;
  receipt: BridgeReceipt;
}

/**
 * Default in-memory store. Idempotent by bundle id / idempotency key, tracks
 * per-artifact high-water revision for stale rejection, and honors a TTL for
 * staged receipts. A durable store can replace this behind `BridgeStore`.
 */
export class InMemoryBridgeStore implements BridgeStore {
  /** Canonical storage is always keyed by bundle id, never by a caller key. */
  private stores = new Map<string, StoredBundle>();
  /** Highest submitted revision per artifact (for stale rejection). */
  private artifactRevision = new Map<string, number>();
  /** Explicit idempotency keys -> bundle id. */
  private idempotency = new Map<string, string>();
  /** Refused attempts caused by an occupied idempotency key (for collisions
   * where the candidate bundle id is already canonical). */
  private conflictReceipts = new Map<string, BridgeReceipt>();
  private readonly now: () => string;
  private readonly nextId: () => string;

  constructor(options: BridgeStoreOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.nextId = options.nextId ?? defaultNextId;
  }

  async submit(req: BridgeSubmitRequest): Promise<BridgeReceipt> {
    if (!isRecord(req)) {
      throw new BridgeError('invalid_request', 'submit request must be an object');
    }
    const bundle = req.bundle;
    if (!hasMinimalBundle(bundle)) {
      throw new BridgeError('invalid_request', 'bundle is not a valid ContextBundle');
    }
    if (req.idempotency_key !== undefined && !nonEmptyString(req.idempotency_key)) {
      throw new BridgeError('invalid_request', 'idempotency_key must be a non-empty string');
    }
    if (
      req.ttl_ms !== undefined &&
      (!Number.isSafeInteger(req.ttl_ms) || req.ttl_ms < 0)
    ) {
      throw new BridgeError('invalid_request', 'ttl_ms must be a non-negative integer');
    }
    if (req.idempotency_key !== undefined && req.idempotency_key.length > 256) {
      throw new BridgeError('invalid_request', 'idempotency_key must be at most 256 characters');
    }
    if (req.mode !== undefined && req.mode !== 'send' && req.mode !== 'queue' && req.mode !== 'confirm') {
      throw new BridgeError('invalid_request', `unsupported bridge mode '${String(req.mode)}'`);
    }

    const bundleId = bundle.bundle_id;
    const explicitKey = req.idempotency_key;

    // An explicit key belongs to exactly one bundle. Never overwrite the
    // original entry when a caller accidentally reuses that key.
    if (explicitKey !== undefined) {
      const mappedBundleId = this.idempotency.get(explicitKey);
      if (mappedBundleId !== undefined && mappedBundleId !== bundleId) {
        return this.conflictRejected(explicitKey, bundle, 'idempotency_key_conflict');
      }
    }

    // Bundle ids are also idempotency identities. A retry with a different
    // explicit key still replays the one canonical receipt and binds the new
    // key to it for future retries.
    const existing = this.stores.get(bundleId);
    if (existing) {
      if (explicitKey !== undefined) this.idempotency.set(explicitKey, bundleId);
      return this.replay(existing.receipt);
    }

    // Stale revision rejection: a bundle older than the highest revision we've
    // already accepted for the same artifact is refused rather than delivered
    // out of order.
    const high = this.artifactRevision.get(bundle.artifact_id);
    if (high !== undefined && bundle.revision < high) {
      return this.storeRejected(bundle, req, 'stale_revision');
    }

    const initial = safeInitialState(bundle, req.mode);
    const now = this.now();
    const receipt: BridgeReceipt = {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      receipt_id: this.nextId(),
      bundle_id: bundle.bundle_id,
      state: initial,
      idempotent: false,
      message: `accepted via bridge as '${initial}'`,
      created_at: now,
      updated_at: now,
    };
    this.stores.set(bundleId, { request: req, receipt });
    if (explicitKey !== undefined) this.idempotency.set(explicitKey, bundleId);
    const current = this.artifactRevision.get(bundle.artifact_id) ?? -1;
    this.artifactRevision.set(bundle.artifact_id, Math.max(current, bundle.revision));
    return receipt;
  }

  async get(bundleId: string): Promise<BridgeReceipt | undefined> {
    return this.stores.get(bundleId)?.receipt;
  }

  async getBundle(bundleId: string): Promise<ContextBundle | undefined> {
    return this.stores.get(bundleId)?.request.bundle;
  }

  async list(state?: BridgeReceiptState): Promise<BridgeReceipt[]> {
    const all = [...this.stores.values()].map((s) => s.receipt);
    return state !== undefined ? all.filter((r) => r.state === state) : all;
  }

  async ack(bundleId: string): Promise<BridgeReceipt> {
    return this.transition(bundleId, ['needs_confirm', 'queued', 'accepted'], 'acknowledged', 'acknowledged by receiver');
  }

  async resume(bundleId: string): Promise<BridgeReceipt> {
    return this.transition(bundleId, ['queued', 'accepted'], 'acknowledged', 'resumed and acknowledged');
  }

  async complete(bundleId: string): Promise<BridgeReceipt> {
    return this.transition(bundleId, ['acknowledged'], 'completed', 'delivered and completed');
  }

  async reject(bundleId: string, reason: string): Promise<BridgeReceipt> {
    if (!nonEmptyString(reason)) throw new BridgeError('invalid_request', 'rejection reason must be non-empty');
    const entry = this.byBundle(bundleId);
    if (!entry) {
      throw new BridgeError('not_found', `no bundle '${bundleId}' to reject`);
    }
    if (entry.receipt.state === 'rejected') return this.replay(entry.receipt);
    if (entry.receipt.state === 'completed' || entry.receipt.state === 'expired') {
      throw new BridgeError('state_conflict', `bundle '${bundleId}' is already '${entry.receipt.state}'`);
    }
    entry.receipt.state = 'rejected';
    entry.receipt.reason = reason;
    entry.receipt.updated_at = this.now();
    entry.receipt.message = `rejected: ${reason}`;
    return entry.receipt;
  }

  /** Pure-data dump of the current state (fs-free). A durable Node-only
   * adapter persists this to a JSON file and restores it on restart. */
  snapshot(): BridgeStoreSnapshot {
    return {
      format_version: BRIDGE_STORE_SNAPSHOT_VERSION,
      stores: [...this.stores.values()].map(({ request, receipt }) => ({ request, receipt })),
      artifact_revision: Object.fromEntries(this.artifactRevision),
      idempotency: Object.fromEntries(this.idempotency),
      conflict_receipts: Object.fromEntries(this.conflictReceipts),
    };
  }

  /**
   * Replace all current state with a snapshot (restart recovery). Validates
   * the snapshot before touching anything; a malformed or unsupported
   * snapshot throws BridgeStoreSnapshotError and leaves the store untouched.
   */
  restore(snapshot: BridgeStoreSnapshot): void {
    if (!isValidSnapshot(snapshot)) {
      throw new BridgeStoreSnapshotError('snapshot is not a valid bridge store state');
    }
    this.stores = new Map(snapshot.stores.map(({ request, receipt }) => [receipt.bundle_id, { request, receipt }]));
    this.artifactRevision = new Map(Object.entries(snapshot.artifact_revision));
    this.idempotency = new Map(Object.entries(snapshot.idempotency));
    this.conflictReceipts = new Map(Object.entries(snapshot.conflict_receipts));
  }

  /** Expire staged receipts whose TTL elapsed (returns receipts updated). */
  expireNow(): BridgeReceipt[] {
    const clock = Date.parse(this.now());
    const nowMs = Number.isFinite(clock) ? clock : Date.now();
    const expired: BridgeReceipt[] = [];
    for (const stored of this.stores.values()) {
      const req = stored.request;
      const ttl = req.ttl_ms ?? 0;
      if (ttl <= 0) continue;
      const stageable = stored.receipt.state === 'needs_confirm' || stored.receipt.state === 'queued' || stored.receipt.state === 'accepted';
      if (!stageable) continue;
      if (nowMs - Date.parse(stored.receipt.updated_at) >= ttl) {
        stored.receipt.state = 'expired';
        stored.receipt.reason = 'ttl';
        stored.receipt.updated_at = this.now();
        stored.receipt.message = 'expired: confirmation window elapsed';
        expired.push(stored.receipt);
      }
    }
    return expired;
  }

  /** Record a refused submission (stale revision / idempotency conflict). */
  private storeRejected(bundle: ContextBundle, request: BridgeSubmitRequest, reason: string): BridgeReceipt {
    const receipt = this.rejectedReceipt(bundle, reason);
    this.stores.set(bundle.bundle_id, { request, receipt });
    if (request.idempotency_key !== undefined) this.idempotency.set(request.idempotency_key, bundle.bundle_id);
    return receipt;
  }

  private conflictRejected(key: string, bundle: ContextBundle, reason: string): BridgeReceipt {
    const conflictKey = `${key}\u0000${bundle.bundle_id}`;
    const previous = this.conflictReceipts.get(conflictKey);
    if (previous) return this.replay(previous);
    const receipt = this.rejectedReceipt(bundle, reason);
    // If this bundle id is not already canonical, retain the refusal so the
    // caller can inspect it via status/fetch and retries remain deterministic.
    // Never overwrite an existing bundle entry merely because its key collides.
    if (!this.stores.has(bundle.bundle_id)) {
      this.stores.set(bundle.bundle_id, { request: { bundle }, receipt });
    }
    this.conflictReceipts.set(conflictKey, receipt);
    return receipt;
  }

  private rejectedReceipt(bundle: ContextBundle, reason: string): BridgeReceipt {
    const now = this.now();
    return {
      protocol_version: BRIDGE_PROTOCOL_VERSION,
      receipt_id: this.nextId(),
      bundle_id: bundle.bundle_id,
      state: 'rejected',
      idempotent: false,
      reason,
      message: `rejected: ${reason}`,
      created_at: now,
      updated_at: now,
    };
  }

  private replay(receipt: BridgeReceipt): BridgeReceipt {
    return {
      ...receipt,
      idempotent: true,
      message: `idempotent replay: ${receipt.bundle_id} already ${receipt.state}`,
    };
  }

  private transition(bundleId: string, from: BridgeReceiptState[], to: BridgeReceiptState, message: string): BridgeReceipt {
    const entry = this.byBundle(bundleId);
    if (!entry) throw new BridgeError('not_found', `no bundle '${bundleId}'`);
    if (entry.receipt.state === to) return this.replay(entry.receipt);
    if (!from.includes(entry.receipt.state)) {
      throw new BridgeError(
        'state_conflict',
        `bundle '${bundleId}' is '${entry.receipt.state}', cannot become '${to}'`,
      );
    }
    entry.receipt.state = to;
    entry.receipt.updated_at = this.now();
    entry.receipt.message = message;
    return entry.receipt;
  }

  private byBundle(bundleId: string): StoredBundle | undefined {
    return this.stores.get(bundleId);
  }
}

/** Snapshot/restore validation failure (malformed or unsupported state). */
export class BridgeStoreSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeStoreSnapshotError';
  }
}

/** Domain error with a stable machine-readable code (bridge boundary). */
export class BridgeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}
