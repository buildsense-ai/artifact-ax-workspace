import { CLOUD_ARTIFACTS_INDEX_CONTRACT, CLOUD_ARTIFACTS_MANAGEMENT_CONTRACT } from './versions.js';
import { CLOUD_ARTIFACT_ID_PATTERN } from './ids.js';
import { isRFC3339 } from './time.js';

/**
 * CatsCo cloud-artifact wire types and runtime validators.
 *
 * These mirror cats-company/server/cloud_artifacts.go semantics exactly:
 * field names are the upstream JSON names, validation rules are ported 1:1
 * from validateCloudArtifactIndex / validateManagedArtifactList /
 * validateManagedArtifact / validateArtifactIdentity /
 * validateArtifactNodeURL. See docs/06-cats-company-context.md.
 */

export type CloudArtifactStatus = 'active' | 'deleted';
export type CloudArtifactKind = 'html' | 'mini_app';

/** The union of the index item and the managed item field sets. */
export interface CloudArtifactItem {
  id: string;
  title: string;
  kind: string;
  url: string;
  status?: CloudArtifactStatus;
  created_at?: string;
  updated_at: string;
  publish_version?: number | null;
  agent_uid?: string | null;
  agent_name?: string | null;
  source_title?: string | null;
  deleted_at?: string | null;
  can_delete?: boolean;
  can_restore?: boolean;
}

export interface CloudArtifactIndex {
  contract_version: typeof CLOUD_ARTIFACTS_INDEX_CONTRACT;
  updated_at?: string;
  artifacts: CloudArtifactItem[];
}

export interface CloudArtifactManagementList {
  contract_version: typeof CLOUD_ARTIFACTS_MANAGEMENT_CONTRACT;
  status: CloudArtifactStatus;
  count: number;
  artifacts: CloudArtifactItem[];
}

export interface CloudArtifactOperation {
  ok: boolean;
  artifact: CloudArtifactItem;
}

function cleanPath(value: string): string {
  const parts: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return '/' + parts.join('/');
}

/** Mirrors validateArtifactIdentity: id pattern, title, kind, http(s) URL with host. */
export function validateCloudArtifactIdentity(item: Pick<CloudArtifactItem, 'id' | 'title' | 'kind' | 'url'>): string[] {
  const errors: string[] = [];
  if (typeof item.id !== 'string' || !CLOUD_ARTIFACT_ID_PATTERN.test(item.id)) {
    errors.push('invalid artifact id (must match [a-z0-9._-] with no leading/trailing punctuation)');
  }
  if (typeof item.title !== 'string' || item.title.trim() === '') {
    errors.push('invalid artifact title (must be non-empty)');
  }
  if (item.kind !== 'html' && item.kind !== 'mini_app') {
    errors.push('invalid artifact kind (must be html or mini_app)');
  }
  let parsedURL: URL | null = null;
  try {
    parsedURL = new URL(String(item.url).trim());
  } catch {
    parsedURL = null;
  }
  if (
    parsedURL === null ||
    parsedURL.host === '' ||
    (parsedURL.protocol !== 'http:' && parsedURL.protocol !== 'https:')
  ) {
    errors.push('invalid artifact url (must be absolute http(s) with a host)');
  }
  return errors;
}

/** Mirrors validateCloudArtifactIndex. */
export function validateCloudArtifactIndex(index: unknown): string[] {
  const errors: string[] = [];
  if (typeof index !== 'object' || index === null) {
    return ['index must be an object'];
  }
  const value = index as Record<string, unknown>;
  if (value.contract_version !== CLOUD_ARTIFACTS_INDEX_CONTRACT) {
    errors.push(`unsupported artifact index contract (expected ${CLOUD_ARTIFACTS_INDEX_CONTRACT})`);
  }
  if (value.updated_at !== undefined && !isRFC3339(value.updated_at)) {
    errors.push('invalid index updated_at timestamp');
  }
  if (!Array.isArray(value.artifacts)) {
    return [...errors, 'artifacts must be an array'];
  }
  const seen = new Set<string>();
  value.artifacts.forEach((artifact, i) => {
    if (typeof artifact !== 'object' || artifact === null) {
      errors.push(`artifacts[${i}] must be an object`);
      return;
    }
    const item = artifact as Record<string, unknown>;
    errors.push(
      ...validateCloudArtifactIdentity({
        id: item.id as string,
        title: item.title as string,
        kind: item.kind as string,
        url: item.url as string,
      }).map((e) => `artifacts[${i}]: ${e}`),
    );
    if (!isRFC3339(item.updated_at)) {
      errors.push(`artifacts[${i}]: invalid artifact updated_at timestamp`);
    }
    if (typeof item.id === 'string') {
      if (seen.has(item.id)) {
        errors.push(`artifacts[${i}]: duplicate artifact id ${item.id}`);
      }
      seen.add(item.id);
    }
  });
  return errors;
}

