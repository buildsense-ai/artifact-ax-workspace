import {
  type ActorInput,
  type Approval,
  type AxGateway,
  type CommandResult,
  type Event,
  type Manifest,
  type Projection,
} from './transport.js';
import {
  type ReviewRow,
  type ReviewTableState,
  filterRows,
  summarize,
} from '@artifact-ax/lesson-report';
import {
  type ContextBundle,
  type Outbox,
  type Selection,
  BridgeOutbox,
  MockOutbox,
  TriggerService,
  newSelectionId,
  type BridgeClient,
} from '@artifact-ax/trigger';
import {
  type ArtifactHostPort,
  CloudHostOutbox,
  type CloudHostDeliveryReceipt,
  detectArtifactHost,
} from '@artifact-ax/trigger';
import { validateDocument, type UiDocument } from '@artifact-ax/ui-document';
import {
  AGENT_NOTES_STORAGE_KEY,
  CLOUD_RESULT_SINK_ID,
  CLOUD_TASK_INTENT_ID,
  AGENT_NOTE_RESULT_SCHEMA,
  agentNotesStorageKey,
  type AgentNoteRecord,
  buildSemanticContext,
  isCloudResultId,
  loadAgentNotes,
  noteFingerprint,
  saveAgentNotes,
  validateAgentNotePayload,
  type CloudContextEventRef,
} from './cloud-surface.js';
import {
  validateResultPayload,
} from '@artifact-ax/contract';
import { resolveConfig, createGateway, createBridgeClient, createAuthClient, hydrateSessionActor, ACTOR_OPTIONS } from './transport.js';
import { LESSON_REPORT_DOCUMENT } from './ui/lesson-report.document.js';
import { renderApp, type SemanticDispatch, type ShellView } from './ui/catalog-renderer.js';
import type { OutboxItemView, UiBuilderView, UIDocumentView } from './ui/view-model.js';
import { applyUiDocumentPatch, readDraftPatchParam } from './ui/ui-draft.js';
import {
  CLOUD_UI_RESULT_SINK_ID,
  CLOUD_UI_TASK_INTENT_ID,
  UI_PATCH_RESULT_SCHEMA,
  UI_PROPOSAL_STORAGE_KEY,
  UiProposalManager,
  buildUiComposeBundle,
  buildUiComposePayload,
  buildUiDocumentMeta,
  loadUiProposals,
  uiProposalStorageKey,
  type UiProposalRecord,
} from './ui-builder.js';

/** Regions a mutation intent may not target (derived / read-only views). */
const READ_ONLY_REGIONS = new Set(['summary-panel', 'approval-panel']);

/** The live document driving the screen. A builder may replace it via a validated draft patch. */
let activeDocument: UiDocument = LESSON_REPORT_DOCUMENT;

/**
 * Teaching-report demo UI: a normal SPA whose business surfaces are driven by a
 * validated declarative UiDocument (catalog + data bindings + semantic events).
 * All mutation goes through semantic commands on the gateway; the production
 * cloud host/task/result sink behavior is unchanged.
 */

interface DemoState {
  manifest: Manifest;
  projection: Projection;
  actor: ActorInput;
  selectedRows: Set<string>;
  /** Focus set: stable selections that are context, not a command. */
  focusSelections: Selection[];
  lastCursor: number;
  lastResult?: CommandResult;
}

interface ArtifactResultRequest {
  sink_id: string;
  result_id: string;
  expected_state_revision?: string;
  payload: unknown;
}

interface ArtifactResultResponse {
  status: 'applied' | 'rejected' | 'failed';
  code?: string;
  message?: string;
  receipt?: Record<string, unknown>;
}

interface ArtifactPageAPI {
  getContext?: (options?: { include_events?: boolean; max_events?: number }) => unknown;
  applyResult?: (request: ArtifactResultRequest) => Promise<ArtifactResultResponse> | ArtifactResultResponse;
  isDirty?: () => boolean;
}

interface WindowWithArtifactSurface extends Window {
  catscoArtifact?: ArtifactPageAPI;
  catscoArtifactHost?: ArtifactHostPort;
}

function injectedArtifactHost(): ArtifactHostPort | null {
  if (typeof window === 'undefined') return null;
  try {
    const candidate = (window as WindowWithArtifactSurface).catscoArtifactHost;
    return detectArtifactHost(candidate) ? candidate : null;
  } catch {
    // A malformed or hostile global must not prevent the standalone page from
    // loading. The official bridge is optional and feature-detected only.
    return null;
  }
}

function hostConnected(host: ArtifactHostPort | null): boolean | undefined {
  if (!host?.isConnected) return undefined;
  try {
    return host.isConnected() === true;
  } catch {
    return false;
  }
}

