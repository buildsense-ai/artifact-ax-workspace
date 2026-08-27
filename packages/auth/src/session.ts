import { AuthError } from './errors.js';
import { assertUserToken, parseCatsCoIntrospection, principalFromIntrospection } from './validate.js';
import type {
  ArtifactAuthServiceOptions,
  ArtifactSession,
  AuthExchangeResult,
  CatsCoIntrospector,
  PrincipalRevalidator,
  SessionStore,
} from './types.js';

export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_REVALIDATE_INTERVAL_MS = 60 * 1000;

function defaultNow(): Date {
  return new Date();
}

function defaultSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new AuthError('invalid_config', 'a cryptographically secure session id factory is required', 500);
  }
  return `axs_${globalThis.crypto.randomUUID()}`;
}

function cloneSession(session: ArtifactSession): ArtifactSession {
  return {
    ...session,
    principal: { ...session.principal, scopes: [...session.principal.scopes] },
  };
}

/** Small in-memory session store; replace it with Redis/DB without changing the contract. */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ArtifactSession>();

  put(session: ArtifactSession): void {
    this.sessions.set(session.session_id, cloneSession(session));
  }

  get(sessionId: string): ArtifactSession | undefined {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : cloneSession(session);
  }

  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }
}

/**
 * Exchanges a provider credential for a short-lived Artifact session.
 *
 * The external CatsCo JWT is only passed to `introspector`; it is never
 * included in the session record or returned from this service.
 */
export class ArtifactAuthService {
  private readonly introspector: CatsCoIntrospector;
  private readonly sessions: SessionStore;
  private readonly ttlMs: number;
  private readonly scopes: readonly string[];
  private readonly now: () => Date;
  private readonly createSessionId: () => string;
  private readonly revalidatePrincipal?: PrincipalRevalidator;
  private readonly revalidateIntervalMs: number;
  /** Last successful provider-status check, kept out of the session record. */
  private readonly revalidatedAt = new Map<string, number>();

  constructor(options: ArtifactAuthServiceOptions) {
    this.introspector = options.introspector;
    this.sessions = options.sessions;
    this.ttlMs = options.session_ttl_ms ?? DEFAULT_SESSION_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 24 * 60 * 60 * 1000) {
      throw new AuthError('invalid_config', 'session_ttl_ms must be between 1000 and 86400000', 500);
    }
    this.scopes = [...new Set((options.scopes ?? []).map((scope) => scope.trim()).filter(Boolean))];
    this.now = options.now ?? defaultNow;
    this.createSessionId = options.create_session_id ?? defaultSessionId;
    this.revalidatePrincipal = options.revalidate_principal;
    this.revalidateIntervalMs = options.revalidate_interval_ms ?? DEFAULT_REVALIDATE_INTERVAL_MS;
    if (
      !Number.isSafeInteger(this.revalidateIntervalMs) ||
      this.revalidateIntervalMs < 1_000 ||
      this.revalidateIntervalMs > 24 * 60 * 60 * 1000
    ) {
      throw new AuthError('invalid_config', 'revalidate_interval_ms must be between 1000 and 86400000', 500);
    }
  }

  async exchange(userToken: string): Promise<AuthExchangeResult> {
    const token = assertUserToken(userToken);
    let raw: unknown;
    try {
      raw = await this.introspector.introspect(token);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('identity_provider_unavailable', 'CatsCo identity provider is unavailable', 503);
    }
    const introspection = parseCatsCoIntrospection(raw);
    const principal = principalFromIntrospection(introspection, this.scopes);
    const created = this.now();
    const expires = new Date(created.getTime() + this.ttlMs);
    if (!Number.isFinite(created.getTime()) || !Number.isFinite(expires.getTime())) {
      throw new AuthError('invalid_config', 'auth clock returned an invalid date', 500);
    }
    const session: ArtifactSession = {
      protocol_version: 'artifact.ax.auth.v1',
      session_id: this.createSessionId(),
      principal,
      created_at: created.toISOString(),
      expires_at: expires.toISOString(),
    };
    if (session.session_id.trim() === '' || session.session_id !== session.session_id.trim() || session.session_id.length > 512) {
      throw new AuthError('invalid_config', 'session id factory returned an invalid value', 500);
    }
    try {
      await this.sessions.put(session);
    } catch {
      throw new AuthError('session_store_unavailable', 'Artifact session store is unavailable', 503);
    }
    if (this.revalidatePrincipal !== undefined) this.revalidatedAt.set(session.session_id, created.getTime());
    return { session: cloneSession(session), principal: { ...principal, scopes: [...principal.scopes] } };
  }

  async resolve(sessionId: string): Promise<ArtifactSession | undefined> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.length > 512) return undefined;
    let session: ArtifactSession | undefined;
    try {
      session = await this.sessions.get(sessionId);
    } catch {
      throw new AuthError('session_store_unavailable', 'Artifact session store is unavailable', 503);
    }
    if (session === undefined) return undefined;
    const expiry = Date.parse(session.expires_at);
    const now = this.now().getTime();
    if (!Number.isFinite(now)) throw new AuthError('invalid_config', 'auth clock returned an invalid date', 500);
    if (!Number.isFinite(expiry) || expiry <= now) {
      try {
        await this.sessions.revoke(sessionId);
      } catch {
        throw new AuthError('session_store_unavailable', 'Artifact session store is unavailable', 503);
      }
      this.revalidatedAt.delete(sessionId);
      return undefined;
    }
    if (this.revalidatePrincipal !== undefined) {
      const lastChecked = this.revalidatedAt.get(sessionId) ?? Number.NEGATIVE_INFINITY;
      if (now - lastChecked >= this.revalidateIntervalMs) {
        let active: boolean;
        try {
          active = await this.revalidatePrincipal(session.principal);
        } catch {
          // A status provider failure must not turn into an authorization
          // success.  Callers receive a retryable 503 instead.
          throw new AuthError('identity_provider_unavailable', 'identity status provider is unavailable', 503);
        }
        if (active !== true) {
          try {
            await this.sessions.revoke(sessionId);
          } catch {
            throw new AuthError('session_store_unavailable', 'Artifact session store is unavailable', 503);
          }
          this.revalidatedAt.delete(sessionId);
          return undefined;
        }
        this.revalidatedAt.set(sessionId, now);
      }
    }
    return cloneSession(session);
  }

  async revoke(sessionId: string): Promise<void> {
    if (typeof sessionId === 'string' && sessionId.trim() !== '') {
      try {
        await this.sessions.revoke(sessionId);
      } catch {
        throw new AuthError('session_store_unavailable', 'Artifact session store is unavailable', 503);
      }
      this.revalidatedAt.delete(sessionId);
    }
  }
}

export function publicSession(session: ArtifactSession) {
  return {
    protocol_version: session.protocol_version,
    principal: { ...session.principal, scopes: [...session.principal.scopes] },
    created_at: session.created_at,
    expires_at: session.expires_at,
  };
}
