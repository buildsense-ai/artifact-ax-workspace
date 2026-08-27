import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  AG_UI_BRIDGE_CONTEXT_EVENT,
  AG_UI_BRIDGE_RECEIPT_EVENT,
  BridgeClient,
  BridgeOutbox,
  InMemoryBridgeStore,
  type BridgeReceipt,
  type BridgeReceiptState,
  type BridgeStore,
  type BridgeSubmitRequest,
  type ContextBundle,
} from '@artifact-ax/trigger';
import { createCatsCoAuthAdapter } from '../src/catsco-auth.js';
import { ArtifactBridgeServer } from '../src/server.js';

const TOKEN = 'artifact-bridge-local-pairing-token-0123456789';

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

/** Store seam used to prove actor filtering fails closed on a transient lookup error. */
class FlakyContextStore implements BridgeStore {
  readonly inner = new InMemoryBridgeStore();
  failContextLookups = false;

  submit(request: BridgeSubmitRequest): Promise<BridgeReceipt> {
    return this.inner.submit(request);
  }

  get(bundleId: string): Promise<BridgeReceipt | undefined> {
    return this.inner.get(bundleId);
  }

  async getBundle(bundleId: string): Promise<ContextBundle | undefined> {
    if (this.failContextLookups) throw new Error('temporary context store failure');
    return this.inner.getBundle(bundleId);
  }

  list(state?: BridgeReceiptState): Promise<BridgeReceipt[]> {
    return this.inner.list(state);
  }

  ack(bundleId: string): Promise<BridgeReceipt> {
    return this.inner.ack(bundleId);
  }

  resume(bundleId: string): Promise<BridgeReceipt> {
    return this.inner.resume(bundleId);
  }

  complete(bundleId: string): Promise<BridgeReceipt> {
    return this.inner.complete(bundleId);
  }

  reject(bundleId: string, reason: string): Promise<BridgeReceipt> {
    return this.inner.reject(bundleId, reason);
  }
}

