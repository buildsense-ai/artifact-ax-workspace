import { describe, expect, it } from 'vitest';
import { IntentArbiter } from './arbiter.js';
import { DEFAULT_POLICY, type Assessment, type Selection } from './types.js';

const sel = (over: Partial<Selection> = {}): Selection => ({
  selection_id: 'sel',
  artifact_id: 'lesson-report',
  revision: 0,
  region_id: 'review-table',
  label: 'Review table',
  ...over,
});

function assessment(partial: Partial<Assessment>): Assessment {
  return {
    intent_kind: 'collect',
    confidence: 1,
    risk: 'none',
    rationale: [],
    complete: true,
    ...partial,
  };
}

describe('IntentArbiter', () => {
  it('collects when there is no intent, even with selections', () => {
    const arbiter = new IntentArbiter();
    const d = arbiter.decide(assessment({ intent_kind: 'collect' }));
    expect(d.action).toBe('collect');
    expect(arbiter.assess([sel()], '   ').intent_kind).toBe('collect');
  });

  it('sends a complete, high-confidence low-risk read intent under default policy', () => {
    const arbiter = new IntentArbiter();
    const d = arbiter.decide(
      assessment({ intent_kind: 'review', confidence: 0.9, risk: 'low', complete: true }),
    );
    expect(d.action).toBe('send');
  });

  it('suggests a read intent below the send threshold', () => {
    const arbiter = new IntentArbiter();
    const d = arbiter.decide(
      assessment({ intent_kind: 'inspect', confidence: 0.5, risk: 'low', complete: false }),
    );
    expect(d.action).toBe('suggest');
  });

  it('auto-sends read intents when the user lowers the send threshold', () => {
    const arbiter = new IntentArbiter({ policy: { readSendThreshold: 0.3 } });
    const d = arbiter.decide(
      assessment({ intent_kind: 'inspect', confidence: 0.5, risk: 'low', complete: false }),
    );
    expect(d.action).toBe('send');
  });

  it('never silently sends a change (mutation) intent: it confirms', () => {
    const arbiter = new IntentArbiter();
    for (const kind of ['change', 'destructive'] as const) {
      const d = arbiter.decide(assessment({ intent_kind: kind, confidence: 0.99, risk: kind === 'change' ? 'medium' : 'high' }));
      expect(d.action).toBe('confirm');
      expect(d.message).toMatch(/confirm|proposal/i);
    }
  });

  it('confirms ambiguous intents whose risk is medium or high', () => {
    const arbiter = new IntentArbiter();
    const d = arbiter.decide(assessment({ intent_kind: 'ambiguous', risk: 'high', complete: false }));
    expect(d.action).toBe('confirm');
  });

  it('suggests ambiguous low-risk intents', () => {
    const arbiter = new IntentArbiter();
    const d = arbiter.decide(assessment({ intent_kind: 'ambiguous', risk: 'low', complete: false }));
    expect(d.action).toBe('suggest');
  });

  it('collects an ambiguous intent below the suggestion threshold', () => {
    const arbiter = new IntentArbiter();
    const d = arbiter.decide(assessment({ intent_kind: 'ambiguous', confidence: 0.2, risk: 'none', complete: false }));
    expect(d.action).toBe('collect');
  });

  it('does not auto-send a read family when a classifier reports mutation risk', () => {
    const arbiter = new IntentArbiter();
    const d = arbiter.decide(assessment({ intent_kind: 'review', confidence: 0.99, risk: 'high' }));
    expect(d.action).toBe('confirm');
  });

  it('respects a policy that disables auto-confirm but still never applies silently', () => {
    const arbiter = new IntentArbiter({ policy: { confirmMutations: false } });
    const d = arbiter.decide(assessment({ intent_kind: 'delete' as Assessment['intent_kind'], risk: 'high' }));
    // Even with confirmMutations=false the MVP rule keeps mutation as confirm.
    expect(d.action).toBe('confirm');
  });

  it('policy merges with DEFAULT_POLICY', () => {
    const arbiter = new IntentArbiter({ policy: { readSendThreshold: 0.5 } });
    expect(
      arbiter.decide(assessment({ intent_kind: 'compare', confidence: 0.6, risk: 'low' })).action,
    ).toBe('send');
    // unset fields keep defaults
    expect(DEFAULT_POLICY.confirmMutations).toBe(true);
  });
});
