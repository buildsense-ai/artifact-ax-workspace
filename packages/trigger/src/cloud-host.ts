/**
 * Browser-safe seam for the Cloud HTML Artifact Host API.
 *
 * This module intentionally does not discover a global, touch the DOM, use
 * postMessage, or make a network request. A host implementation is injected
 * by the embedding page. The host remains responsible for trusted bridge
 * connection checks and for consuming the user's activation gesture.
 */

import { type ContextBundle, type Selection } from './types.js';
import { type DeliveryReceipt, type Outbox } from './outbox.js';

/** Status contract emitted by the bundled CatsCo Artifact Host bridge. */
export const CLOUD_HOST_TASK_STATUS_CONTRACT = 'catsco.artifact-task-status.v1' as const;
/** Alias with an explicit version suffix for consumers that prefer it. */
export const CLOUD_HOST_TASK_STATUS_CONTRACT_VERSION = CLOUD_HOST_TASK_STATUS_CONTRACT;

/** The status values defined by the task loop contract. */
export type CloudHostTaskStatusName = 'submitted' | 'running' | 'completed' | 'failed';

/** Application-level result states used by the result-writeback contract. */
export type CloudHostApplicationStatus = 'applied' | 'rejected' | 'failed';

/**
 * A bounded status object supplied by a trusted host implementation.
 * `contract_version` is optional at this seam so a small test/embedding host
 * can omit boilerplate; when present it must be the official contract marker.
 */
export interface CloudHostTaskStatus {
  contract_version?: typeof CLOUD_HOST_TASK_STATUS_CONTRACT;
  task_id: string;
  status: CloudHostTaskStatusName;
  code?: string;
  message?: string;
  run_id?: string;
  result_id?: string;
  updated_at?: string;
  expires_at?: string;
  /** Optional application receipt returned by a host adapter. */
  application_receipt?: unknown;
  /** Optional shorthand used by some host implementations. */
  application_status?: CloudHostApplicationStatus;
  /** Optional result envelope; its status is inspected when present. */
  result?: unknown;
}

/** Listener supplied to the host's status subscription. */
export type CloudHostTaskStatusListener = (status: CloudHostTaskStatus) => void;

/**
 * Minimal injected host port. This is deliberately a structural interface:
 * feature detection can be performed by a host page without importing any
 * browser bridge implementation.
 */
export interface ArtifactHostPort {
  requestTask(
    intentId: string,
    payload: unknown,
  ): Promise<CloudHostTaskStatus> | CloudHostTaskStatus;
  onTaskStatus?: (listener: CloudHostTaskStatusListener) => (() => void) | void;
  /** Optional read path exposed by the official bridge for a known task ID. */
  getTaskStatus?: (taskId: string) => CloudHostTaskStatus | null | undefined;
  isConnected?: () => boolean;
}

/** Feature-detect an injected host without invoking any of its methods. */
export function isArtifactHostPort(value: unknown): value is ArtifactHostPort {
  try {
    if (!isRecord(value) || typeof value.requestTask !== 'function') return false;
    if (value.onTaskStatus !== undefined && typeof value.onTaskStatus !== 'function') return false;
    if (value.getTaskStatus !== undefined && typeof value.getTaskStatus !== 'function') return false;
    if (value.isConnected !== undefined && typeof value.isConnected !== 'function') return false;
    return true;
  } catch {
    // The Host is an optional injection boundary. A revoked Proxy or throwing
    // getter must fail closed instead of taking down the standalone SPA.
    return false;
  }
}

/** Alias useful to embedding code that wants an explicit detection verb. */
export const detectArtifactHost = isArtifactHostPort;

/** Stable, bounded selection shape used by the default task payload mapper. */
export interface CloudHostSelectionPayload {
  selection_id: string;
  artifact_id: string;
  revision: number;
  region_id: string;
  node_id?: string;
  label: string;
  note?: string;
}

/**
 * Default payload shape. It is a projection of a ContextBundle, not a new
 * task/sink declaration. A caller must configure an intent ID declared by its
 * immutable Artifact manifest; this adapter never invents one.
 */
export interface DefaultCloudHostTaskPayload {
  bundle_id: string;
  session_id: string;
  actor_id: string;
  artifact_id: string;
  revision: number;
  selections: CloudHostSelectionPayload[];
  intent: { text: string };
  assessment: {
    intent_kind: ContextBundle['assessment']['intent_kind'];
    confidence: number;
    risk: ContextBundle['assessment']['risk'];
    complete: boolean;
  };
}

/** Deterministic default mapper; opaque context refs are omitted by default. */
export function defaultCloudHostPayloadMapper(bundle: ContextBundle): DefaultCloudHostTaskPayload {
  return {
    bundle_id: bundle.bundle_id,
    session_id: bundle.session_id,
    actor_id: bundle.actor_id,
    artifact_id: bundle.artifact_id,
    revision: bundle.revision,
    selections: bundle.selections.map((selection) => selectionPayload(selection)),
    intent: { text: bundle.intent.text },
    assessment: {
      intent_kind: bundle.assessment.intent_kind,
      confidence: bundle.assessment.confidence,
      risk: bundle.assessment.risk,
      complete: bundle.assessment.complete,
    },
  };
}

/** Alias retained for callers that use the shorter task-oriented name. */
export const defaultCloudHostTaskPayload = defaultCloudHostPayloadMapper;

export type CloudHostPayloadMapper = (bundle: ContextBundle) => unknown;
export type CloudHostTaskIntentResolver = (bundle: ContextBundle) => string | undefined;

