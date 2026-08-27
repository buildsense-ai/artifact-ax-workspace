import { describe, expect, it } from 'vitest';
import { AuthError } from '@artifact-ax/auth';
import { CatsCoIntrospectionClient, createCatsCoAuthAdapter } from '../src/catsco-auth.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CatsCo transitional identity adapter', () => {
  it('calls account-center introspection with a server-only Service Token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new CatsCoIntrospectionClient({
      account_url: 'https://cats.example/',
      service_token: 'service-token-kept-on-server',
      fetch_impl: async (url, init) => {
        calls.push({ url: String(url), init });
        return response({ active: true, user: { uid: 27, state: 0, account_type: 'human' } });
      },
    });
    const result = await client.introspect('user-jwt-never-persisted');
    expect(result.active).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://cats.example/api/account/introspect');
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Service service-token-kept-on-server',
      'Content-Type': 'application/json',
    });
    expect(JSON.stringify(calls[0]?.init?.headers)).not.toContain('user-jwt-never-persisted');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ token: 'user-jwt-never-persisted' }));
  });

  it('contains upstream failures and malformed responses', async () => {
    const unavailable = new CatsCoIntrospectionClient({
      account_url: 'http://127.0.0.1:1',
      service_token: 'service-token',
      fetch_impl: async () => response({ error: 'bad service token' }, 401),
    });
    await expect(unavailable.introspect('jwt')).rejects.toMatchObject({ code: 'identity_provider_error', status: 503 });

    const malformed = new CatsCoIntrospectionClient({
      account_url: 'https://cats.example',
      service_token: 'service-token',
      fetch_impl: async () => new Response('not-json', { status: 200 }),
    });
    await expect(malformed.introspect('jwt')).rejects.toMatchObject({ code: 'provider_response_invalid', status: 502 });
  });

  it('issues a short-lived Artifact session without retaining the CatsCo JWT', async () => {
    const auth = createCatsCoAuthAdapter({
      account_url: 'https://cats.example',
      service_token: 'service-token',
      session_ttl_ms: 60_000,
      scopes: ['artifact:read'],
      fetch_impl: async () =>
        response({
          active: true,
          user: { uid: 42, state: 0, account_type: 'bot', username: 'builder-bot' },
          claims: { sub: 'catsco:bot:42' },
        }),
    });
    const result = await auth.exchange('jwt-secret');
    expect(result.principal).toMatchObject({ actor_id: 'catsco:bot:42', actor_type: 'agent', scopes: ['artifact:read'] });
    expect(JSON.stringify(result.session)).not.toContain('jwt-secret');
    await expect(auth.resolve(result.session.session_id)).resolves.toMatchObject({
      principal: { actor_id: 'catsco:bot:42' },
    });
  });

  it('passes the optional principal revalidator through without retaining provider credentials', async () => {
    let checks = 0;
    const auth = createCatsCoAuthAdapter({
      account_url: 'https://cats.example',
      service_token: 'service-token',
      session_ttl_ms: 60_000,
      revalidate_interval_ms: 1_000,
      revalidate_principal: (principal) => {
        checks += 1;
        return principal.uid === 42;
      },
      fetch_impl: async () => response({ active: true, user: { uid: 42, state: 0, account_type: 'human' } }),
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    });
    const result = await auth.exchange('jwt-secret');
    await expect(auth.resolve(result.session.session_id)).resolves.toBeDefined();
    expect(checks).toBe(0);
    expect(JSON.stringify(result.session)).not.toContain('jwt-secret');
  });

  it('uses the documented account lookup to revoke a disabled account without retaining its JWT', async () => {
    let clock = new Date('2026-08-27T00:00:00.000Z');
    let enabled = true;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const auth = createCatsCoAuthAdapter({
      account_url: 'https://cats.example',
      service_token: 'service-token',
      session_ttl_ms: 60_000,
      revalidate_interval_ms: 1_000,
      now: () => new Date(clock),
      fetch_impl: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/api/account/introspect')) {
          return response({ active: true, user: { uid: 42, state: 0, account_type: 'human' } });
        }
        return response({ uid: 42, state: enabled ? 0 : 1, account_type: 'human' });
      },
    });
    const result = await auth.exchange('jwt-secret');
    expect(JSON.stringify(result.session)).not.toContain('jwt-secret');
    clock = new Date('2026-08-27T00:00:01.001Z');
    enabled = false;
    await expect(auth.resolve(result.session.session_id)).resolves.toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      'https://cats.example/api/account/introspect',
      'https://cats.example/api/account/users/42',
    ]);
    expect(calls[1]?.init).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Service service-token', Accept: 'application/json' },
    });
    expect(calls[1]?.init?.body).toBeUndefined();
  });

  it('grants only the read scope when a host does not provide a scope list', async () => {
    const auth = createCatsCoAuthAdapter({
      account_url: 'https://cats.example',
      service_token: 'server-only-service-token',
      fetch_impl: async () => new Response(JSON.stringify({ active: true, user: { uid: 43, state: 0 } }), { status: 200 }),
    });
    await expect(auth.exchange('jwt')).resolves.toMatchObject({
      principal: { scopes: ['artifact:read'] },
    });
  });

  it('rejects unsafe adapter configuration before serving requests', () => {
    expect(
      () =>
        new CatsCoIntrospectionClient({
          account_url: 'https://cats.example?token=leak',
          service_token: 'service-token',
        }),
    ).toThrowError(AuthError);
  });
});
