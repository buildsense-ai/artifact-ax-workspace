import {
  asList,
  asRecord,
  asString,
  resolvePath,
  type UiDocument,
  type UiNode,
} from '@artifact-ax/ui-document';
import type { Approval } from '@artifact-ax/contract';
import type { ReviewRow } from '@artifact-ax/lesson-report';
import type { Selection } from '@artifact-ax/trigger';
import type { AgentNoteRecord } from '../cloud-surface.js';
import type { OutboxItemView, UIDocumentView } from './view-model.js';

/**
 * The constrained catalog renderer.
 *
 * It walks a validated `UiDocument` and renders each approved surface from the
 * catalog, resolving data bindings against the projection-derived `UIDocumentView`
 * and wiring semantic events through the provided dispatch. It never emits
 * untrusted text as HTML (all dynamic text is set via `textContent`), never
 * reads raw props as markup, and never allows an arbitrary document to add a
 * surface that is not in the fixed catalog.
 */

export type SemanticDispatch = (action: string, payload: Record<string, unknown>) => void;

type Child = string | HTMLElement | (string | HTMLElement)[] | undefined | null;

function append(target: HTMLElement, child: Child): void {
  if (child === undefined || child === null) return;
  if (typeof child === 'string') {
    target.appendChild(document.createTextNode(child));
  } else if (Array.isArray(child)) {
    for (const item of child) append(target, item);
  } else {
    target.appendChild(child);
  }
}

/** Build an element; string children and attrs are always handled as text/data. */
function el(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) append(node, child);
  return node;
}

function statusBadge(status: string): HTMLElement {
  const cls = status === 'approved' ? 'badge-approved' : status === 'rejected' ? 'badge-rejected' : 'badge-pending';
  return el('span', { class: `badge ${cls}` }, status);
}

function receiptBadge(state: string): HTMLElement {
  const cls =
    state === 'completed' || state === 'acknowledged' || state === 'accepted' || state === 'sent' ? 'badge-approved'
    : state === 'rejected' || state === 'expired' || state === 'failed' || state === 'unavailable' ? 'badge-rejected'
    : 'badge-pending';
  return el('span', { class: `badge ${cls}` }, state);
}

/** A region shell: standard `.region` wrapper with an optional focus action. */
export function surfaceAnchors(node: UiNode): { regionId: string; nodeId: string } {
  return { regionId: asString(node.props?.regionId, node.id), nodeId: node.id };
}

function regionShell(node: UiNode, title: string, onFocus?: () => void): HTMLElement {
  const { regionId, nodeId } = surfaceAnchors(node);
  const section = el('section', { class: 'region', 'data-region-id': regionId, 'data-node-id': nodeId, 'aria-label': title });
  const head = el('div', { class: 'region-head' }, el('h2', {}, title));
  const tools = el('div', { class: 'region-tools' });
  if (onFocus) {
    const focusBtn = el('button', { class: 'btn btn-small', 'data-region-focus': regionId, type: 'button' }, 'Focus region');
    focusBtn.addEventListener('click', onFocus);
    tools.appendChild(focusBtn);
  }
  if (tools.childNodes.length > 0) head.appendChild(tools);
  section.appendChild(head);
  return section;
}

interface NodeCtx {
  node: UiNode;
  bindings: Record<string, unknown>;
  view: UIDocumentView;
  dispatch: SemanticDispatch;
  /** Resolve a catalog event to its allowlisted action and dispatch it. */
  act: (eventName: string, payload: Record<string, unknown>) => void;
}