export interface CloudHostOutboxOptions {
  /** Injected host API. No host means every send is rejected locally. */
  host?: ArtifactHostPort | null;
  /** ID of a task_intents declaration in the immutable Artifact manifest. */
  taskIntentId?: string | CloudHostTaskIntentResolver;
  /** Snake-case alias for integrations that mirror the wire contract. */
  task_intent_id?: string | CloudHostTaskIntentResolver;
  /** Map a bundle to the declared task's input payload. */
  payloadMapper?: CloudHostPayloadMapper;
  /** Alias for payloadMapper. */
  mapPayload?: CloudHostPayloadMapper;
  /** Request timeout; timed-out requests are uncertain and never retried automatically. */
  timeoutMs?: number;
  /** Snake-case alias for timeoutMs. */
  timeout_ms?: number;
  /** Maximum serialized payload size in UTF-8 bytes (default 64 KiB). */
  maxPayloadBytes?: number;
  /** Maximum JSON traversal depth (default 12). */
  maxPayloadDepth?: number;
  /** Maximum string length in the mapped payload (default 16 KiB). */
  maxPayloadStringLength?: number;
}

export const DEFAULT_CLOUD_HOST_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_CLOUD_HOST_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_CLOUD_HOST_MAX_PAYLOAD_DEPTH = 12;
export const DEFAULT_CLOUD_HOST_MAX_PAYLOAD_STRING_LENGTH = 16 * 1024;
const MAX_TASK_ID_LENGTH = 256;
const MAX_STATUS_STRING_LENGTH = 2_000;
const MAX_APPLICATION_RECEIPT_BYTES = 8 * 1024;
const MAX_APPLICATION_RECEIPT_DEPTH = 8;
const MAX_APPLICATION_RECEIPT_STRING_LENGTH = 2_000;
const TASK_INTENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[1-9]\d*$/;
const TASK_ID_PATTERN = /^atk_[A-Za-z0-9_-]{43}$/;
const RESULT_ID_PATTERN = /^arr_[A-Za-z0-9_-]{43}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Extra, UI-useful fields carried by a Cloud Host delivery receipt. */
export interface CloudHostDeliveryReceipt extends DeliveryReceipt {
  /** Host task identifier; it is not mislabeled as a bridge receipt ID. */
  task_id?: string;
  /** Last accepted Host task state, or unavailable before submission. */
  task_status: CloudHostTaskStatusName | 'unavailable';
  /** Convenient status alias for UI code. */
  status: CloudHostTaskStatusName | 'unavailable';
  intent_id?: string;
  code?: string;
  run_id?: string;
  result_id?: string;
  application_status?: CloudHostApplicationStatus;
  application_receipt?: unknown;
  updated_at?: string;
  expires_at?: string;
  /** True when the host request timed out before its outcome was known. */
  uncertain?: boolean;
}

export interface CloudHostTaskSnapshot {
  bundle_id: string;
  intent_id?: string;
  task_id?: string;
  status?: CloudHostTaskStatus;
  receipt: CloudHostDeliveryReceipt;
}

interface TaskRecord {
  bundle_id: string;
  fingerprint: string;
  intent_id?: string;
  task_id?: string;
  status?: CloudHostTaskStatus;
  receipt: CloudHostDeliveryReceipt;
  /** True while the bundle is staged locally and has not created a Host task. */
  staged?: boolean;
  /** Original send bundle retained only for an explicit user resume action. */
  bundle?: ContextBundle;
  /** Shared promise makes concurrent retries exactly-once. */
  pending?: Promise<CloudHostDeliveryReceipt>;
}

/**
 * Outbox adapter for an injected Cloud HTML Artifact Host.
 *
 * It submits one declarative task intent and retains the Host task status in
 * memory for the page's UI. It does not fall back to MockOutbox/BridgeOutbox;
 * a missing or disconnected Host is an explicit unavailable receipt.
 */
export class CloudHostOutbox implements Outbox {
  readonly label = 'Cloud Artifact Host task outbox (injected host only)';

  private readonly host?: ArtifactHostPort;
  private readonly intentResolver?: string | CloudHostTaskIntentResolver;
  private readonly payloadMapper: CloudHostPayloadMapper;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly maxPayloadDepth: number;
  private readonly maxPayloadStringLength: number;
  private readonly records = new Map<string, TaskRecord>();
  private readonly taskToBundle = new Map<string, string>();
  private readonly orphanStatuses = new Map<string, CloudHostTaskStatus>();
  private readonly receiptListeners = new Set<(receipt: CloudHostDeliveryReceipt) => void>();
  private readonly taskStatusListeners = new Set<CloudHostTaskStatusListener>();
  private hostUnsubscribe?: () => void;
  private disposed = false;

  constructor(options: CloudHostOutboxOptions = {}) {
    const host = options.host;
    this.host = isArtifactHostPort(host) ? host : undefined;
    this.intentResolver = resolveOption(options.taskIntentId, options.task_intent_id, 'task intent id');
    this.payloadMapper = resolveOption(options.payloadMapper, options.mapPayload, 'payload mapper') ?? defaultCloudHostPayloadMapper;
    this.timeoutMs = resolveTimeout(options.timeoutMs, options.timeout_ms);
    this.maxPayloadBytes = boundedOption(
      options.maxPayloadBytes,
      DEFAULT_CLOUD_HOST_MAX_PAYLOAD_BYTES,
      1,
      DEFAULT_CLOUD_HOST_MAX_PAYLOAD_BYTES,
      'maxPayloadBytes',
    );
    this.maxPayloadDepth = boundedOption(
      options.maxPayloadDepth,
      DEFAULT_CLOUD_HOST_MAX_PAYLOAD_DEPTH,
      1,
      DEFAULT_CLOUD_HOST_MAX_PAYLOAD_DEPTH,
      'maxPayloadDepth',
    );
    this.maxPayloadStringLength = boundedOption(
      options.maxPayloadStringLength,
      DEFAULT_CLOUD_HOST_MAX_PAYLOAD_STRING_LENGTH,
      1,
      DEFAULT_CLOUD_HOST_MAX_PAYLOAD_STRING_LENGTH,
      'maxPayloadStringLength',
    );

    if (this.host?.onTaskStatus !== undefined) {
      try {
        const unsubscribe = this.host.onTaskStatus((status) => this.handleHostStatus(status));
        if (typeof unsubscribe === 'function') this.hostUnsubscribe = unsubscribe;
      } catch {
        // A status subscription is an optional enhancement. A host request can
        // still be used, and any request error remains visible as a receipt.
      }
    }
  }

