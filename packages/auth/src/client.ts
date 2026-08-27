/** Browser-safe client for the optional Artifact session endpoints. */

import { AUTH_CONTRACT_VERSION, type AuthPrincipal, type PublicArtifactSession } from './types.js';

export const AUTH_EXCHANGE_PATH = '/v1/auth/exchange';
export const AUTH_SESSION_PATH = '/v1/auth/session';
export const AUTH_LOGOUT_PATH = '/v1/auth/logout';

export interface AuthClientOptions {
  baseURL: string;
  fetchImpl?: typeof fetch;
  /** `include` is required when the bridge is a different local origin. */
  credentials?: RequestInit['credentials'];
}

export interface AuthExchangeResponse {
  protocol_version: typeof AUTH_CONTRACT_VERSION;
  authenticated: true;
  principal: AuthPrincipal;
  created_at: string;
  expires_at: string;
}

export class AuthClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'AuthClientError';
    this.code = code;
    this.status = status;
  }
}

export class ArtifactAuthClient {
  readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: RequestInit['credentials'];

  constructor(options: AuthClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.credentials = options.credentials ?? 'include';
  }

  /** Exchange a CatsCo user JWT held by the caller for an HttpOnly session cookie. */
  async exchange(catsCoUserToken: string, pairingToken?: string): Promise<AuthExchangeResponse> {
    const headers: Record<string, string> = {
      'X-CatsCo-User-Token': catsCoUserToken,
      ...(pairingToken ? { Authorization: `Bearer ${pairingToken}` } : {}),
    };
    return this.request<AuthExchangeResponse>(AUTH_EXCHANGE_PATH, {
      method: 'POST',
      headers,
    });
  }

  /** Read the public session view; an absent/expired cookie returns undefined. */
  async current(): Promise<PublicArtifactSession | undefined> {
    try {
      return await this.request<PublicArtifactSession & { authenticated: true }>(AUTH_SESSION_PATH);
    } catch (error) {
      if (error instanceof AuthClientError && error.status === 401) return undefined;
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.request<{ ok: true }>(AUTH_LOGOUT_PATH, { method: 'POST' });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseURL}${path}`, {
      ...init,
      credentials: this.credentials,
      headers: {
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new AuthClientError('invalid_response', `auth endpoint returned invalid JSON (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      const record = payload as Record<string, unknown> | undefined;
      const error = record?.['error'] as Record<string, unknown> | undefined;
      throw new AuthClientError(
        typeof error?.['code'] === 'string' ? error['code'] : 'http_error',
        typeof error?.['message'] === 'string' ? error['message'] : `auth endpoint failed (HTTP ${response.status})`,
        response.status,
      );
    }
    return payload as T;
  }
}
