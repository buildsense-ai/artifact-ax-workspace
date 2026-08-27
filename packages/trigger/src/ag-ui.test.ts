import { describe, expect, it } from 'vitest';
import {
  AG_UI_BRIDGE_CONTEXT_EVENT,
  AG_UI_BRIDGE_RECEIPT_EVENT,
  AgUiBridgeProjector,
  isAgUiEvent,
  type BridgeReceipt,
  type ContextBundle,
} from './index.js';

function bundle(over: Partial<ContextBundle> = {}): ContextBundle {
  const id = over.bundle_id ?? 'bdl-ag-ui';
  const revision = over.revision ?? 4;
  return {
    contract_version: 'trigger.context-bundle.v1',
    bundle_id: id,
    session_id: 'topic-ag-ui',
    actor_id: 'human_teacher',
    artifact_id: 'lesson-report',
    revision,
    selections: [
      {
        selection_id: 'sel-1',
        artifact_id: 'lesson-report',
        revision,
        region_id: 'review-table',
        node_id: 'row-1',
        label: 'Row 1',
      },
    ],
    intent: { text: 'review this row' },
    assessment: {
      intent_kind: 'review',
      confidence: 0.95,
      risk: 'low',
      rationale: ['read-only review'],
      complete: true,
    },
    decision: 'send',
    delivery: 'sent',
    created_at: '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

function receipt(over: Partial<BridgeReceipt> = {}): BridgeReceipt {
  return {
    protocol_version: 'artifact.ax.bridge.v1',
    receipt_id: 'rct-ag-ui',
    bundle_id: 'bdl-ag-ui',
    state: 'accepted',
    idempotent: false,
    message: 'accepted via bridge as \'accepted\'',
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

describe('AG-UI bridge projection', () => {
  it('wraps a receipt in a run lifecycle without creating a chat message', () => {
    const projector = new AgUiBridgeProjector({ now: () => 1234 });
    const events = projector.project(receipt(), bundle());

    expect(events.map((event) => event.type)).toEqual(['RUN_STARTED', 'CUSTOM']);
    expect(events[0]).toMatchObject({ type: 'RUN_STARTED', threadId: 'topic-ag-ui', runId: 'bdl-ag-ui', timestamp: 1234 });
    expect(events[1]).toMatchObject({
      type: 'CUSTOM',
      name: AG_UI_BRIDGE_RECEIPT_EVENT,
      metadata: { bundleId: 'bdl-ag-ui', artifactId: 'lesson-report', revision: 4 },
      value: { selection_refs: [{ region_id: 'review-table', node_id: 'row-1', label: 'Row 1' }] },
    });
    expect(events.some((event) => event.type.startsWith('TEXT_MESSAGE'))).toBe(false);

    // An idempotent replay has a different human message/idempotent bit but no
    // new bridge state, so it must not duplicate the AG-UI event.
    expect(
      projector.project(
        receipt({ idempotent: true, message: 'idempotent replay: bdl-ag-ui already accepted' }),
        bundle(),
      ),
    ).toEqual([]);
  });

  it('emits a terminal finish exactly once', () => {
    const projector = new AgUiBridgeProjector({ now: () => 42 });
    projector.project(receipt(), bundle());
    const completed = projector.project(
      receipt({ state: 'completed', updated_at: '2026-08-26T00:00:01.000Z', message: 'delivered and completed' }),
      bundle(),
    );
    expect(completed.map((event) => event.type)).toEqual(['CUSTOM', 'RUN_FINISHED']);
    expect(completed.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      threadId: 'topic-ag-ui',
      runId: 'bdl-ag-ui',
      result: { bridge_state: 'completed', receipt_id: 'rct-ag-ui' },
    });

    // Further duplicate updates after terminal state are ignored.
    expect(projector.project(receipt({ state: 'completed', updated_at: '2026-08-26T00:00:01.000Z' }), bundle())).toEqual([]);
  });

  it('includes full context only when explicitly requested, and only once', () => {
    const projector = new AgUiBridgeProjector({ includeContext: true, now: () => 99 });
    const first = projector.project(receipt(), bundle());
    expect(first.map((event) => event.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'CUSTOM']);
    expect(first[2]).toMatchObject({ type: 'CUSTOM', name: AG_UI_BRIDGE_CONTEXT_EVENT });
    expect((first[2] as { value: { bundle: ContextBundle } }).value.bundle.bundle_id).toBe('bdl-ag-ui');

    const next = projector.project(
      receipt({ state: 'acknowledged', updated_at: '2026-08-26T00:00:02.000Z', message: 'acknowledged by receiver' }),
      bundle(),
    );
    expect(next.map((event) => event.type)).toEqual(['CUSTOM']);
    expect(next.some((event) => event.type === 'CUSTOM' && event.name === AG_UI_BRIDGE_CONTEXT_EVENT)).toBe(false);
  });

  it('keeps a stable fallback identity when only a compact receipt is available', () => {
    const projector = new AgUiBridgeProjector({ now: () => 7 });
    const events = projector.project(receipt({ bundle_id: 'bdl-no-payload' }));
    expect(events[0]).toMatchObject({
      type: 'RUN_STARTED',
      threadId: 'artifact-bridge:bdl-no-payload',
      runId: 'bdl-no-payload',
    });
  });

  it('guards raw SSE values before handing them to an AG-UI host', () => {
    expect(isAgUiEvent({ type: 'CUSTOM', timestamp: 1, name: 'x', value: {} })).toBe(true);
    expect(isAgUiEvent({ type: 'CUSTOM', name: 'x', value: {} })).toBe(true);
    expect(isAgUiEvent({ type: 'RUN_STARTED', timestamp: 1, threadId: 't', runId: 'r' })).toBe(true);
    expect(isAgUiEvent({ type: 'CUSTOM', timestamp: '1', name: 'x', value: {} })).toBe(false);
    expect(isAgUiEvent({ type: 'UNKNOWN', timestamp: 1 })).toBe(false);
  });
});