  /** Submit once per bundle ID; retries replay the original result/promise. */
  async send(bundle: ContextBundle): Promise<CloudHostDeliveryReceipt> {
    const bundleId = isRecord(bundle) && typeof bundle.bundle_id === 'string' ? bundle.bundle_id : '';
    const existing = bundleId.length > 0 ? this.records.get(bundleId) : undefined;
    const intentId = this.resolveIntentId(bundle);
    let payload: unknown;
    let fingerprint: string;
    try {
      payload = this.mapAndBoundPayload(bundle);
      fingerprint = stableFingerprint(intentId, payload);
    } catch (error) {
      // A retry must never turn a mapper failure into a second Host task. The
      // original record remains authoritative once a bundle ID is known.
      if (existing !== undefined) {
        if (existing.pending !== undefined) return cloneReceipt(await existing.pending);
        return cloneReceipt(existing.receipt);
      }
      const invalid = this.localFailure(
        bundleId,
        intentId,
        'invalid_payload',
        error instanceof Error ? error.message : 'Cloud Host task payload is invalid',
      );
      if (bundleId.length > 0 && !this.records.has(bundleId)) {
        this.records.set(bundleId, { bundle_id: bundleId, fingerprint: '', intent_id: intentId, receipt: invalid });
        this.notifyReceipt(invalid);
      }
      return cloneReceipt(invalid);
    }

    const dispatch = isCloudHostDispatch(bundle);
    const resumingStaged = existing?.staged === true && dispatch;
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return cloneReceipt(
          this.localFailure(bundleId, intentId, 'idempotency_conflict', 'bundle_id was already submitted with a different task intent or payload'),
        );
      }
      if (existing.pending !== undefined) return cloneReceipt(await existing.pending);
      // A locally staged bundle (collect/suggest/confirm or a deferred send)
      // may be deliberately resumed by a later explicit user action with
      // delivery=sent. Since no Host task exists yet, this transition is safe
      // and does not weaken exactly-once behavior for actual task submissions.
      if (!(existing.staged === true && dispatch)) return cloneReceipt(existing.receipt);
      existing.intent_id = intentId;
    }

    const record: TaskRecord = existing ?? {
      bundle_id: bundleId,
      fingerprint,
      ...(intentId !== undefined ? { intent_id: intentId } : {}),
      receipt: this.localFailure(bundleId, intentId, 'pending', 'Cloud Host task has not been submitted'),
    };
    record.fingerprint = fingerprint;
    if (bundle.decision === 'send') {
      const retained = cloneBoundedJson(bundle, {
        maxBytes: this.maxPayloadBytes,
        maxDepth: this.maxPayloadDepth,
        maxStringLength: this.maxPayloadStringLength,
        maxVisits: 16_384,
        maxArrayItems: 1_000,
        maxObjectKeys: 256,
      });
      if (retained !== INVALID && isRecord(retained)) record.bundle = retained as unknown as ContextBundle;
    }
    this.records.set(bundleId, record);

    // TriggerService invokes Outbox.send for every arbiter decision. Only a
    // fully approved, non-deferred `send` is an Agent task request; all other
    // decisions remain local/staged and therefore cannot consume Host user
    // activation or create an unintended visible turn.
    if (!dispatch) {
      const receipt = stagedReceipt(bundle, intentId);
      record.staged = true;
      record.receipt = receipt;
      this.notifyReceipt(receipt);
      return cloneReceipt(receipt);
    }

    if (intentId === undefined) {
      const receipt = this.localFailure(
        bundleId,
        undefined,
        'task_intent_required',
        'no declared task intent is configured; no Host task was created',
      );
      // No task exists; a resolver may become configured before a later
      // explicit send. Keep this as a local staged outcome rather than
      // inventing a task or retrying in the background.
      record.staged = true;
      record.receipt = receipt;
      this.notifyReceipt(receipt);
      return cloneReceipt(receipt);
    }

    if (this.host === undefined) {
      const receipt = this.localFailure(
        bundleId,
        intentId,
        'host_unavailable',
        'Cloud Artifact Host is unavailable; no task was created',
      );
      record.receipt = receipt;
      this.notifyReceipt(receipt);
      return cloneReceipt(receipt);
    }
    if (!this.hostConnected()) {
      const receipt = this.localFailure(
        bundleId,
        intentId,
        'host_not_connected',
        'Cloud Artifact Host is not connected; no task was created',
      );
      // The official bridge reports this before task creation. Preserve a
      // retryable staged record for a later user action after reconnecting.
      record.staged = true;
      record.receipt = receipt;
      this.notifyReceipt(receipt);
      return cloneReceipt(receipt);
    }

    // Mark a staged record as dispatched only after all local preconditions
    // pass. A disconnected Host therefore leaves an explicit staged bundle
    // retryable by a later user action, without any automatic retry loop.
    record.staged = false;
    record.bundle = undefined;
    if (resumingStaged) {
      record.receipt = this.localFailure(bundleId, intentId, 'pending', 'Cloud Host task has not been submitted');
    }
    const request = this.requestHost(record, intentId, payload);
    record.pending = request;
    const receipt = await request;
    // Keep the settled receipt for idempotent replay. A late Host response
    // after a timeout can still update this record through handleHostStatus.
    record.pending = undefined;
    return cloneReceipt(receipt);
  }

  has(bundleId: string): boolean {
    return this.records.has(bundleId);
  }

  /** The Host owns the task payload; do not pretend this remote outbox owns bundles. */
  list(): ContextBundle[] {
    return [];
  }

  /** Receipts are the safe local read surface for UI status. */
  listReceipts(): CloudHostDeliveryReceipt[] {
    return [...this.records.values()].map((record) => cloneReceipt(record.receipt));
  }

  getReceipt(bundleId: string): CloudHostDeliveryReceipt | undefined {
    const receipt = this.records.get(bundleId)?.receipt;
    return receipt === undefined ? undefined : cloneReceipt(receipt);
  }

  /** Alias for UI code that calls the read operation `receipt`. */
  receipt(bundleId: string): CloudHostDeliveryReceipt | undefined {
    return this.getReceipt(bundleId);
  }

  /** Whether this bundle can be resumed by a fresh explicit user action. */
  isResumable(bundleId: string): boolean {
    const record = this.records.get(bundleId);
    return record?.staged === true && record.intent_id !== undefined && record.bundle?.decision === 'send';
  }

  /**
   * Resume a locally staged send without inventing a new bundle ID. The caller
   * must invoke this from its own explicit click so the injected Host can
   * consume that click's user activation.
   */
  async resume(bundleId: string): Promise<CloudHostDeliveryReceipt> {
    const record = this.records.get(bundleId);
    if (!record || record.staged !== true || record.intent_id === undefined || record.bundle?.decision !== 'send') {
      const receipt = this.localFailure(
        bundleId,
        record?.intent_id,
        'not_resumable',
        'this Cloud Host bundle is not waiting for an explicit send',
      );
      return cloneReceipt(receipt);
    }
    return this.send({ ...record.bundle, delivery: 'sent' });
  }

  getTask(bundleId: string): CloudHostTaskSnapshot | undefined {
    const record = this.records.get(bundleId);
    if (record === undefined) return undefined;
    return {
      bundle_id: record.bundle_id,
      ...(record.intent_id !== undefined ? { intent_id: record.intent_id } : {}),
      ...(record.task_id !== undefined ? { task_id: record.task_id } : {}),
      ...(record.status !== undefined ? { status: cloneTaskStatus(record.status) } : {}),
      receipt: cloneReceipt(record.receipt),
    };
  }

  /** Look up by task ID, with a bundle-ID fallback for convenient UI calls. */
  getTaskStatus(id: string): CloudHostTaskStatus | undefined {
    const bundleId = this.taskToBundle.get(id) ?? (this.records.has(id) ? id : undefined);
    const status = bundleId === undefined ? undefined : this.records.get(bundleId)?.status;
    return status === undefined ? undefined : cloneTaskStatus(status);
  }

  taskStatus(id: string): CloudHostTaskStatus | undefined {
    return this.getTaskStatus(id);
  }

  taskIdFor(bundleId: string): string | undefined {
    return this.records.get(bundleId)?.task_id;
  }

  listTasks(): CloudHostTaskSnapshot[] {
    return [...this.records.keys()].map((bundleId) => this.getTask(bundleId)!).filter(Boolean);
  }

  /** Subscribe to mapped receipts (including status updates from the Host). */
  onReceipt(listener: (receipt: CloudHostDeliveryReceipt) => void): () => void {
    if (typeof listener !== 'function') return () => undefined;
    this.receiptListeners.add(listener);
    return () => this.receiptListeners.delete(listener);
  }

  /** Subscribe to normalized Host task statuses, including running updates. */
  onTaskStatus(listener: CloudHostTaskStatusListener): () => void {
    if (typeof listener !== 'function') return () => undefined;
    this.taskStatusListeners.add(listener);
    return () => this.taskStatusListeners.delete(listener);
  }

  /** Stop receiving Host status callbacks; no task is cancelled or retried. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.hostUnsubscribe?.();
    } catch {
      // Host cleanup is best effort and must not surface as a task result.
    }
    this.hostUnsubscribe = undefined;
    this.receiptListeners.clear();
    this.taskStatusListeners.clear();
  }

  private resolveIntentId(bundle: ContextBundle): string | undefined {
    const resolver = this.intentResolver;
    let value: string | undefined;
    try {
      value = typeof resolver === 'function' ? resolver(bundle) : resolver;
    } catch {
      return undefined;
    }
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value !== value.trim() || value.length > 128 || !TASK_INTENT_ID_PATTERN.test(value)) {
      return undefined;
    }
    return value;
  }

  private mapAndBoundPayload(bundle: ContextBundle): unknown {
    if (!isRecord(bundle) || typeof bundle.bundle_id !== 'string' || bundle.bundle_id.trim() === '') {
      throw new Error('ContextBundle.bundle_id must be a non-empty string');
    }
    let mapped: unknown;
    try {
      mapped = this.payloadMapper(bundle);
    } catch {
      throw new Error('payload mapper threw an error');
    }
    const bounded = cloneBoundedJson(mapped, {
      maxBytes: this.maxPayloadBytes,
      maxDepth: this.maxPayloadDepth,
      maxStringLength: this.maxPayloadStringLength,
      maxVisits: 16_384,
      maxArrayItems: 1_000,
      maxObjectKeys: 256,
    });
    if (bounded === INVALID) throw new Error('payload is not bounded JSON');
    return bounded;
  }

  private hostConnected(): boolean {
    if (this.host === undefined || this.disposed) return false;
    if (this.host.isConnected === undefined) return true;
    try {
      return this.host.isConnected() === true;
    } catch {
      return false;
    }
  }

  private async requestHost(record: TaskRecord, intentId: string, payload: unknown): Promise<CloudHostDeliveryReceipt> {
    // Invoke synchronously so a caller's explicit click remains the activation
    // boundary expected by the bundled Host bridge. Promise.resolve().then(...)
    // would move requestTask to a later microtask and can lose that activation.
    let requested: Promise<CloudHostTaskStatus>;
    try {
      requested = Promise.resolve(this.host!.requestTask(intentId, payload));
    } catch (error) {
      requested = Promise.reject(error);
    }
    let timedOut = false;
    const hostPromise = requested;
    const guarded = hostPromise.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    // Observe a late resolution directly. This both avoids an unhandled
    // rejection and minimizes the microtask chain before an uncertain timeout
    // can be reconciled to the same record (never by issuing a retry).
    void hostPromise.then(
      (value) => {
        if (timedOut) {
          const status = normalizeCloudHostTaskStatus(value);
          if (status !== undefined) this.applyHostStatus(record, status);
        }
      },
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), this.timeoutMs);
    });
    const outcome = await Promise.race([guarded, timeout]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome.kind === 'timeout') {
      timedOut = true;
      const receipt: CloudHostDeliveryReceipt = {
        ...this.localFailure(
          record.bundle_id,
          intentId,
          'request_timeout',
          'Cloud Artifact Host task request timed out; task outcome is uncertain and will not be retried automatically',
        ),
        task_status: 'unavailable',
        status: 'unavailable',
        uncertain: true,
      };
      record.receipt = receipt;
      this.notifyReceipt(receipt);
      return receipt;
    }

    if (outcome.kind === 'error') {
      const code = errorCode(outcome.error) ?? 'request_failed';
      const message = errorMessage(outcome.error) ?? 'Cloud Artifact Host rejected the task request';
      if (code === 'user_activation_required') {
        // The official bridge rejects this before creating a task. Keep the
        // bundle visibly queued so a later, genuinely explicit user action can
        // resubmit it; never retry from this adapter or hide the Host code.
        const receipt: CloudHostDeliveryReceipt = {
          ...stagedFailureReceipt(record.bundle_id, intentId, code, message),
        };
        record.staged = true;
        record.receipt = receipt;
        this.notifyReceipt(receipt);
        return receipt;
      }
      const receipt = this.localFailure(record.bundle_id, intentId, code, message);
      record.receipt = receipt;
      this.notifyReceipt(receipt);
      return receipt;
    }

    const status = normalizeCloudHostTaskStatus(outcome.value);
    if (status === undefined) {
      const receipt = this.localFailure(record.bundle_id, intentId, 'invalid_response', 'Cloud Artifact Host returned an invalid task status');
      record.receipt = receipt;
      this.notifyReceipt(receipt);
      return receipt;
    }
    if (status.status === 'failed' && status.code === 'user_activation_required') {
      // Some embedding Hosts encode a pre-task rejection as a failed status
      // instead of rejecting the request promise. Treat the two wire forms
      // identically; a task ID was not created at this boundary.
      const receipt = stagedFailureReceipt(record.bundle_id, intentId, status.code, status.message ?? 'Cloud Artifact Host requires a recent user activation');
      record.staged = true;
      record.receipt = receipt;
      this.notifyReceipt(receipt);
      return receipt;
    }
    this.applyHostStatus(record, status);
    return record.receipt;
  }

  private handleHostStatus(value: unknown): void {
    if (this.disposed) return;
    const status = normalizeCloudHostTaskStatus(value);
    if (status === undefined) return;
    const bundleId = this.taskToBundle.get(status.task_id);
    if (bundleId === undefined) {
      this.notifyTaskStatus(status);
      const previous = this.orphanStatuses.get(status.task_id);
      if (previous === undefined || statusRank(status.status) >= statusRank(previous.status)) {
        this.orphanStatuses.set(status.task_id, status);
      }
      // Keep the orphan cache bounded; unknown task IDs have no UI owner yet.
      while (this.orphanStatuses.size > 128) this.orphanStatuses.delete(this.orphanStatuses.keys().next().value!);
      return;
    }
    const record = this.records.get(bundleId);
    if (record !== undefined) this.applyHostStatus(record, status);
  }

  private applyHostStatus(record: TaskRecord, incoming: CloudHostTaskStatus, emitStatus = true): void {
    if (record.task_id !== undefined && record.task_id !== incoming.task_id) {
      // A Host must never move one bundle to a second task ID.
      return;
    }
    const current = record.status;
    if (current !== undefined && shouldIgnoreStatus(current, incoming)) return;
    const owner = this.taskToBundle.get(incoming.task_id);
    if (owner !== undefined && owner !== record.bundle_id) return;
    record.task_id = incoming.task_id;
    this.taskToBundle.set(incoming.task_id, record.bundle_id);
    record.status = incoming;
    if (emitStatus) this.notifyTaskStatus(incoming);
    const receipt = receiptFromTaskStatus(record.bundle_id, record.intent_id, incoming);
    record.receipt = receipt;
    this.notifyReceipt(receipt);

    const orphan = this.orphanStatuses.get(incoming.task_id);
    if (orphan !== undefined && orphan !== incoming) {
      this.orphanStatuses.delete(incoming.task_id);
      if (!shouldIgnoreStatus(incoming, orphan)) this.applyHostStatus(record, orphan, false);
    }
  }

  private localFailure(bundleId: string, intentId: string | undefined, code: string, message: string): CloudHostDeliveryReceipt {
    const unavailable = code === 'host_unavailable' || code === 'host_not_connected' || code === 'task_intent_required';
    return {
      ok: false,
      bundle_id: typeof bundleId === 'string' ? bundleId : '',
      kind: 'rejected',
      message: clampMessage(message),
      task_status: unavailable ? 'unavailable' : 'failed',
      status: unavailable ? 'unavailable' : 'failed',
      ...(intentId !== undefined ? { intent_id: intentId } : {}),
      code: cleanStatusString(code, 128) ?? 'request_failed',
    };
  }

  private notifyReceipt(receipt: CloudHostDeliveryReceipt): void {
    const snapshot = cloneReceipt(receipt);
    for (const listener of this.receiptListeners) {
      try {
        listener(snapshot);
      } catch {
        // A UI listener must not affect task state or host delivery.
      }
    }
  }

  private notifyTaskStatus(status: CloudHostTaskStatus): void {
    const snapshot = cloneTaskStatus(status);
    for (const listener of this.taskStatusListeners) {
      try {
        listener(snapshot);
      } catch {
        // A UI listener must not affect task state or Host delivery.
      }
    }
  }
}

/** Normalize an untrusted host status before it enters the outbox state. */
export function normalizeCloudHostTaskStatus(value: unknown): CloudHostTaskStatus | undefined {
  try {
    return normalizeCloudHostTaskStatusInternal(value);
  } catch {
    // A host status is an untrusted boundary. Getters, proxies, and malformed
    // nested values must be treated as an invalid update, never escape into
    // the page event loop.
    return undefined;
  }
}

