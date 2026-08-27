/**
 * Trigger MVP contract types. These are transport-neutral: a ContextBundle
 * and an IntentArbiter describe *what the user selected and meant*, not how
 * it is delivered. The CatsCo server is never touched; delivery goes through
 * an `Outbox` seam so the bundle can be shown, queued, or sent later.
 */

export const TRIGGER_CONTRACT_VERSION = 'trigger.context-bundle.v1';

/** Risk of acting on the recognized intent. */
export type IntentRisk = 'none' | 'low' | 'medium' | 'high';

/**
 * Intent families. Read-only families may auto-send or suggest per user
 * policy. `change` is a mutation. `destructive` is consequential (delete,
 * publish, approve, ...) and must always confirm. `ambiguous` is a mix or an
 * unclear intent. `collect` means the user gave no intent: gather only.
 */
export type IntentKind =
  | 'collect'
  | 'inspect'
  | 'explain'
  | 'review'
  | 'compare'
  | 'change'
  | 'destructive'
  | 'ambiguous';

/** Arbiter output: how the system should behave for one bundle. */
export type DecisionAction = 'collect' | 'suggest' | 'send' | 'confirm';

/** Lifecycle of a bundle inside the outbox / turn queue. */
export type DeliveryState =
  | 'collecting'
  | 'suggested'
  | 'queued'
  | 'needs_confirm'
  | 'sent';

/**
 * One stable artifact region / node in the focus set. Anchors are the
 * documented, stable identifiers (`artifact_id`, `revision`, `region_id`,
 * `node_id`) — never pixel coordinates or fragile DOM selectors.
 */
export interface Selection {
  selection_id: string;
  artifact_id: string;
  revision: number;
  region_id: string;
  region_title?: string;
  /** Stable data-node-id within the region, when the selection is an item. */
  node_id?: string;
  /** Human label used in the composer and the packed message. */
  label: string;
  /** Optional per-item note. */
  note?: string;
  /** Out-of-band payload reference for large selection payloads. */
  ref?: string;
}

export interface Assessment {
  intent_kind: IntentKind;
  /** Deterministic 0..1 confidence from the classifier. */
  confidence: number;
  risk: IntentRisk;
  /** Human-readable reasons backing the verdict. */
  rationale: string[];
  /** True when intent decoded unambiguously and fully. */
  complete: boolean;
}

export interface Decision {
  action: DecisionAction;
  /** User-facing sentence describing the decision. */
  message: string;
  assessment: Assessment;
}

/**
 * A structured context bundle. One visible, compact CatsCo-style message
 * carries this; `context_ref` points to the full out-of-band payload when the
 * selection set is large.
 */
export interface ContextBundle {
  contract_version: string;
  bundle_id: string;
  /** Mockable session / topic binding. */
  session_id: string;
  actor_id: string;
  artifact_id: string;
  revision: number;
  /** Ordered selections (order is meaningful: first is most important). */
  selections: Selection[];
  intent: { text: string };
  assessment: Assessment;
  decision: DecisionAction;
  delivery: DeliveryState;
  created_at: string;
  /** Reference to the full stored payload (mock outbox), for large bundles. */
  context_ref?: string;
}

/** Explicit user policy that controls when a read intent auto-sends. */
export interface ArbiterPolicy {
  /** Confidence at/above which a complete low-risk read intent auto-sends. */
  readSendThreshold: number;
  /** Confidence at/above which an incomplete read intent becomes a proposal. */
  suggestThreshold: number;
  /** Safety floor: write/destructive intents always require confirmation. */
  confirmMutations: boolean;
}

export const DEFAULT_POLICY: ArbiterPolicy = {
  readSendThreshold: 0.8,
  suggestThreshold: 0.4,
  confirmMutations: true,
};
