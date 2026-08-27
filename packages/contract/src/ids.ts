/**
 * Stable identifier patterns. The Artifact and Region identifiers are part of
 * the public contract and must survive across published versions.
 */

/** Mirrors artifactIDPattern in cats-company/server/cloud_artifacts.go. */
export const CLOUD_ARTIFACT_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/;

/** AX Region identifiers are lower-case kebab-case words. */
export const REGION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** AX capability names are lower-case snake_case words. */
export const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function isCloudArtifactId(value: unknown): value is string {
  return typeof value === 'string' && CLOUD_ARTIFACT_ID_PATTERN.test(value);
}

export function isRegionId(value: unknown): value is string {
  return typeof value === 'string' && REGION_ID_PATTERN.test(value);
}

export function isCapabilityName(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_NAME_PATTERN.test(value);
}

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

export function newCommandId(): string {
  return nextId('cmd');
}

export function newEventId(): string {
  return nextId('evt');
}

export function newApprovalId(): string {
  return nextId('apr');
}

export function newDraftId(): string {
  return nextId('dft');
}

export function newTaskId(): string {
  return nextId('task');
}