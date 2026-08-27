/**
 * Transport-neutral identity and session contract.
 *
 * This package deliberately knows nothing about CatsCo's database, JWT
 * signing key, browser framework, or Agent runtime.  A provider (currently a
 * server-side CatsCo account-center introspector) turns an external login
 * credential into an Artifact principal; the Artifact service then issues a
 * short-lived opaque session.
 */

export const AUTH_CONTRACT_VERSION = 'artifact.ax.auth.v1' as const;

export type AuthActorType = 'human' | 'agent' | 'service' | 'system';

/** The subset of a CatsCo account needed by the Artifact boundary. */
export interface CatsCoUser {
  uid: number;
  username?: string;
  email?: string;
  display_name?: string;
  avatar_url?: string;
  account_type?: string;
  /** CatsCo uses 0 for an enabled account. */
  state: number;
}

/** Optional trusted claims returned alongside account-center introspection. */
export interface CatsCoClaims {
  issuer?: string;
  issued_at?: string;
  expires_at?: string;
  sub?: string;
}

export interface CatsCoIntrospection {
  active: boolean;
  user?: CatsCoUser;
  claims?: CatsCoClaims;
  /** Provider reason for an inactive token; never contains the token itself. */
  error?: string;
}

/** Stable Artifact-side identity used for accountability and actor binding. */
export interface AuthPrincipal {
  /** Trusted external subject, or the transitional `catsco:user:<uid>` value. */
  subject: string;
  /** Canonical value that a ContextBundle.actor_id must match in session mode. */
  actor_id: string;
  uid: number;
  actor_type: AuthActorType;
  account_type: string;
  display_name?: string;
  scopes: string[];
}

/** Server-side session record. `session_id` is an opaque bearer secret. */
export interface ArtifactSession {
  protocol_version: typeof AUTH_CONTRACT_VERSION;
  session_id: string;
  principal: AuthPrincipal;
  created_at: string;
  expires_at: string;
}

export interface PublicArtifactSession {
  protocol_version: typeof AUTH_CONTRACT_VERSION;
  principal: AuthPrincipal;
  created_at: string;
  expires_at: string;
}

export interface CatsCoIntrospector {
  introspect(userToken: string): Promise<CatsCoIntrospection>;
}

/** Replaceable storage seam; implementations must not persist the CatsCo JWT. */
export interface SessionStore {
  put(session: ArtifactSession): Promise<void> | void;
  get(sessionId: string): Promise<ArtifactSession | undefined> | ArtifactSession | undefined;
  revoke(sessionId: string): Promise<void> | void;
}

/**
 * Optional provider-side status hook.  It receives only the already-mapped
 * principal (never the provider JWT), so a host can connect a revocation or
 * account-status service without making credentials part of session state.
 */
export type PrincipalRevalidator = (principal: AuthPrincipal) => Promise<boolean> | boolean;

export interface ArtifactAuthServiceOptions {
  introspector: CatsCoIntrospector;
  sessions: SessionStore;
  /** Default 15 minutes; callers may choose a shorter product-specific TTL. */
  session_ttl_ms?: number;
  /** Server-side scopes granted to an authenticated principal. */
  scopes?: readonly string[];
  now?: () => Date;
  /** Injected so the contract package remains browser/runtime agnostic. */
  create_session_id?: () => string;
  /** Optional bounded account/revocation check for an existing session. */
  revalidate_principal?: PrincipalRevalidator;
  /** How often to invoke the optional revalidator (default one minute). */
  revalidate_interval_ms?: number;
}

export interface AuthExchangeResult {
  session: ArtifactSession;
  principal: AuthPrincipal;
}
