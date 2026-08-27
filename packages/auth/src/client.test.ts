import { describe, expect, it } from 'vitest';
import { ArtifactAuthClient, AuthClientError } from './index.js';

describe('ArtifactAuthClient', () => {
  it('sends the user credential only in the exchange header and includes cookies', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const client = new ArtifactAuthClient({
      baseURL: 'http://127.0.0.1:8788/',
      fetchImpl: async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response(
          JSON.stringify({
            protocol_version: 'artifact.ax.auth.v1',
            authenticated: true,
            principal: { subject: 'catsco:user:27', actor_id: 'catsco:user:27', uid: 27, actor_type: 'human', account_type: 'human', scopes: ['artifact:read'] },
            created_at: '2026-08-27T00:00:00.000Z',
            expires_at: '2026-08-27T00:15:00.000Z',
          }),
          { status: 200 },
        );
      },
    });
    const result = await client.exchange('jwt-value', 'pairing-value');
    expect(result.principal.actor_id).toBe('catsco:user:27');
    expect(calls[0]?.input).toBe('http://127.0.0.1:8788/v1/auth/exchange');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(calls[0]?.init?.headers).toMatchObject({
      'X-CatsCo-User-Token': 'jwt-value',
      Authorization: 'Bearer pairing-value',
    });
  });

  it('treats a 401 current-session response as signed out', async () => {
    const client = new ArtifactAuthClient({
      baseURL: 'http://127.0.0.1:8788',
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no session' } }), { status: 401 }),
    });
    await expect(client.current()).resolves.toBeUndefined();
  });

  it('surfaces malformed or non-401 errors to the host', async () => {
    const badJSON = new ArtifactAuthClient({ baseURL: 'http://auth', fetchImpl: async () => new Response('oops', { status: 500 }) });
    await expect(badJSON.current()).rejects.toMatchObject({ code: 'invalid_response', status: 500 });
    const forbidden = new ArtifactAuthClient({
      baseURL: 'http://auth',
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'scope_denied', message: 'nope' } }), { status: 403 }),
    });
    await expect(forbidden.current()).rejects.toBeInstanceOf(AuthClientError);
  });
});