function normalizeCloudHostTaskStatusInternal(value: unknown): CloudHostTaskStatus | undefined {
  if (!isRecord(value)) return undefined;
  const contract = value['contract_version'];
  if (contract !== undefined && contract !== CLOUD_HOST_TASK_STATUS_CONTRACT) return undefined;
  const hasOfficialContract = contract !== undefined;
  const taskId = cleanStatusString(value['task_id'], MAX_TASK_ID_LENGTH);
  const status = value['status'];
  if (taskId === undefined || !isTaskStatusName(status)) return undefined;
  // A marker-bearing status is an official wire object and must use the
  // platform's task/result ID shapes. Marker-less values remain accepted as a
  // small structural-test/embedding convenience; the injected official Host
  // always emits the marker and therefore takes the strict path.
  if (hasOfficialContract && !TASK_ID_PATTERN.test(taskId)) return undefined;
  const normalized: CloudHostTaskStatus = {
    task_id: taskId,
    status,
    ...(hasOfficialContract ? { contract_version: CLOUD_HOST_TASK_STATUS_CONTRACT } : {}),
  };
  for (const [key, genericMax, officialMax] of [
    ['code', 128, 64],
    ['message', MAX_STATUS_STRING_LENGTH, 500],
    ['run_id', MAX_TASK_ID_LENGTH, 128],
    ['result_id', MAX_TASK_ID_LENGTH, 64],
    ['updated_at', 128, 64],
    ['expires_at', 128, 64],
  ] as const) {
    const candidate = cleanStatusString(value[key], hasOfficialContract ? officialMax : genericMax);
    if (value[key] !== undefined && candidate === undefined) return undefined;
    if (hasOfficialContract && key === 'result_id' && candidate !== undefined && !RESULT_ID_PATTERN.test(candidate)) return undefined;
    if (candidate !== undefined) Object.assign(normalized, { [key]: candidate });
  }
  if (value['application_status'] !== undefined && !isApplicationStatus(value['application_status'])) return undefined;
  if (isApplicationStatus(value['application_status'])) normalized.application_status = value['application_status'];

  if (value['application_receipt'] !== undefined) {
    const receipt = cloneBoundedJson(value['application_receipt'], {
      maxBytes: MAX_APPLICATION_RECEIPT_BYTES,
      maxDepth: MAX_APPLICATION_RECEIPT_DEPTH,
      maxStringLength: MAX_APPLICATION_RECEIPT_STRING_LENGTH,
      maxVisits: 2_048,
      maxArrayItems: 1_000,
      maxObjectKeys: 256,
    });
    if (receipt === INVALID) return undefined;
    normalized.application_receipt = receipt;
  }
  if (value['result'] !== undefined) {
    const result = cloneBoundedJson(value['result'], {
      maxBytes: MAX_APPLICATION_RECEIPT_BYTES,
      maxDepth: MAX_APPLICATION_RECEIPT_DEPTH,
      maxStringLength: MAX_APPLICATION_RECEIPT_STRING_LENGTH,
      maxVisits: 2_048,
      maxArrayItems: 1_000,
      maxObjectKeys: 256,
    });
    if (result === INVALID) return undefined;
    normalized.result = result;
  }
  return normalized;
}

