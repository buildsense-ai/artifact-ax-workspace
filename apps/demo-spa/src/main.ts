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

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

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
  if (state === 'rejected' || state === 'expired') return 'badge-rejected';
  return 'badge-pending';
}

export class DemoApp {
  private state: DemoState | null = null;
  private watcher: ReturnType<typeof setTimeout> | null = null;
  private trigger: TriggerService | null = null;
  private bridgeClient: BridgeClient | null = null;
  private bridgeWatcher: ReturnType<typeof setTimeout> | null = null;
  /** True while a stream turn is being processed; deliveries then queue. */
  private turnActive = false;

  constructor(
    private readonly gateway: AxGateway,
    private readonly transportLabel: string,
  ) {}

  async start(): Promise<void> {
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
    // The outbox is the honest transport seam: a MockOutbox by default, or a
    // BridgeOutbox when an external Agent Bridge is configured (?bridge=<url>).
    const bridgeClient = createBridgeClient(config);
    const outbox: Outbox = bridgeClient ? new BridgeOutbox({ client: bridgeClient }) : new MockOutbox();
    this.bridgeClient = bridgeClient;
    this.trigger = new TriggerService({
      outbox,
      actorId: config.actor.id,
      sessionProvider: () => 'topic_lesson_report',
      regionWritable: (regionId: string) => !READ_ONLY_REGIONS.has(regionId),
    });
    $('outbox-label').textContent = `outbox: ${this.trigger.outboxLabel()}`;
    document.querySelectorAll<HTMLElement>('[data-region-focus]').forEach((btn) => {
      btn.addEventListener('click', () => this.focusRegion(btn.dataset.regionFocus ?? ''));
    });
    $('focus-toggle').addEventListener('click', () => this.toggleFocus());
    $('focus-intent').addEventListener('input', () => this.onIntentInput());
    $('focus-commit').addEventListener('click', () => void this.commitFocus());
    $('focus-list').addEventListener('click', (e) => this.onFocusListAction(e as MouseEvent));
    $('focus-list').addEventListener('input', (e) => this.onFocusNote(e as InputEvent));

    $('transport-note').textContent = `transport: ${this.transportLabel}`;
    document.title = `Lesson report · ${this.transportLabel}`;

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
      if (deferred) {
        note.hidden = false;
        note.textContent = 'Run active: bundles queued for the next turn, not injected mid-turn.';
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
