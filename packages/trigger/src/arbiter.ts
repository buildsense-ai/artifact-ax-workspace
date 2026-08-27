import {
  DEFAULT_POLICY,
  type ArbiterPolicy,
  type Assessment,
  type Decision,
  type IntentKind,
  type Selection,
} from './types.js';
import { DEFAULT_INTENT_CLASSIFIER, type IntentClassifier } from './intent.js';

/**
 * Intent arbiter: turns "what the user selected plus one natural-language
 * intent" into a deterministic, transport-neutral decision. It never applies
 * anything silently. Read-only intents may auto-send or suggest according to
 * the explicit user policy; write/destructive intents always produce a
 * proposal that requires confirmation.
 */
export class IntentArbiter {
  private readonly classifier: IntentClassifier;
  private readonly policy: ArbiterPolicy;

  constructor(opts: { classifier?: IntentClassifier; policy?: Partial<ArbiterPolicy> } = {}) {
    this.classifier = opts.classifier ?? DEFAULT_INTENT_CLASSIFIER;
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
  }

  /**
   * Classify the intent text. `collect` means no intent text was given and no
   * action is implied; the selections are still bundled as context.
   */
  assess(selections: Selection[], intentText: string): Assessment {
    return this.classifier.classify(intentText);
  }

  /** Decide how to behave for one assessment, honoring the user policy. */
  decide(assessment: Assessment): Decision {
    const a = assessment;
    const p = this.policy;
    const base = (action: Decision['action'], message: string): Decision => ({ action, message, assessment: a });

    switch (a.intent_kind) {
      case 'collect':
        return base('collect', 'Collected as context. You gave no intent, so nothing is sent.');
      case 'inspect':
      case 'explain':
      case 'review':
      case 'compare': {
        // A custom classifier may attach a higher risk to a read-shaped
        // intent. Never let the family name alone bypass the risk gate.
        if (a.risk === 'medium' || a.risk === 'high') {
          return base('confirm', 'This read-shaped request carries mutation risk. Proposal staged; confirm before sending.');
        }
        if (a.risk !== 'low') {
          return base('collect', 'Risk could not be established. Collected only; clarify the intent before sending.');
        }
        // `readSendThreshold` is the explicit user gate: confidence at/above it
        // auto-sends a low-risk read intent (complete or not). Below that, a
        // suggestion is offered; far below, we only collect.
        if (a.confidence >= p.readSendThreshold) {
          return base('send', `Sent a read-only request: ${intentLabel(a.intent_kind)} across the focus set.`);
        }
        if (a.confidence >= p.suggestThreshold) {
          return base('suggest', `Suggested ${intentLabel(a.intent_kind)}. Confirm to send a read-only request.`);
        }
        return base('collect', `Low-confidence read intent. Collected only; adjust the intent or confirm to proceed.`);
      }
      case 'change':
      case 'destructive': {
        // `confirmMutations` is intentionally a safety declaration rather than
        // an escape hatch. A caller cannot weaken this floor by configuration.
        if (!p.confirmMutations) {
          return base(
            'confirm',
            `${intentLabel(a.intent_kind)} is a mutation. A proposal is prepared; it is never applied without your confirmation.`,
          );
        }
        return base(
          'confirm',
          `${intentLabel(a.intent_kind)} mutates the artifact. Proposal staged for your review; nothing is applied automatically.`,
        );
      }
      case 'ambiguous':
      default: {
        if (a.risk === 'medium' || a.risk === 'high') {
          return base('confirm', 'Ambiguous intent with mutation risk. Proposal staged; confirm before sending.');
        }
        if (a.confidence >= p.suggestThreshold) {
          return base('suggest', 'Ambiguous intent. Confirm to send; review the proposal first.');
        }
        return base('collect', 'Intent confidence is too low to suggest an action. Collected only; clarify the intent.');
      }
    }
  }
}

function intentLabel(kind: IntentKind): string {
  switch (kind) {
    case 'inspect':
      return 'inspect';
    case 'explain':
      return 'explain';
    case 'review':
      return 'review';
    case 'compare':
      return 'compare';
    case 'change':
      return 'edit/update';
    case 'destructive':
      return 'delete/publish';
    default:
      return kind;
  }
}
