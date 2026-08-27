/**
 * AG-UI-compatible projection for the external Artifact Bridge.
 *
 * The Artifact domain does not depend on AG-UI (and it does not need an Agent
 * runtime).  This small, transport-neutral projector translates a bridge
 * receipt into the subset of AG-UI BaseEvents that is useful for a host UI:
 *
 *   RUN_STARTED -> CUSTOM(artifact.ax.bridge.receipt.v1) -> RUN_FINISHED
 *
 * A receipt is a structured interaction, not a chat message, so the adapter
 * deliberately does not emit TEXT_MESSAGE_* events.  The custom event keeps
 * the context hidden from a normal conversation surface while still allowing
 * an AG-UI host to render approvals, queue state, and completion.
 *
 * This module is pure TypeScript: no DOM, fetch, Node APIs, or AG-UI SDK
 * dependency.  A server/client adapter can therefore be swapped in without
 * coupling the Artifact app to a particular AG-UI implementation.
 */

import { BRIDGE_PROTOCOL_VERSION, type BridgeReceipt } from './bridge.js';
import type { ContextBundle } from './types.js';

/** Namespaced custom events emitted by the bridge projection. */
export const AG_UI_BRIDGE_RECEIPT_EVENT = 'artifact.ax.bridge.receipt.v1';
export const AG_UI_BRIDGE_CONTEXT_EVENT = 'artifact.ax.bridge.context.v1';
export const AG_UI_BRIDGE_WATCH_PATH = '/v1/ag-ui/watch';

export type AgUiEventType = 'RUN_STARTED' | 'CUSTOM' | 'RUN_FINISHED';

/** The common fields used by the current AG-UI event vocabulary. */
export interface AgUiBaseEvent {
  type: AgUiEventType;
  /** Unix epoch milliseconds; AG-UI makes this BaseEvent field optional. */
  timestamp?: number;
  rawEvent?: unknown;
  metadata?: Record<string, unknown>;
}

export interface AgUiRunStartedEvent extends AgUiBaseEvent {
  type: 'RUN_STARTED';
  threadId: string;
  runId: string;
}

export interface AgUiCustomEvent extends AgUiBaseEvent {
  type: 'CUSTOM';
  name: string;
  value: unknown;
}

export interface AgUiRunFinishedEvent extends AgUiBaseEvent {
  type: 'RUN_FINISHED';
  threadId: string;
  runId: string;
  result?: unknown;
}

export type AgUiEvent = AgUiRunStartedEvent | AgUiCustomEvent | AgUiRunFinishedEvent;

export interface BridgeBundleRef {
  bundle_id: string;
  session_id?: string;
  actor_id?: string;
  artifact_id?: string;
  revision?: number;
  context_ref?: string;
}

/** Stable, compact anchors a host can use to highlight the selected UI. */
export interface BridgeSelectionRef {
  selection_id: string;
  artifact_id: string;
  revision: number;
  region_id: string;
  node_id?: string;
  label: string;
  note?: string;
  ref?: string;
}

/** Value carried by the receipt custom event. */
export interface BridgeReceiptEventValue {
  protocol_version: typeof BRIDGE_PROTOCOL_VERSION;
  receipt: BridgeReceipt;
  bundle_ref: BridgeBundleRef;
  /** Stable anchors are included without requiring the full context payload. */
  selection_refs: BridgeSelectionRef[];
}

/** Value carried by the opt-in full-context custom event. */
export interface BridgeContextEventValue {
  protocol_version: typeof BRIDGE_PROTOCOL_VERSION;
  bundle: ContextBundle;
}

export interface AgUiBridgeProjectorOptions {
  /** Include the full ContextBundle once per run (off by default). */
  includeContext?: boolean;
  /** Injectable clock for deterministic tests and replay tooling. */
  now?: () => number;
}

function terminal(state: BridgeReceipt['state']): boolean {
  return state === 'completed' || state === 'rejected' || state === 'expired';
}

function fallbackThreadId(bundleId: string): string {
  return `artifact-bridge:${bundleId}`;
}

function bundleRef(receipt: BridgeReceipt, bundle?: ContextBundle): BridgeBundleRef {
  return {
    bundle_id: receipt.bundle_id,
    ...(bundle?.session_id ? { session_id: bundle.session_id } : {}),
    ...(bundle?.actor_id ? { actor_id: bundle.actor_id } : {}),
    ...(bundle?.artifact_id ? { artifact_id: bundle.artifact_id } : {}),
    ...(bundle?.revision !== undefined ? { revision: bundle.revision } : {}),
    ...(bundle?.context_ref ? { context_ref: bundle.context_ref } : {}),
  };
}

function eventMetadata(receipt: BridgeReceipt, bundle?: ContextBundle): Record<string, unknown> {
  return {
    source: BRIDGE_PROTOCOL_VERSION,
    bundleId: receipt.bundle_id,
    receiptId: receipt.receipt_id,
    state: receipt.state,
    ...(bundle?.artifact_id ? { artifactId: bundle.artifact_id } : {}),
    ...(bundle?.revision !== undefined ? { revision: bundle.revision } : {}),
  };
}

