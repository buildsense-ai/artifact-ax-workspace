import { AuthError } from './errors.js';
import type { AuthActorType, AuthPrincipal, CatsCoClaims, CatsCoIntrospection, CatsCoUser } from './types.js';

const MAX_SUBJECT_LENGTH = 256;
const MAX_TOKEN_LENGTH = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string, max = 1024): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new AuthError('provider_response_invalid', `${field} must be a non-empty string`, 502);
  }
  return value;
}

function parseUser(value: unknown): CatsCoUser | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new AuthError('provider_response_invalid', 'introspection user must be an object', 502);
  const uid = value['uid'];
  const state = value['state'];
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0) {
    throw new AuthError('provider_response_invalid', 'introspection user.uid must be a positive integer', 502);
  }
  if (typeof state !== 'number' || !Number.isSafeInteger(state)) {
    throw new AuthError('provider_response_invalid', 'introspection user.state must be an integer', 502);
  }
  const accountType = optionalString(value['account_type'], 'introspection user.account_type', 128);
  const username = optionalString(value['username'], 'introspection user.username');
  const email = optionalString(value['email'], 'introspection user.email');
  const displayName = optionalString(value['display_name'], 'introspection user.display_name');
  const avatarURL = optionalString(value['avatar_url'], 'introspection user.avatar_url');
  return {
    uid,
    state,
    ...(username !== undefined ? { username } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(displayName !== undefined ? { display_name: displayName } : {}),
    ...(avatarURL !== undefined ? { avatar_url: avatarURL } : {}),
    ...(accountType !== undefined ? { account_type: accountType } : {}),
  };
}

function parseClaims(value: unknown): CatsCoClaims | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new AuthError('provider_response_invalid', 'introspection claims must be an object', 502);
  const issuer = optionalString(value['issuer'], 'introspection claims.issuer');
  const issuedAt = optionalString(value['issued_at'], 'introspection claims.issued_at');
  const expiresAt = optionalString(value['expires_at'], 'introspection claims.expires_at');
  const subject = optionalString(value['sub'], 'introspection claims.sub', MAX_SUBJECT_LENGTH);
  return {
    ...(issuer !== undefined ? { issuer } : {}),
    ...(issuedAt !== undefined ? { issued_at: issuedAt } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(subject !== undefined ? { sub: subject } : {}),
  };
}

/** Strictly validate the JSON shape received from the identity provider. */
export function parseCatsCoIntrospection(value: unknown): CatsCoIntrospection {
  if (!isRecord(value) || typeof value['active'] !== 'boolean') {
    throw new AuthError('provider_response_invalid', 'introspection response must contain boolean active', 502);
  }
  const user = parseUser(value['user']);
  const claims = parseClaims(value['claims']);
  const error = optionalString(value['error'], 'introspection error', 256);
  if (value['active'] && user === undefined) {
    throw new AuthError('provider_response_invalid', 'active introspection response must contain user', 502);
  }
  return {
    active: value['active'],
    ...(user !== undefined ? { user } : {}),
    ...(claims !== undefined ? { claims } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export function assertUserToken(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TOKEN_LENGTH) {
    throw new AuthError('invalid_request', 'CatsCo user token must be a non-empty string', 400);
  }
  return value.trim();
}

function actorTypeFor(accountType: string): AuthActorType {
  switch (accountType.trim().toLowerCase()) {
    case 'human':
    case 'user':
      return 'human';
    case 'agent':
    case 'bot':
      return 'agent';
    case 'service':
      return 'service';
    default:
      // Unknown provider account types get the least-assumptive actor class;
      // local scopes still decide whether they can do anything.
      return 'service';
  }
}

/** Convert a trusted, active provider result into an Artifact principal. */
export function principalFromIntrospection(
  introspection: CatsCoIntrospection,
  scopes: readonly string[] = [],
): AuthPrincipal {
  if (!introspection.active) {
    const reason = introspection.error === 'user_not_available' ? 'user_not_available' : 'invalid_or_expired_token';
    throw new AuthError(
      'unauthenticated',
      'CatsCo user token is not active',
      401,
      reason,
    );
  }
  const user = introspection.user;
  if (user === undefined || user.state !== 0) {
    throw new AuthError('unauthenticated', 'CatsCo account is not available', 401, 'user_not_available');
  }
  const accountType = user.account_type?.trim() || 'human';
  const subject = introspection.claims?.sub?.trim() || `catsco:user:${user.uid}`;
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw new AuthError('provider_response_invalid', 'identity subject is too long', 502);
  }
  const uniqueScopes = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  const displayName = user.display_name?.trim() || user.username?.trim();
  return {
    subject,
    actor_id: subject,
    uid: user.uid,
    actor_type: actorTypeFor(accountType),
    account_type: accountType,
    ...(displayName !== undefined ? { display_name: displayName } : {}),
    scopes: uniqueScopes,
  };
}

export function hasScope(principal: AuthPrincipal, scope: string): boolean {
  return principal.scopes.includes(scope);
}