/**
 * Only a fully approved, non-deferred send may consume Host activation. The
 * TriggerService deliberately calls its Outbox for staged decisions too; the
 * adapter keeps those decisions local instead of turning them into Agent
 * tasks. A deferred send (`delivery=queued`) is likewise not dispatched until
 * the caller explicitly submits a `delivery=sent` bundle.
 */
function isCloudHostDispatch(bundle: ContextBundle): boolean {
  return bundle.decision === 'send' && bundle.delivery === 'sent';
}

function stagedReceipt(bundle: ContextBundle, intentId: string | undefined): CloudHostDeliveryReceipt {
  let kind: DeliveryReceipt['kind'];
  let message: string;
  switch (bundle.decision) {
    case 'collect':
      kind = 'collected';
      message = 'Context collected locally; no Cloud Artifact Host task was created';
      break;
    case 'suggest':
      kind = 'suggested';
      message = 'Read suggestion staged locally; confirm before creating a Cloud Artifact Host task';
      break;
    case 'confirm':
      kind = 'needs_confirm';
      message = 'Proposal staged locally; explicit confirmation is required before creating a Cloud Artifact Host task';
      break;
    case 'send':
    default:
      kind = 'queued';
      message = 'Cloud Artifact Host task queued locally until an explicit non-deferred send';
      break;
  }
  return {
    ok: true,
    bundle_id: bundle.bundle_id,
    kind,
    message,
    task_status: 'unavailable',
    status: 'unavailable',
    ...(intentId !== undefined ? { intent_id: intentId } : {}),
    code: 'not_dispatched',
  };
}

