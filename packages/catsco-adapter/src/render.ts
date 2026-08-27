import {
  type CloudArtifactIndex,
  type CloudArtifactItem,
  type CloudArtifactManagementList,
  type CloudArtifactOperation,
  type CloudArtifactStatus,
  CLOUD_ARTIFACTS_INDEX_CONTRACT,
  CLOUD_ARTIFACTS_MANAGEMENT_CONTRACT,
  nowRFC3339,
} from '@artifact-ax/contract';
import { type ExportedArtifact } from '@artifact-ax/domain';

/**
 * Rendering of domain facts into the CatsCo cloud-artifact wire contracts.
 * Only this module knows about URL layout; the domain service stays URL-free.
 */

export interface NodeURLLayout {
  /** Public origin + base path where artifacts are served, e.g. http://127.0.0.1:8787. */
  publicBaseURL: string;
}

export interface ExportOptions extends NodeURLLayout {
  /** Restrict to a specific CatsCo agent UID. */
  agentUID?: string;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function artifactPublicURL(layout: NodeURLLayout, artifact: Pick<ExportedArtifact, 'id' | 'agent_uid'>): string {
  const base = trimSlash(layout.publicBaseURL);
  if (artifact.agent_uid) {
    return `${base}/by-agent/${artifact.agent_uid}/${artifact.id}/latest/`;
  }
  return `${base}/${artifact.id}/latest/`;
}

export function artifactSidecarURL(layout: NodeURLLayout, artifact: Pick<ExportedArtifact, 'id' | 'agent_uid'>): string {
  const base = trimSlash(layout.publicBaseURL);
  if (artifact.agent_uid) {
    return `${base}/by-agent/${artifact.agent_uid}/${artifact.id}/latest/artifact.ax.json`;
  }
  return `${base}/${artifact.id}/latest/artifact.ax.json`;
}

function toIndexItem(layout: NodeURLLayout, artifact: ExportedArtifact): CloudArtifactItem {
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    url: artifactPublicURL(layout, artifact),
    updated_at: artifact.updated_at,
    ...(artifact.publish_version !== null && artifact.publish_version !== undefined
      ? { publish_version: artifact.publish_version }
      : {}),
    ...(artifact.agent_uid ? { agent_uid: artifact.agent_uid } : {}),
  };
}

/** Mirrors validateCloudArtifactIndex expectations: active only, unique ids. */
export function renderIndex(artifacts: ExportedArtifact[], layout: NodeURLLayout): CloudArtifactIndex {
  const active = artifacts.filter((a) => a.status === 'active');
  return {
    contract_version: CLOUD_ARTIFACTS_INDEX_CONTRACT,
    updated_at: active.length > 0 ? maxTimestamp(active.map((a) => a.updated_at)) : nowRFC3339(),
    artifacts: active.map((a) => toIndexItem(layout, a)),
  };
}

function toManagedItem(artifact: ExportedArtifact, opts: ExportOptions): CloudArtifactItem {
  const item: CloudArtifactItem = {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    url: artifactPublicURL(opts, artifact),
    status: artifact.status,
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
    ...(artifact.publish_version !== null && artifact.publish_version !== undefined
      ? { publish_version: artifact.publish_version }
      : {}),
    can_delete: artifact.can_delete,
    can_restore: artifact.can_restore,
  };
  if (artifact.agent_uid) item.agent_uid = artifact.agent_uid;
  if (artifact.deleted_at) item.deleted_at = artifact.deleted_at;
  return item;
}

/** Mirrors validateManagedArtifactList: status filter, full managed shape. */
export function renderManagementList(
  artifacts: ExportedArtifact[],
  status: CloudArtifactStatus,
  opts: ExportOptions,
): CloudArtifactManagementList {
  const filtered = artifacts.filter((a) => {
    if (a.status !== status) return false;
    if (opts.agentUID !== undefined && a.agent_uid !== opts.agentUID) return false;
    return true;
  });
  return {
    contract_version: CLOUD_ARTIFACTS_MANAGEMENT_CONTRACT,
    status,
    count: filtered.length,
    artifacts: filtered.map((a) => toManagedItem(a, opts)),
  };
}

/** Mutation response shape expected by CatsCo handleMutation. */
export function renderOperation(artifact: ExportedArtifact, opts: ExportOptions): CloudArtifactOperation {
  return { ok: true, artifact: toManagedItem(artifact, opts) };
}

function maxTimestamp(values: string[]): string {
  let max = '-inf';
  for (const value of values) {
    if (value > max) max = value;
  }
  return max;
}