import {
  TRIGGER_CONTRACT_VERSION,
  type ArbiterPolicy,
  type Assessment,
  type ContextBundle,
  type DeliveryState,
  type Selection,
} from './types.js';
import { IntentArbiter } from './arbiter.js';
import { groupSelections, mutationIntent, type RegionWritability, type SelectionGroup } from './group.js';
import { newBundleId } from './ids.js';
import { type DeliveryReceipt, type Outbox } from './outbox.js';
import { type IntentClassifier } from './intent.js';

export interface PlannedBundle {
  bundle: ContextBundle;
  decision: ContextBundle['decision'];
  message: string;
}

export interface CommitResult {
  bundles: ContextBundle[];
  receipts: DeliveryReceipt[];
}

export interface TriggerServiceOptions {
  outbox: Outbox;
  /** Explicit user policy for read-only auto-send / suggest thresholds. */
  policy?: Partial<ArbiterPolicy>;
  /** Replaceable classifier seam (future LLM classifier can plug in here). */
  classifier?: IntentClassifier;
  /** Mockable session / topic binding provider. */
  sessionProvider?: () => string;
  /** Marks whether a region structurally supports mutation intents. */
  regionWritable?: RegionWritability;
  actorId?: string;
  now?: () => string;
}

function defaultSession(): string {
  return `session_${Date.now().toString(36)}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * The deep, transport-neutral trigger module. It orchestrates: group the
 * selections, assess the one natural-language intent, decide how to behave,
 * then dispatch to the outbox. Nothing here reads the DOM or the network; the
 * SPA is a thin view over this seam.
 */
export class TriggerService {
  private readonly outbox: Outbox;
  private readonly arbiter: IntentArbiter;
  private readonly sessionProvider: () => string;
  private readonly regionWritable: RegionWritability;
  private readonly actorId: string;
  private readonly now: () => string;

  constructor(options: TriggerServiceOptions) {
    this.outbox = options.outbox;
    this.arbiter = new IntentArbiter({
      classifier: options.classifier,
      policy: options.policy,
    });
    this.sessionProvider = options.sessionProvider ?? defaultSession;
    this.regionWritable = options.regionWritable ?? (() => true);
    this.actorId = options.actorId ?? 'human_teacher';
    this.now = options.now ?? defaultNow;
  }

  /** Assess the intent for a raw selection set + intent text. */
  assess(selections: Selection[], intentText: string): Assessment {
    return this.arbiter.assess(selections, intentText);
  }

  /**
   * Build the plan: split selections into compatible groups, assess and
   * decide each group independently, and assemble explicit bundles.
   */
  plan(selections: Selection[], intentText: string): PlannedBundle[] {
    const sessionId = this.sessionProvider();
    const assessment = this.arbiter.assess(selections, intentText);
    const groups = groupSelections(selections);
    if (groups.length === 0) {
      return [];
    }
    return groups.map((group) => {
      const groupAssessment = this.groupAssessment(group, assessment);
      const decision = this.arbiter.decide(groupAssessment);
      // Hold any mutation that targets a read-only region instead of sending.
      // The arbiter stays intent-level; region writability is a service policy.
      const incompatible = mutationIntent(groupAssessment.intent_kind) && !this.regionWritable(group.region_id);
      const effectiveAssessment: Assessment = incompatible
        ? {
            ...groupAssessment,
            complete: false,
            rationale: [
              ...groupAssessment.rationale,
              `region '${group.region_id}' is read-only for ${groupAssessment.intent_kind}; held as collected, not sent`,
            ],
          }
        : groupAssessment;
      const effectiveDecision = incompatible
          ? {
            action: 'collect' as const,
            message: `Held as collected: '${group.region_id}' is read-only for ${groupAssessment.intent_kind} and an ${groupAssessment.risk}-risk intent cannot target it.`,
            assessment: effectiveAssessment,
          }
        : decision;
      const bundleId = newBundleId();

      const bundle: ContextBundle = {
        contract_version: TRIGGER_CONTRACT_VERSION,
        bundle_id: bundleId,
        session_id: sessionId,
        actor_id: this.actorId,
        artifact_id: group.artifact_id,
        revision: group.revision,
        selections: group.selections,
        intent: { text: intentText.trim() },
        assessment: effectiveAssessment,
        decision: effectiveDecision.action,
        delivery: toInitialState(effectiveDecision.action),
        created_at: this.now(),
        context_ref: `mock://outbox/${encodeURIComponent(sessionId)}/${encodeURIComponent(group.region_id)}/${encodeURIComponent(group.artifact_id)}/${group.revision}/${encodeURIComponent(bundleId)}`,
      };
      return { bundle, decision: effectiveDecision.action, message: effectiveDecision.message };
    });
  }

  /**
   * Execute the plan: dispatch each bundle to the outbox. `defer` means an
   * active run is in progress, so bundles are queued for the next turn rather
   * than sent now. Confirmations and suggestions are staged, never applied.
   */
  async execute(
    selections: Selection[],
    intentText: string,
    opts: { defer?: boolean } = {},
  ): Promise<CommitResult> {
    const planned = this.plan(selections, intentText);
    const bundles: ContextBundle[] = [];
    const receipts: DeliveryReceipt[] = [];
    for (const plannedBundle of planned) {
      let delivery: DeliveryState = plannedBundle.bundle.delivery;
      const action = plannedBundle.bundle.decision;
      if (action === 'send' && !opts.defer) {
        delivery = 'sent';
      } else if (action === 'send' && opts.defer) {
        delivery = 'queued';
      }
      const toSend: ContextBundle = { ...plannedBundle.bundle, delivery };
      const receipt = await this.outbox.send(toSend);
      bundles.push(toSend);
      receipts.push(receipt);
    }
    return { bundles, receipts };
  }

  /** The mock outbox, for the SPA to render one message per stored bundle. */
  outboxBundles(): ContextBundle[] {
    return this.outbox.list();
  }

  /**
   * Optional receipt read path for remote outboxes. A bridge intentionally
   * keeps full bundles off the wire, so consumers should render receipts when
   * this method returns them and use `outboxBundles()` only for local payloads.
   */
  outboxReceipts(): DeliveryReceipt[] {
    const receiptAware = this.outbox as Outbox & {
      listReceipts?: () => DeliveryReceipt[];
    };
    return receiptAware.listReceipts?.() ?? [];
  }

  outboxLabel(): string {
    return this.outbox.label;
  }

  private groupAssessment(group: SelectionGroup, global: Assessment): Assessment {
    // Each region gets the same intent text, but its own assessment so risk
    // framing can reflect the specific selection set if a future classifier
    // wants it. For this MVP all groups share the global assessment.
    return { ...global };
  }
}

function toInitialState(action: ContextBundle['decision']): DeliveryState {
  switch (action) {
    case 'collect':
      return 'collecting';
    case 'suggest':
      return 'suggested';
    case 'confirm':
      return 'needs_confirm';
    case 'send':
      return 'queued';
  }
}
