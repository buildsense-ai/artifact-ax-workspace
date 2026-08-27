import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient, type ContextBundle } from '@artifact-ax/trigger';
import { ArtifactBridgeServer } from '../src/server.js';
import { BridgeStoreFileError, JsonFileBridgeStore } from '../src/json-file-store.js';

function bundle(bundleId: string, over: Partial<ContextBundle> = {}): ContextBundle {
  const artifactId = over.artifact_id ?? 'lesson-report';
  const bundleRevision = over.revision ?? 1;
  return {
    contract_version: 'trigger.context-bundle.v1',
    bundle_id: bundleId,
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

async function tempStoreFile(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-bridge-store-'));
  return { dir, file: join(dir, 'store.json') };
}

describe('JsonFileBridgeStore (durable, atomic JSON file)', () => {
  it('restart recovery: a submitted bundle survives a new store over the same file', async () => {
    const { file } = await tempStoreFile();
    const first = await JsonFileBridgeStore.open(file);
    const receipt = await first.submit({ bundle: bundle('bdl-restart', { revision: 5 }) });
    expect(receipt.state).toBe('accepted');

    // submit awaited its durable write — no flush needed before "restart".
    const second = await JsonFileBridgeStore.open(file);
    const recovered = await second.get('bdl-restart');
    expect(recovered?.receipt_id).toBe(receipt.receipt_id);
    expect(recovered?.state).toBe('accepted');
    expect(recovered?.created_at).toBe(receipt.created_at);
    const payload = await second.getBundle('bdl-restart');
    expect(payload?.selections[0]?.node_id).toBe('r-1');
  });

  it('idempotent replay and stale-revision rejection survive restart', async () => {
    const { file } = await tempStoreFile();
    const a = await JsonFileBridgeStore.open(file);
    const first = await a.submit({ bundle: bundle('bdl-i', { revision: 3 }) });
    const replay = await a.submit({ bundle: bundle('bdl-i', { revision: 3 }) });
    expect(replay.idempotent).toBe(true);
    expect(replay.receipt_id).toBe(first.receipt_id);
    const stale = await a.submit({ bundle: bundle('bdl-stale-1', { revision: 1 }) });
    expect(stale.state).toBe('rejected');
    expect(stale.reason).toBe('stale_revision');

    const b = await JsonFileBridgeStore.open(file);
    const replayAfter = await b.submit({ bundle: bundle('bdl-i', { revision: 3 }) });
    expect(replayAfter.idempotent).toBe(true);
    expect(replayAfter.receipt_id).toBe(first.receipt_id);
    const staleAfter = await b.submit({ bundle: bundle('bdl-stale-2', { revision: 2 }) });
    expect(staleAfter.state).toBe('rejected');
    expect(staleAfter.reason).toBe('stale_revision');
  });

  it('state transitions, replay, and conflicts stay stable across restart', async () => {
    const { file } = await tempStoreFile();
    const a = await JsonFileBridgeStore.open(file);
    await a.submit({ bundle: bundle('bdl-t', { revision: 7 }), mode: 'queue' });
    const resumed = await a.resume('bdl-t');
    expect(resumed.state).toBe('acknowledged');
    const done = await a.complete('bdl-t');
    expect(done.state).toBe('completed');
    expect((await a.complete('bdl-t')).idempotent).toBe(true);

    await a.submit({ bundle: bundle('bdl-t2', { revision: 8 }) });
    const rejected = await a.reject('bdl-t2', 'no longer needed');
    expect(rejected.state).toBe('rejected');
    expect(rejected.reason).toBe('no longer needed');

    const b = await JsonFileBridgeStore.open(file);
    expect((await b.get('bdl-t'))?.state).toBe('completed');
    // Repeating the same transition is an idempotent replay, not a conflict.
    expect((await b.complete('bdl-t')).idempotent).toBe(true);
    // A transition outside the allowed edges is still refused after restart.
    await expect(b.ack('bdl-t')).rejects.toMatchObject({ code: 'state_conflict' });
    expect((await b.get('bdl-t2'))?.state).toBe('rejected');
    expect((await b.reject('bdl-t2', 'no longer needed')).idempotent).toBe(true);
  });

  it('concurrent submits serialize durably: all land on disk without a flush', async () => {
    const { file } = await tempStoreFile();
    const store = await JsonFileBridgeStore.open(file);
    const receipts = await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.submit({ bundle: bundle(`bdl-c-${i}`, { revision: i }) })),
    );
    expect(receipts).toHaveLength(25);
    expect(receipts.every((receipt) => receipt.state === 'accepted')).toBe(true);

    const reopened = await JsonFileBridgeStore.open(file);
    const all = await reopened.list();
    expect(all).toHaveLength(25);
    for (const receipt of all) expect(receipt.state).toBe('accepted');
    // High-water bookkeeping survived: a replay is still idempotent.
    const replay = await reopened.submit({ bundle: bundle('bdl-c-0', { revision: 0 }) });
    expect(replay.idempotent).toBe(true);
  });

  it('concurrent state mutations on distinct bundles serialize without lost updates', async () => {
    const { file } = await tempStoreFile();
    const store = await JsonFileBridgeStore.open(file);
    await Promise.all([
      store.submit({ bundle: bundle('bdl-m1', { revision: 1 }), mode: 'confirm' }),
      store.submit({ bundle: bundle('bdl-m2', { revision: 2 }), mode: 'confirm' }),
    ]);
    await Promise.all([store.ack('bdl-m1'), store.ack('bdl-m2')]);

    const reopened = await JsonFileBridgeStore.open(file);
    expect((await reopened.get('bdl-m1'))?.state).toBe('acknowledged');
    expect((await reopened.get('bdl-m2'))?.state).toBe('acknowledged');
  });

  it('TTL expiry is persisted before expireNow resolves', async () => {
    const { file } = await tempStoreFile();
    let now = '2050-01-01T00:00:00.000Z';
    const store = await JsonFileBridgeStore.open(file, { now: () => now });
    await store.submit({ bundle: bundle('bdl-exp', { revision: 1 }), ttl_ms: 1000, mode: 'confirm' });
    now = '2050-01-01T00:00:02.000Z';
    const expired = await store.expireNow();
    expect(expired.map((receipt) => receipt.bundle_id)).toContain('bdl-exp');

    const reopened = await JsonFileBridgeStore.open(file);
    expect((await reopened.get('bdl-exp'))?.state).toBe('expired');
  });

  it('corrupt store files fail explicitly instead of being silently wiped', async () => {
    const { dir } = await tempStoreFile();

    const garbage = join(dir, 'garbage.json');
    await writeFile(garbage, 'this is not json {', 'utf8');
    await expect(JsonFileBridgeStore.open(garbage)).rejects.toBeInstanceOf(BridgeStoreFileError);

    const emptyFile = join(dir, 'empty.json');
    await writeFile(emptyFile, '', 'utf8');
    await expect(JsonFileBridgeStore.open(emptyFile)).rejects.toBeInstanceOf(BridgeStoreFileError);

    const badVersion = join(dir, 'bad-version.json');
    await writeFile(
      badVersion,
      JSON.stringify({ format_version: 999, stores: [], artifact_revision: {}, idempotency: {}, conflict_receipts: {} }),
      'utf8',
    );
    await expect(JsonFileBridgeStore.open(badVersion)).rejects.toBeInstanceOf(BridgeStoreFileError);

    const badEntry = join(dir, 'bad-entry.json');
    await writeFile(
      badEntry,
      JSON.stringify({ format_version: 1, stores: [{ request: {}, receipt: {} }], artifact_revision: {}, idempotency: {}, conflict_receipts: {} }),
      'utf8',
    );
    const error = await JsonFileBridgeStore.open(badEntry).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(BridgeStoreFileError);
    if (error instanceof BridgeStoreFileError) expect(error.path).toBe(badEntry);

    // A corrupt file never wiped a good file: the store file itself is intact
    // and no temp garbage was promoted.
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toHaveLength(0);
  });

  it('a missing store file starts an empty store (first run)', async () => {
    const { dir } = await tempStoreFile();
    const file = join(dir, 'nested', 'brand-new.json');
    const store = await JsonFileBridgeStore.open(file);
    expect(await store.list()).toHaveLength(0);
    const receipt = await store.submit({ bundle: bundle('bdl-first', { revision: 1 }) });
    expect(receipt.state).toBe('accepted');
    const reopened = await JsonFileBridgeStore.open(file);
    await expect(reopened.get('bdl-first')).resolves.toBeDefined();
  });

  it('server keeps receipts across restart when backed by the durable store', async () => {
    const { file } = await tempStoreFile();
    const token = 'durable-store-test-token';

    const storeOne = await JsonFileBridgeStore.open(file);
    const serverOne = new ArtifactBridgeServer({ store: storeOne, token });
    await serverOne.listen(0);
    const clientOne = new BridgeClient({ baseURL: `http://127.0.0.1:${serverOne.address()!.port}`, token });
    const receipt = await clientOne.submit({ bundle: bundle('bdl-http-durable', { revision: 11 }) });
    expect(receipt.state).toBe('accepted');
    await serverOne.close();

    const storeTwo = await JsonFileBridgeStore.open(file);
    const serverTwo = new ArtifactBridgeServer({ store: storeTwo, token });
    await serverTwo.listen(0);
    const clientTwo = new BridgeClient({ baseURL: `http://127.0.0.1:${serverTwo.address()!.port}`, token });
    const recovered = await clientTwo.get('bdl-http-durable');
    expect(recovered?.receipt_id).toBe(receipt.receipt_id);
    expect(recovered?.state).toBe('accepted');
    await serverTwo.close();
  });
});