function isResultRequest(value: unknown): value is ArtifactResultRequest {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const object = value as Record<string, unknown>;
    const allowed = new Set(['sink_id', 'result_id', 'expected_state_revision', 'payload']);
    if (Object.keys(object).some((key) => !allowed.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key))) return false;
    if (typeof object.sink_id !== 'string' || typeof object.result_id !== 'string' || !Object.hasOwn(object, 'payload')) return false;
    if (object.expected_state_revision !== undefined &&
        (typeof object.expected_state_revision !== 'string' || object.expected_state_revision.trim() !== object.expected_state_revision || object.expected_state_revision.length > 128)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resultFailure(code: string, message: string): ArtifactResultResponse {
  const failed = code === 'application_unavailable' || code === 'storage_failed';
  return { status: failed ? 'failed' : 'rejected', code, message: message.replace(/[\0\r\n]/g, ' ').slice(0, 500) };
}

function appliedReceipt(note: AgentNoteRecord, noteCount = 1): ArtifactResultResponse {
  return {
    status: 'applied',
    receipt: {
      result_id: note.result_id,
      state_revision: note.state_revision,
      note_count: noteCount,
      row_ids: [...note.row_ids],
    },
  };
}



function cloneArtifactResultResponse(response: ArtifactResultResponse): ArtifactResultResponse {
  return {
    ...response,
    ...(response.receipt !== undefined
      ? { receipt: JSON.parse(JSON.stringify(response.receipt)) as Record<string, unknown> }
      : {}),
  };
}

/** Project a bounded, one-line event ref for the opt-in history query. */
function eventRef(event: Event): CloudContextEventRef {
  return {
    seq: event.seq,
    type: event.type,
    actor_id: event.actor.id,
    summary: `${event.type} → ${JSON.stringify(event.data)}`,
  };
}

export class DemoApp {
  private state: DemoState | null = null;
  private watcher: ReturnType<typeof setTimeout> | null = null;
  private trigger: TriggerService | null = null;
  private bridgeClient: BridgeClient | null = null;
  private bridgeWatcher: ReturnType<typeof setTimeout> | null = null;
  private cloudHost: ArtifactHostPort | null = null;
  private cloudOutbox: CloudHostOutbox | null = null;
  private cloudReceiptUnsubscribe: (() => void) | null = null;
  private agentNotes: AgentNoteRecord[] = [];
  private notesStorageKey = AGENT_NOTES_STORAGE_KEY;
  private readonly resultReceipts = new Map<string, ArtifactResultResponse>();
  private readonly resultFingerprints = new Map<string, string>();
  private readonly pendingResults = new Map<string, Promise<ArtifactResultResponse>>();
  /** True while a stream turn is being processed; deliveries then queue. */
  private turnActive = false;
  /** Composer state kept across re-renders so keystrokes never lose focus. */
  private intentText = '';
  private runNote = '';
  private focusExpanded = false;
  private transportLabel = '';
  private actionStatus = '';
  /** Formal compose-ui Host outbox (only when an injected Cloud Host exists). */
  private uiOutbox: CloudHostOutbox | null = null;
  /** Builder panel intent, kept across re-renders so keystrokes never lose focus. */
  private uiIntentText = '';
  private uiBuilderStatus = '';
  private uiProposalManager = new UiProposalManager();
  private uiProposalStorageKey: string = UI_PROPOSAL_STORAGE_KEY;

  constructor(
    private readonly gateway: AxGateway,
    private readonly transport: string,
  ) {
    this.transportLabel = transport;
  }

  async start(): Promise<void> {
    // Install the synchronous page surface before any awaited auth/network
    // work. The official reader may ask for context as soon as the document is
    // embedded; the closures read the latest state once refresh completes.
    this.installArtifactSurface();
    const config = resolveConfig();
    const authClient = createAuthClient(config);
    // A host performs the CatsCo exchange before loading the SPA. Reading
    // the public session view here replaces the demo actor with the canonical
    // authenticated actor, so ContextBundle.actor_id cannot be spoofed by a
    // picker value.
    const authenticatedSession = authClient ? await hydrateSessionActor(config) : false;
    this.authenticated = authenticatedSession;

    // Intelligent trigger: focus set is context, the arbiter decides what happens.
    const bridgeClient = createBridgeClient(config);
    const cloudHost = injectedArtifactHost();
    const cloudOutbox = cloudHost
      ? new CloudHostOutbox({ host: cloudHost, taskIntentId: CLOUD_TASK_INTENT_ID })
      : null;
    const outbox: Outbox = cloudOutbox ?? (bridgeClient ? new BridgeOutbox({ client: bridgeClient }) : new MockOutbox());
    this.bridgeClient = bridgeClient;
    this.cloudHost = cloudHost;
    this.cloudOutbox = cloudOutbox;
    // Formal compose-ui Host outbox: it dispatches the compose-ui task through
    // the injected Host port only, with a bounded payload built from the current
    // UI document/config + app revision + user UI intent. No Host means this
    // stays null and the builder never pretends to dispatch a task.
    this.uiOutbox = cloudHost
      ? new CloudHostOutbox({
          host: cloudHost,
          taskIntentId: CLOUD_UI_TASK_INTENT_ID,
          payloadMapper: (bundle) => buildUiComposePayload({ bundle, document: activeDocument, workspaceId: config.workspaceId }),
        })
      : null;
    this.notesStorageKey = agentNotesStorageKey(config.workspaceId, config.artifactId, config.actor.id);
    this.agentNotes = loadAgentNotes(this.browserStorage(), this.notesStorageKey);
    this.uiProposalStorageKey = uiProposalStorageKey(config.workspaceId, config.artifactId, config.actor.id);
    this.uiProposalManager = new UiProposalManager({
      storage: this.browserStorage(),
      storageKey: this.uiProposalStorageKey,
      initial: loadUiProposals(this.browserStorage(), this.uiProposalStorageKey),
    });
    this.trigger = new TriggerService({
      outbox,
      actorId: config.actor.id,
      sessionProvider: () => 'topic_lesson_report',
      regionWritable: (regionId: string) => !READ_ONLY_REGIONS.has(regionId),
    });

    const effectiveTransportLabel = cloudOutbox
      ? `Cloud Artifact Host${hostConnected(cloudHost) === false ? ' (not connected)' : ''}`
      : this.transportLabel;
    this.transportLabel = effectiveTransportLabel;
    if (cloudOutbox) {
      this.cloudReceiptUnsubscribe = cloudOutbox.onReceipt(() => this.renderApp());
    }

    await this.refresh();
    this.applyDraft();

    if (bridgeClient && outbox instanceof BridgeOutbox) this.startBridgeWatch(bridgeClient, outbox);
    this.startWatch();
  }

  private async refresh(): Promise<void> {
    const config = resolveConfig();
    const [manifest, projection] = await Promise.all([
      this.gateway.describe({ workspace_id: config.workspaceId, artifact_id: config.artifactId, actor: this.state?.actor ?? config.actor }),
      this.gateway.inspect({
        workspace_id: config.workspaceId,
        artifact_id: config.artifactId,
        actor: this.state?.actor ?? config.actor,
        max_events: 25,
      }),
    ]);
    this.state = {
      manifest,
      projection,
      actor: this.state?.actor ?? config.actor,
      selectedRows: this.state?.selectedRows ?? new Set(),
      focusSelections: this.state?.focusSelections ?? [],
      lastCursor: projection.cursor,
      lastResult: this.state?.lastResult,
    };
    this.renderApp();
  }

  // -------------------------------------------------- semantic action dispatch

  /** Route a validated document event action to the domain/gateway handler. */
  private readonly dispatch: SemanticDispatch = (action, payload) => {
    switch (action) {
      case 'filterRows':
        void this.applyFilter(String(payload.status ?? 'all'));
        break;
      case 'toggleRow':
        this.onRowToggle(payload.row as ReviewRow, Boolean(payload.checked));
        break;
      case 'selectAll':
        this.toggleSelectAll(Boolean(payload.checked));
        break;
      case 'approveRows':
        void this.approveSelected();
        break;
      case 'focusRegion':
        this.focusRegion(String(payload.regionId ?? ''));
        break;
      case 'resolveApproval':
        void this.resolveLocal(payload.approval as Approval, payload.decision as 'approved' | 'rejected');
        break;
      case 'toggleFocus':
        this.toggleFocus();
        break;
      case 'focusNote':
        this.setFocusNote(String(payload.selectionId ?? ''), String(payload.note ?? ''));
        break;
      case 'focusRemove':
        this.removeFocusSelection(String(payload.selectionId ?? ''));
        break;
      case 'focusMove':
        this.moveFocusSelection(String(payload.selectionId ?? ''), payload.dir === 'up' ? 'up' : 'down');
        break;
      case 'intentInput':
        this.onIntentInput(String(payload.value ?? ''));
        break;
      case 'commitFocus':
        void this.commitFocus();
        break;
      case 'resumeBundle':
        void this.resumeCloudBundle(String(payload.bundleId ?? ''));
        break;
      case 'uiIntentInput':
        this.onUiIntentInput(String(payload.value ?? ''));
        break;
      case 'requestUiProposal':
        void this.requestUiProposal();
        break;
      case 'applyUiProposal':
        void this.applyUiProposal();
        break;
      case 'discardUiProposal':
        void this.discardUiProposal();
        break;
      case 'switchActor':
        this.switchActor(String(payload.actor ?? ''));
        break;
    }
  };

  private switchActor(value: string): void {
    const [id, type] = value.split(':') as [string, ActorInput['type']];
    const actor = ACTOR_OPTIONS.find((a) => a.id === id) ?? { id, type };
    if (this.state) this.state.actor = { ...actor, type };
    const config = resolveConfig();
    this.notesStorageKey = agentNotesStorageKey(config.workspaceId, config.artifactId, id);
    this.agentNotes = loadAgentNotes(this.browserStorage(), this.notesStorageKey);
    this.resultReceipts.clear();
    this.resultFingerprints.clear();
    // Reset the compose-ui builder to the new actor-scoped browser store.
    this.uiProposalStorageKey = uiProposalStorageKey(config.workspaceId, config.artifactId, id);
    this.uiProposalManager = new UiProposalManager({
      storage: this.browserStorage(),
      storageKey: this.uiProposalStorageKey,
      initial: loadUiProposals(this.browserStorage(), this.uiProposalStorageKey),
    });
    this.uiBuilderStatus = '';
    void this.refresh();
  }

  private async applyFilter(status: string): Promise<void> {
    if (!this.state) return;
    const result = await this.gateway.apply({
      command_id: crypto.randomUUID(),
      workspace_id: this.state.manifest.workspace_id,
      artifact_id: this.state.manifest.artifact_id,
      version: this.state.manifest.published_version,
      base_revision: this.state.projection.revision,
      actor: this.state.actor,
      name: 'filter_rows',
      args: { status },
      idempotency_key: `filter:${status}:${this.state.projection.revision}`,
    });
    this.recordResult(result, 'filter');
    await this.refresh();
  }

  private async approveSelected(): Promise<void> {
    if (!this.state || this.state.selectedRows.size === 0) return;
    const rowIds = [...this.state.selectedRows];
    const result = await this.gateway.apply({
      command_id: crypto.randomUUID(),
      workspace_id: this.state.manifest.workspace_id,
      artifact_id: this.state.manifest.artifact_id,
      version: this.state.manifest.published_version,
      base_revision: this.state.projection.revision,
      actor: this.state.actor,
      name: 'approve_rows',
      args: { row_ids: rowIds },
      idempotency_key: `approve:${[...rowIds].sort().join(',')}`,
    });
    this.recordResult(result, 'approve');
    await this.refresh();
  }

  private recordResult(result: CommandResult, label: string): void {
    if (!this.state) return;
    this.state.lastResult = result;
    switch (result.outcome) {
      case 'accepted':
        this.actionStatus = `${label}: accepted (revision ${result.revision})`;
        break;
      case 'pending_approval':
        this.actionStatus = `${label}: waiting for approval ${result.approval?.approval_id?.slice(0, 12)}…`;
        break;
      case 'conflict':
        this.actionStatus = `${label}: conflict; refresh and retry`;
        break;
      case 'rejected':
      case 'failed':
        this.actionStatus = `${label}: ${result.error?.code ?? result.outcome}: ${result.error?.message ?? ''}`;
        break;
    }
  }

  private async resolveLocal(approval: Approval, decision: 'approved' | 'rejected'): Promise<void> {
    if (!this.state) return;
    try {
      await this.gateway.resolveApproval({
        workspace_id: this.state.manifest.workspace_id,
        artifact_id: this.state.manifest.artifact_id,
        approval_id: approval.approval_id,
        decision,
        reviewer: this.state.actor,
      });
      await this.refresh();
    } catch (error) {
      this.actionStatus = `approval ${decision} failed: ${error instanceof Error ? error.message : String(error)}`;
      this.renderApp();
    }
  }

  private toggleSelectAll(checked: boolean): void {
    if (!this.state) return;
    const { rows } = this.tableState();
    const visibleIds = new Set(rows.map((row) => row.id));
    if (checked) {
      this.state.selectedRows = new Set([...this.state.selectedRows, ...visibleIds]);
      for (const row of rows) {
        const key = `${this.state.manifest.artifact_id}|${this.state.projection.revision}|review-table|${row.id}`;
        if (!this.state.focusSelections.some((selection) => `${selection.artifact_id}|${selection.revision}|${selection.region_id}|${selection.node_id ?? ''}` === key)) {
          this.state.focusSelections.push({
            selection_id: newSelectionId(),
            artifact_id: this.state.manifest.artifact_id,
            revision: this.state.projection.revision,
            region_id: 'review-table',
            region_title: 'Review table',
            node_id: row.id,
            label: `${row.student} · ${row.topic}`,
          });
        }
      }
    } else {
      for (const id of visibleIds) this.state.selectedRows.delete(id);
      this.state.focusSelections = this.state.focusSelections.filter(
        (selection) => !(selection.region_id === 'review-table' && selection.node_id && visibleIds.has(selection.node_id)),
      );
    }
    this.renderApp();
  }

  private onRowToggle(row: ReviewRow, checked: boolean): void {
    if (!this.state) return;
    if (checked) {
      this.state.selectedRows.add(row.id);
      this.addFocusNode(row);
    } else {
      this.state.selectedRows.delete(row.id);
      this.removeFocusSelectionForNode(row.id);
    }
    this.renderApp();
  }

  private tableState(): { rows: ReviewRow[]; table: ReviewTableState } {
    const region = this.state?.projection.regions.find((r) => r.region.id === 'review-table');
    const table = (region?.data ?? { rows: [], filter: {} }) as ReviewTableState;
    return { rows: filterRows(table), table };
  }

  // -------------------------------------------------- view model + document rendering

  private buildViewModel(): UIDocumentView {
    const manifest = this.state?.manifest ?? ({ artifact_id: 'lesson-report', workspace_id: 'ws_demo' } as unknown as Manifest);
    const projection = this.state?.projection ?? ({ revision: 0, pending_approvals: [], events: [] } as unknown as Projection);
    const { rows, table } = this.tableState();
    const counts = summarize(table);
    const selected = this.state ? [...this.state.selectedRows] : [];
    const approvals = projection.pending_approvals;
    const notes = this.agentNotes;
    const events = projection.events;
    const focus = this.state?.focusSelections ?? [];
    const assessment = focus.length === 0 ? '' : `${this.computeAssessment(focus)}`;
    return {
      manifest,
      projection,
      reviewTable: { rows, filter: table.filter, selected, actionStatus: this.actionStatus },
      summary: counts,
      approvals,
      focus: {
        count: focus.length,
        selections: focus,
        assessment,
        intent: this.intentText,
        runNote: this.runNote,
        expanded: this.focusExpanded,
        commitLabel: this.cloudOutbox ? 'Ask Agent with this context' : 'Compose context bundle',
      },
      agentNotes: notes,
      eventLines: events.slice(-12).map((event: Event) => `${event.seq} ${event.type} by ${event.actor.id} → ${JSON.stringify(event.data)}`),
      outbox: this.buildOutboxView(),
      uiBuilder: this.buildUiBuilderView(),
      transportNote: `transport: ${this.transportLabel}`,
    };
  }

  private computeAssessment(focus: Selection[]): string {
    if (!this.trigger || focus.length === 0) return '';
    const a = this.trigger.assess(focus, this.intentText);
    return `${a.intent_kind} · risk ${a.risk} · ${Math.round(a.confidence * 100)}%: ${a.rationale.join(' ')}`;
  }

  private buildShell(): ShellView {
    const config = resolveConfig();
    const manifest = this.state?.manifest;
    const revision = this.state?.projection.revision ?? 0;
    const includesConfigActor = ACTOR_OPTIONS.some((actor) => actor.id === config.actor.id);
    const options = [
      ...ACTOR_OPTIONS.map((actor) => ({ id: actor.id, type: actor.type ?? 'human', name: actor.name, selected: actor.id === config.actor.id })),
      ...(!includesConfigActor ? [{ id: config.actor.id, type: config.actor.type ?? 'human', name: config.actor.name ?? `Authenticated actor (${config.actor.id})`, selected: true }] : []),
    ];
    return {
      title: manifest?.title ?? 'Lesson report',
      versionLine: manifest ? `version ${manifest.published_version} · revision ${revision} · ${manifest.artifact_id} @ ${manifest.workspace_id}` : '',
      transportNote: `transport: ${this.transportLabel}`,
      actorValue: `${config.actor.id}:${config.actor.type ?? 'human'}`,
      actorOptions: options,
      actorDisabled: Boolean(this.authenticated),
      actorTitle: 'Actor is fixed by the authenticated Artifact session',
      onActorChange: (value) => this.dispatch('switchActor', { actor: value }),
    };
  }

  private authenticated = false;

  /**
   * Draft-only builder surface. Read a validated UiDocument patch from the
   * `?ui_patch=` query and, only if it passes the catalog allowlists, swap the
   * live document and re-render. Invalid patches surface as an error line and
   * never touch application state, the manifest, or production contracts.
   */
  private applyDraft(): void {
    const patch = readDraftPatchParam();
    if (patch === undefined) return;
    const result = applyUiDocumentPatch(activeDocument, patch);
    if (result.ok) {
      activeDocument = result.document;
      this.renderApp();
      return;
    }
    const note = document.getElementById('transport-note');
    if (note) note.textContent = `ui_draft rejected: ${result.message}`;
  }

  // -------------------------------------------------- formal compose-ui builder

  /** Store the Builder intent without re-rendering so keystrokes never lose focus. */
  private onUiIntentInput(value: string): void {
    this.uiIntentText = value;
  }

  /** Send the compose-ui task through the injected Cloud Host port (explicit action only). */
  private async requestUiProposal(): Promise<void> {
    if (!this.state || !this.uiOutbox) {
      this.uiBuilderStatus = 'No Cloud Artifact Host; a UI change request is only available in the embedded page.';
      this.renderApp();
      return;
    }
    const intent = this.uiIntentText.trim();
    if (!intent) {
      this.uiBuilderStatus = 'Describe the desired UI change before requesting it.';
      this.renderApp();
      return;
    }
    const bundle = buildUiComposeBundle({
      actorId: this.state.actor.id,
      artifactId: this.state.manifest.artifact_id,
      revision: this.state.projection.revision,
      sessionId: 'topic_lesson_report',
      intentText: intent,
    });
    this.uiBuilderStatus = 'Sending the UI change request through the Cloud Artifact Host…';
    this.renderApp();
    try {
      const receipt = await this.uiOutbox.send(bundle);
      const unavailable = receipt.task_status === 'unavailable' || receipt.status === 'unavailable';
      this.uiBuilderStatus = unavailable
        ? `Cloud Host did not create a task: ${receipt.message}`
        : receipt.ok
          ? `Cloud Host accepted the UI request${receipt.task_id ? ` (task ${receipt.task_id})` : ''}; a staged proposal will appear after the Agent turn.`
          : `Cloud Host rejected the UI request: ${receipt.message}`;
    } catch (error) {
      this.uiBuilderStatus = `UI request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.renderApp();
  }

  /** Human Apply: revalidate against the then-current document, apply, persist. */
  private async applyUiProposal(): Promise<void> {
    const result = this.uiProposalManager.apply(activeDocument);
    if (!result.ok) {
      this.uiBuilderStatus = result.record ? `Apply rejected: ${result.message}` : 'No staged UI proposal to apply.';
      this.renderApp();
      return;
    }
    activeDocument = result.document;
    this.uiBuilderStatus = `Applied ${result.record.summary} (document revision ${result.document.revision}).`;
    this.renderApp();
  }

  /** Human Discard: remove the staged proposal (never apply merely because it was delivered). */
  private async discardUiProposal(): Promise<void> {
    const result = this.uiProposalManager.discard();
    this.uiBuilderStatus = result.ok ? result.message : 'No staged UI proposal to discard.';
    this.renderApp();
  }

  private currentUiProposal(): UiProposalRecord | null {
    return this.uiProposalManager.current();
  }

  private buildUiBuilderView(): UiBuilderView {
    const proposal = this.currentUiProposal();
    const noHost = this.uiOutbox === null;
    const status = this.uiBuilderStatus || (noHost
      ? 'UI Builder needs an embedded Cloud Artifact Host; this standalone page does not dispatch a compose-ui task.'
      : 'Describe a bounded UI change to request it through the Cloud Artifact Host.');
    return {
      intent: this.uiIntentText,
      status,
      requestLabel: 'Request UI change',
      applyLabel: 'Apply proposal',
      discardLabel: 'Discard proposal',
      proposal: proposal
        ? {
            state: proposal.state,
            summary: proposal.summary,
            base_revision: proposal.base_revision,
            op_count: proposal.op_count,
            ...(proposal.applied_revision !== undefined ? { applied_revision: proposal.applied_revision } : {}),
            ...(proposal.error !== undefined ? { error: proposal.error } : {}),
          }
        : { state: 'none', summary: '', base_revision: 0, op_count: 0 },
      requestDisabled: noHost,
      applyDisabled: proposal === null || proposal.state === 'stale',
      discardDisabled: proposal === null,
    };
  }

  private renderApp(): void {
    if (typeof document === 'undefined') return;
    const root = document.getElementById('app');
    if (!root) return;
    // Defensive: the active document is validated before every render; a builder
    // draft may replace it only after passing the same validator (see applyDraft).
    const errors = validateDocument(activeDocument);
    if (errors.length > 0) {
      root.textContent = `UI document is invalid at render time: ${errors[0]}`;
      return;
    }
    renderApp(root, activeDocument, this.buildViewModel(), this.buildShell(), this.dispatch);
  }

  // -------------------------------------------------- focus set + trigger

  private focusSelections(): Selection[] {
    return this.state?.focusSelections ?? [];
  }

  private addFocusSelection(sel: Selection): void {
    if (!this.state) return;
    const key = `${sel.artifact_id}|${sel.revision}|${sel.region_id}|${sel.node_id ?? ''}`;
    const exists = this.state.focusSelections.some(
      (s) => `${s.artifact_id}|${s.revision}|${s.region_id}|${s.node_id ?? ''}` === key,
    );
    if (!exists) this.state.focusSelections.push(sel);
    this.renderApp();
  }

  private addFocusNode(row: ReviewRow): void {
    if (!this.state) return;
    this.addFocusSelection({
      selection_id: newSelectionId(),
      artifact_id: this.state.manifest.artifact_id,
      revision: this.state.projection.revision,
      region_id: 'review-table',
      region_title: 'Review table',
      node_id: row.id,
      label: `${row.student} · ${row.topic}`,
    });
  }

  private focusRegion(regionId: string): void {
    if (!this.state) return;
    const region = this.state.manifest.regions.find((r) => r.id === regionId);
    this.addFocusSelection({
      selection_id: newSelectionId(),
      artifact_id: this.state.manifest.artifact_id,
      revision: this.state.projection.revision,
      region_id: regionId,
      region_title: region?.title,
      label: region?.title ?? regionId,
    });
  }

  private removeFocusSelection(selectionId: string): void {
    if (!this.state) return;
    const sel = this.state.focusSelections.find((s) => s.selection_id === selectionId);
    if (sel?.node_id) this.state.selectedRows.delete(sel.node_id);
    this.state.focusSelections = this.state.focusSelections.filter((s) => s.selection_id !== selectionId);
    this.renderApp();
  }

  private removeFocusSelectionForNode(nodeId: string): void {
    if (!this.state) return;
    this.state.focusSelections = this.state.focusSelections.filter(
      (s) => !(s.region_id === 'review-table' && s.node_id === nodeId),
    );
    this.renderApp();
  }

  private moveFocusSelection(selectionId: string, dir: 'up' | 'down'): void {
    if (!this.state) return;
    const arr = this.state.focusSelections;
    const idx = arr.findIndex((s) => s.selection_id === selectionId);
    const to = dir === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || to < 0 || to >= arr.length) return;
    const a = arr[idx]!;
    const b = arr[to]!;
    arr[idx] = b;
    arr[to] = a;
    this.renderApp();
  }

  private toggleFocus(): void {
    this.focusExpanded = !this.focusExpanded;
    this.renderApp();
  }

  private setFocusNote(selectionId: string, note: string): void {
    const sel = this.focusSelections().find((s) => s.selection_id === selectionId);
    if (sel) sel.note = note;
    // No re-render on keystroke: the input already reflects the value.
  }

  private onIntentInput(value: string): void {
    this.intentText = value;
    this.renderAssessment();
  }

  /** Narrow update of the live assessment line only (preserves textarea focus). */
  private renderAssessment(): void {
    const focus = this.focusSelections();
    const assessment = focus.length === 0 ? '' : this.computeAssessment(focus);
    const out = document.getElementById('focus-assessment');
    if (out) out.textContent = assessment;
    const commit = document.getElementById('focus-commit') as HTMLButtonElement | null;
    if (commit) commit.disabled = focus.length === 0;
  }

  private async commitFocus(): Promise<void> {
    if (!this.state || !this.trigger) return;
    const sels = this.state.focusSelections;
    if (sels.length === 0) return;
    const intent = this.intentText;
    const deferred = this.turnActive;
    let note = '';
    try {
      const result = await this.trigger.execute(sels, intent, { defer: deferred });
      const failed = result.receipts.filter((receipt) => !receipt.ok).length;
      const cloudStaged = this.cloudOutbox
        ? result.receipts.filter((receipt) => {
            const cloud = receipt as Partial<CloudHostDeliveryReceipt>;
            return cloud.task_status === 'unavailable' && cloud.kind === 'queued';
          }).length
        : 0;
      if (deferred) {
        note = this.cloudOutbox
          ? 'Run active: the Cloud task stayed local and was not injected mid-turn; resend it explicitly after this turn.'
          : 'Run active: bundles queued for the next turn, not injected mid-turn.';
      } else if (this.cloudOutbox) {
        note = cloudStaged > 0
          ? `Cloud Host created ${result.receipts.length - cloudStaged} task${result.receipts.length - cloudStaged === 1 ? '' : 's'}; ${cloudStaged} additional context${cloudStaged === 1 ? '' : 's'} stayed queued for a separate explicit click.`
          : failed === 0
          ? `Cloud Host accepted ${result.receipts.length} context ${result.receipts.length === 1 ? 'task' : 'tasks'}; the Agent turn and application receipt appear below.`
          : `Cloud Host did not create ${failed} ${failed === 1 ? 'task' : 'tasks'}; inspect the staged receipt below.`;
      } else if (this.bridgeClient) {
        note = failed === 0
          ? `Bridge accepted ${result.receipts.length} context ${result.receipts.length === 1 ? 'bundle' : 'bundles'}; receipt state is shown below.`
          : `Bridge delivery failed for ${failed} ${failed === 1 ? 'bundle' : 'bundles'}; inspect the receipt below.`;
      }
    } catch (error) {
      note = `Context delivery failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.runNote = note;
    this.renderApp();
  }

  // -------------------------------------------------- Cloud Artifact page contract

  /**
   * Install the optional page-authored API consumed by the official Cloud HTML
   * Artifact bridge.  It is feature-detected and additive: a directly opened
   * page has no Host, but can still use every normal SPA control.
   */
  private installArtifactSurface(): void {
    if (typeof window === 'undefined') return;
    const target = window as WindowWithArtifactSurface;
    try {
      const prior = target.catscoArtifact ?? {};
      target.catscoArtifact = {
        ...prior,
        getContext: (options?: { include_events?: boolean; max_events?: number }) => this.semanticContext(options),
        applyResult: (request) => this.applyArtifactResult(request),
        isDirty: () => false,
      };
    } catch {
      // A publisher may expose a non-configurable page surface. Keep the
      // application usable even when an embedding policy prevents extension.
    }
  }

  /** Synchronous, bounded, read-only semantic context for OBSERVE/TASK reads. */
  private semanticContext(options?: { include_events?: boolean; max_events?: number }): Record<string, unknown> {
    if (!this.state) {
      return { view: 'lesson-report', semantic_mode: 'final-state', state_revision: '0', dirty: false };
    }
    const { rows, table } = this.tableState();
    return buildSemanticContext({
      revision: this.state.projection.revision,
      table,
      visibleRows: rows,
      selections: this.state.focusSelections,
      notes: this.agentNotes,
      documentMeta: buildUiDocumentMeta(activeDocument),
      ...(options?.include_events
        ? {
            includeEvents: true,
            maxEvents: options.max_events ?? 5,
            events: this.state.projection.events.map(eventRef),
          }
        : {}),
    });
  }

  /**
   * Result sink implementation. The official injected bridge validates the
   * outer envelope; this method validates the sink and business payload again,
   * checks optimistic revision continuity, persists through localStorage, and
   * only then returns `applied`.
   */
  private applyArtifactResult(request: ArtifactResultRequest): Promise<ArtifactResultResponse> {
    let resultId = '';
    try {
      resultId = typeof request?.result_id === 'string' ? request.result_id : '';
    } catch {
      return Promise.resolve(resultFailure('invalid_request', 'result request is invalid'));
    }
    if (resultId === '') return this.applyArtifactResultOnce(request).then(cloneArtifactResultResponse);
    // Sink-scoped idempotency key: the same result id must never collide with a
    // different sink (e.g. an agent-note result id reused for a UI patch).
    const requestKey = `${String(request?.sink_id ?? '')}::${resultId}`;
    const pending = this.pendingResults.get(requestKey);
    if (pending) return pending.then(cloneArtifactResultResponse);
    const promise = this.applyArtifactResultOnce(request);
    this.pendingResults.set(requestKey, promise);
    void promise.then(
      () => {
        if (this.pendingResults.get(requestKey) === promise) this.pendingResults.delete(requestKey);
      },
      () => {
        if (this.pendingResults.get(requestKey) === promise) this.pendingResults.delete(requestKey);
      },
    );
    return promise.then(cloneArtifactResultResponse);
  }

  private async applyArtifactResultOnce(request: ArtifactResultRequest): Promise<ArtifactResultResponse> {
    if (!this.state) return resultFailure('application_unavailable', 'application state is not ready');
    if (!isResultRequest(request)) return resultFailure('invalid_request', 'result request is invalid');
    if (request.sink_id === CLOUD_UI_RESULT_SINK_ID) return this.applyUiDocumentResult(request);
    if (request.sink_id !== CLOUD_RESULT_SINK_ID) return resultFailure('unknown_sink', 'result sink is not declared by this application');
    if (!isCloudResultId(request.result_id)) return resultFailure('invalid_result_id', 'result id is invalid');

    const existing = this.agentNotes.find((note) => note.result_id === request.result_id);
    const knownRows = new Set(
      ((this.state.projection.regions.find((region) => region.region.id === 'review-table')?.data as ReviewTableState | undefined)?.rows ?? [])
        .map((row) => row.id),
    );
    try {
      // Keep the runtime contract in lock-step with artifact-manifest.json.
      validateResultPayload(AGENT_NOTE_RESULT_SCHEMA, request.payload);
    } catch (error) {
      return resultFailure('invalid_payload', error instanceof Error ? error.message : 'result payload does not match the declared sink schema');
    }
    const checked = validateAgentNotePayload(request.payload, knownRows);
    if (!checked.ok) return resultFailure(checked.code, checked.message);
    const payload = checked.value;
    const fingerprint = noteFingerprint(payload);

    const cachedReceipt = this.resultReceipts.get(request.result_id);
    if (cachedReceipt) {
      return this.resultFingerprints.get(request.result_id) === fingerprint
        ? cloneArtifactResultResponse(cachedReceipt)
        : resultFailure('idempotency_conflict', 'result id was already applied with a different payload');
    }

    if (existing) {
      const priorFingerprint = noteFingerprint({
        summary: existing.summary,
        row_ids: existing.row_ids,
        recommendations: existing.recommendations,
      });
      if (priorFingerprint !== fingerprint) return resultFailure('idempotency_conflict', 'result id was already applied with a different payload');
      const prior = appliedReceipt(existing, this.agentNotes.length);
      this.resultReceipts.set(request.result_id, prior);
      this.resultFingerprints.set(request.result_id, fingerprint);
      return cloneArtifactResultResponse(prior);
    }

    const currentRevision = String(this.state.projection.revision);
    if (request.expected_state_revision !== undefined && request.expected_state_revision !== currentRevision) {
      return resultFailure('state_conflict', `expected state revision ${request.expected_state_revision} does not match ${currentRevision}`);
    }

    const note: AgentNoteRecord = {
      result_id: request.result_id,
      summary: payload.summary,
      row_ids: payload.row_ids ?? [],
      recommendations: payload.recommendations ?? [],
      state_revision: currentRevision,
      applied_at: new Date().toISOString(),
    };
    const nextNotes = [...this.agentNotes, note].slice(-20);
    if (!saveAgentNotes(this.browserStorage(), nextNotes, this.notesStorageKey)) {
      return resultFailure('storage_failed', 'the application could not persist the Agent note');
    }
    this.agentNotes = nextNotes;
    const receipt = appliedReceipt(note, nextNotes.length);
    this.resultReceipts.set(request.result_id, receipt);
    this.resultFingerprints.set(request.result_id, fingerprint);
    this.renderApp();
    return receipt;
  }

  private async applyUiDocumentResult(request: ArtifactResultRequest): Promise<ArtifactResultResponse> {
    if (!this.state) return resultFailure('application_unavailable', 'application state is not ready');
    if (!isCloudResultId(request.result_id)) return resultFailure('invalid_result_id', 'result id is invalid');
    try {
      // Manifest-layer envelope bounds (object/array bounds only).
      validateResultPayload(UI_PATCH_RESULT_SCHEMA, request.payload);
    } catch (error) {
      return resultFailure('invalid_payload', error instanceof Error ? error.message : 'UI patch proposal does not match the declared sink schema');
    }
    // Exact catalog / op / anchor / stale validation, plus sink-scoped
    // idempotency and durable staging, happen in the manager. A delivered patch
    // is *staged only*; a human applies or discards it later.
    const result = this.uiProposalManager.stage({
      result_id: request.result_id,
      payload: request.payload,
      document: activeDocument,
    });
    if (!result.ok) return resultFailure(result.code, result.message);
    this.uiBuilderStatus = `Staged ${result.record.summary}; review and apply or discard it.`;
    this.renderApp();
    return { status: 'applied', receipt: { ...result.receipt } };
  }

  private browserStorage(): Storage | undefined {
    if (typeof window === 'undefined') return undefined;
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------- outbox view model

  private buildOutboxView(): { label: string; items: OutboxItemView[] } {
    const label = this.trigger ? `outbox: ${this.trigger.outboxLabel()}` : '';
    if (this.cloudOutbox) {
      const receipts = this.cloudOutbox.listReceipts();
      return {
        label,
        items: receipts.map((receipt: CloudHostDeliveryReceipt) => {
          const state = !receipt.ok
            ? receipt.kind === 'rejected' ? 'rejected' : 'failed'
            : receipt.task_status === 'unavailable'
            ? receipt.kind
            : receipt.application_status === 'rejected' || receipt.application_status === 'failed'
              ? receipt.application_status
              : receipt.task_status;
          const canResume = receipt.ok
            && receipt.kind === 'queued'
            && receipt.task_status === 'unavailable'
            && this.cloudOutbox?.isResumable(receipt.bundle_id) === true;
          const meta: string[] = [];
          if (receipt.task_id) meta.push(`task ${receipt.task_id}`);
          if (receipt.application_status) meta.push(`application receipt: ${receipt.application_status}`);
          return {
            kind: 'receipt',
            bundleId: receipt.bundle_id,
            state,
            stateKind: this.stateKind(state),
            title: receipt.bundle_id,
            message: receipt.message,
            meta,
            canResume,
          };
        }),
      };
    }
    if (this.bridgeClient) {
      const receipts = this.trigger?.outboxReceipts() ?? [];
      return {
        label,
        items: receipts.map((receipt) => {
          const state = receipt.bridged_state ?? receipt.kind;
          const meta: string[] = [];
          if (receipt.receipt_id) meta.push(`receipt ${receipt.receipt_id}`);
          return {
            kind: 'receipt',
            bundleId: receipt.bundle_id,
            state,
            stateKind: this.stateKind(state),
            title: receipt.bundle_id,
            message: receipt.message,
            meta,
            canResume: false,
          };
        }),
      };
    }
    const bundles = this.trigger?.outboxBundles() ?? [];
    return {
      label,
      items: bundles.map((b: ContextBundle) => ({
        kind: 'bundle',
        bundleId: b.bundle_id,
        state: b.decision,
        stateKind: this.stateKind(b.decision),
        title: `${b.selections.length} ${b.selections.length === 1 ? 'item' : 'items'} · ${b.artifact_id}`,
        message: `intent: ${b.intent.text || '(none · collect only)'} · ${b.assessment.intent_kind} · risk ${b.assessment.risk} · ${Math.round(b.assessment.confidence * 100)}%\ndelivery: ${b.delivery}: ${b.assessment.rationale.join(' ')}`,
        meta: [`@${b.session_id}`, ...(b.context_ref ? [`context_ref: ${b.context_ref}`] : [])],
        canResume: false,
      })),
    };
  }

  private stateKind(state: string): OutboxItemView['stateKind'] {
    if (state === 'approved' || state === 'accepted' || state === 'completed' || state === 'acknowledged' || state === 'sent' || state === 'send') return 'approved';
    if (state === 'rejected' || state === 'expired' || state === 'failed' || state === 'unavailable' || state === 'confirm') return 'rejected';
    if (state === 'suggest' || state === 'queued' || state === 'needs_confirm' || state === 'collecting' || state === 'suggested') return 'pending';
    return 'decision';
  }

  private async resumeCloudBundle(bundleId: string): Promise<void> {
    if (!this.cloudOutbox || bundleId === '' || !this.cloudOutbox.isResumable(bundleId)) return;
    this.runNote = 'Sending the staged context through the Cloud Artifact Host…';
    this.renderApp();
    try {
      const receipt = await this.cloudOutbox.resume(bundleId);
      this.runNote = receipt.ok && receipt.task_id
        ? 'Cloud Host accepted the staged context; follow its task and application receipt below.'
        : receipt.ok
          ? 'The staged context remains queued; use Send now after the Host is connected and the click is active.'
          : `Cloud Host could not send the staged context: ${receipt.message}`;
    } catch (error) {
      this.runNote = `Cloud Host resume failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.renderApp();
  }

  private startBridgeWatch(client: BridgeClient, outbox: BridgeOutbox): void {
    const run = async (): Promise<void> => {
      try {
        for await (const envelope of client.watch(undefined, { timeoutMs: 60000 })) {
          if (envelope.kind === 'receipt') {
            outbox.ingest(envelope.receipt);
            this.renderApp();
          }
        }
      } catch {
        // The bridge is opt-in and may be started after the SPA. Retry without
        // surfacing a noisy error in the normal app event log.
      }
      this.bridgeWatcher = setTimeout(() => void run(), 1000);
    };
    void run();
  }

  private startWatch(): void {
    const config = resolveConfig();
    if (!this.state) return;
    const run = async (): Promise<void> => {
      try {
        const cursor = this.state?.lastCursor ?? 0;
        for await (const envelope of this.gateway.watch({
          workspace_id: config.workspaceId,
          artifact_id: config.artifactId,
          actor: this.state?.actor ?? config.actor,
          cursor,
          timeout_ms: 60000,
        })) {
          if (envelope.kind === 'event' && this.state) {
            this.state.lastCursor = envelope.event.seq;
            if (envelope.event.type.startsWith('capability.') || envelope.event.type.startsWith('approval.')) {
              // A run is active: fold the turn in, and let a concurrent focus
              // commit queue rather than pretend to inject mid-turn.
              this.turnActive = true;
              await this.refresh();
              this.turnActive = false;
            }
          } else if (envelope.kind === 'done') {
            break;
          }
        }
        this.watcher = setTimeout(() => void run(), 250);
      } catch {
        this.watcher = setTimeout(() => void run(), 1000);
      }
    };
    void run();
  }
}

export async function initDemo(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('missing #app root');
  const config = resolveConfig();
  const { gateway, transport } = await createGateway(config);
  const demo = new DemoApp(gateway, transport);
  await demo.start();
}

// Exposed for the draft/builder surface (dev-only) — see the ui-draft test hook.
export function currentDocument(): UiDocument {
  return activeDocument;
}

if (typeof document !== 'undefined') {
  void initDemo().catch((error) => {
    const note = document.getElementById('transport-note');
    if (note) note.textContent = `boot failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(error);
  });
}
