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
} from './cloud-surface.js';
import {
  validateResultPayload,
} from '@artifact-ax/contract';
import { resolveConfig, createGateway, createBridgeClient, createAuthClient, hydrateSessionActor, ACTOR_OPTIONS } from './transport.js';

/** Regions a mutation intent may not target (derived / read-only views). */
const READ_ONLY_REGIONS = new Set(['summary-panel', 'approval-panel']);

/**
 * Teaching-report demo UI: a normal SPA with stable region identifiers,
 * a manifest-driven command surface, an approval panel, and an event log.
 * All mutation goes through semantic commands on the gateway.
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
  getContext?: () => unknown;
  applyResult?: (request: ArtifactResultRequest) => Promise<ArtifactResultResponse> | ArtifactResultResponse;
  isDirty?: () => boolean;
}

interface WindowWithArtifactSurface extends Window {
  catscoArtifact?: ArtifactPageAPI;
  catscoArtifactHost?: ArtifactHostPort;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

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

function statusBadge(status: string): string {
  const cls = status === 'approved' ? 'badge-approved' : status === 'rejected' ? 'badge-rejected' : 'badge-pending';
  return `<span class="badge ${cls}">${status}</span>`;
}

function rowTableRow(row: ReviewRow, selected: boolean): string {
  return `<tr data-row-id="${row.id}" data-node-id="${row.id}">
    <td><input type="checkbox" class="row-select" data-row-id="${row.id}" aria-label="Select ${escapeHtml(row.student)} · ${escapeHtml(row.topic)}" ${selected ? 'checked' : ''} /></td>
    <td>${escapeHtml(row.student)}</td>
    <td>${escapeHtml(row.topic)}</td>
    <td>${statusBadge(row.status)}</td>
  </tr>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function decisionBadge(decision: string): string {
  switch (decision) {
    case 'send':
      return 'badge-approved';
    case 'confirm':
      return 'badge-rejected';
    case 'suggest':
      return 'badge-pending';
    default:
      return 'badge-decision';
  }
}

function receiptBadge(state: string): string {
  if (state === 'completed' || state === 'acknowledged' || state === 'accepted') return 'badge-approved';
  if (state === 'rejected' || state === 'expired' || state === 'failed' || state === 'unavailable') return 'badge-rejected';
  return 'badge-pending';
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

  constructor(
    private readonly gateway: AxGateway,
    private readonly transportLabel: string,
  ) {}

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
    ACTOR_OPTIONS.forEach((actor) => {
      const option = document.createElement('option');
      option.value = `${actor.id}:${actor.type}`;
      option.textContent = actor.name ?? actor.id;
      const picker = $<HTMLSelectElement>('actor-select');
      if (actor.id === config.actor.id) option.selected = true;
      picker.appendChild(option);
    });
    if (!ACTOR_OPTIONS.some((actor) => actor.id === config.actor.id)) {
      const option = document.createElement('option');
      option.value = `${config.actor.id}:${config.actor.type ?? 'human'}`;
      option.textContent = config.actor.name ?? `Authenticated actor (${config.actor.id})`;
      option.selected = true;
      $<HTMLSelectElement>('actor-select').appendChild(option);
    }
    const actorPicker = $<HTMLSelectElement>('actor-select');
    actorPicker.disabled = authenticatedSession;
    if (authenticatedSession) actorPicker.title = 'Actor is fixed by the authenticated Artifact session';
    actorPicker.addEventListener('change', (e) => this.switchActor((e.target as HTMLSelectElement).value));
    $('filter-select').addEventListener('change', () => void this.applyFilter());
    $('approve-rows-btn').addEventListener('click', () => void this.approveSelected());
    $('select-all').addEventListener('change', (e) => this.toggleSelectAll((e.target as HTMLInputElement).checked));
    $('rows-body').addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.classList.contains('row-select')) {
        const row = this.tableState().rows.find((r) => r.id === (target.dataset.rowId ?? ''));
        if (row) this.onRowToggle(row, target.checked);
      }
    });

    // Intelligent trigger: focus set is context, the arbiter decides what happens.
    // A connected Cloud Artifact Host is the production path. The local bridge
    // remains an explicit development adapter, and MockOutbox keeps a directly
    // opened/static page useful when neither external surface is available.
    const bridgeClient = createBridgeClient(config);
    const cloudHost = injectedArtifactHost();
    const cloudOutbox = cloudHost
      ? new CloudHostOutbox({ host: cloudHost, taskIntentId: CLOUD_TASK_INTENT_ID })
      : null;
    const outbox: Outbox = cloudOutbox ?? (bridgeClient ? new BridgeOutbox({ client: bridgeClient }) : new MockOutbox());
    this.bridgeClient = bridgeClient;
    this.cloudHost = cloudHost;
    this.cloudOutbox = cloudOutbox;
    this.notesStorageKey = agentNotesStorageKey(config.workspaceId, config.artifactId, config.actor.id);
    this.agentNotes = loadAgentNotes(this.browserStorage(), this.notesStorageKey);
    this.trigger = new TriggerService({
      outbox,
      actorId: config.actor.id,
      sessionProvider: () => 'topic_lesson_report',
      regionWritable: (regionId: string) => !READ_ONLY_REGIONS.has(regionId),
    });
    $('outbox-label').textContent = `outbox: ${this.trigger.outboxLabel()}`;
    if (cloudOutbox) {
      // Receipt updates are emitted for submitted/running/completed as well as
      // terminal failures. Rendering them locally never sends a second task.
      this.cloudReceiptUnsubscribe = cloudOutbox.onReceipt(() => this.renderOutbox());
      const commit = $<HTMLButtonElement>('focus-commit');
      commit.textContent = 'Ask Agent with this context';
      const connected = hostConnected(cloudHost) ?? true;
      $('transport-note').textContent = connected
        ? 'transport: Cloud Artifact Host (task loop; visible Agent turn)'
        : 'transport: Cloud Artifact Host unavailable until the trusted host connects';
    }
    document.querySelectorAll<HTMLElement>('[data-region-focus]').forEach((btn) => {
      btn.addEventListener('click', () => this.focusRegion(btn.dataset.regionFocus ?? ''));
    });
    $('focus-toggle').addEventListener('click', () => this.toggleFocus());
    $('focus-intent').addEventListener('input', () => this.onIntentInput());
    $('focus-commit').addEventListener('click', () => void this.commitFocus());
    $('focus-list').addEventListener('click', (e) => this.onFocusListAction(e as MouseEvent));
    $('focus-list').addEventListener('input', (e) => this.onFocusNote(e as InputEvent));
    $('outbox-list').addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-cloud-resume]');
      if (button) void this.resumeCloudBundle(button.dataset.cloudResume ?? '');
    });

    const effectiveTransportLabel = cloudOutbox
      ? `Cloud Artifact Host${hostConnected(cloudHost) === false ? ' (not connected)' : ''}`
      : this.transportLabel;
    $('transport-note').textContent = `transport: ${effectiveTransportLabel}`;
    document.title = `Lesson report · ${effectiveTransportLabel}`;

    await this.refresh();
    this.updateFocusChrome();
    this.renderOutbox();
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
    this.render();
  }

  private switchActor(value: string): void {
    const [id, type] = value.split(':') as [string, ActorInput['type']];
    const actor = ACTOR_OPTIONS.find((a) => a.id === id) ?? { id, type };
    if (this.state) this.state.actor = { ...actor, type };
    const config = resolveConfig();
    this.notesStorageKey = agentNotesStorageKey(config.workspaceId, config.artifactId, id);
    this.agentNotes = loadAgentNotes(this.browserStorage(), this.notesStorageKey);
    this.resultReceipts.clear();
    this.resultFingerprints.clear();
    void this.refresh();
  }

  private async applyFilter(): Promise<void> {
    if (!this.state) return;
    const status = $<HTMLSelectElement>('filter-select').value;
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
    const status = $('action-status');
    switch (result.outcome) {
      case 'accepted':
        status.textContent = `${label}: accepted (revision ${result.revision})`;
        break;
      case 'pending_approval':
        status.textContent = `${label}: waiting for approval ${result.approval?.approval_id?.slice(0, 12)}…`;
        break;
      case 'conflict':
        status.textContent = `${label}: conflict; refresh and retry`;
        break;
      case 'rejected':
      case 'failed':
        status.textContent = `${label}: ${result.error?.code ?? result.outcome}: ${result.error?.message ?? ''}`;
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
      $('action-status').textContent = `approval ${decision} failed: ${error instanceof Error ? error.message : String(error)}`;
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
    this.renderTable();
    this.refreshFocusUI();
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
    this.renderTable();
  }

  private tableState(): { rows: ReviewRow[]; table: ReviewTableState } {
    const region = this.state?.projection.regions.find((r) => r.region.id === 'review-table');
    const table = (region?.data ?? { rows: [], filter: {} }) as ReviewTableState;
    return { rows: filterRows(table), table };
  }

  private render(): void {
    if (!this.state) return;
    const { manifest, projection } = this.state;
    $('artifact-title').textContent = manifest.title;
    $('artifact-version').textContent = `version ${manifest.published_version} · revision ${projection.revision} · ${manifest.artifact_id} @ ${manifest.workspace_id}`;
    this.renderTable();
    this.renderSummary();
    this.renderApprovals();
    this.renderEvents();
    this.renderAgentNotes();
    this.updateFocusChrome();
  }

  private renderTable(): void {
    if (!this.state) return;
    const { rows } = this.tableState();
    const body = $<HTMLElement>('rows-body');
    body.innerHTML = rows.map((row) => rowTableRow(row, this.state!.selectedRows.has(row.id))).join('');
    $<HTMLButtonElement>('approve-rows-btn').disabled = this.state.selectedRows.size === 0;
    $<HTMLInputElement>('select-all').checked =
      rows.length > 0 && rows.every((row) => this.state!.selectedRows.has(row.id));
  }

  private renderSummary(): void {
    if (!this.state) return;
    const { table } = this.tableState();
    const counts = summarize(table);
    $('summary-list').innerHTML = [
      ['Total', counts.total],
      ['Pending', counts.pending],
      ['Approved', counts.approved],
      ['Rejected', counts.rejected],
    ]
      .map(([label, value]) => `<li><span>${label}</span><strong>${value}</strong></li>`)
      .join('');
  }

  private renderApprovals(): void {
    if (!this.state) return;
    const pending = this.state.projection.pending_approvals;
    const list = $<HTMLElement>('approval-list');
    if (pending.length === 0) {
      list.innerHTML = '<p class="muted">No pending approvals.</p>';
      return;
    }
    list.innerHTML = pending
      .map(
        (approval) => `<div class="approval-card">
          <p><strong>${escapeHtml(approval.message)}</strong></p>
          <p class="muted">${approval.kind}${approval.capability ? ` · ${approval.capability}` : ''} · requested by ${escapeHtml(approval.requested_by.id)}</p>
          <div class="approval-actions">
            <button class="btn btn-approve" data-approval="${approval.approval_id}" data-decision="approved">Approve</button>
            <button class="btn btn-reject" data-approval="${approval.approval_id}" data-decision="rejected">Reject</button>
          </div>
        </div>`,
      )
      .join('');
    list.querySelectorAll('button[data-approval]').forEach((button) => {
      button.addEventListener('click', () => {
        const approval = pending.find((a) => a.approval_id === button.getAttribute('data-approval'));
        if (approval) void this.resolveLocal(approval, button.getAttribute('data-decision') as 'approved' | 'rejected');
      });
    });
  }

  private renderEvents(): void {
    if (!this.state) return;
    const events = this.state.projection.events;
    const lines = events
      .slice(-12)
      .map((event: Event) => `${event.seq} ${event.type} by ${event.actor.id} → ${JSON.stringify(event.data)}`)
      .join('\n');
    $('event-log').textContent = lines === '' ? '(no events yet; commands will appear here)' : lines;
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
        getContext: () => this.semanticContext(),
        applyResult: (request) => this.applyArtifactResult(request),
        isDirty: () => false,
      };
    } catch {
      // A publisher may expose a non-configurable page surface. Keep the
      // application usable even when an embedding policy prevents extension.
    }
  }

  /** Synchronous, bounded, read-only semantic context for OBSERVE/TASK reads. */
  private semanticContext(): Record<string, unknown> {
    if (!this.state) {
      return { view: 'lesson-report', state_revision: '0', dirty: false };
    }
    const { rows, table } = this.tableState();
    return buildSemanticContext({
      revision: this.state.projection.revision,
      table,
      visibleRows: rows,
      selections: this.state.focusSelections,
      notes: this.agentNotes,
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
    const pending = this.pendingResults.get(resultId);
    if (pending) return pending.then(cloneArtifactResultResponse);
    const promise = this.applyArtifactResultOnce(request);
    this.pendingResults.set(resultId, promise);
    void promise.then(
      () => {
        if (this.pendingResults.get(resultId) === promise) this.pendingResults.delete(resultId);
      },
      () => {
        if (this.pendingResults.get(resultId) === promise) this.pendingResults.delete(resultId);
      },
    );
    return promise.then(cloneArtifactResultResponse);
  }

  private async applyArtifactResultOnce(request: ArtifactResultRequest): Promise<ArtifactResultResponse> {
    if (!this.state) return resultFailure('application_unavailable', 'application state is not ready');
    if (!isResultRequest(request)) return resultFailure('invalid_request', 'result request is invalid');
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
    this.renderAgentNotes();
    return receipt;
  }

  private browserStorage(): Storage | undefined {
    if (typeof window === 'undefined') return undefined;
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }

  private renderAgentNotes(): void {
    const list = document.getElementById('agent-notes-list');
    if (!list) return;
    if (this.agentNotes.length === 0) {
      list.innerHTML = '<li class="muted">No Agent notes yet. A completed Cloud task will appear here.</li>';
      return;
    }
    list.innerHTML = [...this.agentNotes]
      .reverse()
      .map((note) => `<li class="agent-note-item">
        <p class="agent-note-summary">${escapeHtml(note.summary)}</p>
        <p class="outbox-meta muted">${note.row_ids.length > 0 ? `Rows: ${escapeHtml(note.row_ids.join(', '))} · ` : ''}${escapeHtml(note.applied_at)}</p>
        ${note.recommendations.length > 0 ? `<ul class="agent-note-recommendations">${note.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
      </li>`)
      .join('');
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
    this.refreshFocusUI();
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
    this.renderTable(); // uncheck the corresponding row, if any
    this.refreshFocusUI();
  }

  private removeFocusSelectionForNode(nodeId: string): void {
    if (!this.state) return;
    this.state.focusSelections = this.state.focusSelections.filter(
      (s) => !(s.region_id === 'review-table' && s.node_id === nodeId),
    );
    this.refreshFocusUI();
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
    this.renderFocusList();
  }

  private toggleFocus(): void {
    const body = $<HTMLElement>('focus-body');
    const toggle = $<HTMLButtonElement>('focus-toggle');
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close' : 'Compose';
    if (open) {
      this.renderFocusList();
      this.renderLiveAssessment();
    }
  }

  private renderFocusList(): void {
    const list = $<HTMLElement>('focus-list');
    const sels = this.focusSelections();
    if (sels.length === 0) {
      list.innerHTML =
        '<li class="muted">No selections yet. Click a region’s “Focus region” button or check rows.</li>';
      return;
    }
    list.innerHTML = sels
      .map(
        (s, i) => `<li class="focus-item" data-selection-id="${escapeHtml(s.selection_id)}">
        <div class="focus-item-main">
          <span class="focus-item-reorder">
            <button class="btn btn-mini" data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-mini" data-act="down" aria-label="Move down" ${i === sels.length - 1 ? 'disabled' : ''}>↓</button>
          </span>
          <span class="focus-item-label">${escapeHtml(s.label)}</span>
          <button class="btn btn-mini" data-act="remove" aria-label="Remove ${escapeHtml(s.label)}">✕</button>
        </div>
        <input class="focus-item-note" data-act="note" value="${escapeHtml(s.note ?? '')}" placeholder="Optional note" aria-label="Note for ${escapeHtml(s.label)}" />
      </li>`,
      )
      .join('');
  }

  private onFocusListAction(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>('button[data-act]');
    if (!btn) return;
    const li = btn.closest<HTMLElement>('li[data-selection-id]');
    if (!li) return;
    const id = li.dataset.selectionId ?? '';
    const act = btn.dataset.act;
    if (act === 'remove') this.removeFocusSelection(id);
    else if (act === 'up' || act === 'down') this.moveFocusSelection(id, act);
  }

  private onFocusNote(e: InputEvent): void {
    const input = e.target as HTMLInputElement;
    if (!input.classList.contains('focus-item-note')) return;
    const li = input.closest<HTMLElement>('li[data-selection-id]');
    if (!li) return;
    const sel = this.focusSelections().find((s) => s.selection_id === li.dataset.selectionId);
    if (sel) sel.note = input.value;
  }

  private onIntentInput(): void {
    this.renderLiveAssessment();
  }

  private renderLiveAssessment(): void {
    const out = $<HTMLElement>('focus-assessment');
    const sels = this.focusSelections();
    $<HTMLButtonElement>('focus-commit').disabled = sels.length === 0;
    if (sels.length === 0 || !this.trigger) {
      out.textContent = '';
      return;
    }
    const text = ($('focus-intent') as HTMLTextAreaElement).value;
    const a = this.trigger.assess(sels, text);
    out.textContent =
      `${a.intent_kind} · risk ${a.risk} · ${Math.round(a.confidence * 100)}%: ${a.rationale.join(' ')}`;
  }

  private async commitFocus(): Promise<void> {
    if (!this.state || !this.trigger) return;
    const sels = this.state.focusSelections;
    if (sels.length === 0) return;
    const intent = ($('focus-intent') as HTMLTextAreaElement).value;
    const deferred = this.turnActive;
    try {
      const result = await this.trigger.execute(sels, intent, { defer: deferred });
      const failed = result.receipts.filter((receipt) => !receipt.ok).length;
      const note = $<HTMLElement>('focus-run-note');
      const cloudStaged = this.cloudOutbox
        ? result.receipts.filter((receipt) => {
            const cloud = receipt as Partial<CloudHostDeliveryReceipt>;
            return cloud.task_status === 'unavailable' && cloud.kind === 'queued';
          }).length
        : 0;
      if (deferred) {
        note.hidden = false;
        note.textContent = this.cloudOutbox
          ? 'Run active: the Cloud task stayed local and was not injected mid-turn; resend it explicitly after this turn.'
          : 'Run active: bundles queued for the next turn, not injected mid-turn.';
      } else if (this.cloudOutbox) {
        note.hidden = false;
        note.textContent = cloudStaged > 0
          ? `Cloud Host created ${result.receipts.length - cloudStaged} task${result.receipts.length - cloudStaged === 1 ? '' : 's'}; ${cloudStaged} additional context${cloudStaged === 1 ? '' : 's'} stayed queued for a separate explicit click.`
          : failed === 0
          ? `Cloud Host accepted ${result.receipts.length} context ${result.receipts.length === 1 ? 'task' : 'tasks'}; the Agent turn and application receipt appear below.`
          : `Cloud Host did not create ${failed} ${failed === 1 ? 'task' : 'tasks'}; inspect the staged receipt below.`;
      } else if (this.bridgeClient) {
        note.hidden = false;
        note.textContent = failed === 0
          ? `Bridge accepted ${result.receipts.length} context ${result.receipts.length === 1 ? 'bundle' : 'bundles'}; receipt state is shown below.`
          : `Bridge delivery failed for ${failed} ${failed === 1 ? 'bundle' : 'bundles'}; inspect the receipt below.`;
      } else {
        note.hidden = true;
      }
    } catch (error) {
      const note = $<HTMLElement>('focus-run-note');
      note.hidden = false;
      note.textContent = `Context delivery failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.renderOutbox();
  }

  private updateFocusChrome(): void {
    if (!this.state) return;
    $<HTMLElement>('focus-count').textContent = String(this.state.focusSelections.length);
    $<HTMLButtonElement>('focus-commit').disabled = this.state.focusSelections.length === 0;
  }

  private refreshFocusUI(): void {
    this.updateFocusChrome();
    this.renderFocusList();
    this.renderLiveAssessment();
  }

  private renderOutbox(): void {
    if (!this.trigger) return;
    const list = $<HTMLElement>('outbox-list');
    if (this.cloudOutbox) {
      const receipts = this.cloudOutbox.listReceipts();
      if (receipts.length === 0) {
        list.innerHTML = '<li class="muted">No Cloud tasks yet. Compose a focus set and explicitly ask the Agent.</li>';
        return;
      }
      list.innerHTML = receipts
        .map((receipt: CloudHostDeliveryReceipt) => {
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
          return `<li class="outbox-item" data-bundle-id="${escapeHtml(receipt.bundle_id)}">
          <div class="outbox-head">
            <span class="badge ${receiptBadge(state)}">${escapeHtml(state)}</span>
            <span class="outbox-title">${escapeHtml(receipt.bundle_id)}</span>
            ${receipt.task_id ? `<span class="muted">task ${escapeHtml(receipt.task_id)}</span>` : ''}
          </div>
          <p class="outbox-meta muted">${escapeHtml(receipt.message)}</p>
          ${receipt.application_status ? `<p class="outbox-meta muted">application receipt: ${escapeHtml(receipt.application_status)}</p>` : ''}
          ${canResume ? `<button class="btn btn-small" data-cloud-resume="${escapeHtml(receipt.bundle_id)}">Send now</button>` : ''}
        </li>`;
        })
        .join('');
      return;
    }
    if (this.bridgeClient) {
      const receipts = this.trigger.outboxReceipts();
      if (receipts.length === 0) {
        list.innerHTML = '<li class="muted">No bridge receipts yet. Compose a focus set to submit context.</li>';
        return;
      }
      list.innerHTML = receipts
        .map(
          (receipt) => `<li class="outbox-item" data-bundle-id="${escapeHtml(receipt.bundle_id)}">
          <div class="outbox-head">
            <span class="badge ${receiptBadge(receipt.bridged_state ?? receipt.kind)}">${escapeHtml(receipt.bridged_state ?? receipt.kind)}</span>
            <span class="outbox-title">${escapeHtml(receipt.bundle_id)}</span>
            ${receipt.receipt_id ? `<span class="muted">receipt ${escapeHtml(receipt.receipt_id)}</span>` : ''}
          </div>
          <p class="outbox-meta muted">${escapeHtml(receipt.message)}</p>
        </li>`,
        )
        .join('');
      return;
    }
    const bundles = this.trigger.outboxBundles();
    if (bundles.length === 0) {
      list.innerHTML = '<li class="muted">No context bundles yet. Compose a focus set to create one.</li>';
      return;
    }
    list.innerHTML = bundles
      .map(
        (b: ContextBundle) => `<li class="outbox-item" data-bundle-id="${escapeHtml(b.bundle_id)}">
        <div class="outbox-head">
          <span class="badge ${decisionBadge(b.decision)}">${escapeHtml(b.decision)}</span>
          <span class="outbox-title">${escapeHtml(String(b.selections.length))} ${b.selections.length === 1 ? 'item' : 'items'} · ${escapeHtml(b.artifact_id)}</span>
          <span class="muted">@${escapeHtml(b.session_id)}</span>
        </div>
        <p class="outbox-text"><strong>intent:</strong> ${escapeHtml(b.intent.text || '(none · collect only)')} · ${escapeHtml(b.assessment.intent_kind)} · risk ${escapeHtml(b.assessment.risk)} · ${Math.round(b.assessment.confidence * 100)}%</p>
        <p class="outbox-meta muted"><strong>delivery:</strong> ${escapeHtml(b.delivery)}: ${escapeHtml(b.assessment.rationale.join(' '))}</p>
        ${b.context_ref ? `<p class="outbox-meta muted"><strong>context_ref:</strong> ${escapeHtml(b.context_ref)}</p>` : ''}
      </li>`,
      )
      .join('');
  }

  private async resumeCloudBundle(bundleId: string): Promise<void> {
    if (!this.cloudOutbox || bundleId === '' || !this.cloudOutbox.isResumable(bundleId)) return;
    const note = $<HTMLElement>('focus-run-note');
    note.hidden = false;
    note.textContent = 'Sending the staged context through the Cloud Artifact Host…';
    try {
      const receipt = await this.cloudOutbox.resume(bundleId);
      note.textContent = receipt.ok && receipt.task_id
        ? 'Cloud Host accepted the staged context; follow its task and application receipt below.'
        : receipt.ok
          ? 'The staged context remains queued; use Send now after the Host is connected and the click is active.'
          : `Cloud Host could not send the staged context: ${receipt.message}`;
    } catch (error) {
      note.textContent = `Cloud Host resume failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.renderOutbox();
  }

  private startBridgeWatch(client: BridgeClient, outbox: BridgeOutbox): void {
    const run = async (): Promise<void> => {
      try {
        for await (const envelope of client.watch(undefined, { timeoutMs: 60000 })) {
          if (envelope.kind === 'receipt') {
            outbox.ingest(envelope.receipt);
            this.renderOutbox();
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
              this.renderOutbox();
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

if (typeof document !== 'undefined') {
  void initDemo().catch((error) => {
    const note = document.getElementById('transport-note');
    if (note) note.textContent = `boot failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(error);
  });
}