function renderReviewTable(ctx: NodeCtx): HTMLElement {
  const { node, bindings, act } = ctx;
  const rows = asList(bindings.rows) as ReviewRow[];
  const filter = asRecord(bindings.filter);
  const selected = new Set(asList(bindings.selected) as string[]);
  const actionStatus = asString(bindings.actionStatus, '');
  const regionTitle = asString(node.props?.regionTitle, 'Review table');
  const emptyText = asString(node.props?.emptyText, 'No rows to show.');
  const section = regionShell(node, regionTitle, node.events?.focus ? () => act('focus', { regionId: asString(node.props?.regionId, node.id) }) : undefined);

  const tools = section.querySelector('.region-tools') as HTMLElement;
  const status = asString(filter.status ?? 'all');
  const filterSelect = el('select', { id: 'filter-select', 'aria-label': 'Filter rows by status' },
    ['all', 'pending', 'approved', 'rejected'].map((value) =>
      el('option', { value }, value[0]!.toUpperCase() + value.slice(1)),
    ),
  );
  (filterSelect as HTMLSelectElement).value = status;
  filterSelect.addEventListener('change', () => {
    act('filter', { status: (filterSelect as HTMLSelectElement).value });
  });
  tools.appendChild(el('label', {}, ['Status ', filterSelect]));

  const tableWrap = el('div', { class: 'table-wrap' });
  const table = el('table', { id: 'rows-table' });
  const thead = el('thead', {},
    el('tr', {},
      el('th', {}, (() => {
        const box = el('input', { type: 'checkbox', id: 'select-all', 'aria-label': 'Select all visible rows' });
        (box as HTMLInputElement).checked = rows.length > 0 && rows.every((row) => selected.has(row.id));
        box.addEventListener('change', () => act('selectAll', { checked: (box as HTMLInputElement).checked }));
        return box;
      })()),
      el('th', {}, 'Student'),
      el('th', {}, 'Topic'),
      el('th', {}, 'Status'),
    ),
  );
  const tbody = el('tbody', { id: 'rows-body' });
  if (rows.length === 0) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: '4' }, emptyText)));
  }
  for (const row of rows) {
    const checkbox = el('input', { type: 'checkbox', class: 'row-select', 'aria-label': `Select ${row.student} · ${row.topic}` });
    (checkbox as HTMLInputElement).checked = selected.has(row.id);
    checkbox.setAttribute('data-row-id', row.id);
    checkbox.addEventListener('change', () => act('rowToggle', { row, checked: (checkbox as HTMLInputElement).checked }));
    tbody.appendChild(el('tr', { 'data-row-id': row.id, 'data-node-id': row.id },
      el('td', {}, checkbox),
      el('td', {}, row.student),
      el('td', {}, row.topic),
      el('td', {}, statusBadge(row.status)),
    ));
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  const approveBtn = el('button', { id: 'approve-rows-btn', class: 'btn btn-primary', type: 'button' }, 'Approve selected rows');
  (approveBtn as HTMLButtonElement).disabled = selected.size === 0;
  approveBtn.addEventListener('click', () => act('approve', {}));
  const statusLine = el('span', { id: 'action-status', class: 'muted', role: 'status' }, actionStatus);

  section.appendChild(tableWrap);
  section.appendChild(el('div', { class: 'region-actions' }, approveBtn, statusLine));
  return section;
}

function renderSummaryList(ctx: NodeCtx): HTMLElement {
  const { node, bindings, act } = ctx;
  const counts = asRecord(bindings.counts);
  const regionTitle = asString(node.props?.regionTitle, 'Summary');
  const section = regionShell(node, regionTitle, node.events?.focus ? () => act('focus', { regionId: asString(node.props?.regionId, node.id) }) : undefined);
  const list = el('ul', { id: 'summary-list', class: 'summary-list' });
  const entries: [string, unknown][] = [['Total', counts.total], ['Pending', counts.pending], ['Approved', counts.approved], ['Rejected', counts.rejected]];
  for (const [label, value] of entries) {
    list.appendChild(el('li', {}, el('span', {}, label), el('strong', {}, asString(value, '0'))));
  }
  section.appendChild(list);
  return section;
}

function renderApprovalList(ctx: NodeCtx): HTMLElement {
  const { node, bindings, act } = ctx;
  const approvals = asList(bindings.approvals) as Approval[];
  const regionTitle = asString(node.props?.regionTitle, 'Approvals');
  const emptyText = asString(node.props?.emptyText, 'No pending approvals.');
  const section = regionShell(node, regionTitle);
  const list = el('div', { id: 'approval-list', class: 'approval-list' });
  if (approvals.length === 0) {
    list.appendChild(el('p', { class: 'muted' }, emptyText));
  } else {
    for (const approval of approvals) {
      const card = el('div', { class: 'approval-card', 'data-approval-id': approval.approval_id },
        el('p', {}, el('strong', {}, approval.message)),
        el('p', { class: 'muted' }, `${approval.kind}${approval.capability ? ` · ${approval.capability}` : ''} · requested by ${approval.requested_by.id}`),
      );
      const actions = el('div', { class: 'approval-actions' });
      const approve = el('button', { class: 'btn btn-approve', type: 'button', 'data-approval': approval.approval_id }, 'Approve');
      approve.addEventListener('click', () => act('approve', { approval, decision: 'approved' }));
      const reject = el('button', { class: 'btn btn-reject', type: 'button', 'data-approval': approval.approval_id }, 'Reject');
      reject.addEventListener('click', () => act('reject', { approval, decision: 'rejected' }));
      actions.appendChild(approve);
      actions.appendChild(reject);
      card.appendChild(actions);
      list.appendChild(card);
    }
  }
  section.appendChild(list);
  return section;
}