function selectionRefs(bundle?: ContextBundle): BridgeSelectionRef[] {
  if (!bundle) return [];
  return bundle.selections.map((selection) => ({
    selection_id: selection.selection_id,
    artifact_id: selection.artifact_id,
    revision: selection.revision,
    region_id: selection.region_id,
    ...(selection.node_id ? { node_id: selection.node_id } : {}),
    label: selection.label,
    ...(selection.note ? { note: selection.note } : {}),
    ...(selection.ref ? { ref: selection.ref } : {}),
  }));
}

function fingerprint(receipt: BridgeReceipt): string {
  // `idempotent` and `message` change on a replay even though no domain state
  // changed.  They must not make an AG-UI reconnect look like a new event.
  return `${receipt.receipt_id}|${receipt.state}|${receipt.updated_at}`;
}

/**
 * Stateful per-connection projector.  A new instance should be used for each
 * SSE subscription (or replay session), which gives every subscriber a valid
 * RUN_STARTED/RUN_FINISHED envelope without persisting AG-UI state in the
 * Artifact store.
 */
export class AgUiBridgeProjector {
  private readonly includeContext: boolean;
  private readonly now: () => number;
  private readonly started = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly contextSent = new Set<string>();
  private readonly fingerprints = new Map<string, string>();
  private readonly identities = new Map<string, { threadId: string; runId: string }>();

  constructor(options: AgUiBridgeProjectorOptions = {}) {
    this.includeContext = options.includeContext ?? false;
    this.now = options.now ?? Date.now;
  }

  /** Project one receipt update; duplicate replays produce no duplicate event. */
  project(receipt: BridgeReceipt, bundle?: ContextBundle): AgUiEvent[] {
    const bundleId = receipt.bundle_id;
    const identity = this.identities.get(bundleId) ?? {
      threadId: bundle?.session_id || fallbackThreadId(bundleId),
      // The receipt is authoritative for correlation. A malformed/mismatched
      // payload must never make the run appear under a different ID.
      runId: bundleId,
    };
    this.identities.set(bundleId, identity);

    const sameReceipt = this.fingerprints.get(bundleId) === fingerprint(receipt);
    const needsContext = this.includeContext && bundle !== undefined && !this.contextSent.has(bundleId);
    if (sameReceipt && !needsContext) return [];
    this.fingerprints.set(bundleId, fingerprint(receipt));

    const metadata = eventMetadata(receipt, bundle);
    const timestamp = (): number => this.now();
    const events: AgUiEvent[] = [];

    if (!this.started.has(bundleId)) {
      this.started.add(bundleId);
      events.push({
        type: 'RUN_STARTED',
        timestamp: timestamp(),
        threadId: identity.threadId,
        runId: identity.runId,
        metadata,
      });
    }

    // If a receipt was already seen without a payload, a later authorized
    // fetch can still add the context event without replaying the receipt.
    if (!sameReceipt) {
      const value: BridgeReceiptEventValue = {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        receipt: { ...receipt },
        bundle_ref: bundleRef(receipt, bundle),
        selection_refs: selectionRefs(bundle),
      };
      events.push({
        type: 'CUSTOM',
        timestamp: timestamp(),
        name: AG_UI_BRIDGE_RECEIPT_EVENT,
        value,
        metadata,
      });
    }

    if (needsContext) {
      const value: BridgeContextEventValue = {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        bundle: bundle!,
      };
      this.contextSent.add(bundleId);
      events.push({
        type: 'CUSTOM',
        timestamp: timestamp(),
        name: AG_UI_BRIDGE_CONTEXT_EVENT,
        value,
        metadata,
      });
    }

    if (terminal(receipt.state) && !this.finished.has(bundleId)) {
      this.finished.add(bundleId);
      events.push({
        type: 'RUN_FINISHED',
        timestamp: timestamp(),
        threadId: identity.threadId,
        runId: identity.runId,
        result: {
          protocol_version: BRIDGE_PROTOCOL_VERSION,
          bridge_state: receipt.state,
          receipt_id: receipt.receipt_id,
        },
        metadata,
      });
    }

    return events;
  }

  /** Clear per-connection state (useful for a long-lived adapter in tests). */
  reset(): void {
    this.started.clear();
    this.finished.clear();
    this.contextSent.clear();
    this.fingerprints.clear();
    this.identities.clear();
  }
}

/** Narrow runtime guard for untrusted SSE data. */
export function isAgUiEvent(value: unknown): value is AgUiEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== 'string') return false;
  if ('timestamp' in event && (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp))) return false;
  if (event.type === 'CUSTOM') return typeof event.name === 'string' && 'value' in event;
  if (event.type === 'RUN_STARTED' || event.type === 'RUN_FINISHED') {
    return typeof event.threadId === 'string' && typeof event.runId === 'string';
  }
  return false;
}
