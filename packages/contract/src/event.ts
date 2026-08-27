import type { Actor } from './actor.js';

/**
 * Events carry state changes, task progress, and provenance. They are ordered
 * within an Artifact stream; a consumer can resume from a cursor and detect a
 * gap. The application may map this envelope to AG-UI events at an adapter
 * boundary; the core event remains meaningful to a human client, a script, or
 * another Agent.
 */
export interface Event {
  event_id: string;
  /** Monotonic per-artifact sequence number; the watch/inspect cursor. */
  seq: number;
  workspace_id: string;
  artifact_id: string;
  version: number;
  revision: number;
  actor: Actor;
  /** command_id that produced this event, or 'system' for background events. */
  caused_by: string;
  type: string;
  data: unknown;
  created_at: string;
}

export const EVENT_TYPES = {
  capabilityExecuted: 'capability.executed',
  capabilityFailed: 'capability.failed',
  approvalRequested: 'approval.requested',
  approvalResolved: 'approval.resolved',
  approvalRejected: 'approval.rejected',
  approvalExpired: 'approval.expired',
  draftCreated: 'draft.created',
  draftValidated: 'draft.validated',
  versionPublished: 'version.published',
  artifactSoftDeleted: 'artifact.soft_deleted',
  artifactRestored: 'artifact.restored',
  changed: 'state.changed',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface EventCursor {
  /** Last consumed event seq, inclusive. 0 means "from the beginning". */
  seq: number;
}

export function cursorFromSeq(seq: number): EventCursor {
  return { seq };
}