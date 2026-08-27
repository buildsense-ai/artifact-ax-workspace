import type { Actor, ActorInput } from './actor.js';
import type { Approval } from './approval.js';

/** Stable command name (lower_snake_case), shared by manifest capabilities. */
export type CapabilityName = string;

/**
 * A Command requests a semantic state transition. It carries everything a
 * retry needs to be safe and a conflict needs to be explainable.
 */
export interface Command {
  command_id: string;
  workspace_id: string;
  artifact_id: string;
  version: number;
  /** Optimistic concurrency: must match the current published state revision. */
  base_revision: number;
  actor: Actor;
  name: CapabilityName;
  args: Record<string, unknown>;
  /** Optional caller-supplied replay guard; defaults to command_id. */
  idempotency_key?: string;
}

export interface CommandInput {
  command_id: string;
  workspace_id: string;
  artifact_id: string;
  version: number;
  base_revision: number;
  actor: ActorInput;
  name: CapabilityName;
  args: Record<string, unknown>;
  idempotency_key?: string;
}

export type CommandOutcome = 'accepted' | 'pending_approval' | 'conflict' | 'rejected' | 'failed';

export interface CommandResult {
  outcome: CommandOutcome;
  command_id: string;
  artifact_id: string;
  workspace_id: string;
  version: number;
  /** New revision when accepted; otherwise the current revision. */
  revision: number;
  base_revision: number;
  /** True when the idempotency key already produced this result. */
  idempotent_replay?: boolean;
  /** Structured outcome of the capability handler (accepted). */
  result?: unknown;
  /** Populated when outcome === 'pending_approval'. */
  approval?: Approval;
  error?: {
    code: string;
    message: string;
    retry_hint?: string;
  };
}

export const COMMAND_OUTCOMES: CommandOutcome[] = [
  'accepted',
  'pending_approval',
  'conflict',
  'rejected',
  'failed',
];