import type { ActorInput } from './actor.js';
import type { CommandInput, CommandResult } from './command.js';
import type { Manifest } from './manifest.js';
import type { Event } from './event.js';
import type { Projection, InspectRequest } from './projection.js';
import type {
  CreateDraftRequest,
  Draft,
  PublishDraftRequest,
  PublishResult,
  ValidateDraftRequest,
} from './draft.js';
import type { ApprovalResolutionResult, ResolveApprovalRequest } from './approval.js';

export interface DescribeRequest {
  workspace_id: string;
  artifact_id: string;
  actor: ActorInput;
}

export interface WatchRequest {
  workspace_id: string;
  artifact_id: string;
  /** Who is subscribing; used for surface/scope filtering on some transports. */
  actor?: ActorInput;
  /** Resume from events after this seq. */
  cursor?: number;
  /** Only emit events of these types. */
  include_types?: string[];
  /** Stop the stream after this many ms. */
  timeout_ms?: number;
  /** Stop after this many events. */
  max_events?: number;
}

export type WatchEnvelope =
  | { kind: 'event'; event: Event }
  | { kind: 'heartbeat'; seq: number }
  | { kind: 'done'; reason: 'timeout' | 'closed' }
  | { kind: 'gap'; missing: [number, number] };

/**
 * The AX gateway is the one semantic surface humans and Agents share. The
 * transport-neutral interface is implemented by the in-memory domain service
 * and by the HTTP gateway client; a CLI, an AG-UI adapter, and a human SPA
 * can all consume the same contract (docs/04-ax-contract.md).
 */
export interface AxGateway {
  describe(req: DescribeRequest): Promise<Manifest>;
  inspect(req: InspectRequest): Promise<Projection>;
  apply(cmd: CommandInput): Promise<CommandResult>;
  watch(req: WatchRequest): AsyncIterable<WatchEnvelope>;
  createDraft(req: CreateDraftRequest): Promise<Draft>;
  validateDraft(req: ValidateDraftRequest): Promise<Draft>;
  publish(req: PublishDraftRequest): Promise<PublishResult>;
  resolveApproval(req: ResolveApprovalRequest): Promise<ApprovalResolutionResult>;
}