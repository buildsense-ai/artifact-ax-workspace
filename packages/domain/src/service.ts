import {
  type Actor,
  type ActorInput,
  type Approval,
  type ApprovalDecision,
  type ApprovalResolutionResult,
  type AxGateway,
  type Capability,
  type Command,
  type CommandInput,
  type CommandResult,
  type CreateDraftRequest,
  type DescribeRequest,
  type Draft,
  type DraftChangeSet,
  type Event,
  type InspectRequest,
  type Manifest,
  type Membership,
  type Projection,
  type PublishDraftRequest,
  type PublishResult,
  type Region,
  type ResolveApprovalRequest,
  type Schema,
  type Scope,
  type ValidateDraftRequest,
  type WatchEnvelope,
  type WatchRequest,
  AX_CONTRACT_VERSION,
  ContractError,
  EVENT_TYPES,
  newApprovalId,
  newDraftId,
  newEventId,
  nowRFC3339,
  scopesFor,
  toActor,
  validateManifest,
} from '@artifact-ax/contract';
import { TypedEmitter } from './emitter.js';
import { validateObject } from './schema.js';

/** Structured building spec used to seed an Artifact into the service. */
export interface RegionSeed {
  id: string;
  title: string;
  summary?: string;
  order?: number;
  schema?: Schema;
  initial_data?: unknown;
}

export interface HandlerContext {
  workspace_id: string;
  artifact_id: string;
  version: number;
  revision: number;
  actor: Actor;
  args: Record<string, unknown>;
  /** Read-only view of current region data (region id -> data). */
  regions: ReadonlyMap<string, unknown>;
}

export interface CommandExecution {
  result: unknown;
  region_updates?: { region_id: string; data: unknown }[];
}

export type CapabilityHandler = (ctx: HandlerContext) => CommandExecution | void;

export interface CapabilitySeed extends Capability {
  /** Optional executable handler. Capabilities without a handler are discoverable but reject execution. */
  handler?: CapabilityHandler;
}

export interface ArtifactSpec {
  workspace_id: string;
  artifact_id: string;
  title: string;
  kind: 'html' | 'mini_app';
  /** CatsCo virtual-employee UID for agent-scoped URL generation. */
  agent_uid?: string;
  policy_hints?: string[];
  regions: RegionSeed[];
  capabilities: CapabilitySeed[];
}

export interface WorkspaceSeed {
  id: string;
  members: Membership[];
}

export interface ArtifactServiceOptions {
  specs: ArtifactSpec[];
  workspaces?: WorkspaceSeed[];
  /** Publication requires a resolved approval by default. */
  publication_requires_approval?: boolean;
}

export interface ExportedArtifact {
  id: string;
  title: string;
  kind: string;
  status: 'active' | 'deleted';
  created_at: string;
  updated_at: string;
  publish_version: number | null;
  agent_uid?: string | null;
  deleted_at?: string | null;
  can_delete: boolean;
  can_restore: boolean;
}

interface VersionSnapshot {
  version: number;
  revision: number;
  published_at: string;
  source_draft_id?: string;
  publisher: Actor;
  manifest: Manifest;
  regions: Map<string, unknown>;
}

interface WorkspaceState {
  id: string;
  members: Map<string, Membership>;
  publication_requires_approval: boolean;
}

interface RegionDatum {
  region: Region;
  data: unknown;
  changed_seq?: number;
}

interface ArtifactState {
  spec: ArtifactSpec;
  workspace_id: string;
  status: 'active' | 'deleted';
  version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
  manifest: Manifest;
  regions: Map<string, RegionDatum>;
  drafts: Map<string, Draft>;
  approvals: Map<string, Approval>;
  /** Commands waiting on approval, keyed by approval_id. */
  pendingCommands: Map<string, Command>;
  versions: VersionSnapshot[];
  events: Event[];
  /** idempotency_key -> result (including pending_approval outcomes). */
  idempotency: Map<string, CommandResult>;
}

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const WATCH_HEARTBEAT_MS = 5_000;

/**
 * Deep in-memory Artifact domain service. It implements the transport-neutral
 * AxGateway seam, owns Draft/Published version transitions, optimistic
 * revisions, idempotency, approvals, audit events, and soft delete/restore.
 * It has no knowledge of CatsCo URLs or HTTP; the catsco-adapter composes
 * index/management JSON from this service's exported facts.
 */
export class ArtifactService implements AxGateway {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly artifacts = new Map<string, ArtifactState>();
  private readonly emitters = new Map<string, TypedEmitter>();
  private readonly publicationRequiresApproval: boolean;

