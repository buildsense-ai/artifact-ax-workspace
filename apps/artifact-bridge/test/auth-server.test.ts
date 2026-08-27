import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeClient, type ContextBundle } from '@artifact-ax/trigger';
import { createCatsCoAuthAdapter } from '../src/catsco-auth.js';
import { ArtifactBridgeServer } from '../src/server.js';

const PAIRING_TOKEN = 'auth-server-pairing-token-0123456789';

function bundle(bundleId: string, actorId = 'catsco:user:27', revision = 1): ContextBundle {
  return {
    contract_version: 'trigger.context-bundle.v1',
    bundle_id: bundleId,
    session_id: 'topic_auth',
    actor_id: actorId,
    artifact_id: 'lesson-report',
    revision,
    selections: [
      {
        selection_id: `sel-${bundleId}`,
        artifact_id: 'lesson-report',
        revision,
        region_id: 'review-table',
        node_id: 'r-1',
        label: 'Row r-1',
      },
    ],
    intent: { text: 'review' },
    assessment: { intent_kind: 'review', confidence: 0.9, risk: 'low', rationale: ['read intent'], complete: true },
    decision: 'send',
    delivery: 'sent',
    created_at: '2026-08-27T00:00:00.000Z',
  };
}

function authAdapter() {
  return createCatsCoAuthAdapter({
    account_url: 'https://cats.example',
    service_token: 'server-only-service-token',
    session_ttl_ms: 60_000,
    scopes: ['artifact:read', 'artifact:execute'],
    fetch_impl: async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body)) as { token?: string };
      if (requestBody.token === 'disabled-jwt') {
        return new Response(JSON.stringify({ active: false, error: 'user_not_available' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          active: true,
          user: { uid: 27, username: 'alice', display_name: 'Alice', account_type: 'human', state: 0 },
          claims: { sub: 'catsco:user:27' },
        }),
        { status: 200 },
      );
    },
  });
}

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie');
  expect(value).toBeTruthy();
  return value!.split(';', 1)[0]!;
}

describe('optional CatsCo-backed session auth on the bridge', () => {
  let server: ArtifactBridgeServer;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    server = new ArtifactBridgeServer({
      token: PAIRING_TOKEN,
      auth: { service: authAdapter() },
    });
    await server.listen(0);
    base = `http://127.0.0.1:${server.address()!.port}`;

    const exchanged = await fetch(`${base}/v1/auth/exchange`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAIRING_TOKEN}`,
        'X-CatsCo-User-Token': 'active-jwt',
        Origin: 'http://127.0.0.1:5173',
      },
    });
    expect(exchanged.status).toBe(200);
    cookie = cookieFrom(exchanged);
  });

  afterAll(async () => {
    await server.close();
  });

  it('exchanges a CatsCo JWT server-side and exposes only a public session view', async () => {
    const response = await fetch(`${base}/v1/auth/session`, {
      headers: { Cookie: cookie, Origin: 'http://127.0.0.1:5173' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      protocol_version: 'artifact.ax.auth.v1',
      authenticated: true,
      principal: { actor_id: 'catsco:user:27', uid: 27, actor_type: 'human' },
    });
    expect(JSON.stringify(body)).not.toContain('active-jwt');
    expect(JSON.stringify(body)).not.toContain('server-only-service-token');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('requires the pairing token for the exchange when one is configured', async () => {
    const response = await fetch(`${base}/v1/auth/exchange`, {
      method: 'POST',
      headers: { 'X-CatsCo-User-Token': 'active-jwt' },
    });
    expect(response.status).toBe(401);
  });

  it('allows a session to submit only for its own canonical actor id', async () => {
    const client = new BridgeClient({ baseURL: base, fetchImpl: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Cookie: cookie } }) });
    const accepted = await client.submit({ bundle: bundle('bdl-session-owned') });
    expect(accepted.state).toBe('accepted');

    const wrongActor = await fetch(`${base}/v1/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ bundle: bundle('bdl-session-spoof', 'human_teacher') }),
    });
    expect(wrongActor.status).toBe(403);
    await expect(wrongActor.json()).resolves.toMatchObject({ error: { code: 'actor_mismatch' } });
  });

  it('filters receipts and protects mutations by session actor', async () => {
    const client = new BridgeClient({ baseURL: base, fetchImpl: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers ?? {}), Cookie: cookie } }) });
    await client.submit({ bundle: bundle('bdl-session-visible', 'catsco:user:27', 2) });
    const visible = await client.list();
    expect(visible.some((receipt) => receipt.bundle_id === 'bdl-session-visible')).toBe(true);

    const foreign = await fetch(`${base}/v1/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAIRING_TOKEN}` },
      body: JSON.stringify({ bundle: bundle('bdl-foreign', 'catsco:user:99', 3) }),
    });
    expect(foreign.status).toBe(200);

    const hidden = await fetch(`${base}/v1/bundles/bdl-foreign`, { headers: { Cookie: cookie } });
    expect(hidden.status).toBe(404);
    const forbiddenMutation = await fetch(`${base}/v1/bundles/bdl-foreign/ack`, { method: 'POST', headers: { Cookie: cookie } });
    expect(forbiddenMutation.status).toBe(404);
  });

  it('logout invalidates the opaque session and rejects subsequent bridge calls', async () => {
    const logout = await fetch(`${base}/v1/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    expect(logout.status).toBe(200);
    const after = await fetch(`${base}/v1/auth/session`, { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
    const submit = await fetch(`${base}/v1/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ bundle: bundle('bdl-after-logout') }),
    });
    expect(submit.status).toBe(401);
  });

  it('maps an inactive CatsCo token to a safe 401', async () => {
    const response = await fetch(`${base}/v1/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PAIRING_TOKEN}`, 'X-CatsCo-User-Token': 'disabled-jwt' },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'unauthenticated' } });
  });
});

