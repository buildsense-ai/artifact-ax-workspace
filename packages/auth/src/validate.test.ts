import { describe, expect, it } from 'vitest';
import { AuthError, parseCatsCoIntrospection, principalFromIntrospection } from './index.js';

describe('auth provider validation', () => {
  it('uses a trusted sub when present and falls back to a UID subject', () => {
    const withSub = principalFromIntrospection(
      { active: true, user: { uid: 7, state: 0, account_type: 'bot' }, claims: { sub: 'agent:7' } },
      ['artifact:execute'],
    );
    expect(withSub).toMatchObject({ subject: 'agent:7', actor_type: 'agent' });
    const fallback = principalFromIntrospection({ active: true, user: { uid: 8, state: 0 } });
    expect(fallback.subject).toBe('catsco:user:8');
    expect(fallback.actor_type).toBe('human');
  });

  it('maps unknown account types to a least-assumptive service actor', () => {
    const principal = principalFromIntrospection({ active: true, user: { uid: 9, state: 0, account_type: 'future_type' } });
    expect(principal.actor_type).toBe('service');
  });

  it('rejects malformed active responses and inactive identities safely', () => {
    expect(() => parseCatsCoIntrospection({ active: 'yes' })).toThrowError(AuthError);
    expect(() => parseCatsCoIntrospection({ active: true, user: { uid: 0, state: 0 } })).toThrowError(AuthError);
    expect(() => principalFromIntrospection({ active: false, error: 'user_not_available' })).toThrowError(
      expect.objectContaining({ code: 'unauthenticated', reason: 'user_not_available' }),
    );
    expect(() => principalFromIntrospection({ active: false, error: 'database details should not escape' })).toThrowError(
      expect.objectContaining({ code: 'unauthenticated', reason: 'invalid_or_expired_token' }),
    );
  });
});
