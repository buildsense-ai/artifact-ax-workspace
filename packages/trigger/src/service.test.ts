import { describe, expect, it } from 'vitest';
import { TriggerService } from './service.js';
import { MockOutbox } from './outbox.js';
import { type Selection } from './types.js';

function sel(regionId: string, nodeId?: string): Selection {
  return {
    selection_id: `sel-${regionId}-${nodeId ?? ''}`,
    artifact_id: 'lesson-report',
    revision: 0,
    region_id: regionId,
    ...(nodeId ? { node_id: nodeId } : {}),
    label: regionId,
  };
}

function service(over: Record<string, unknown> = {}) {
  return new TriggerService({
    outbox: new MockOutbox(),
    sessionProvider: () => 'topic_demo',
    actorId: 'human_teacher',
    ...over,
  });
}

describe('TriggerService', () => {
  it('groups semantically compatible selections into separate bundles', async () => {
    const svc = service();
    const { bundles } = await svc.execute([sel('review-table', 'r-1'), sel('review-table', 'r-2'), sel('summary-panel')], 'review');
    expect(bundles).toHaveLength(2); // table + summary split
    const table = bundles.find((b) => b.selections[0]?.region_id === 'review-table')!;
    expect(table.selections).toHaveLength(2);
    expect(table.contract_version).toBe('trigger.context-bundle.v1');
    expect(table.context_ref).toContain('mock://outbox/topic_demo');
  });

  it('collects when no intent text is given and does not send', async () => {
    const svc = service();
    const { bundles, receipts } = await svc.execute([sel('review-table', 'r-1')], '   ');
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.decision).toBe('collect');
    expect(bundles[0]!.delivery).toBe('collecting');
    expect(receipts[0]!.kind).toBe('collected');
  });

  it('sends a complete low-risk read intent when not deferred', async () => {
    const svc = service();
    const { bundles } = await svc.execute([sel('review-table', 'r-1')], 'review these rows');
    expect(bundles[0]!.decision).toBe('send');
    expect(bundles[0]!.delivery).toBe('sent');
  });

  it('queues a send for the next turn when a run is active (defer)', async () => {
    const svc = service();
    const { bundles, receipts } = await svc.execute([sel('review-table', 'r-1')], 'review these rows', { defer: true });
    expect(bundles[0]!.decision).toBe('send');
    expect(bundles[0]!.delivery).toBe('queued');
    expect(receipts[0]!.kind).toBe('queued');
  });

  it('never sends a mutation silently: it stages a confirmation', async () => {
    const svc = service();
    const { bundles } = await svc.execute([sel('review-table', 'r-1')], 'delete these rows');
    expect(bundles[0]!.decision).toBe('confirm');
    expect(bundles[0]!.delivery).toBe('needs_confirm');
  });

  it('holds a mutation that targets a read-only region instead of sending', async () => {
    const svc = service({
      regionWritable: (regionId: string) => regionId !== 'summary-panel',
    });
    const { bundles } = await svc.execute([sel('summary-panel')], 'delete the summary');
    // Must not send to a read-only region.
    expect(bundles[0]!.delivery).not.toBe('sent');
    expect(bundles[0]!.assessment.rationale.join(' ')).toMatch(/read-only/);
  });

  it('is idempotent: the mock outbox stores each bundle_id once', async () => {
    const outbox = new MockOutbox();
    const svc = service({ outbox });
    await svc.execute([sel('review-table', 'r-1')], 'review these rows');
    const first = outbox.list()[0]!;
    // Re-send the identical bundle: receipt says stored, no duplicate.
    const r2 = await outbox.send(first);
    expect(r2.kind).toBe('stored');
    expect(outbox.list()).toHaveLength(1);
  });

  it('stores collected / suggested bundles in the outbox for visibility', async () => {
    const outbox = new MockOutbox();
    const svc = service({ outbox });
    await svc.execute([sel('review-table', 'r-1')], '');
    await svc.execute([sel('review-table', 'r-2')], 'inspect that');
    expect(outbox.list().length).toBeGreaterThanOrEqual(2);
  });

  it('requires selections to produce bundles', async () => {
    const svc = service();
    const { bundles } = await svc.execute([], 'review');
    expect(bundles).toEqual([]);
  });

  it('carries per-selection notes and stable anchors through the bundle', async () => {
    const svc = service();
    const s = sel('review-table', 'r-9');
    const noted = { ...s, note: 'double-check this one', region_title: 'Review table' };
    const { bundles } = await svc.execute([noted], 'review these rows');
    expect(bundles[0]!.selections[0]).toMatchObject({ node_id: 'r-9', note: 'double-check this one', region_title: 'Review table' });
  });
});