function renderFocusComposer(ctx: NodeCtx): HTMLElement {
  const { node, bindings, act } = ctx;
  const regionTitle = asString(node.props?.regionTitle, 'Focus set');
  const hint = asString(node.props?.hint, '');
  const count = Number(bindings.count ?? 0);
  const selections = asList(bindings.selections) as Selection[];
  const assessment = asString(bindings.assessment, '');
  const intent = asString(bindings.intent, '');
  const runNote = asString(bindings.runNote, '');
  const commitLabel = asString(bindings.commitLabel, 'Compose context bundle');
  const expanded = Boolean((ctx.view as UIDocumentView).focus.expanded);

  const regionId = asString(node.props?.regionId, 'focus-set');
  const section = el('section', { class: 'region region-focus', 'data-region-id': regionId, 'data-node-id': node.id, 'aria-label': regionTitle });
  const countBadge = el('span', { id: 'focus-count', class: 'badge badge-pending' }, String(count));
  const toggle = el('button', { id: 'focus-toggle', class: 'btn btn-small', type: 'button', 'aria-expanded': String(expanded), 'aria-controls': 'focus-body' }, expanded ? 'Close' : 'Compose');
  toggle.addEventListener('click', () => act('toggle', {}));
  section.appendChild(el('div', { class: 'region-head' },
    el('h2', {}, regionTitle),
    el('div', { class: 'region-tools' }, countBadge, toggle),
  ));

  const body = el('div', { id: 'focus-body', class: 'focus-body' });
  if (!expanded) body.setAttribute('hidden', '');
  if (hint) body.appendChild(el('p', { class: 'muted focus-hint' }, hint));

  const list = el('ul', { id: 'focus-list', class: 'focus-list' });
  if (selections.length === 0) {
    list.appendChild(el('li', { class: 'muted' }, 'No selections yet. Click a region’s “Focus region” button or check rows.'));
  } else {
    selections.forEach((selection, index) => {
      const li = el('li', { class: 'focus-item', 'data-selection-id': selection.selection_id });
      const main = el('div', { class: 'focus-item-main' });
      const reorder = el('span', { class: 'focus-item-reorder' });
      const up = el('button', { class: 'btn btn-mini', type: 'button', 'aria-label': 'Move up' }, '↑');
      if (index === 0) (up as HTMLButtonElement).disabled = true;
      up.addEventListener('click', () => act('move', { selectionId: selection.selection_id, dir: 'up' }));
      const down = el('button', { class: 'btn btn-mini', type: 'button', 'aria-label': 'Move down' }, '↓');
      if (index === selections.length - 1) (down as HTMLButtonElement).disabled = true;
      down.addEventListener('click', () => act('move', { selectionId: selection.selection_id, dir: 'down' }));
      reorder.appendChild(up);
      reorder.appendChild(down);
      const label = el('span', { class: 'focus-item-label' }, selection.label);
      const remove = el('button', { class: 'btn btn-mini', type: 'button', 'aria-label': `Remove ${selection.label}` }, '✕');
      remove.addEventListener('click', () => act('remove', { selectionId: selection.selection_id }));
      main.appendChild(reorder);
      main.appendChild(label);
      main.appendChild(remove);
      li.appendChild(main);
      const noteInput = el('input', { class: 'focus-item-note', type: 'text', placeholder: 'Optional note', 'aria-label': `Note for ${selection.label}` });
      (noteInput as HTMLInputElement).value = selection.note ?? '';
      noteInput.addEventListener('input', () => act('note', { selectionId: selection.selection_id, note: (noteInput as HTMLInputElement).value }));
      li.appendChild(noteInput);
      list.appendChild(li);
    });
  }
  body.appendChild(list);

  const intentLabel = el('label', { for: 'focus-intent' }, 'One intent (empty means collect only)');
  const intentTextarea = el('textarea', { id: 'focus-intent', rows: '2', placeholder: 'e.g. review these, 解释一下, delete these rows' });
  (intentTextarea as HTMLTextAreaElement).value = intent;
  intentTextarea.addEventListener('input', () => act('intent', { value: (intentTextarea as HTMLTextAreaElement).value }));
  body.appendChild(el('div', { class: 'field' }, intentLabel, intentTextarea));

  const assessmentLine = el('p', { id: 'focus-assessment', class: 'focus-assessment muted', role: 'status' }, assessment);
  const runNoteLine = el('p', { id: 'focus-run-note', class: 'muted focus-run-note' }, runNote);
  if (runNote) runNoteLine.removeAttribute('hidden'); else runNoteLine.setAttribute('hidden', '');
  const commit = el('button', { id: 'focus-commit', class: 'btn btn-primary', type: 'button' }, commitLabel);
  (commit as HTMLButtonElement).disabled = selections.length === 0;
  commit.addEventListener('click', () => act('commit', {}));
  body.appendChild(assessmentLine);
  body.appendChild(runNoteLine);
  body.appendChild(el('div', { class: 'region-actions' }, commit));

  section.appendChild(body);
  return section;
}