function stagedFailureReceipt(
  bundleId: string,
  intentId: string | undefined,
  code: string,
  message: string,
): CloudHostDeliveryReceipt {
  return {
    ok: true,
    bundle_id: bundleId,
    kind: 'queued',
    message: `${clampMessage(message)}; retry from an explicit user action to send`,
    task_status: 'unavailable',
    status: 'unavailable',
    ...(intentId !== undefined ? { intent_id: intentId } : {}),
    code: cleanStatusString(code, 128) ?? 'request_failed',
  };
}

function receiptFromTaskStatus(
  bundleId: string,
  intentId: string | undefined,
  status: CloudHostTaskStatus,
): CloudHostDeliveryReceipt {
  const reportedApplicationStatus = applicationStatusFromTask(status);
  // The official Host status contract intentionally exposes only bounded task
  // fields. Its contract-marked `completed` state is emitted by CatsCo only
  // after the exact page returned an `applied` application receipt. Structural
  // test/embedding hosts without that marker must provide the explicit receipt
  // status instead of getting an implicit success.
  const applicationStatus = status.status === 'completed'
    && status.contract_version === CLOUD_HOST_TASK_STATUS_CONTRACT
    && reportedApplicationStatus === undefined
    ? 'applied' as const
    : reportedApplicationStatus;
  const applicationFailed = applicationStatus === 'failed' || applicationStatus === 'rejected';
  let kind: DeliveryReceipt['kind'];
  let ok: boolean;
  switch (status.status) {
    case 'submitted':
      kind = 'accepted';
      ok = true;
      break;
    case 'running':
      // Agent execution is not application completion.
      kind = 'acknowledged';
      ok = true;
      break;
    case 'completed':
      // An official contract-marked completion is authoritative because the
      // Host only emits it after the exact Artifact result sink returned an
      // applied receipt. Marker-less embedding statuses still require an
      // explicit application receipt below.
      kind = applicationStatus === 'applied' ? 'completed' : 'rejected';
      ok = applicationStatus === 'applied';
      break;
    case 'failed':
      kind = 'rejected';
      ok = false;
      break;
  }
  const defaultMessage = status.status === 'submitted'
    ? `Cloud Host accepted task ${status.task_id}`
    : status.status === 'running'
      ? `Cloud Host is running task ${status.task_id}`
      : status.status === 'completed'
        ? applicationFailed
          ? `Cloud Host task ${status.task_id} completed without an applied result`
          : applicationStatus === 'applied'
            ? `Cloud Host task ${status.task_id} completed with an applied result`
            : `Cloud Host task ${status.task_id} reported completion without an application receipt`
        : `Cloud Host task ${status.task_id} failed`;
  const code = status.code ?? (
    status.status === 'completed' && applicationStatus === undefined
      ? 'application_receipt_missing'
      : applicationFailed
        ? `application_${applicationStatus}`
        : undefined
  );
  return {
    ok,
    bundle_id: bundleId,
    kind,
    message: clampMessage(status.message ?? defaultMessage),
    task_id: status.task_id,
    task_status: status.status,
    status: status.status,
    ...(intentId !== undefined ? { intent_id: intentId } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(status.run_id !== undefined ? { run_id: status.run_id } : {}),
    ...(status.result_id !== undefined ? { result_id: status.result_id } : {}),
    ...(applicationStatus !== undefined ? { application_status: applicationStatus } : {}),
    ...(applicationReceiptFromTask(status) !== undefined
      ? { application_receipt: cloneJson(applicationReceiptFromTask(status)) }
      : {}),
    ...(status.updated_at !== undefined ? { updated_at: status.updated_at } : {}),
    ...(status.expires_at !== undefined ? { expires_at: status.expires_at } : {}),
  };
}

function applicationStatusFromTask(status: CloudHostTaskStatus): CloudHostApplicationStatus | undefined {
  if (status.application_status !== undefined) return status.application_status;
  const candidates: unknown[] = [
    status.application_receipt,
    status.result,
    isRecord(status.result) ? status.result['application_receipt'] : undefined,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate) && isApplicationStatus(candidate['status'])) return candidate['status'];
  }
  return undefined;
}

