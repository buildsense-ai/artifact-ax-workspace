/**
 * Server-only transitional CatsCo identity adapter.
 *
 * CatsCo currently documents account-center introspection rather than a
 * general OIDC issuer.  This adapter keeps that fact at one boundary: the
 * bridge sends the user's JWT to `/api/account/introspect` with a Service
 * Token, then issues an Artifact-side opaque session.  The Service Token and
 * the user's JWT never leave this process or enter a session record.
 */

import { randomBytes } from 'node:crypto';
import {
  ArtifactAuthService,
  AuthError,
  InMemorySessionStore,
  parseCatsCoIntrospection,
  type ArtifactAuthServiceOptions,
  type CatsCoIntrospection,
  type CatsCoIntrospector,
  type AuthPrincipal,
} from '@artifact-ax/auth';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1 << 20;
const MAX_USER_TOKEN_LENGTH = 16 * 1024;

export interface CatsCoIntrospectionClientOptions {
  account_url: string;
  service_token: string;
  fetch_impl?: typeof fetch;
  timeout_ms?: number;
}

function normalizeAccountURL(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthError('invalid_config', 'CatsCo account_url must be a non-empty URL', 500);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AuthError('invalid_config', 'CatsCo account_url must be a valid URL', 500);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AuthError('invalid_config', 'CatsCo account_url must use http or https', 500);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AuthError('invalid_config', 'CatsCo account_url must not contain credentials or a query', 500);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function assertServiceToken(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 16 * 1024) {
    throw new AuthError('invalid_config', 'CatsCo service_token must be a non-empty server-side value', 500);
  }
  return value.trim();
}

function defaultSessionId(): string {
  return `axs_${randomBytes(32).toString('base64url')}`;
}

export class CatsCoIntrospectionClient implements CatsCoIntrospector {
  private readonly accountURL: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CatsCoIntrospectionClientOptions) {
    this.accountURL = normalizeAccountURL(options.account_url);
    this.serviceToken = assertServiceToken(options.service_token);
    this.fetchImpl = options.fetch_impl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new AuthError('invalid_config', 'CatsCo introspection timeout_ms must be between 100 and 60000', 500);
    }
  }

  async introspect(userToken: string): Promise<CatsCoIntrospection> {
    if (typeof userToken !== 'string' || userToken.trim() === '' || userToken.length > MAX_USER_TOKEN_LENGTH) {
      throw new AuthError('invalid_request', 'CatsCo user token is required', 400);
    }
    const response = await this.request('/api/account/introspect', {
      method: 'POST',
      headers: {
        Authorization: `Service ${this.serviceToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token: userToken.trim() }),
    });
    if (!response.ok) {
      // Do not echo the upstream body: it can contain operational details.
      throw new AuthError('identity_provider_error', `CatsCo identity provider returned HTTP ${response.status}`, 503);
    }
    return parseCatsCoIntrospection(await this.json(response, 'CatsCo introspection'));
  }

  /**
   * Re-check the currently stored CatsCo account state without retaining the
   * user's JWT. The observed account-center endpoint is a profile lookup, not
   * a token-revocation oracle, so this closes the disabled/deleted-account
   * window while session expiry still bounds token lifecycle.
   */
  async isAccountActive(principal: AuthPrincipal): Promise<boolean> {
    if (!Number.isSafeInteger(principal.uid) || principal.uid <= 0) {
      throw new AuthError('provider_response_invalid', 'Artifact principal uid is invalid for CatsCo account lookup', 502);
    }
    const response = await this.request(`/api/account/users/${encodeURIComponent(String(principal.uid))}`, {
      method: 'GET',
      headers: {
        Authorization: `Service ${this.serviceToken}`,
        Accept: 'application/json',
      },
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new AuthError('identity_provider_error', `CatsCo account lookup returned HTTP ${response.status}`, 503);
    }
    const parsed = parseCatsCoIntrospection({ active: true, user: await this.json(response, 'CatsCo account lookup') });
    const user = parsed.user;
    if (user === undefined || user.uid !== principal.uid) {
      throw new AuthError('provider_response_invalid', 'CatsCo account lookup returned a mismatched uid', 502);
    }
    return user.state === 0;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.accountURL}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AuthError('identity_provider_timeout', 'CatsCo identity provider timed out', 503);
      }
      throw new AuthError('identity_provider_unavailable', 'CatsCo identity provider is unavailable', 503);
    } finally {
      clearTimeout(timer);
    }
  }

  private async json(response: Response, label: string): Promise<unknown> {
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new AuthError('provider_response_invalid', `${label} response is too large`, 502);
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
      throw new AuthError('provider_response_invalid', `${label} response is too large`, 502);
    }
    try {
      return body === '' ? undefined : JSON.parse(body);
    } catch {
      throw new AuthError('provider_response_invalid', `${label} response is not valid JSON`, 502);
    }
  }
}

export interface CatsCoAuthAdapterOptions
  extends Omit<ArtifactAuthServiceOptions, 'introspector' | 'sessions' | 'create_session_id'> {
  account_url: string;
  service_token: string;
  fetch_impl?: typeof fetch;
  timeout_ms?: number;
  /** Default true: poll the documented account-state lookup between requests. */
  revalidate_account_state?: boolean;
}

/** Build the default server-side adapter used by the optional bridge auth. */
export function createCatsCoAuthAdapter(options: CatsCoAuthAdapterOptions): ArtifactAuthService {
  const introspector = new CatsCoIntrospectionClient(options);
  const revalidator = options.revalidate_principal ?? (
    options.revalidate_account_state === false
      ? undefined
      : (principal: AuthPrincipal) => introspector.isAccountActive(principal)
  );
  return new ArtifactAuthService({
    introspector,
    sessions: new InMemorySessionStore(),
    ...(options.session_ttl_ms !== undefined ? { session_ttl_ms: options.session_ttl_ms } : {}),
    // Read-only is the least-surprising bridge default. Passing an explicit
    // empty array remains a deliberate identity-only policy for a host that
    // grants no bridge data access.
    scopes: options.scopes ?? ['artifact:read'],
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(revalidator !== undefined ? { revalidate_principal: revalidator } : {}),
    ...(options.revalidate_interval_ms !== undefined ? { revalidate_interval_ms: options.revalidate_interval_ms } : {}),
    create_session_id: defaultSessionId,
  });
}
