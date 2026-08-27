/** Actor taxonomy and the workspace role / scope model. */

export const ACTOR_TYPES = ['human', 'agent', 'service', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Actor provenance for every command and event. An Agent identity never
 * receives authority merely because its name contains "builder" or "admin";
 * scopes are granted explicitly in the workspace policy.
 */
export interface Actor {
  id: string;
  type: ActorType;
  name?: string;
  /** Human identity behind a delegated Agent grant (for accountability). */
  owner_id?: string;
}

export interface ActorInput {
  id: string;
  type?: ActorType;
  name?: string;
  owner_id?: string;
}

export function toActor(input: ActorInput): Actor {
  return {
    id: input.id,
    type: input.type ?? 'human',
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.owner_id !== undefined ? { owner_id: input.owner_id } : {}),
  };
}

export const ROLES = ['owner', 'builder', 'reviewer', 'operator', 'observer'] as const;
export type Role = (typeof ROLES)[number];

export const SCOPES = [
  'artifact:read',
  'artifact:edit',
  'artifact:execute',
  'artifact:approve',
  'artifact:publish',
  'artifact:share',
  'artifact:admin',
] as const;
export type Scope = (typeof SCOPES)[number];

/** Default role-to-scope mapping. Workspace policy can override per actor. */
export const DEFAULT_ROLE_SCOPES: Record<Role, Scope[]> = {
  owner: [...SCOPES],
  builder: ['artifact:read', 'artifact:edit'],
  reviewer: ['artifact:read', 'artifact:approve', 'artifact:publish'],
  operator: ['artifact:read', 'artifact:execute'],
  observer: ['artifact:read'],
};

export interface Membership {
  actor_id: string;
  roles: Role[];
  scopes?: Scope[];
}

export function scopesFor(membership: Membership): Scope[] {
  if (membership.scopes !== undefined && membership.scopes.length > 0) {
    return [...membership.scopes];
  }
  const merged = new Set<Scope>();
  for (const role of membership.roles) {
    for (const scope of DEFAULT_ROLE_SCOPES[role]) {
      merged.add(scope);
    }
  }
  return [...merged];
}