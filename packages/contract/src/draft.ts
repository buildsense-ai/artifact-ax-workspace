import type { Actor, ActorInput } from './actor.js';
import type { Capability } from './manifest.js';
import type { Schema } from './manifest.js';

export type DraftStatus = 'open' | 'validated' | 'published' | 'superseded';

/**
 * A Draft records a structured change set against a base version. Structured
 * building (declarative region data / manifest changes) is the supported
 * first mode; arbitrary code building is explicitly out of scope for this
 * slice.
 */
export interface DraftChangeSet {
  title?: string;
  /** Replace payloads for existing regions; region ids must stay stable. */
  region_updates?: { region_id: string; data?: unknown; definition?: RegionDefinition }[];
  capabilities?: Capability[];
}

export interface RegionDefinition {
  id: string;
  title: string;
  summary?: string;
  order: number;
  schema?: Schema;
}

export interface Draft {
  draft_id: string;
  workspace_id: string;
  artifact_id: string;
  base_version: number;
  parent_revision: number;
  builder: Actor;
  status: DraftStatus;
  change_set: DraftChangeSet;
  validation?: { ok: boolean; errors: string[]; checked_at: string };
  created_at: string;
  updated_at: string;
}

export interface CreateDraftRequest {
  workspace_id: string;
  artifact_id: string;
  builder: ActorInput;
  change_set: DraftChangeSet;
}

export interface ValidateDraftRequest {
  workspace_id: string;
  artifact_id: string;
  draft_id: string;
  actor: ActorInput;
}

export interface PublishDraftRequest {
  workspace_id: string;
  artifact_id: string;
  draft_id: string;
  actor: ActorInput;
  /** A resolved publish approval that authorizes this publication. */
  approval_id?: string;
  reason?: string;
}

export interface PublishResult {
  outcome: 'published' | 'pending_approval' | 'rejected';
  new_version: number | null;
  new_revision: number | null;
  approval?: ApprovalLike;
  error?: { code: string; message: string };
}

export interface ApprovalLike {
  approval_id: string;
  status: string;
  message: string;
}