function applicationReceiptFromTask(status: CloudHostTaskStatus): unknown {
  if (status.application_receipt !== undefined) return status.application_receipt;
  if (isRecord(status.result) && status.result['application_receipt'] !== undefined) {
    return status.result['application_receipt'];
  }
  return undefined;
}

function statusRank(status: CloudHostTaskStatusName): number {
  switch (status) {
    case 'submitted':
      return 0;
    case 'running':
      return 1;
    case 'completed':
    case 'failed':
      return 2;
  }
}

function shouldIgnoreStatus(current: CloudHostTaskStatus, incoming: CloudHostTaskStatus): boolean {
  if (current.task_id !== incoming.task_id) return true;
  if (statusRank(incoming.status) < statusRank(current.status)) return true;
  // Once a terminal state is observed, do not let a late running/submitted
  // event reopen it. Same-state updates may carry a result/message enrichment.
  if (statusRank(current.status) === 2 && statusRank(incoming.status) === 2 && current.status !== incoming.status) return true;
  return false;
}

function selectionPayload(selection: Selection): CloudHostSelectionPayload {
  const note = typeof selection.note === 'string' && selection.note.trim() !== '' ? selection.note : undefined;
  const nodeId = typeof selection.node_id === 'string' && selection.node_id.trim() !== '' ? selection.node_id : undefined;
  return {
    selection_id: selection.selection_id,
    artifact_id: selection.artifact_id,
    revision: selection.revision,
    region_id: selection.region_id,
    ...(nodeId !== undefined ? { node_id: nodeId } : {}),
    label: selection.label,
    ...(note !== undefined ? { note } : {}),
  };
}