/** Mirrors validateManagedArtifact for one managed item. */
export function validateCloudArtifactManagedItem(item: Record<string, unknown>): string[] {
  const errors = validateCloudArtifactIdentity({
    id: item.id as string,
    title: item.title as string,
    kind: item.kind as string,
    url: item.url as string,
  });
  if (item.status !== 'active' && item.status !== 'deleted') {
    errors.push('invalid artifact status (must be active or deleted)');
  }
  if (!isRFC3339(item.created_at)) {
    errors.push('invalid artifact created_at timestamp');
  }
  if (!isRFC3339(item.updated_at)) {
    errors.push('invalid artifact updated_at timestamp');
  }
  if (item.status === 'active' && item.can_delete !== true) {
    errors.push('active artifact must be deletable (can_delete=true)');
  }
  if (item.status === 'deleted') {
    if (item.can_restore !== true) {
      errors.push('deleted artifact must be restorable (can_restore=true)');
    }
    if (!isRFC3339(item.deleted_at)) {
      errors.push('invalid artifact deleted_at timestamp');
    }
  }
  return errors;
}

/** Mirrors validateManagedArtifactList. */
export function validateCloudArtifactManagementList(list: unknown, expectedStatus: string): string[] {
  const errors: string[] = [];
  if (typeof list !== 'object' || list === null) {
    return ['management list must be an object'];
  }
  const value = list as Record<string, unknown>;
  if (value.contract_version !== CLOUD_ARTIFACTS_MANAGEMENT_CONTRACT) {
    errors.push(`unsupported artifact management contract (expected ${CLOUD_ARTIFACTS_MANAGEMENT_CONTRACT})`);
  }
  if (value.status !== expectedStatus) {
    errors.push(`management list status mismatch (expected ${expectedStatus})`);
  }
  if (typeof value.count !== 'number') {
    errors.push('management list count must be a number');
  }
  if (!Array.isArray(value.artifacts)) {
    return [...errors, 'artifacts must be an array'];
  }
  const seen = new Set<string>();
  value.artifacts.forEach((artifact, i) => {
    if (typeof artifact !== 'object' || artifact === null) {
      errors.push(`artifacts[${i}] must be an object`);
      return;
    }
    const item = artifact as Record<string, unknown>;
    const itemErrors = validateCloudArtifactManagedItem(item).map((e) => `artifacts[${i}]: ${e}`);
    errors.push(...itemErrors);
    if (item.status !== expectedStatus) {
      errors.push(`artifacts[${i}]: artifact status mismatch`);
    }
    if (typeof item.id === 'string') {
      if (seen.has(item.id)) {
        errors.push(`artifacts[${i}]: duplicate artifact id ${item.id}`);
      }
      seen.add(item.id);
    }
  });
  return errors;
}

/** Mirrors CatsCo's management operation response shape. */
export function validateCloudArtifactOperation(operation: unknown): string[] {
  const errors: string[] = [];
  if (typeof operation !== 'object' || operation === null) {
    return ['operation must be an object'];
  }
  const value = operation as Record<string, unknown>;
  if (value.ok !== true) {
    errors.push('operation ok must be true');
  }
  if (typeof value.artifact !== 'object' || value.artifact === null) {
    return [...errors, 'operation artifact must be an object'];
  }
  errors.push(...validateCloudArtifactManagedItem(value.artifact as Record<string, unknown>));
  return errors;
}

/**
 * Mirrors validateArtifactNodeURL in cats-company/server/artifact_nodes.go:
 * scheme+host must equal the node base, no query/credentials, path must live
 * under the node base path, and (when an agent UID is expected) under
 * <base>/by-agent/<uid>/. Returns an error message or null when valid.
 */
export function validateCloudArtifactNodeURL(
  value: string,
  publicBaseURL: string,
  expectedAgentUID?: number,
): string | null {
  if (publicBaseURL.trim() === '') {
    return null;
  }
  let artifactURL: URL;
  try {
    artifactURL = new URL(value.trim());
  } catch {
    return 'invalid artifact URL';
  }
  if (artifactURL.username !== '' || artifactURL.password !== '' || artifactURL.search !== '') {
    return 'artifact URL must not contain credentials or a query string';
  }
  let baseURL: URL;
  try {
    baseURL = new URL(publicBaseURL);
  } catch {
    return 'invalid artifact node URL';
  }
  if (artifactURL.protocol !== baseURL.protocol || artifactURL.host !== baseURL.host) {
    return 'artifact URL does not belong to the configured node';
  }
  const basePath = cleanPath('/' + baseURL.pathname.replace(/^\/+/, ''));
  const artifactPath = cleanPath('/' + artifactURL.pathname.replace(/^\/+/, ''));
  if (basePath !== '/' && artifactPath !== basePath && !artifactPath.startsWith(basePath + '/')) {
    return 'artifact URL does not belong to the configured node';
  }
  if (expectedAgentUID !== undefined && expectedAgentUID > 0) {
    const agentPath = cleanPath(basePath + '/by-agent/' + String(expectedAgentUID));
    if (!artifactPath.startsWith(agentPath + '/')) {
      return 'artifact URL does not belong to the configured agent';
    }
  }
  return null;
}

/** True when the URL looks like a valid index/management artifact URL (identity level). */
export function isCloudArtifactURLValid(url: string): boolean {
  return validateCloudArtifactIdentity({ id: 'a', title: 't', kind: 'html', url }).length === 0;
}