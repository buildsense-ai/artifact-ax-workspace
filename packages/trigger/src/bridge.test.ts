import { describe, expect, it } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_STORE_SNAPSHOT_VERSION,
  BridgeError,
  BridgeStoreSnapshotError,
  InMemoryBridgeStore,
  hasMinimalBundle,
  initialStateForDelivery,
  type BridgeStoreSnapshot,
  type BridgeSubmitRequest,
} from './bridge.js';
import { BridgeClient } from './bridge-client.js';
import { type ContextBundle } from './types.js';

function bundle(over: Partial<ContextBundle> = {}): ContextBundle {
  const id = over.bundle_id ?? `bdl-${Math.random().toString(36).slice(2, 8)}`;
  const artifactId = over.artifact_id ?? 'lesson-report';
  const bundleRevision = over.revision ?? 1;
  return {
    contract_version: 'trigger.context-bundle.v1',
    bundle_id: id,
    session_id: 'topic_demo',
    actor_id: 'human_teacher',
    artifact_id: artifactId,
    revision: bundleRevision,
    selections: [
      { selection_id: 'sel-1', artifact_id: artifactId, revision: bundleRevision, region_id: 'review-table', node_id: 'r-1', label: 'Row r-1' },
    ],
    intent: { text: 'review' },
    assessment: { intent_kind: 'review', confidence: 0.9, risk: 'low', rationale: ['read intent'], complete: true },
    decision: 'send',
    delivery: 'sent',
    created_at: '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

function submit(store: InMemoryBridgeStore, req: Partial<BridgeSubmitRequest> = {}) {
  return store.submit({ bundle: req.bundle ?? bundle(), ...req });
}

describe('bridge protocol / store', () => {
  it('exactly-once: submitting the same bundle_id is an idempotent replay, not a new state', async () => {
    const store = new InMemoryBridgeStore();
    const first = await submit(store, { bundle: bundle({ bundle_id: 'bdl-same' }), mode: 'send' });
    const second = await submit(store, { bundle: bundle({ bundle_id: 'bdl-same' }), mode: 'send' });
    expect(first.state).toBe('accepted');
    expect(first.bundle_id).toBe('bdl-same');
    expect(second.idempotent).toBe(true);
    expect(second.state).toBe('accepted');
    expect(second.receipt_id).toBe(first.receipt_id);
    expect((await store.list()).filter((r) => r.bundle_id === 'bdl-same')).toHaveLength(1);
  });

  it('dedupes a bundle across explicit keys and never overwrites the original on key conflict', async () => {
    const store = new InMemoryBridgeStore();
    const first = await submit(store, { idempotency_key: 'k-first', bundle: bundle({ bundle_id: 'bdl-owner' }) });
    const byAnotherKey = await submit(store, {
      idempotency_key: 'k-second',
      bundle: bundle({ bundle_id: 'bdl-owner' }),
    });
    expect(byAnotherKey.idempotent).toBe(true);
    expect(byAnotherKey.receipt_id).toBe(first.receipt_id);

    const conflict = await submit(store, {
      idempotency_key: 'k-first',
      bundle: bundle({ bundle_id: 'bdl-other' }),
    });
    expect(conflict.state).toBe('rejected');
    expect(conflict.reason).toBe('idempotency_key_conflict');
    const repeatedConflict = await submit(store, {
      idempotency_key: 'k-first',
      bundle: bundle({ bundle_id: 'bdl-other' }),
    });
    expect(repeatedConflict.idempotent).toBe(true);
    expect((await store.get('bdl-owner'))?.receipt_id).toBe(first.receipt_id);
    expect((await store.get('bdl-other'))?.receipt_id).toBe(conflict.receipt_id);
    expect((await store.list()).map((receipt) => receipt.bundle_id)).toEqual(['bdl-owner', 'bdl-other']);
  });

  it('a distinct bundle under an idempotency key conflict is refused, not overwritten', async () => {
    const store = new InMemoryBridgeStore();
    await submit(store, { idempotency_key: 'k1', bundle: bundle({ bundle_id: 'bdl-a' }) });
    const second = await submit(store, { idempotency_key: 'k1', bundle: bundle({ bundle_id: 'bdl-b' }) });
    expect(second.state).toBe('rejected');
    expect(second.reason).toBe('idempotency_key_conflict');
  });

  it('run-active queueing: mode queue and a queued delivery stage as queued', async () => {
    const store = new InMemoryBridgeStore();
    const queued = await submit(store, { mode: 'queue' });
    expect(queued.state).toBe('queued');
    const byDelivery = await submit(store, { bundle: bundle({ bundle_id: 'bdl-q', delivery: 'queued' }) });
    expect(byDelivery.state).toBe('queued');
  });

  it('confirmation/resume: confirm -> needs_confirm -> ack -> acknowledged; queue -> resume -> acknowledged', async () => {
    const store = new InMemoryBridgeStore();
    const confirm = await submit(store, { bundle: bundle({ bundle_id: 'bdl-c' }), mode: 'confirm' });
    expect(confirm.state).toBe('needs_confirm');
    const acked = await store.ack('bdl-c');
    expect(acked.state).toBe('acknowledged');

    const queued = await submit(store, { bundle: bundle({ bundle_id: 'bdl-r' }), mode: 'queue' });
    expect(queued.state).toBe('queued');
    const resumed = await store.resume('bdl-r');
    expect(resumed.state).toBe('acknowledged');
  });

  it('completion: an acknowledged receipt can complete; a fresh one cannot jump ahead', async () => {
    const store = new InMemoryBridgeStore();
    await submit(store, { bundle: bundle({ bundle_id: 'bdl-x' }), mode: 'send' });
    await store.ack('bdl-x');
    const done = await store.complete('bdl-x');
    expect(done.state).toBe('completed');
    expect((await store.complete('bdl-x')).idempotent).toBe(true);
    await submit(store, { bundle: bundle({ bundle_id: 'bdl-y' }), mode: 'send' });
    await expect(store.complete('bdl-y')).rejects.toThrow(BridgeError);
  });

  it('stale revision rejection: a bundle older than the accepted high-water revision is refused', async () => {
    const store = new InMemoryBridgeStore();
    const r5 = await submit(store, { bundle: bundle({ bundle_id: 'bdl-hi', revision: 5 }) });
    expect(r5.state).toBe('accepted');
    const stale = await submit(store, { bundle: bundle({ bundle_id: 'bdl-lo', revision: 3 }) });
    expect(stale.state).toBe('rejected');
    expect(stale.reason).toBe('stale_revision');
  });

  it('different artifacts are tracked independently (no cross-artifact staleness)', async () => {
    const store = new InMemoryBridgeStore();
    await submit(store, { bundle: bundle({ bundle_id: 'bdl-a1', artifact_id: 'lesson-report', revision: 9 }) });
    const other = await submit(store, { bundle: bundle({ bundle_id: 'bdl-a2', artifact_id: 'grades', revision: 1 }) });
    expect(other.state).toBe('accepted');
  });

  it('ttl expiry: staged receipts whose confirmation window elapsed expire', async () => {
    let now = '2050-08-26T00:00:00.000Z';
    const store = new InMemoryBridgeStore({ now: () => now });
    await submit(store, { bundle: bundle({ bundle_id: 'bdl-e', revision: 7 }), ttl_ms: 5000 });
    // advance past TTL
    now = '2050-08-26T00:00:20.000Z';
    const expired = store.expireNow();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.state).toBe('expired');
    expect(expired[0]!.reason).toBe('ttl');
  });

  it('safety gate: a send hint cannot bypass a high-risk or incomplete assessment', async () => {
    const store = new InMemoryBridgeStore();
    const receipt = await submit(store, {
      bundle: bundle({
        bundle_id: 'bdl-risk',
        decision: 'send',
        delivery: 'sent',
        assessment: {
          intent_kind: 'destructive',
          confidence: 0.99,
          risk: 'high',
          rationale: ['delete intent'],
          complete: true,
        },
      }),
      mode: 'send',
    });
    expect(receipt.state).toBe('needs_confirm');
  });

  it('initialStateForDelivery maps delivery + mode hints to stable receipt states', () => {
    expect(initialStateForDelivery('sent')).toBe('accepted');
    expect(initialStateForDelivery('queued')).toBe('queued');
    expect(initialStateForDelivery('needs_confirm')).toBe('needs_confirm');
    expect(initialStateForDelivery('suggested')).toBe('needs_confirm');
    expect(initialStateForDelivery('collecting')).toBe('queued');
    expect(initialStateForDelivery('sent', 'confirm')).toBe('needs_confirm');
    expect(initialStateForDelivery('sent', 'queue')).toBe('queued');
  });

  it('hasMinimalBundle guards malformed payloads', () => {
    expect(hasMinimalBundle(bundle())).toBe(true);
    expect(hasMinimalBundle({})).toBe(false);
    expect(hasMinimalBundle(null)).toBe(false);
    expect(hasMinimalBundle({ ...bundle(), revision: 'one' })).toBe(false);
    expect(hasMinimalBundle({ ...bundle(), selections: 'nope' })).toBe(false);
    expect(hasMinimalBundle({ ...bundle(), assessment: { ...bundle().assessment, confidence: Number.NaN } })).toBe(false);
    expect(hasMinimalBundle({ ...bundle(), decision: 'unknown' })).toBe(false);
    expect(
      hasMinimalBundle({
        ...bundle(),
        selections: [{ ...bundle().selections[0]!, artifact_id: 'other-artifact' }],
      }),
    ).toBe(false);
  });

  it('a missing bundle for ack/complete raises a BridgeError with a stable code', async () => {
    const store = new InMemoryBridgeStore();
    await expect(store.ack('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(store.get('nope')).resolves.toBeUndefined();
  });

  it('repeating ack/reject is safe for a retrying receiver', async () => {
    const store = new InMemoryBridgeStore();
    await submit(store, { bundle: bundle({ bundle_id: 'bdl-retry' }), mode: 'confirm' });
    expect((await store.ack('bdl-retry')).state).toBe('acknowledged');
    expect((await store.ack('bdl-retry')).idempotent).toBe(true);

    await submit(store, { bundle: bundle({ bundle_id: 'bdl-reject-retry' }), mode: 'confirm' });
    expect((await store.reject('bdl-reject-retry', 'policy')).state).toBe('rejected');
    expect((await store.reject('bdl-reject-retry', 'policy')).idempotent).toBe(true);
  });

  it('receipts carry the versioned protocol marker', async () => {
    const store = new InMemoryBridgeStore();
    const receipt = await submit(store);
    expect(receipt.protocol_version).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(receipt.receipt_id).toBeTruthy();
  });
});

describe('snapshot/restore seam (pure data, fs-free)', () => {
  it('round-trips receipts, key bindings, conflicts, and revision bounds', async () => {
    const store = new InMemoryBridgeStore();
    await store.submit({ bundle: bundle({ bundle_id: 'bdl-snap-1', revision: 3 }), idempotency_key: 'key-1' });
    await store.submit({ bundle: bundle({ bundle_id: 'bdl-snap-2', revision: 4 }), mode: 'confirm' });
    await store.ack('bdl-snap-2');
    // An idempotency-key collision populates conflict refusals.
    await store.submit({ bundle: bundle({ bundle_id: 'bdl-snap-other', revision: 3 }), idempotency_key: 'key-1' });

    const snapshot = store.snapshot();
    expect(snapshot.format_version).toBe(BRIDGE_STORE_SNAPSHOT_VERSION);

    const revived = new InMemoryBridgeStore();
    revived.restore(snapshot);
    expect(revived.snapshot().stores).toEqual(snapshot.stores);

    expect((await revived.get('bdl-snap-1'))?.state).toBe('accepted');
    expect((await revived.get('bdl-snap-2'))?.state).toBe('acknowledged');

    // Idempotent replay and conflict refusal stay deterministic after restore.
    const replay = await revived.submit({ bundle: bundle({ bundle_id: 'bdl-snap-1', revision: 3 }), idempotency_key: 'key-1' });
    expect(replay.idempotent).toBe(true);
    const conflict = await revived.submit({ bundle: bundle({ bundle_id: 'bdl-snap-other', revision: 3 }), idempotency_key: 'key-1' });
    expect(conflict.state).toBe('rejected');
    expect(conflict.idempotent).toBe(true);

    // Revision high-water mark survives: an older bundle is still refused.
    const stale = await revived.submit({ bundle: bundle({ bundle_id: 'bdl-snap-stale', revision: 1 }) });
    expect(stale.state).toBe('rejected');
    expect(stale.reason).toBe('stale_revision');
  });

  it('restore rejects malformed or unsupported snapshots without mutating the store', () => {
    const store = new InMemoryBridgeStore();
    const bad = (value: unknown) => () => store.restore(value as BridgeStoreSnapshot);
    const receiptShape = { format_version: 1, stores: [{ request: { bundle: {} }, receipt: {} }], artifact_revision: {}, idempotency: {}, conflict_receipts: {} };
    expect(bad({ format_version: 999 })).toThrow(BridgeStoreSnapshotError);
    expect(bad({ format_version: 1, stores: 'nope' })).toThrow(BridgeStoreSnapshotError);
    expect(bad(receiptShape)).toThrow(BridgeStoreSnapshotError);
    // The store is untouched after a refused restore.
    expect(store.snapshot().stores).toHaveLength(0);
  });

  it('restores a collision refusal on an artifact with no accepted high-water mark', async () => {
    const store = new InMemoryBridgeStore();
    await store.submit({ bundle: bundle({ bundle_id: 'bdl-owner-a', artifact_id: 'artifact-a', revision: 4 }), idempotency_key: 'shared-key' });
    const refused = await store.submit({ bundle: bundle({ bundle_id: 'bdl-refused-b', artifact_id: 'artifact-b', revision: 1 }), idempotency_key: 'shared-key' });
    expect(refused.reason).toBe('idempotency_key_conflict');

    const restored = new InMemoryBridgeStore();
    restored.restore(store.snapshot());
    expect((await restored.get('bdl-refused-b'))?.state).toBe('rejected');
    expect((await restored.submit({ bundle: bundle({ bundle_id: 'bdl-new-b', artifact_id: 'artifact-b', revision: 0 }) })).state).toBe('accepted');
  });
});

describe('BridgeClient session transport option', () => {
  it('passes credentials: include to ordinary requests when cookie auth is used', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const client = new BridgeClient({
      baseURL: 'http://bridge.example',
      credentials: 'include',
      fetchImpl: async (_input, init) => {
        calls.push({ init });
        return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
      },
    });
    await expect(client.list()).resolves.toEqual([]);
    expect(calls[0]?.init?.credentials).toBe('include');
  });

  it('uses an Artifact-Session header and keeps an optional pairing token separate', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const client = new BridgeClient({
      baseURL: 'http://bridge.example',
      sessionToken: 'opaque-session',
      token: 'pairing-token',
      fetchImpl: async (_input, init) => {
        calls.push({ init });
        return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
      },
    });
    await client.list();
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Artifact-Session opaque-session',
      'X-Bridge-Token': 'pairing-token',
    });
  });
});