  constructor(options: ArtifactServiceOptions) {
    this.publicationRequiresApproval = options.publication_requires_approval ?? true;
    for (const workspace of options.workspaces ?? []) {
      const members = new Map<string, Membership>();
      for (const membership of workspace.members) {
        members.set(membership.actor_id, membership);
      }
      this.workspaces.set(workspace.id, {
        id: workspace.id,
        members,
        publication_requires_approval: this.publicationRequiresApproval,
      });
    }
    for (const spec of options.specs) {
      this.seedArtifact(spec);
    }
  }

  // ------------------------------------------------------------------ seeds

  private seedArtifact(spec: ArtifactSpec): void {
    if (!this.workspaces.has(spec.workspace_id)) {
      this.workspaces.set(spec.workspace_id, {
        id: spec.workspace_id,
        members: new Map(),
        publication_requires_approval: this.publicationRequiresApproval,
      });
    }
    const now = nowRFC3339();
    const regions = new Map<string, RegionDatum>();
    const manifestRegions: Region[] = [];
    spec.regions.forEach((seed, index) => {
      const region: Region = {
        id: seed.id,
        title: seed.title,
        order: seed.order ?? index + 1,
        ...(seed.summary !== undefined ? { summary: seed.summary } : {}),
        ...(seed.schema !== undefined ? { schema: seed.schema } : {}),
      };
      manifestRegions.push(region);
      regions.set(region.id, { region, data: seed.initial_data ?? {} });
    });
    const capabilities = spec.capabilities.map(({ handler: _handler, ...rest }) => rest);
    const manifest: Manifest = {
      contract_version: AX_CONTRACT_VERSION,
      workspace_id: spec.workspace_id,
      artifact_id: spec.artifact_id,
      title: spec.title,
      published_version: 1,
      published_revision: 0,
      regions: manifestRegions,
      capabilities,
      policy: { hints: spec.policy_hints ?? [] },
      updated_at: now,
    };
    const state: ArtifactState = {
      spec,
      workspace_id: spec.workspace_id,
      status: 'active',
      version: 1,
      revision: 0,
      created_at: now,
      updated_at: now,
      manifest,
      regions,
      drafts: new Map(),
      approvals: new Map(),
      pendingCommands: new Map(),
      versions: [
        {
          version: 1,
          revision: 0,
          published_at: now,
          publisher: { id: 'system', type: 'system' },
          manifest,
          regions: new Map([...regions].map(([id, datum]) => [id, datum.data])),
        },
      ],
      events: [],
      idempotency: new Map(),
    };
    this.artifacts.set(spec.artifact_id, state);
  }

