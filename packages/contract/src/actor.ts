/**
 * Visitor identity for a collaborative Artifact.
 *
 * The platform hands the application a verified identity at launch time (a
 * one-time launch code exchanged at the gateway, or an explicit guest
 * fallback). The page treats every identity claim as untrusted input until it
 * arrives through that exchange; nothing in the URL or page content is
 * authority by itself.
 */

export interface CollabIdentity {
  /** Platform user id. Guests get a stable `guest-<n>` pseudo id. */
  uid: string;
  /** Display name used for presence, journal attribution, and UI. */
  username: string;
  /** True when the platform verified a signed-in account. */
  authenticated: boolean;
}

export const GUEST_IDENTITY: CollabIdentity = {
  uid: 'guest',
  username: 'Guest',
  authenticated: false,
};

export function isCollabIdentity(value: unknown): value is CollabIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.uid === 'string' && candidate.uid.length > 0
    && typeof candidate.username === 'string'
    && typeof candidate.authenticated === 'boolean';
}

/** Stable display label for feeds and presence lists. */
export function identityLabel(identity: CollabIdentity): string {
  const name = identity.username.trim() || 'Guest';
  return identity.authenticated ? name : `${name} (guest)`;
}
