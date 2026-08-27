import { AX_CONTRACT_VERSION } from './versions.js';
import { isRegionId, isCapabilityName } from './ids.js';

/** Minimal JSON-Schema-ish property used by region schemas and capability inputs. */
export interface SchemaProperty {
  type: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  items?: { type: string };
}

export interface Schema {
  type: 'object';
  properties: Record<string, SchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

/**
 * A Region is a semantic area of the Artifact whose identifier stays stable
 * within the Artifact contract. It is the unit of bounded agent context.
 */
export interface Region {
  id: string;
  title: string;
  summary?: string;
  order: number;
  schema?: Schema;
}

/**
 * A Capability is a semantic operation the application exposes. The server
 * validates it against policy, revision, and idempotency; a human or Agent
 * never infers success from changed pixels.
 */
export interface Capability {
  name: string;
  description: string;
  input_schema: Schema;
  /** Required scopes, e.g. ['artifact:execute']. */
  requires: ScopeId[];
  /**
   * Approval gate. `true` means a human/policy approval is required before
   * the capability actually executes; an object tunes the message/assignees.
   */
  requires_approval?: boolean | { message?: string; assignees?: string[] };
  /** Optional stable outcome shape description for tooling. */
  result_schema?: Schema;
}

export type ScopeId = string;

/**
 * The manifest describes what an actor may discover. It does not grant
 * permission; the server filters capabilities again for the authenticated
 * actor.
 */
export interface Manifest {
  contract_version: typeof AX_CONTRACT_VERSION;
  workspace_id: string;
  artifact_id: string;
  title: string;
  published_version: number;
  published_revision: number;
  regions: Region[];
  capabilities: Capability[];
  policy: { hints: string[] };
  updated_at: string;
  /** Relative URL of the per-artifact manifest sidecar (artifact.ax.json). */
  sidecar?: string;
}

export function validateRegion(region: Region, index: number): string[] {
  const errors: string[] = [];
  if (!isRegionId(region.id)) {
    errors.push(`regions[${index}].id must match ${/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/}`.replaceAll('/', ''));
  }
  if (typeof region.title !== 'string' || region.title.trim() === '') {
    errors.push(`regions[${index}].title must be a non-empty string`);
  }
  if (typeof region.order !== 'number') {
    errors.push(`regions[${index}].order must be a number`);
  }
  return errors;
}

export function validateCapability(capability: Capability, index: number): string[] {
  const errors: string[] = [];
  if (!isCapabilityName(capability.name)) {
    errors.push(`capabilities[${index}].name must match lower_snake_case`);
  }
  if (typeof capability.description !== 'string' || capability.description.trim() === '') {
    errors.push(`capabilities[${index}].description must be a non-empty string`);
  }
  if (
    capability.input_schema === undefined ||
    capability.input_schema.type !== 'object' ||
    typeof capability.input_schema.properties !== 'object'
  ) {
    errors.push(`capabilities[${index}].input_schema must be an object schema`);
  }
  if (!Array.isArray(capability.requires) || capability.requires.some((s) => typeof s !== 'string')) {
    errors.push(`capabilities[${index}].requires must be an array of scope strings`);
  }
  if (
    capability.requires_approval !== undefined &&
    typeof capability.requires_approval !== 'boolean' &&
    typeof capability.requires_approval !== 'object'
  ) {
    errors.push(`capabilities[${index}].requires_approval must be boolean or an object`);
  }
  return errors;
}

/**
 * Structural validation of a manifest without access to workspace policy.
 * Used before publish and by the `describe` surface. Returns accumulated
 * errors; an empty array means valid.
 */
export function validateManifest(manifest: Manifest): string[] {
  const errors: string[] = [];
  if (manifest.contract_version !== AX_CONTRACT_VERSION) {
    errors.push(`contract_version must be ${AX_CONTRACT_VERSION}`);
  }
  if (typeof manifest.workspace_id !== 'string' || manifest.workspace_id === '') {
    errors.push('workspace_id must be a non-empty string');
  }
  if (!isCloudArtifactLikeId(manifest.artifact_id)) {
    errors.push('artifact_id must match [a-z0-9._-] pattern');
  }
  if (typeof manifest.title !== 'string' || manifest.title.trim() === '') {
    errors.push('title must be a non-empty string');
  }
  if (!Number.isInteger(manifest.published_version) || manifest.published_version < 1) {
    errors.push('published_version must be a positive integer');
  }
  if (!Number.isInteger(manifest.published_revision) || manifest.published_revision < 0) {
    errors.push('published_revision must be a non-negative integer');
  }
  const regionIds = new Set<string>();
  manifest.regions.forEach((region, i) => {
    errors.push(...validateRegion(region, i));
    if (regionIds.has(region.id)) {
      errors.push(`duplicate region id ${region.id}`);
    }
    regionIds.add(region.id);
  });
  const capabilityNames = new Set<string>();
  manifest.capabilities.forEach((capability, i) => {
    errors.push(...validateCapability(capability, i));
    if (capabilityNames.has(capability.name)) {
      errors.push(`duplicate capability name ${capability.name}`);
    }
    capabilityNames.add(capability.name);
  });
  return errors;
}

function isCloudArtifactLikeId(value: unknown): boolean {
  return typeof value === 'string' && /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}