  addMember(workspaceId: string, membership: Membership): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new ContractError('workspace_not_found', `workspace ${workspaceId} not found`);
    workspace.members.set(membership.actor_id, membership);
  }

  // ------------------------------------------------------- AX gateway surface

  async describe(req: DescribeRequest): Promise<Manifest> {
    const state = this.requireArtifact(req.workspace_id, req.artifact_id);
    const actor = toActor(req.actor);
    const scopes = this.scopesOf(state.workspace_id, actor.id);
    const capabilities = scopes
      ? state.manifest.capabilities.filter((c) => c.requires.every((scope) => scopes.has(scope)))
      : [];
    return { ...state.manifest, capabilities };
  }

  async inspect(req: InspectRequest): Promise<Projection> {
    const state = this.requireArtifact(req.workspace_id, req.artifact_id);
    const actor = toActor(req.actor);
    if (req.version !== undefined && req.version !== state.version) {
      throw new ContractError('version_not_found', `version ${req.version} is not the latest published version`);
    }
    const cursor = req.cursor ?? 0;
    const maxEvents = req.max_events ?? 50;
    const sinceEvents = state.events.filter((e) => e.seq > cursor);
    const events = maxEvents < 0 ? sinceEvents : sinceEvents.slice(-maxEvents);
    const lastEvent = events[events.length - 1];
    const lastSeq = lastEvent !== undefined ? lastEvent.seq : state.revision;

    const regionIds =
      req.region !== undefined ? [req.region] : [...state.regions.keys()];
    const regions = regionIds.map((id) => {
      const datum = state.regions.get(id);
      if (!datum) throw new ContractError('region_not_found', `region ${id} not found`);
      return {
        region: datum.region,
        data: datum.data,
        ...(datum.changed_seq !== undefined ? { changed_seq: datum.changed_seq } : {}),
      };
    });

    return {
      contract_version: AX_CONTRACT_VERSION,
      workspace_id: state.workspace_id,
      artifact_id: state.spec.artifact_id,
      actor,
      version: state.version,
      revision: state.revision,
      regions,
      pending_approvals: [...state.approvals.values()].filter((a) => a.status === 'pending'),
      events,
      cursor: lastSeq,
    };
  }

  async apply(input: CommandInput): Promise<CommandResult> {
    const command: Command = {
      command_id: input.command_id,
      workspace_id: input.workspace_id,
      artifact_id: input.artifact_id,
      version: input.version,
      base_revision: input.base_revision,
      actor: toActor(input.actor),
      name: input.name,
      args: input.args ?? {},
      ...(input.idempotency_key !== undefined ? { idempotency_key: input.idempotency_key } : {}),
    };
    return this.runCommand(this.requireArtifact(input.workspace_id, input.artifact_id), command, {
      skipApprovalGate: false,
      skipIdempotency: false,
    });
  }

  /**
   * Watch replays events after the cursor, then streams live events until
   * timeout / max_events / consumer close.
   */
  async *watch(req: WatchRequest): AsyncIterable<WatchEnvelope> {
    const state = this.requireArtifact(req.workspace_id, req.artifact_id);
    const cursor = req.cursor ?? 0;
    const include = req.include_types;
    const matches = (e: Event): boolean => include === undefined || include.includes(e.type);
    const maxEvents = req.max_events ?? 0;
    const timeoutMs = req.timeout_ms ?? 30_000;

    const emitter = this.emitterFor(state.spec.artifact_id);
    const liveQueue: Event[] = [];
    let waiters: Array<() => void> = [];
    const wake = (): void => {
      const pending = waiters;
      waiters = [];
      for (const w of pending) w();
    };
    const unsubscribe = emitter.on('event', (event) => {
      liveQueue.push(event as Event);
      wake();
    });

    let count = 0;
    try {
      // Replay snapshot (captured after subscribing, so live events are queued).
      for (const event of state.events) {
        if (event.seq <= cursor) continue;
        if (!matches(event)) continue;
        count += 1;
        yield { kind: 'event', event };
        if (maxEvents > 0 && count >= maxEvents) {
          yield { kind: 'done', reason: 'closed' };
          return;
        }
      }

      const deadline = Date.now() + timeoutMs;
      let nextHeartbeat = Date.now() + WATCH_HEARTBEAT_MS;
      while (true) {
        while (liveQueue.length > 0) {
          const event = liveQueue.shift()!;
          if (!matches(event)) continue;
          count += 1;
          yield { kind: 'event', event };
          if (maxEvents > 0 && count >= maxEvents) {
            yield { kind: 'done', reason: 'closed' };
            return;
          }
          nextHeartbeat = Date.now() + WATCH_HEARTBEAT_MS;
        }
        const now = Date.now();
        if (now >= deadline) {
          yield { kind: 'done', reason: 'timeout' };
          return;
        }
        if (now >= nextHeartbeat) {
          nextHeartbeat = now + WATCH_HEARTBEAT_MS;
          yield { kind: 'heartbeat', seq: state.revision };
        }
        // Wake at the next heartbeat or the deadline so a quiet stream still ends.
        const wakeAt = Math.min(nextHeartbeat, deadline);
        const timer = setTimeout(wake, Math.max(0, wakeAt - Date.now()));
        try {
          await new Promise<void>((resolve) => waiters.push(resolve));
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      unsubscribe();
    }
  }

  // ---------------------------------------------------------------- drafts

  async createDraft(req: CreateDraftRequest): Promise<Draft> {
    const state = this.requireArtifact(req.workspace_id, req.artifact_id);
    this.requireScope(state.workspace_id, req.builder, 'artifact:edit');
    this.requireActive(state);
    const now = nowRFC3339();
    const draft: Draft = {
      draft_id: newDraftId(),
      workspace_id: state.workspace_id,
      artifact_id: state.spec.artifact_id,
      base_version: state.version,
      parent_revision: state.revision,
      builder: toActor(req.builder),
      status: 'open',
      change_set: req.change_set,
      created_at: now,
      updated_at: now,
    };
    state.drafts.set(draft.draft_id, draft);
    this.appendEvent(state, {
      type: EVENT_TYPES.draftCreated,
      caused_by: 'system',
      actor: draft.builder,
      data: { draft_id: draft.draft_id, base_version: draft.base_version, parent_revision: draft.parent_revision },
    });
    return draft;
  }

  async validateDraft(req: ValidateDraftRequest): Promise<Draft> {
    const state = this.requireArtifact(req.workspace_id, req.artifact_id);
    const actor = toActor(req.actor);
    // Validation is a review activity: builders (artifact:edit) and
    // reviewers (artifact:approve) may run it, mirroring docs/07.
    if (!this.hasScope(state.workspace_id, actor, 'artifact:edit') && !this.hasScope(state.workspace_id, actor, 'artifact:approve')) {
      throw new ContractError('forbidden', `actor ${actor.id} cannot validate drafts`);
    }
    const draft = this.requireDraft(state, req.draft_id);
    const errors = this.validateChangeSet(state, draft.change_set);
    const now = nowRFC3339();
    draft.validation = { ok: errors.length === 0, errors, checked_at: now };
    draft.status = draft.validation.ok ? 'validated' : 'open';
    draft.updated_at = now;
    this.appendEvent(state, {
      type: EVENT_TYPES.draftValidated,
      caused_by: 'system',
      actor,
      data: { draft_id: draft.draft_id, ok: draft.validation.ok, errors: draft.validation.errors },
    });
    return draft;
  }

  async publish(req: PublishDraftRequest): Promise<PublishResult> {
    const state = this.requireArtifact(req.workspace_id, req.artifact_id);
    const actor = toActor(req.actor);
    this.requireActive(state);
    if (!this.hasScope(state.workspace_id, actor, 'artifact:publish')) {
      return {
        outcome: 'rejected',
        new_version: null,
        new_revision: null,
        error: { code: 'forbidden', message: 'actor lacks artifact:publish scope' },
      };
    }
    const draft = this.requireDraft(state, req.draft_id);
    if (draft.status === 'published') {
      return {
        outcome: 'rejected',
        new_version: null,
        new_revision: null,
        error: { code: 'draft_already_published', message: 'draft is already published' },
      };
    }
    const errors = this.validateChangeSet(state, draft.change_set);
    if (errors.length > 0) {
      return {
        outcome: 'rejected',
        new_version: null,
        new_revision: null,
        error: { code: 'validation_failed', message: errors.join('; ') },
      };
    }

    // Publication approval gate (human in the loop on a consequential action).
    if (this.workspaceOf(state.workspace_id).publication_requires_approval) {
      if (req.approval_id !== undefined) {
        const approval = state.approvals.get(req.approval_id);
        if (!approval || approval.kind !== 'publish' || approval.status !== 'approved' || approval.draft_id !== draft.draft_id) {
          return {
            outcome: 'rejected',
            new_version: null,
            new_revision: null,
            error: { code: 'approval_invalid', message: 'publish approval is missing, not approved, or belongs to another draft' },
          };
        }
      } else {
        let approval = [...state.approvals.values()].find(
          (a) => a.kind === 'publish' && a.draft_id === draft.draft_id && a.status === 'pending',
        );
        if (!approval) {
          approval = this.createApproval(state, {
            kind: 'publish',
            draft_id: draft.draft_id,
            requested_by: actor,
            message: `Publish draft ${draft.draft_id} for ${state.spec.artifact_id}`,
            assignees: this.reviewerIds(state, actor.id),
          });
          this.appendEvent(state, {
            type: EVENT_TYPES.approvalRequested,
            caused_by: 'system',
            actor,
            data: { approval_id: approval.approval_id, kind: 'publish', draft_id: draft.draft_id },
          });
        }
        return {
          outcome: 'pending_approval',
          new_version: null,
          new_revision: null,
          approval: { approval_id: approval.approval_id, status: approval.status, message: approval.message },
        };
      }
    }

    return this.commitPublish(state, draft, actor, req.reason);
  }

  // ------------------------------------------------------------- approvals

  async resolveApproval(req: ResolveApprovalRequest): Promise<ApprovalResolutionResult> {
    const state = this.requireArtifact(req.workspace_id, req.artifact_id);
    const reviewer = toActor(req.reviewer);
    const approval = state.approvals.get(req.approval_id);
    if (!approval) throw new ContractError('approval_not_found', `approval ${req.approval_id} not found`);
    if (approval.status !== 'pending') {
      throw new ContractError('approval_resolved', `approval ${req.approval_id} is ${approval.status}`);
    }
    if (approval.expires_at !== undefined && Date.parse(approval.expires_at) < Date.now()) {
      approval.status = 'expired';
      this.appendEvent(state, {
        type: EVENT_TYPES.approvalExpired,
        caused_by: 'system',
        actor: approval.requested_by,
        data: { approval_id: approval.approval_id },
      });
      throw new ContractError('approval_expired', `approval ${req.approval_id} expired`);
    }
    const allowed = approval.assignees.includes(reviewer.id) || this.hasScope(state.workspace_id, reviewer, 'artifact:approve');
    if (!allowed) {
      throw new ContractError('forbidden', `actor ${reviewer.id} is not an assignee of ${req.approval_id}`);
    }

    const decision: ApprovalDecision = req.decision;
    const now = nowRFC3339();
    approval.status = decision === 'approved' ? 'approved' : 'rejected';
    approval.decision = decision;
    approval.resolved_by = reviewer;
    approval.resolved_at = now;
    if (req.note !== undefined) {
      approval.message = `${approval.message} (${req.note})`;
    }

    let commandResult: CommandResult | undefined;
    if (decision === 'approved' && approval.kind === 'command' && approval.command_id) {
      const pending = state.pendingCommands.get(approval.approval_id);
      if (pending) {
        commandResult = this.executeCapability(state, pending, {
          via_approval: approval.approval_id,
        });
        this.appendEvent(state, {
          type: EVENT_TYPES.approvalResolved,
          caused_by: pending.command_id,
          actor: reviewer,
          data: {
            approval_id: approval.approval_id,
            decision,
            command_id: pending.command_id,
            result: commandResult.result,
            error: commandResult.error,
          },
        });
      }
    } else {
      this.appendEvent(state, {
        type: decision === 'approved' ? EVENT_TYPES.approvalResolved : EVENT_TYPES.approvalRejected,
        caused_by: approval.command_id ?? 'system',
        actor: reviewer,
        data: { approval_id: approval.approval_id, decision, note: req.note },
      });
    }
    return { approval, ...(commandResult !== undefined ? { command_result: commandResult } : {}) };
  }

  // ------------------------------------------------- management (CatsCo)

  /** Soft-delete one exact artifact; throws ContractError with CatsCo codes. */
  async softDeleteArtifact(workspaceId: string, artifactId: string, actor?: ActorInput): Promise<ExportedArtifact> {
    const state = this.requireArtifact(workspaceId, artifactId);
    if (state.status === 'deleted') {
      throw new ContractError('artifact_already_deleted', 'artifact is already deleted');
    }
    state.status = 'deleted';
    state.deleted_at = nowRFC3339();
    state.updated_at = state.deleted_at;
    this.appendEvent(state, {
      type: EVENT_TYPES.artifactSoftDeleted,
      caused_by: 'system',
      actor: toActor(actor ?? { id: 'system', type: 'system' }),
      data: { deleted_at: state.deleted_at },
    });
    return this.exportArtifact(state);
  }

  /** Restore one exact artifact; throws ContractError with CatsCo codes. */
  async restoreArtifact(workspaceId: string, artifactId: string, actor?: ActorInput): Promise<ExportedArtifact> {
    const state = this.requireArtifact(workspaceId, artifactId);
    if (state.status === 'active') {
      throw new ContractError('artifact_not_deleted', 'artifact is not deleted');
    }
    state.status = 'active';
    state.deleted_at = undefined;
    state.updated_at = nowRFC3339();
    this.appendEvent(state, {
      type: EVENT_TYPES.artifactRestored,
      caused_by: 'system',
      actor: toActor(actor ?? { id: 'system', type: 'system' }),
      data: { restored_at: state.updated_at },
    });
    return this.exportArtifact(state);
  }

  exportArtifacts(): ExportedArtifact[] {
    return [...this.artifacts.values()].map((state) => this.exportArtifact(state));
  }

  getArtifactManifest(artifactId: string): Manifest | undefined {
    return this.artifacts.get(artifactId)?.manifest;
  }

  // ------------------------------------------------------------ internals

  private runCommand(
    state: ArtifactState,
    command: Command,
    opts: { skipApprovalGate: boolean; skipIdempotency: boolean },
  ): CommandResult {
    this.requireActive(state);
    const capability = state.spec.capabilities.find((c) => c.name === command.name);
    const base: Omit<CommandResult, 'outcome'> = {
      command_id: command.command_id,
      artifact_id: state.spec.artifact_id,
      workspace_id: state.workspace_id,
      version: state.version,
      revision: state.revision,
      base_revision: command.base_revision,
    };
    if (!capability) {
      return { ...base, outcome: 'rejected', error: { code: 'capability_not_found', message: `unknown capability ${command.name}` } };
    }
    if (!this.hasScope(state.workspace_id, command.actor, ...capability.requires)) {
      return {
        ...base,
        outcome: 'rejected',
        error: { code: 'forbidden', message: `actor lacks required scopes: ${capability.requires.join(', ')}` },
      };
    }
    const argErrors = validateObject(command.args, capability.input_schema);
    if (argErrors.length > 0) {
      return { ...base, outcome: 'rejected', error: { code: 'invalid_args', message: argErrors.join('; ') } };
    }

    const idempotencyKey = command.idempotency_key ?? command.command_id;
    if (!opts.skipIdempotency) {
      const previous = state.idempotency.get(idempotencyKey);
      if (previous) {
        return { ...previous, idempotent_replay: true };
      }
    }
    if (command.version !== state.version) {
      return { ...base, outcome: 'conflict', error: { code: 'version_stale', message: 'published version changed; refresh the manifest' } };
    }
    if (command.base_revision !== state.revision) {
      return {
        ...base,
        outcome: 'conflict',
        error: { code: 'base_revision_stale', message: `base_revision ${command.base_revision} is stale (current ${state.revision})` },
      };
    }

    if (!opts.skipApprovalGate && capability.requires_approval) {
      const pending = [...state.approvals.values()].find(
        (a) => a.kind === 'command' && a.command_id === command.command_id && a.status === 'pending',
      );
      let approval: Approval;
      if (pending) {
        approval = pending;
      } else {
        approval = this.createApproval(state, {
          kind: 'command',
          command_id: command.command_id,
          capability: command.name,
          requested_by: command.actor,
          message: typeof capability.requires_approval === 'object' && capability.requires_approval.message
            ? capability.requires_approval.message
            : `Capability ${command.name} requires approval`,
          assignees:
            typeof capability.requires_approval === 'object' && capability.requires_approval.assignees
              ? capability.requires_approval.assignees
              : this.reviewerIds(state),
        });
        state.pendingCommands.set(approval.approval_id, command);
        this.appendEvent(state, {
          type: EVENT_TYPES.approvalRequested,
          caused_by: command.command_id,
          actor: command.actor,
          data: { approval_id: approval.approval_id, kind: 'command', capability: command.name },
        });
      }
      const result: CommandResult = { ...base, outcome: 'pending_approval', approval };
      state.idempotency.set(idempotencyKey, result);
      return result;
    }

    if (!capability.handler) {
      const result: CommandResult = {
        ...base,
        outcome: 'failed',
        error: { code: 'capability_unavailable', message: `${command.name} is declared but not implemented in this build` },
      };
      this.appendEvent(state, {
        type: EVENT_TYPES.capabilityFailed,
        caused_by: command.command_id,
        actor: command.actor,
        data: { capability: command.name, error: result.error },
      });
      state.idempotency.set(idempotencyKey, result);
      return result;
    }

    const result = this.executeCapability(state, command);
    state.idempotency.set(idempotencyKey, result);
    return result;
  }

  /** Execute a command that has a handler. Shared by direct apply and approval resume. */
  private executeCapability(state: ArtifactState, command: Command, opts?: { via_approval?: string }): CommandResult {
    const capability = state.spec.capabilities.find((c) => c.name === command.name)!;
    const base: Omit<CommandResult, 'outcome'> = {
      command_id: command.command_id,
      artifact_id: state.spec.artifact_id,
      workspace_id: state.workspace_id,
      version: state.version,
      revision: state.revision,
      base_revision: command.base_revision,
    };
    try {
      const ctx: HandlerContext = {
        workspace_id: state.workspace_id,
        artifact_id: state.spec.artifact_id,
        version: state.version,
        revision: state.revision,
        actor: command.actor,
        args: command.args,
        regions: new Map([...state.regions].map(([id, datum]) => [id, datum.data])),
      };
      const execution = capability.handler!(ctx) ?? { result: { ok: true } };
      const updates = execution.region_updates ?? [];
      const changed: string[] = [];
      for (const update of updates) {
        const datum = state.regions.get(update.region_id);
        if (!datum) {
          throw new ContractError('region_not_found', `handler touched unknown region ${update.region_id}`);
        }
        const regionErrors = validateObject(update.data, datum.region.schema);
        if (regionErrors.length > 0) {
          throw new ContractError('invalid_region_data', `region ${update.region_id}: ${regionErrors.join('; ')}`);
        }
        datum.data = update.data;
        changed.push(update.region_id);
      }
      const eventData = { capability: command.name, result: execution.result, ...(changed.length > 0 ? { changed_regions: changed } : {}) };
      const event = this.appendEvent(state, {
        type: EVENT_TYPES.capabilityExecuted,
        caused_by: command.command_id,
        actor: command.actor,
        data: { ...eventData, ...(opts?.via_approval ? { via_approval: opts.via_approval } : {}) },
      });
      for (const id of changed) {
        const datum = state.regions.get(id);
        if (datum) datum.changed_seq = event.seq;
      }
      return { ...base, outcome: 'accepted', revision: state.revision, result: execution.result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryHint = error instanceof ContractError ? error.code : 'retry_after_fix';
      const failed: CommandResult = {
        ...base,
        outcome: 'failed',
        error: { code: error instanceof ContractError ? error.code : 'execution_failed', message, retry_hint: retryHint },
      };
      this.appendEvent(state, {
        type: EVENT_TYPES.capabilityFailed,
        caused_by: command.command_id,
        actor: command.actor,
        data: { capability: command.name, error: failed.error },
      });
      return failed;
    }
  }

  private commitPublish(
    state: ArtifactState,
    draft: Draft,
    publisher: Actor,
    reason?: string,
  ): PublishResult {
    const changeSet = draft.change_set;
    const nextVersion = state.version + 1;
    const nextRegions = new Map<string, unknown>();
    for (const [id, datum] of state.regions) {
      nextRegions.set(id, datum.data);
    }
    for (const update of changeSet.region_updates ?? []) {
      const datum = state.regions.get(update.region_id);
      if (!datum) {
        return { outcome: 'rejected', new_version: null, new_revision: null, error: { code: 'validation_failed', message: `unknown region ${update.region_id}` } };
      }
      if (update.data !== undefined) {
        const regionErrors = validateObject(update.data, datum.region.schema);
        if (regionErrors.length > 0) {
          return { outcome: 'rejected', new_version: null, new_revision: null, error: { code: 'validation_failed', message: regionErrors.join('; ') } };
        }
        nextRegions.set(update.region_id, update.data);
      }
    }
    const regions: Region[] = changeSet.region_updates
      ? state.manifest.regions.map((region) => {
          const updated = changeSet.region_updates!.find((u) => u.region_id === region.id && u.definition);
          return updated && updated.definition ? { ...region, ...updated.definition } : region;
        })
      : state.manifest.regions;
    const manifest: Manifest = {
      ...state.manifest,
      title: changeSet.title ?? state.manifest.title,
      regions,
      capabilities: changeSet.capabilities ?? state.manifest.capabilities,
      published_version: nextVersion,
      updated_at: nowRFC3339(),
    };
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      return { outcome: 'rejected', new_version: null, new_revision: null, error: { code: 'validation_failed', message: errors.join('; ') } };
    }

    state.version = nextVersion;
    state.manifest = manifest;
    state.updated_at = manifest.updated_at;
    for (const [id, data] of nextRegions) {
      const datum = state.regions.get(id);
      if (datum) datum.data = data;
    }
    state.versions.push({
      version: nextVersion,
      revision: state.revision,
      published_at: manifest.updated_at,
      source_draft_id: draft.draft_id,
      publisher,
      manifest,
      regions: nextRegions,
    });
    draft.status = 'published';
    draft.updated_at = manifest.updated_at;
    const event = this.appendEvent(state, {
      type: EVENT_TYPES.versionPublished,
      caused_by: 'system',
      actor: publisher,
      data: {
        new_version: nextVersion,
        source_draft_id: draft.draft_id,
        title: manifest.title,
        ...(reason !== undefined ? { reason } : {}),
      },
    });
    state.manifest.published_revision = event.revision;
    return { outcome: 'published', new_version: nextVersion, new_revision: event.revision };
  }

  /** Structural validation of a draft change set against the artifact. */
  private validateChangeSet(state: ArtifactState, changeSet: DraftChangeSet): string[] {
    const errors: string[] = [];
    for (const update of changeSet.region_updates ?? []) {
      const datum = state.regions.get(update.region_id);
      if (!datum) {
        errors.push(`unknown region ${update.region_id}`);
        continue;
      }
      if (update.definition !== undefined && update.definition.id !== datum.region.id) {
        errors.push(`region ${update.region_id}: definition id must stay stable`);
      }
      if (update.data !== undefined) {
        errors.push(...validateObject(update.data, datum.region.schema).map((e) => `region ${update.region_id}: ${e}`));
      }
    }
    if (changeSet.capabilities !== undefined) {
      const names = new Set<string>();
      for (const capability of changeSet.capabilities) {
        if (names.has(capability.name)) errors.push(`duplicate capability ${capability.name}`);
        names.add(capability.name);
        const manifestErrors = this.validateCapabilityShape(capability);
        errors.push(...manifestErrors);
      }
    }
    return errors;
  }

  private validateCapabilityShape(capability: Capability): string[] {
    const errors: string[] = [];
    if (typeof capability.name !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(capability.name)) {
      errors.push('capability name must match lower_snake_case');
    }
    if (typeof capability.description !== 'string' || capability.description === '') {
      errors.push('capability description required');
    }
    if (!capability.input_schema || capability.input_schema.type !== 'object') {
      errors.push('capability input_schema must be an object schema');
    }
    if (!Array.isArray(capability.requires)) {
      errors.push('capability requires must be an array');
    }
    return errors;
  }

  private createApproval(
    state: ArtifactState,
    params: {
      kind: 'command' | 'publish';
      command_id?: string;
      draft_id?: string;
      capability?: string;
      requested_by: Actor;
      message: string;
      assignees: string[];
    },
  ): Approval {
    const approval: Approval = {
      approval_id: newApprovalId(),
      workspace_id: state.workspace_id,
      artifact_id: state.spec.artifact_id,
      kind: params.kind,
      ...(params.command_id !== undefined ? { command_id: params.command_id } : {}),
      ...(params.draft_id !== undefined ? { draft_id: params.draft_id } : {}),
      ...(params.capability !== undefined ? { capability: params.capability } : {}),
      requested_by: params.requested_by,
      assignees: params.assignees,
      status: 'pending',
      message: params.message,
      created_at: nowRFC3339(),
      expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    };
    state.approvals.set(approval.approval_id, approval);
    return approval;
  }

  private reviewerIds(state: ArtifactState, excludeActorId?: string): string[] {
    const workspace = this.workspaceOf(state.workspace_id);
    const ids: string[] = [];
    for (const [actorId, membership] of workspace.members) {
      if (actorId === excludeActorId) continue;
      if (membership.roles.includes('reviewer') || membership.roles.includes('owner')) {
        ids.push(actorId);
      }
    }
    if (ids.length === 0 && excludeActorId !== undefined) {
      ids.push(excludeActorId);
    }
    return ids.length > 0 ? ids : ['owner'];
  }

  private appendEvent(state: ArtifactState, params: Omit<Event, 'event_id' | 'seq' | 'workspace_id' | 'artifact_id' | 'version' | 'revision' | 'created_at'>): Event {
    state.revision += 1;
    const event: Event = {
      event_id: newEventId(),
      seq: state.revision,
      workspace_id: state.workspace_id,
      artifact_id: state.spec.artifact_id,
      version: state.version,
      revision: state.revision,
      actor: params.actor,
      caused_by: params.caused_by,
      type: params.type,
      data: params.data,
      created_at: nowRFC3339(),
    };
    state.events.push(event);
    this.emitterFor(state.spec.artifact_id).emit('event', event);
    return event;
  }

  private emitterFor(artifactId: string): TypedEmitter {
    let emitter = this.emitters.get(artifactId);
    if (!emitter) {
      emitter = new TypedEmitter();
      this.emitters.set(artifactId, emitter);
    }
    return emitter;
  }

  private exportArtifact(state: ArtifactState): ExportedArtifact {
    return {
      id: state.spec.artifact_id,
      title: state.manifest.title,
      kind: state.spec.kind,
      status: state.status,
      created_at: state.created_at,
      updated_at: state.updated_at,
      publish_version: state.version,
      ...(state.spec.agent_uid !== undefined ? { agent_uid: state.spec.agent_uid } : {}),
      ...(state.deleted_at !== undefined ? { deleted_at: state.deleted_at } : {}),
      can_delete: state.status === 'active',
      can_restore: state.status === 'deleted',
    };
  }

  private workspaceOf(workspaceId: string): WorkspaceState {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new ContractError('workspace_not_found', `workspace ${workspaceId} not found`);
    return workspace;
  }

  private requireArtifact(workspaceId: string, artifactId: string): ArtifactState {
    const state = this.artifacts.get(artifactId);
    if (!state) throw new ContractError('artifact_not_found', `artifact ${artifactId} not found`);
    if (state.workspace_id !== workspaceId) {
      throw new ContractError('artifact_not_found', `artifact ${artifactId} not found in workspace ${workspaceId}`);
    }
    return state;
  }

  private requireDraft(state: ArtifactState, draftId: string): Draft {
    const draft = state.drafts.get(draftId);
    if (!draft) throw new ContractError('draft_not_found', `draft ${draftId} not found`);
    return draft;
  }

  private requireActive(state: ArtifactState): void {
    if (state.status !== 'active') {
      throw new ContractError('artifact_not_found', `${state.spec.artifact_id} is deleted`);
    }
  }

  private requireScope(workspaceId: string, actor: ActorInput, scope: Scope): void {
    const resolved = toActor(actor);
    if (!this.hasScope(workspaceId, resolved, scope)) {
      throw new ContractError('forbidden', `actor ${resolved.id} lacks scope ${scope}`);
    }
  }

  private scopesOf(workspaceId: string, actorId: string): Set<string> | undefined {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return undefined;
    const membership = workspace.members.get(actorId);
    if (!membership) return undefined;
    return new Set(scopesFor(membership));
  }

  private hasScope(workspaceId: string, actor: Actor, ...required: string[]): boolean {
    const scopes = this.scopesOf(workspaceId, actor.id);
    if (!scopes) return false;
    return required.every((scope) => scopes.has(scope));
  }
}