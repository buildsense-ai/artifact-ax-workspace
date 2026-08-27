import type { Actor, ActorInput } from './actor.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalKind = 'command' | 'publish';

/**
 * An Approval is a human or policy decision required by an action. It is
 * explicit, scoped, and resumable: it binds to the Artifact, version, command
 * or draft, requestor, and expiry, and resolving it produces a structured
 * event that the waiting task can resume.
 */
export interface Approval {
  approval_id: string;
  workspace_id: string;
  artifact_id: string;
  kind: ApprovalKind;
  /** Capability name when kind === 'command'. */
  capability?: string;
  /** Command waiting on this approval when kind === 'command'. */
  command_id?: string;
  /** Draft waiting on this approval when kind === 'publish'. */
  draft_id?: string;
  requested_by: Actor;
  /** Actor ids allowed to resolve this approval. */
  assignees: string[];
  status: ApprovalStatus;
  message: string;
  created_at: string;
  expires_at?: string;
  decision?: ApprovalDecision;
  resolved_by?: Actor;
  resolved_at?: string;
}

export interface ResolveApprovalRequest {
  workspace_id: string;
  artifact_id: string;
  approval_id: string;
  decision: ApprovalDecision;
  reviewer: ActorInput;
  note?: string;
}

export interface ApprovalResolutionResult {
  approval: Approval;
  /** When approving a gated command, the resumed command result. */
  command_result?: CommandResultLike;
}

/** Minimal shape used when one approval resolver feeds another command. */
export interface CommandResultLike {
  outcome: string;
  revision: number | null;
  result?: unknown;
  error?: { code: string; message: string };
}