function renderAgentNotes(ctx: NodeCtx): HTMLElement {
  const { node, bindings } = ctx;
  const notes = asList(bindings.notes) as AgentNoteRecord[];
  const regionTitle = asString(node.props?.regionTitle, 'Agent notes');
  const emptyText = asString(node.props?.emptyText, 'No Agent notes yet.');
  const section = regionShell(node, regionTitle);
  section.appendChild(el('span', { class: 'muted' }, 'durable application writeback'));
  const list = el('ul', { id: 'agent-notes-list', class: 'outbox-list' });
  if (notes.length === 0) {
    list.appendChild(el('li', { class: 'muted' }, emptyText));
  } else {
    for (const note of [...notes].reverse()) {
      const li = el('li', { class: 'agent-note-item' });
      li.appendChild(el('p', { class: 'agent-note-summary' }, note.summary));
      const meta = `Rows: ${note.row_ids.join(', ')} · ${note.applied_at}`;
      li.appendChild(el('p', { class: 'outbox-meta muted' }, note.row_ids.length > 0 ? meta : note.applied_at));
      if (note.recommendations.length > 0) {
        const ul = el('ul', { class: 'agent-note-recommendations' });
        for (const rec of note.recommendations) ul.appendChild(el('li', {}, rec));
        li.appendChild(ul);
      }
      list.appendChild(li);
    }
  }
  section.appendChild(list);
  return section;
}

function renderEventLog(ctx: NodeCtx): HTMLElement {
  const { node, bindings } = ctx;
  const lines = asList(bindings.lines) as string[];
  const regionTitle = asString(node.props?.regionTitle, 'Recent events');
  const section = regionShell(node, regionTitle);
  const pre = el('pre', { id: 'event-log', class: 'event-log' }, lines.length === 0 ? '(no events yet; commands will appear here)' : lines.join('\n'));
  section.appendChild(pre);
  return section;
}

function renderOutbox(ctx: NodeCtx): HTMLElement {
  const { node, bindings, act } = ctx;
  const items = asList(bindings.items) as OutboxItemView[];
  const label = asString(bindings.label, '');
  const regionTitle = asString(node.props?.regionTitle, 'Context bundles');
  const emptyText = asString(node.props?.emptyText, 'No context bundles yet.');
  const section = regionShell(node, regionTitle);
  section.appendChild(el('span', { class: 'muted' }, 'context payloads or bridge delivery receipts'));
  section.appendChild(el('p', { id: 'outbox-label', class: 'muted' }, label));
  const list = el('ul', { id: 'outbox-list', class: 'outbox-list' });
  if (items.length === 0) {
    list.appendChild(el('li', { class: 'muted' }, emptyText));
  } else {
    for (const item of items) {
      const li = el('li', { class: 'outbox-item', 'data-bundle-id': item.bundleId });
      const head = el('div', { class: 'outbox-head' },
        receiptBadge(item.state),
        el('span', { class: 'outbox-title' }, item.title ?? item.bundleId),
      );
      if (item.meta) for (const meta of item.meta) head.appendChild(el('span', { class: 'muted' }, meta));
      li.appendChild(head);
      if (item.message) li.appendChild(el('p', { class: 'outbox-meta muted' }, item.message));
      if (item.canResume) {
        const resume = el('button', { class: 'btn btn-small', type: 'button', 'data-cloud-resume': item.bundleId }, 'Send now');
        resume.addEventListener('click', () => act('resume', { bundleId: item.bundleId }));
        li.appendChild(resume);
      }
      list.appendChild(li);
    }
  }
  section.appendChild(list);
  return section;
}