describe('session-only bridge mode (no pairing token)', () => {
  let server: ArtifactBridgeServer;
  let base: string;
  let sessionToken: string;

  beforeAll(async () => {
    server = new ArtifactBridgeServer({ auth: { service: authAdapter() } });
    await server.listen(0);
    base = `http://127.0.0.1:${server.address()!.port}`;
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    const exchanged = await fetch(`${base}/v1/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: 'Bearer active-jwt' },
    });
    expect(exchanged.status).toBe(200);
    const cookie = cookieFrom(exchanged);
    sessionToken = decodeURIComponent(cookie.split('=', 2)[1]!);
  });

  afterAll(async () => {
    await server.close();
  });

  it('accepts the explicit Artifact-Session bearer form for non-browser agents', async () => {
    const response = await fetch(`${base}/v1/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Artifact-Session ${sessionToken}`,
      },
      body: JSON.stringify({ bundle: bundle('bdl-session-header') }),
    });
    expect(response.status).toBe(200);
  });

  it('fails closed when the session has no configured read scope', async () => {
    const noScopeServer = new ArtifactBridgeServer({
      auth: {
        service: createCatsCoAuthAdapter({
          account_url: 'https://cats.example',
          service_token: 'server-only-service-token',
          scopes: [],
          fetch_impl: async () => new Response(JSON.stringify({ active: true, user: { uid: 27, state: 0 } }), { status: 200 }),
        }),
      },
    });
    await noScopeServer.listen(0);
    const noScopeBase = `http://127.0.0.1:${noScopeServer.address()!.port}`;
    const exchanged = await fetch(`${noScopeBase}/v1/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt' },
    });
    const noScopeCookie = cookieFrom(exchanged);
    const denied = await fetch(`${noScopeBase}/v1/bundles`, { headers: { Cookie: noScopeCookie } });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'scope_denied' } });
    await noScopeServer.close();
  });

  it('keeps read-only sessions from mutating bridge state', async () => {
    const readOnlyServer = new ArtifactBridgeServer({
      auth: {
        service: createCatsCoAuthAdapter({
          account_url: 'https://cats.example',
          service_token: 'server-only-service-token',
          scopes: ['artifact:read'],
          fetch_impl: async () => new Response(JSON.stringify({ active: true, user: { uid: 27, state: 0 } }), { status: 200 }),
        }),
      },
    });
    await readOnlyServer.listen(0);
    const readOnlyBase = `http://127.0.0.1:${readOnlyServer.address()!.port}`;
    const exchanged = await fetch(`${readOnlyBase}/v1/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt' },
    });
    const readOnlyCookie = cookieFrom(exchanged);
    const readable = await fetch(`${readOnlyBase}/v1/bundles`, { headers: { Cookie: readOnlyCookie } });
    expect(readable.status).toBe(200);
    const deniedWrite = await fetch(`${readOnlyBase}/v1/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: readOnlyCookie },
      body: JSON.stringify({ bundle: bundle('bdl-read-only') }),
    });
    expect(deniedWrite.status).toBe(403);
    await expect(deniedWrite.json()).resolves.toMatchObject({ error: { code: 'scope_denied' } });
    await readOnlyServer.close();
  });

  it('rejects an existing session after its configured status revalidator disables the principal', async () => {
    let clock = new Date('2026-08-27T00:00:00.000Z');
    let active = true;
    const revalidatingServer = new ArtifactBridgeServer({
      auth: {
        service: createCatsCoAuthAdapter({
          account_url: 'https://cats.example',
          service_token: 'server-only-service-token',
          scopes: ['artifact:read'],
          revalidate_interval_ms: 1_000,
          revalidate_principal: () => active,
          now: () => new Date(clock),
          fetch_impl: async () => new Response(JSON.stringify({ active: true, user: { uid: 27, state: 0 } }), { status: 200 }),
        }),
      },
    });
    await revalidatingServer.listen(0);
    const revalidatingBase = `http://127.0.0.1:${revalidatingServer.address()!.port}`;
    const exchanged = await fetch(`${revalidatingBase}/v1/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt' },
    });
    const revalidatingCookie = cookieFrom(exchanged);
    expect((await fetch(`${revalidatingBase}/v1/bundles`, { headers: { Cookie: revalidatingCookie } })).status).toBe(200);

    active = false;
    clock = new Date('2026-08-27T00:00:01.001Z');
    expect((await fetch(`${revalidatingBase}/v1/bundles`, { headers: { Cookie: revalidatingCookie } })).status).toBe(401);
    await revalidatingServer.close();
  });

  it('does not expose transitional session auth on a non-loopback bind', () => {
    expect(
      () => new ArtifactBridgeServer({ host: '0.0.0.0', auth: { service: authAdapter() } }),
    ).toThrow(/loopback-only/);
  });
});