describe('artifact bridge server (loopback HTTP) + BridgeOutbox', () => {
  let server: ArtifactBridgeServer;
  let store: InMemoryBridgeStore;
  let base: string;
  let client: BridgeClient;

  beforeAll(async () => {
    store = new InMemoryBridgeStore();
    server = new ArtifactBridgeServer({ store, token: TOKEN });
    await server.listen(0);
    base = `http://127.0.0.1:${server.address()!.port}`;
    client = new BridgeClient({ baseURL: base, token: TOKEN });
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejects missing/wrong pairing token with 401 and allows it with the token', async () => {
    const unauth = new BridgeClient({ baseURL: base, token: 'wrong' });
    await expect(unauth.submit({ bundle: bundle('bdl-auth') })).rejects.toMatchObject({ code: 'unauthorized' });
    const ok = new BridgeClient({ baseURL: base, token: TOKEN });
    const receipt = await ok.submit({ bundle: bundle('bdl-auth2') });
    expect(receipt.state).toBe('accepted');
    await expect(ok.get('bdl-does-not-exist')).resolves.toBeUndefined();
  });

  it('only grants CORS to configured local origins', async () => {
    const allowed = await fetch(`${base}/v1/health`, { headers: { Origin: 'http://127.0.0.1:5173' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    const denied = await fetch(`${base}/v1/health`, { headers: { Origin: 'https://untrusted.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('exactly-once over HTTP: replaying the same bundle is idempotent', async () => {
    const first = await client.submit({ bundle: bundle('bdl-http-once') });
    const second = await client.submit({ bundle: bundle('bdl-http-once') });
    expect(first.state).toBe('accepted');
    expect(second.idempotent).toBe(true);
    expect(second.receipt_id).toBe(first.receipt_id);
    const full = await client.getBundle('bdl-http-once');
    expect(full?.selections[0]?.node_id).toBe('r-1');
  });

  it('run-active queueing over HTTP: mode queue stages as queued', async () => {
    const queued = await client.submit({ bundle: bundle('bdl-http-q'), mode: 'queue' });
    expect(queued.state).toBe('queued');
  });

  it('confirmation/resume over HTTP: confirm -> ack -> acknowledged; queue -> resume', async () => {
    await client.submit({ bundle: bundle('bdl-http-c'), mode: 'confirm' });
    const acked = await client.ack('bdl-http-c');
    expect(acked.state).toBe('acknowledged');

    await client.submit({ bundle: bundle('bdl-http-r'), mode: 'queue' });
    const resumed = await client.resume('bdl-http-r');
    expect(resumed.state).toBe('acknowledged');
    const done = await client.complete('bdl-http-r');
    expect(done.state).toBe('completed');
  });

  it('stale revision rejection over HTTP', async () => {
    expect((await client.submit({ bundle: bundle('bdl-http-hi', { revision: 9 }) })).state).toBe('accepted');
    const stale = await client.submit({ bundle: bundle('bdl-http-lo', { revision: 2 }) });
    expect(stale.state).toBe('rejected');
    expect(stale.reason).toBe('stale_revision');
  });

  it('malformed payload is refused with 400 invalid_request', async () => {
    const bad = new BridgeClient({ baseURL: base, token: TOKEN });
    await expect(
      bad.submit({ bundle: { bundle_id: 'x' } as never }),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    await expect(
      bad.submit({ bundle: bundle('bdl-bad-mode'), mode: 'oops' as never }),
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('status requests opportunistically expire staged receipts', async () => {
    let now = '2050-08-26T00:00:00.000Z';
    const expiringStore = new InMemoryBridgeStore({ now: () => now });
    const expiringServer = new ArtifactBridgeServer({ store: expiringStore, token: TOKEN });
    await expiringServer.listen(0);
    const expiringBase = `http://127.0.0.1:${expiringServer.address()!.port}`;
    const expiringClient = new BridgeClient({ baseURL: expiringBase, token: TOKEN });
    await expiringClient.submit({ bundle: bundle('bdl-expire-http'), ttl_ms: 1000, mode: 'confirm' });
    now = '2050-08-26T00:00:02.000Z';
    const receipts = await expiringClient.list();
    expect(receipts.find((receipt) => receipt.bundle_id === 'bdl-expire-http')?.state).toBe('expired');
    await expiringServer.close();
  });

  it('BridgeOutbox delivers a bundle through the bridge and returns a receipt', async () => {
    const outbox = new BridgeOutbox({ client });
    const receipt = await outbox.send(bundle('bdl-outbox-1', { revision: 20 }));
    expect(receipt.ok).toBe(true);
    expect(receipt.kind).toBe('accepted');
    expect(receipt.receipt_id).toBeTruthy();
    expect(receipt.bridged_state).toBe('accepted');
    expect(outbox.label).toContain('bridge outbox');
    // Does not look like a CatsCo chat send.
    expect(outbox.label.toLowerCase()).not.toContain('catsco');
  });

  it('BridgeOutbox reports an unsuccessful receipt when the bridge is unreachable', async () => {
    const dead = new BridgeClient({ baseURL: 'http://127.0.0.1:1', token: TOKEN });
    const outbox = new BridgeOutbox({ client: dead });
    const receipt = await outbox.send(bundle('bdl-outbox-dead'));
    expect(receipt.ok).toBe(false);
    expect(receipt.kind).toBe('rejected');
  });

  it('watch replays snapshot history on (re)connect and streams new receipts', async () => {
    // Seed two receipts before watching.
    await client.submit({ bundle: bundle('bdl-watch-1', { revision: 30 }) });
    await client.submit({ bundle: bundle('bdl-watch-2', { revision: 31 }) });

    const seen: string[] = [];
    const watcher = (async () => {
      for await (const envelope of client.watch()) {
        if (envelope.kind === 'receipt') seen.push(envelope.receipt.bundle_id);
        else break;
      }
    })();

    // Give the SSE stream a moment to connect, then submit a new bundle.
    await new Promise((r) => setTimeout(r, 150));
    await client.submit({ bundle: bundle('bdl-watch-3', { revision: 32 }) });

    // The client stream stays open; poll briefly to let events arrive.
    await new Promise((r) => setTimeout(r, 150));

    // The reconnect replay + the live event are all visible.
    expect(seen).toContain('bdl-watch-1');
    expect(seen).toContain('bdl-watch-2');
    expect(seen).toContain('bdl-watch-3');
    void watcher;
  }, 10_000);

  it('health reports the protocol version', async () => {
    const response = await fetch(`${base}/v1/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { protocol: string; ag_ui_projection: { path: string; custom_events: string[] } };
    expect(body.protocol).toBe('artifact.ax.bridge.v1');
    expect(body.ag_ui_projection.path).toBe('/v1/ag-ui/watch');
    expect(body.ag_ui_projection.custom_events).toContain(AG_UI_BRIDGE_RECEIPT_EVENT);
  });

  it('projects bridge receipts as AG-UI lifecycle + custom events without chat text', async () => {
    const submitted = await client.submit({ bundle: bundle('bdl-ag-ui-http', { revision: 100 }) });
    expect(submitted.state).toBe('accepted');

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const envelope of client.watchAgUi({ bundleId: 'bdl-ag-ui-http', timeoutMs: 500 })) {
      if (envelope.kind === 'event') events.push(envelope.event);
    }
    expect(events.map((event) => event.type)).toEqual(['RUN_STARTED', 'CUSTOM']);
    expect(events[0]).toMatchObject({ threadId: 'topic_demo', runId: 'bdl-ag-ui-http' });
    expect(events[1]).toMatchObject({ type: 'CUSTOM', name: AG_UI_BRIDGE_RECEIPT_EVENT });
    expect(events[1]).toMatchObject({ value: { selection_refs: [{ region_id: 'review-table', node_id: 'r-1' }] } });
    expect(events.some((event) => event.type.startsWith('TEXT_MESSAGE'))).toBe(false);

    const withContext: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const envelope of client.watchAgUi({ bundleId: 'bdl-ag-ui-http', includeContext: true, timeoutMs: 500 })) {
      if (envelope.kind === 'event') withContext.push(envelope.event);
    }
    expect(withContext.map((event) => event.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'CUSTOM']);
    expect(withContext[2]).toMatchObject({ type: 'CUSTOM', name: AG_UI_BRIDGE_CONTEXT_EVENT });
    expect(
      ((withContext[2] as { value: { bundle: ContextBundle } }).value.bundle).bundle_id,
    ).toBe('bdl-ag-ui-http');

    await client.ack('bdl-ag-ui-http');
    await client.complete('bdl-ag-ui-http');
    const terminal: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const envelope of client.watchAgUi({ bundleId: 'bdl-ag-ui-http', timeoutMs: 500 })) {
      if (envelope.kind === 'event') terminal.push(envelope.event);
    }
    expect(terminal.map((event) => event.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'RUN_FINISHED']);
    expect(terminal.at(-1)).toMatchObject({
      type: 'RUN_FINISHED',
      result: { bridge_state: 'completed' },
    });
  });

  it('protects the AG-UI projection with the same pairing token and filters by state', async () => {
    const unauthorized = await fetch(`${base}/v1/ag-ui/watch`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${base}/v1/ag-ui/watch?state=not-a-state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('streams receipt transitions live on one AG-UI subscription', async () => {
    await client.submit({ bundle: bundle('bdl-ag-ui-live', { revision: 120 }), mode: 'confirm' });
    const iterator = client.watchAgUi({ bundleId: 'bdl-ag-ui-live', timeoutMs: 2_000 })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'event', event: { type: 'RUN_STARTED' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'event', event: { type: 'CUSTOM' } } });

    await client.ack('bdl-ag-ui-live');
    const acknowledged = await iterator.next();
    expect(acknowledged.value).toMatchObject({ kind: 'event', event: { type: 'CUSTOM' } });
    expect(
      ((acknowledged.value as { event: { value: { receipt: { state: string } } } }).event.value.receipt.state),
    ).toBe('acknowledged');

    await client.complete('bdl-ag-ui-live');
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'event', event: { type: 'CUSTOM' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'event', event: { type: 'RUN_FINISHED' } } });
    await iterator.return?.();
  });

  it('fails closed for a session AG-UI watcher when ownership lookup fails', async () => {
    const flaky = new FlakyContextStore();
    const authService = createCatsCoAuthAdapter({
      account_url: 'https://cats.example',
      service_token: 'server-only-service-token',
      scopes: ['artifact:read', 'artifact:execute'],
      fetch_impl: async () => new Response(JSON.stringify({ active: true, user: { uid: 27, state: 0 } }), { status: 200 }),
    });
    const authServer = new ArtifactBridgeServer({ token: TOKEN, store: flaky, auth: { service: authService } });
    await authServer.listen(0);
    const authBase = `http://127.0.0.1:${authServer.address()!.port}`;
    const exchanged = await fetch(`${authBase}/v1/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-CatsCo-User-Token': 'active-jwt' },
    });
    const cookie = exchanged.headers.get('set-cookie')!.split(';', 1)[0]!;
    const pairingClient = new BridgeClient({ baseURL: authBase, token: TOKEN });
    await pairingClient.submit({ bundle: bundle('bdl-owned-before-flake', { revision: 1, actor_id: 'catsco:user:27' }) });

    const sessionClient = new BridgeClient({
      baseURL: authBase,
      credentials: 'include',
      fetchImpl: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Cookie: cookie } }),
    });
    const iterator = sessionClient.watchAgUi({ timeoutMs: 450 })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'event', event: { type: 'RUN_STARTED' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: 'event', event: { type: 'CUSTOM' } } });

    flaky.failContextLookups = true;
    await pairingClient.submit({ bundle: bundle('bdl-foreign-after-flake', { revision: 2, actor_id: 'catsco:user:99' }) });
    const afterFailure = await iterator.next();
    expect(afterFailure.value).toMatchObject({ kind: 'done' });
    await iterator.return?.();
    await authServer.close();
  });

  it('returns JSON before opening a session AG-UI stream when the initial ownership snapshot fails', async () => {
    const flaky = new FlakyContextStore();
    const authService = createCatsCoAuthAdapter({
      account_url: 'https://cats.example',
      service_token: 'server-only-service-token',
      fetch_impl: async () => new Response(JSON.stringify({ active: true, user: { uid: 28, state: 0 } }), { status: 200 }),
    });
    const authServer = new ArtifactBridgeServer({ token: TOKEN, store: flaky, auth: { service: authService } });
    await authServer.listen(0);
    try {
      const authBase = `http://127.0.0.1:${authServer.address()!.port}`;
      const exchanged = await fetch(`${authBase}/v1/auth/exchange`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-CatsCo-User-Token': 'active-jwt' },
      });
      const cookie = exchanged.headers.get('set-cookie')!.split(';', 1)[0]!;
      const pairingClient = new BridgeClient({ baseURL: authBase, token: TOKEN });
      await pairingClient.submit({ bundle: bundle('bdl-owned-initial-flake', { revision: 1, actor_id: 'catsco:user:28' }) });

      flaky.failContextLookups = true;
      const response = await fetch(`${authBase}/v1/ag-ui/watch`, {
        headers: { Accept: 'text/event-stream', Cookie: cookie },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'store_unavailable' },
      });
    } finally {
      await authServer.close();
    }
  });
});