function resolveOption<T>(primary: T | undefined, alias: T | undefined, name: string): T | undefined {
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new Error(`${name} was provided twice with different values`);
  }
  return primary ?? alias;
}

function resolveTimeout(primary: number | undefined, alias: number | undefined): number {
  const value = resolveOption(primary, alias, 'timeout') ?? DEFAULT_CLOUD_HOST_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error('timeoutMs must be an integer between 1 and 120000');
  }
  return value;
}

function boundedOption(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isTaskStatusName(value: unknown): value is CloudHostTaskStatusName {
  return value === 'submitted' || value === 'running' || value === 'completed' || value === 'failed';
}

function isApplicationStatus(value: unknown): value is CloudHostApplicationStatus {
  return value === 'applied' || value === 'rejected' || value === 'failed';
}

function cleanStatusString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value !== value.trim() || /[\0\r\n]/.test(value)) {
    return undefined;
  }
  return value;
}

function clampMessage(value: string): string {
  const normalized = value.replace(/[\0\r\n]/g, ' ').trim();
  return normalized.length > MAX_STATUS_STRING_LENGTH ? normalized.slice(0, MAX_STATUS_STRING_LENGTH) : normalized;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = cleanStatusString(error['code'], 128);
  return code?.match(/^[a-z][a-z0-9_]{0,127}$/) ? code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return clampMessage(error.message) || undefined;
  if (isRecord(error)) {
    const message = cleanStatusString(error['message'], MAX_STATUS_STRING_LENGTH);
    return message === undefined ? undefined : clampMessage(message);
  }
  return undefined;
}

function stableFingerprint(intentId: string | undefined, payload: unknown): string {
  return `${intentId ?? ''}\u0000${JSON.stringify(payload)}`;
}

function cloneReceipt(receipt: CloudHostDeliveryReceipt): CloudHostDeliveryReceipt {
  return {
    ...receipt,
    ...(receipt.application_receipt !== undefined ? { application_receipt: cloneJson(receipt.application_receipt) } : {}),
  };
}

function cloneTaskStatus(status: CloudHostTaskStatus): CloudHostTaskStatus {
  return {
    ...status,
    ...(status.application_receipt !== undefined ? { application_receipt: cloneJson(status.application_receipt) } : {}),
    ...(status.result !== undefined ? { result: cloneJson(status.result) } : {}),
  };
}

function cloneJson(value: unknown): unknown {
  // Values have already passed cloneBoundedJson, so JSON serialization is safe.
  return JSON.parse(JSON.stringify(value)) as unknown;
}

const INVALID = Symbol('invalid-cloud-host-json');

interface JsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxStringLength: number;
  maxVisits: number;
  maxArrayItems: number;
  maxObjectKeys: number;
}

function cloneBoundedJson(value: unknown, limits: JsonLimits): unknown | typeof INVALID {
  const visits = { remaining: limits.maxVisits };
  let cloned: unknown | typeof INVALID;
  try {
    cloned = cloneJsonValue(value, 0, new WeakSet<object>(), visits, limits);
  } catch {
    return INVALID;
  }
  if (cloned === INVALID) return INVALID;
  try {
    const serialized = JSON.stringify(cloned);
    if (serialized === undefined || utf8ByteLength(serialized) > limits.maxBytes) return INVALID;
  } catch {
    return INVALID;
  }
  return cloned;
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  visits: { remaining: number },
  limits: JsonLimits,
): unknown | typeof INVALID {
  if (depth > limits.maxDepth || visits.remaining <= 0) return INVALID;
  visits.remaining -= 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
  if (typeof value === 'string') return value.length <= limits.maxStringLength ? value : INVALID;
  if (typeof value !== 'object' || ancestors.has(value)) return INVALID;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) return INVALID;
      const result: unknown[] = [];
      for (const item of value) {
        const cloned = cloneJsonValue(item, depth + 1, ancestors, visits, limits);
        if (cloned === INVALID) return INVALID;
        result.push(cloned);
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return INVALID;
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length > limits.maxObjectKeys) return INVALID;
    const result: Record<string, unknown> = {};
    for (const key of keys.sort()) {
      if (UNSAFE_KEYS.has(key) || key.length > 128 || /[\0\r\n]/.test(key)) return INVALID;
      const cloned = cloneJsonValue(source[key], depth + 1, ancestors, visits, limits);
      if (cloned === INVALID) return INVALID;
      Object.defineProperty(result, key, { value: cloned, enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function utf8ByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    // Conservative fallback for unusual runtimes without TextEncoder.
    return value.length;
  }
}
