import { describe, expect, it } from 'vitest';
import { ArtifactAuthService, AuthError, InMemorySessionStore } from './index.js';
import type { CatsCoIntrospector } from './types.js';

function service(introspector: CatsCoIntrospector, now = new Date('2026-08-27T00:00:00.000Z')) {
  return new ArtifactAuthService({
    introspector,
    sessions: new InMemorySessionStore(),
    session_ttl_ms: 60_000,
    scopes: ['artifact:read', 'artifact:read', ''],
    now: () => new Date(now),
    create_session_id: () => 'axs_test_session',
  });
}

describe('ArtifactAuthService', () => {
  it('exchanges an active CatsCo identity for an opaque short-lived session', async () => {
    let received = '';
    const auth = service({
      introspect: async (token) => {
        received = token;
        return {
          active: true,
          user: { uid: 27, username: 'alice', display_name: 'Alice', account_type: 'human', state: 0 },
          claims: { sub: 'catsco:user:27' },
        };
      },
    });
    const result = await auth.exchange('jwt-secret-value');
    expect(received).toBe('jwt-secret-value');
    expect(result.session).toMatchObject({
      protocol_version: 'artifact.ax.auth.v1',
      session_id: 'axs_test_session',
      created_at: '2026-08-27T00:00:00.000Z',
      expires_at: '2026-08-27T00:01:00.000Z',
    });
    expect(result.principal).toMatchObject({
      subject: 'catsco:user:27',
      actor_id: 'catsco:user:27',
      uid: 27,
      actor_type: 'human',
      scopes: ['artifact:read'],
    });
    // The provider credential does not appear in the session record.
    expect(JSON.stringify(result.session)).not.toContain('jwt-secret-value');
    await expect(auth.resolve('axs_test_session')).resolves.toMatchObject({ session_id: 'axs_test_session' });
  });

  it('rejects inactive and disabled accounts without creating a session', async () => {
    const store = new InMemorySessionStore();
    const inactive = new ArtifactAuthService({
      introspector: { introspect: async () => ({ active: false, error: 'invalid_or_expired_token' }) },
      sessions: store,
      create_session_id: () => 'never',
    });
    await expect(inactive.exchange('jwt')).rejects.toMatchObject({ code: 'unauthenticated', status: 401, reason: 'invalid_or_expired_token' });
    expect(store.size()).toBe(0);

    const disabled = new ArtifactAuthService({
      introspector: {
        introspect: async () => ({ active: true, user: { uid: 2, state: 1, account_type: 'human' } }),
      },
      sessions: store,
      create_session_id: () => 'never',
    });
    await expect(disabled.exchange('jwt')).rejects.toMatchObject({ code: 'unauthenticated', reason: 'user_not_available' });
    expect(store.size()).toBe(0);
  });

  it('expires and revokes sessions, making replayed cookies unusable', async () => {
    let clock = new Date('2026-08-27T00:00:00.000Z');
    const store = new InMemorySessionStore();
    const auth = new ArtifactAuthService({
      introspector: { introspect: async () => ({ active: true, user: { uid: 4, state: 0 } }) },
      sessions: store,
      session_ttl_ms: 1_000,
      now: () => new Date(clock),
      create_session_id: () => 'axs_expiring',
    });
    await auth.exchange('jwt');
    clock = new Date('2026-08-27T00:00:01.001Z');
    await expect(auth.resolve('axs_expiring')).resolves.toBeUndefined();
    expect(store.size()).toBe(0);

    clock = new Date('2026-08-27T00:00:02.000Z');
    await auth.exchange('jwt');
    await auth.revoke('axs_expiring');
    await expect(auth.resolve('axs_expiring')).resolves.toBeUndefined();
  });

  it('optionally revalidates a principal and revokes it when the provider disables it', async () => {
    let clock = new Date('2026-08-27T00:00:00.000Z');
    let active = true;
    let checks = 0;
    const auth = new ArtifactAuthService({
      introspector: { introspect: async () => ({ active: true, user: { uid: 9, state: 0 } }) },
      sessions: new InMemorySessionStore(),
      session_ttl_ms: 60_000,
      revalidate_interval_ms: 1_000,
      revalidate_principal: async (principal) => {
        checks += 1;
        expect(principal.actor_id).toBe('catsco:user:9');
        return active;
      },
      now: () => new Date(clock),
      create_session_id: () => 'axs_revalidated',
    });
    await auth.exchange('jwt');
    await expect(auth.resolve('axs_revalidated')).resolves.toMatchObject({ session_id: 'axs_revalidated' });
    expect(checks).toBe(0); // exchange itself is the initial identity check

    clock = new Date('2026-08-27T00:00:01.001Z');
    active = false;
    await expect(auth.resolve('axs_revalidated')).resolves.toBeUndefined();
    expect(checks).toBe(1);
    await expect(auth.resolve('axs_revalidated')).resolves.toBeUndefined();
    expect(checks).toBe(1); // revoked sessions are not sent back to the provider
  });

  it('fails closed with a retryable provider error when revalidation is unavailable', async () => {
    let clock = new Date('2026-08-27T00:00:00.000Z');
    const auth = new ArtifactAuthService({
      introspector: { introspect: async () => ({ active: true, user: { uid: 10, state: 0 } }) },
      sessions: new InMemorySessionStore(),
      session_ttl_ms: 60_000,
      revalidate_interval_ms: 1_000,
      revalidate_principal: async () => {
        throw new Error('status endpoint down');
      },
      now: () => new Date(clock),
      create_session_id: () => 'axs_revalidation_error',
    });
    await auth.exchange('jwt');
    await expect(auth.resolve('axs_revalidation_error')).resolves.toBeDefined();
    clock = new Date('2026-08-27T00:00:01.001Z');
    await expect(auth.resolve('axs_revalidation_error')).rejects.toMatchObject({
      code: 'identity_provider_unavailable',
      status: 503,
    });
  });

  it('contains malformed provider responses and invalid credentials at the seam', async () => {
    const malformed = service({ introspect: async () => ({ active: true } as never) });
    await expect(malformed.exchange('jwt')).rejects.toMatchObject({ code: 'provider_response_invalid', status: 502 });
    await expect(malformed.exchange('')).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    await expect(malformed.exchange('x'.repeat(16_385))).rejects.toBeInstanceOf(AuthError);
  });
});
