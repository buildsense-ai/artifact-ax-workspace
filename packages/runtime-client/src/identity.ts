import { GUEST_IDENTITY, type CollabIdentity } from '@artifact-ax/contract';

/**
 * Visitor identity resolution.
 *
 * Production path: the platform's `artifact-auth.html` handshake exchanges
 * the signed-in session for a one-time code embedded in the launch URL; the
 * application trades that code for a verified identity at the gateway's
 * exchange endpoint. `identity=guest` is the explicit visitor fallback.
 *
 * Local path: `?as=<name>` mints a deterministic dev identity so two browser
 * tabs can pretend to be two collaborators without any platform.
 */

export interface LaunchParams {
  code?: string;
  identityMode?: string;
  as?: string;
  gateway?: string;
}

export function parseLaunchParams(search: string): LaunchParams {
  const params = new URLSearchParams(search);
  return {
    ...(params.get('code') ? { code: params.get('code')! } : {}),
    ...(params.get('identity') ? { identityMode: params.get('identity')! } : {}),
    ...(params.get('as') ? { as: params.get('as')! } : {}),
    ...(params.get('gw') ? { gateway: params.get('gw')! } : {}),
  };
}

export interface IdentityExchangeResponse {
  authenticated?: boolean;
  uid?: number | string;
  username?: string;
}

export type IdentityFetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Exchange a one-time launch code for the verified identity. The gateway owns
 * the pseudonym secret; the page only ever sees the resolved uid/username.
 */
export async function exchangeLaunchCode(
  gatewayBase: string,
  code: string,
  fetcher: IdentityFetcher = ((url, init) => fetch(url, init) as Promise<never>),
): Promise<CollabIdentity | null> {
  const base = gatewayBase.replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) return null;
  const response = await fetcher(`${base}/_exchange/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code }),
  }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json()) as IdentityExchangeResponse;
  if (!body || body.authenticated !== true) return null;
  const uid = String(body.uid ?? '').trim();
  if (!uid) return null;
  return { uid, username: String(body.username ?? uid), authenticated: true };
}

/** Deterministic dev identity for `?as=` so tests and two-tab demos agree. */
export function devIdentity(name: string): CollabIdentity {
  const clean = name.trim().slice(0, 64) || 'dev';
  return { uid: `dev-${clean.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`, username: clean, authenticated: true };
}

/**
 * The catsco.artifact-viewer.v1 contract an app's backend exposes at
 * `api/whoami`: it forwards the visitor's `catsco_artifact_id` domain cookie
 * to the artifact gateway's viewer lookup — the page itself can never read
 * that HttpOnly cookie, and must not try. Used by standalone deployments.
 */
export interface WhoamiResponse {
  authenticated?: boolean;
  viewer?: { uid?: number | string; username?: string } | null;
}

export interface WhoamiFetcher {
  (url: string): Promise<{ authenticated?: boolean; viewer?: unknown } | null>;
}

const defaultWhoami: WhoamiFetcher = (url) =>
  fetch(url, { cache: 'no-store', credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

/** Resolve identity from a deployed app's whoami endpoint (cookie forwarded server-side). */
async function whoamiIdentity(fetcher: WhoamiFetcher): Promise<CollabIdentity | null> {
  const body = await fetcher('api/whoami');
  if (!body || body.authenticated !== true) return null;
  const viewer = body.viewer as { uid?: unknown; username?: unknown } | null | undefined;
  const uid = String(viewer?.uid ?? '').trim();
  if (!uid) return null;
  return { uid, username: String(viewer?.username ?? uid), authenticated: true };
}

/**
 * Resolve the visitor identity. Order: explicit guest → launch code exchange
 * → dev `?as=` → same-origin `api/whoami` (deployed standalone apps) → guest.
 */
export async function resolveIdentity(
  search: string,
  fetcher?: IdentityFetcher,
  whoami: WhoamiFetcher = defaultWhoami,
): Promise<{ identity: CollabIdentity; via: 'code' | 'guest' | 'dev' | 'whoami' | 'standalone' }> {
  const params = parseLaunchParams(search);
  if (params.identityMode === 'guest') {
    return { identity: GUEST_IDENTITY, via: 'guest' };
  }
  if (params.code && params.gateway) {
    const identity = await exchangeLaunchCode(params.gateway, params.code, fetcher);
    if (identity) return { identity, via: 'code' };
  }
  if (params.as) {
    return { identity: devIdentity(params.as), via: 'dev' };
  }
  const deployed = await whoamiIdentity(whoami);
  if (deployed) return { identity: deployed, via: 'whoami' };
  return { identity: GUEST_IDENTITY, via: 'standalone' };
}