/** Render one catalog node into a standalone region element. */
export function renderNode(node: UiNode, view: UIDocumentView, dispatch: SemanticDispatch): HTMLElement {
  const bindings: Record<string, unknown> = {};
  if (node.bindings) {
    for (const [name, path] of Object.entries(node.bindings)) {
      bindings[name] = resolvePath(view, path);
    }
  }
  const ctx: NodeCtx = {
    node,
    bindings,
    view,
    dispatch,
    act: (eventName, payload) => {
      const action = node.events?.[eventName];
      if (action) dispatch(action, payload);
    },
  };
  switch (node.kind) {
    case 'review-table':
      return renderReviewTable(ctx);
    case 'summary-list':
      return renderSummaryList(ctx);
    case 'approval-list':
      return renderApprovalList(ctx);
    case 'focus-composer':
      return renderFocusComposer(ctx);
    case 'agent-notes':
      return renderAgentNotes(ctx);
    case 'event-log':
      return renderEventLog(ctx);
    case 'context-outbox':
      return renderOutbox(ctx);
    default:
      throw new Error(`UI-document renderer does not implement catalog kind "${node.kind}"`);
  }
}

export interface ShellView {
  title: string;
  versionLine: string;
  transportNote: string;
  actorValue: string;
  actorOptions: { id: string; type: string; name?: string; selected?: boolean }[];
  actorDisabled: boolean;
  actorTitle?: string;
  onActorChange: (value: string) => void;
}

/** Render the app chrome + document surfaces directly into the `#app` root. */
export function renderApp(
  root: HTMLElement,
  document: UiDocument,
  view: UIDocumentView,
  shell: ShellView,
  dispatch: SemanticDispatch,
): void {
  // Header (app chrome, not a business surface; title/actor from the view/config).
  const header = el('header', { class: 'app-header', 'aria-label': 'Artifact identity' });
  header.appendChild(el('div', {},
    el('h1', { id: 'artifact-title' }, shell.title),
    el('p', { id: 'artifact-version', class: 'muted' }, shell.versionLine),
  ));
  const pickerWrap = el('label', { class: 'actor-picker' }, 'Acting as');
  const actorSelect = el('select', { id: 'actor-select', 'aria-label': 'Current actor' });
  for (const option of shell.actorOptions) {
    const node = el('option', { value: `${option.id}:${option.type}` }, option.name ?? option.id);
    (node as HTMLOptionElement).selected = Boolean(option.selected);
    actorSelect.appendChild(node);
  }
  (actorSelect as HTMLSelectElement).value = shell.actorValue;
  (actorSelect as HTMLSelectElement).disabled = shell.actorDisabled;
  if (shell.actorDisabled && shell.actorTitle) actorSelect.title = shell.actorTitle;
  actorSelect.addEventListener('change', () => shell.onActorChange((actorSelect as HTMLSelectElement).value));
  pickerWrap.appendChild(actorSelect);
  header.appendChild(pickerWrap);

  // Document surfaces, placed into a main/side layout with full-width nodes below.
  const mainNodes = document.nodes.filter((n) => (n.placement ?? 'main') === 'main');
  const sideNodes = document.nodes.filter((n) => n.placement === 'side');
  const fullNodes = document.nodes.filter((n) => n.placement === 'full');

  const layout = el('section', { class: 'layout' });
  layout.appendChild(el('div', { class: 'region-column' }, mainNodes.map((n) => renderNode(n, view, dispatch))));
  layout.appendChild(el('aside', { class: 'side' }, sideNodes.map((n) => renderNode(n, view, dispatch))));

  const footer = el('footer', { class: 'muted' }, el('span', { id: 'transport-note' }, shell.transportNote));

  root.replaceChildren(header, layout, ...fullNodes.map((n) => renderNode(n, view, dispatch)), footer);
}
