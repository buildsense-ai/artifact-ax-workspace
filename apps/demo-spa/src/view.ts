import type { CollabIdentity, TaskStatusUpdate } from '@artifact-ax/contract';
import { identityLabel } from '@artifact-ax/contract';
import type { PresenceSnapshot } from '@artifact-ax/collab';
import type { JournalEntry } from '@artifact-ax/collab';
import type { ReviewRow, RowStatus } from '@artifact-ax/lesson-report';
import type { BoardSnapshot } from './board.js';
import type { ComparisonViewProposal, PrivateViewRecipe, ReopenedRecipe } from './domain.js';
import type { AnchorPick } from './annotate-anchor.js';
import { renderUiDocumentPreview } from './ui-render.js';
import { applyPatch } from '@artifact-ax/ui-document';
import type { UiDocument } from '@artifact-ax/ui-document';

/**
 * Direct-DOM renderer for the collaboration template. Everything rendered
 * through textContent; no application data ever becomes markup.
 */

export interface AppView {
  identity: CollabIdentity;
  via: string;
  embedded: boolean;
  hostConnected: boolean;
  roomKey: string;
  presence: PresenceSnapshot | null;
  board: BoardSnapshot;
  /** The live, agent-patchable shared canvas document. */
  canvas: UiDocument | null;
  selectedRowIds: Set<string>;
  journal: JournalEntry[];
  recipes: PrivateViewRecipe[];
  reopened: ReopenedRecipe | null;
  /** Derived agent activity — presence focus, or native task status. */
  agentActivity: string | null;
  /** Canvas-annotation mode + the picked element waiting for a note. */
  annotateMode: boolean;
  agentNotes: Array<{ summary: string; row_ids: string[]; at: string }>;
  taskStatuses: TaskStatusUpdate[];
  notice: string | null;
}

export interface AppHandlers {
  bindNotes(textarea: HTMLTextAreaElement, workItemId: string): void;
  setFilter(status: RowStatus | 'all'): void;
  toggleRow(id: string): void;
  approveSelected(): void;
  createWorkItem(): void;
  createFinding(workItemId: string, summary: string): void;
  addFeedback(findingId: string, revision: number, text: string): void;
  askAgent(findingId: string): void;
  useProposal(id: string): void;
  discardProposal(id: string): void;
  useCanvasPatch(id: string): void;
  discardCanvasPatch(id: string): void;
  saveRecipe(proposalId: string): void;
  toggleAnnotate(): void;
  submitAnnotations(items: Array<{ anchor: AnchorPick; text: string }>): void;
  retractAnnotation(id: string): void;
  locateAnnotation(id: string): void;
  reopenRecipe(recipeId: string): void;
}

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  const node = el('button', className, label) as HTMLButtonElement;
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export function renderApp(root: HTMLElement, view: AppView, handlers: AppHandlers): void {
  root.replaceChildren();
  root.appendChild(renderHeader(view, handlers));
  if (view.notice) root.appendChild(el('p', 'notice', view.notice));
  const grid = el('div', 'grid');
  grid.appendChild(renderReviewTable(view, handlers));
  grid.appendChild(renderWorkboard(view, handlers));
  grid.appendChild(renderCanvas(view, handlers));
  grid.appendChild(renderProposals(view, handlers));
  grid.appendChild(renderJournal(view));
  grid.appendChild(renderAgentNotes(view));
  grid.appendChild(renderAnnotations(view, handlers));
  root.appendChild(grid);

}

function renderHeader(view: AppView, handlers: AppHandlers): HTMLElement {
  const header = el('header', 'hdr');
  const title = el('div', 'hdr-title');
  title.appendChild(el('strong', '', 'Lesson report'));
  title.appendChild(el('span', 'muted', `room ${view.roomKey}`));
  header.appendChild(title);

  const who = el('div', 'hdr-who');
  who.appendChild(el('span', view.identity.authenticated ? 'badge ok' : 'badge', identityLabel(view.identity)));
  who.appendChild(el('span', 'muted', `via ${view.via}${view.embedded ? ' · embedded' : ' · standalone'}${view.hostConnected ? ' · host connected' : ''}`));
  const others = view.presence?.entries ?? [];
  if (others.length > 0) {
    const online = el('span', 'presence');
    for (const entry of others) {
      const chip = el('span', `chip${entry.kind === 'agent' ? ' agent' : ''}`);
      chip.appendChild(el('span', '', entry.username || entry.uid));
      if (entry.kind === 'agent' && entry.focus) {
        chip.appendChild(el('span', 'muted', ` · ${entry.focus}`));
      } else if (entry.focus) {
        chip.title = entry.focus;
      }
      online.appendChild(chip);
    }
    who.appendChild(online);
  }
  // Agent activity derived from the platform's own task stream — shown when
  // no agent presence doc is in play (a burst process need not heartbeat).
  if (view.agentActivity && !others.some((entry) => entry.kind === 'agent')) {
    who.appendChild(el('span', 'chip agent', view.agentActivity));
  }
  const annotate = button(view.annotateMode ? 'Annotating — click / drag / ⌥+scroll' : 'Annotate',
    () => handlers.toggleAnnotate(), `btn small${view.annotateMode ? ' accent' : ''}`);
  who.appendChild(annotate);
  header.appendChild(who);
  return header;
}

function renderReviewTable(view: AppView, handlers: AppHandlers): HTMLElement {
  const card = el('section', 'card');
  card.appendChild(el('h2', '', 'Review table'));
  const filters = el('div', 'row-actions');
  for (const status of ['pending', 'approved', 'rejected', 'all'] as const) {
    const b = button(status, () => handlers.setFilter(status), 'btn small');
    if (view.board.state.filter === status) b.classList.add('active');
    filters.appendChild(b);
  }
  card.appendChild(filters);

  const table = el('table', 'rows');
  const head = el('tr');
  for (const label of ['', 'Student', 'Topic', 'Status']) head.appendChild(el('th', '', label));
  table.appendChild(head);
  const rows: ReviewRow[] = view.board.state.rows.filter(
    (row) => view.board.state.filter === 'all' || row.status === view.board.state.filter,
  );
  for (const row of rows) {
    const tr = el('tr');
    tr.dataset.nodeId = row.id;
    tr.dataset.regionId = 'review-table';
    const cell = el('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = view.selectedRowIds.has(row.id);
    checkbox.addEventListener('change', () => handlers.toggleRow(row.id));
    cell.appendChild(checkbox);
    tr.appendChild(cell);
    tr.appendChild(el('td', '', row.student));
    tr.appendChild(el('td', '', row.topic));
    tr.appendChild(el('td', `status ${row.status}`, row.status));
    table.appendChild(tr);
  }
  card.appendChild(table);
  const actions = el('div', 'row-actions');
  actions.appendChild(button('Approve selected', handlers.approveSelected));
  actions.appendChild(button('New work item from selected', handlers.createWorkItem, 'btn accent'));
  card.appendChild(actions);
  return card;
}

function renderWorkboard(view: AppView, handlers: AppHandlers): HTMLElement {
  const card = el('section', 'card');
  card.appendChild(el('h2', '', 'Work items'));
  const items = view.board.workItems;
  if (items.length === 0) {
    card.appendChild(el('p', 'muted', 'Select rows and create a work item to start a shared comparison.'));
    return card;
  }
  for (const item of items) {
    const block = el('div', 'workitem');
    block.dataset.nodeId = item.id;
    block.dataset.regionId = 'workboard';
    block.appendChild(el('h3', '', `${item.title} `));
    block.lastElementChild?.appendChild(el('span', 'muted', `rows ${item.rowIds.join(', ')} · ${item.state}`));

    // Shared notes pad — the live Y.Text surface: every viewer types into
    // the same text and remote edits merge at character level.
    const notes = el('div', 'notes');
    const notesHead = el('div', 'notes-head');
    notesHead.appendChild(el('span', 'muted', 'Shared notes · live'));
    for (const entry of view.presence?.entries ?? []) {
      if (entry.focus === `notes:${item.id}`) {
        notesHead.appendChild(el('span', 'typing', `${entry.username || entry.uid} typing…`));
      }
    }
    notes.appendChild(notesHead);
    const textarea = document.createElement('textarea');
    textarea.className = 'notes-input';
    textarea.rows = 3;
    textarea.placeholder = 'Everyone types into the same notes — edits merge live.';
    textarea.dataset.focus = `notes:${item.id}`;
    notes.appendChild(textarea);
    block.appendChild(notes);
    handlers.bindNotes(textarea, item.id);

    const findings = view.board.findings.filter((finding) => finding.workItemId === item.id);
    if (findings.length === 0) {
      block.appendChild(el('p', 'muted', 'No findings yet.'));
    }
    for (const finding of findings) {
      const f = el('div', 'finding');
      f.appendChild(el('p', 'finding-summary', `rev ${finding.revision} — ${finding.summary}`));
      const feedbackList = view.board.feedback.filter((item2) => item2.findingId === finding.findingId);
      for (const feedback of feedbackList) {
        f.appendChild(el('p', 'feedback', `${feedback.actorId ?? 'someone'}: ${feedback.text}`));
      }
      const form = el('div', 'row-actions');
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Add feedback…';
      input.maxLength = 200;
      input.dataset.focus = `feedback:${finding.findingId}`;
      form.appendChild(input);
      form.appendChild(button('Add', () => {
        if (input.value.trim()) {
          handlers.addFeedback(finding.findingId, finding.revision, input.value.trim());
          input.value = '';
        }
      }, 'btn small'));
      form.appendChild(button('Ask agent', () => handlers.askAgent(finding.findingId), 'btn small accent'));
      f.appendChild(form);
      block.appendChild(f);
    }

    const create = el('div', 'row-actions');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'New finding summary…';
    input.maxLength = 200;
    input.dataset.focus = `newfinding:${item.id}`;
    create.appendChild(input);
    create.appendChild(button('Add finding', () => {
      if (input.value.trim()) {
        handlers.createFinding(item.id, input.value.trim());
        input.value = '';
      }
    }, 'btn small'));
    block.appendChild(create);
    card.appendChild(block);
  }
  return card;
}

/**
 * Snapshot view model for a staged agent-authored document: the proposal's
 * rows resolved to ReviewRow data, status counts over them, and the work
 * item's feedback lines for `notes` bindings. Static — previews never wire
 * events and never bind live board streams.
 */
function proposalViewModel(view: AppView, proposal: ComparisonViewProposal): Record<string, unknown> {
  const rows = proposal.rowIds.map((id) => {
    const row = view.board.state.rows.find((candidate) => candidate.id === id);
    return row
      ? { id: row.id, student: row.student, topic: row.topic, status: row.status }
      : { id, student: '?', topic: '(missing)', status: '-' };
  });
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  const findingIds = new Set(
    view.board.findings
      .filter((finding) => finding.workItemId === proposal.workItemId)
      .map((finding) => finding.findingId),
  );
  const notes = view.board.feedback
    .filter((entry) => findingIds.has(entry.findingId))
    .slice(0, 5)
    .map((entry) => `[${entry.actorId ?? 'unknown'}] ${entry.text.slice(0, 120)}`);
  return { rows, counts, notes, lines: [] };
}

function renderProposals(view: AppView, handlers: AppHandlers): HTMLElement {
  const card = el('section', 'card');
  card.appendChild(el('h2', '', 'Comparison views'));
  const proposals = view.board.proposals.filter((proposal) => proposal.state !== 'discarded');
  if (proposals.length === 0) {
    card.appendChild(el('p', 'muted', 'Agent or human proposals will appear here for explicit Use / Discard.'));
  }
  for (const proposal of proposals) {
    const row = el('div', 'proposal');
    row.appendChild(el('span', `badge ${proposal.origin === 'agent' ? 'accent' : ''}`,
      `${proposal.id} · ${proposal.state}${proposal.origin === 'agent' ? ' · agent' : ''}`));
    row.appendChild(el('span', 'muted', `rows ${proposal.rowIds.join(', ')} · base rev ${proposal.baseRevision}`));
    const judgment = view.board.judgments.find((entry) => entry.proposalId === proposal.id);
    if (judgment) {
      const badge = el('span', `badge jev-${judgment.verdict}`,
        `jev ${judgment.verdict}${judgment.confidence !== undefined ? ` ${judgment.confidence.toFixed(2)}` : ''}`);
      badge.title = judgment.rationale;
      row.appendChild(badge);
    }
    if (proposal.state === 'staged') {
      row.appendChild(button('Use', () => handlers.useProposal(proposal.id), 'btn small accent'));
      row.appendChild(button('Discard', () => handlers.discardProposal(proposal.id), 'btn small'));
    }
    if (proposal.state === 'used') {
      row.appendChild(button('Save private view', () => handlers.saveRecipe(proposal.id), 'btn small'));
    }
    if (proposal.document) {
      row.appendChild(renderUiDocumentPreview(proposal.document, proposalViewModel(view, proposal)));
    }
    card.appendChild(row);
  }
  const recipes = view.recipes;
  if (recipes.length > 0) {
    card.appendChild(el('h3', '', 'Private views'));
    for (const recipe of recipes) {
      const row = el('div', 'proposal');
      row.appendChild(el('span', 'badge', recipe.id));
      row.appendChild(el('span', 'muted', `rows ${recipe.rowIds.join(', ')}`));
      row.appendChild(button('Reopen', () => handlers.reopenRecipe(recipe.id), 'btn small'));
      card.appendChild(row);
    }
  }
  if (view.reopened) {
    const open = el('div', 'reopened');
    open.appendChild(el('p', '', `Reopened ${view.reopened.recipe.id}: ${view.reopened.status}`));
    open.appendChild(el('p', 'muted',
      `${view.reopened.rows.length} rows${view.reopened.missingRowIds.length > 0 ? `, missing ${view.reopened.missingRowIds.join(', ')}` : ''}`));
    card.appendChild(open);
  }
  return card;
}

/**
 * The live canvas — a shared UiDocument the agent can patch in response to
 * annotations. Staged patches show their op list + rationale; Use applies
 * them against the current revision, Discard drops them.
 */
function renderCanvas(view: AppView, handlers: AppHandlers): HTMLElement {
  const card = el('section', 'card');
  card.dataset.regionId = 'canvas';
  card.appendChild(el('h2', '', 'Canvas'));
  const canvas = view.canvas;
  if (!canvas) {
    card.appendChild(el('p', 'muted', 'No canvas document.'));
    return card;
  }
  card.appendChild(el('p', 'muted', `document ${canvas.id} · revision ${canvas.revision} — annotate a node to have the agent propose a patch`));
  card.appendChild(renderUiDocumentPreview(canvas, canvasViewModel(view)));
  const staged = view.board.patchProposals.filter((p) => p.state === 'staged');
  const settled = view.board.patchProposals.filter((p) => p.state !== 'staged').slice(-5);
  for (const proposal of staged) {
    const row = el('div', 'proposal');
    row.appendChild(el('span', 'badge warn', `patch ${proposal.id.slice(0, 18)}`));
    row.appendChild(el('span', 'muted', ` ops: ${proposal.patch.ops.map((op) => `${op.op}${'id' in op ? ` ${op.id}` : ''}`).join(', ')}${proposal.annotationId ? ` · from ${proposal.annotationId}` : ''}`));
    if (proposal.rationale) row.appendChild(el('span', 'muted', ` “${proposal.rationale}”`));
    // Preview the patch outcome — Use is informed consent, not blind trust.
    // Stale-base patches are marked, not silently unappliable.
    const stale = proposal.patch.base_revision !== canvas.revision;
    const preview = stale ? null : applyPatch(canvas, proposal.patch);
    if (stale) {
      row.appendChild(el('span', 'badge', `stale (base r${proposal.patch.base_revision} ≠ canvas r${canvas.revision})`));
    } else if (preview && preview.ok) {
      const previewBox = el('div', 'patch-preview');
      previewBox.appendChild(el('div', 'muted', 'after:'));
      previewBox.appendChild(renderUiDocumentPreview(preview.document, canvasViewModel(view)));
      row.appendChild(previewBox);
    } else if (preview && !preview.ok) {
      row.appendChild(el('span', 'badge', `invalid: ${preview.message.slice(0, 80)}`));
    }
    row.appendChild(button('Use', () => handlers.useCanvasPatch(proposal.id), 'btn small accent'));
    row.appendChild(button('Discard', () => handlers.discardCanvasPatch(proposal.id), 'btn small'));
    card.appendChild(row);
  }
  for (const proposal of settled) {
    const row = el('div', 'proposal muted');
    row.appendChild(el('span', 'badge', `patch ${proposal.id.slice(0, 18)}`));
    row.appendChild(el('span', 'muted', ` ${proposal.state}`));
    card.appendChild(row);
  }
  return card;
}

function canvasViewModel(view: AppView): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const row of view.board.state.rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  const notes = view.agentNotes.slice(-5).map((n) => n.summary.slice(0, 120));
  return { counts, notes, rows: view.board.state.rows, lines: [] };
}

/**
 * Canvas annotations — human notes anchored to rendered elements. Shared
 * room entities, so they persist, render for every viewer, and enter the
 * agent's journal tail as `ui.annotate` signals.
 */
function renderAnnotations(view: AppView, handlers: AppHandlers): HTMLElement {
  const card = el('section', 'card');
  card.appendChild(el('h2', '', 'Annotations'));
  const annotations = [...view.board.annotations].sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
  if (annotations.length === 0) {
    card.appendChild(el('p', 'muted', 'Toggle Annotate, click any element, leave a note — the agent reads these.'));
    return card;
  }
  for (const annotation of annotations) {
    const row = el('div', 'annotation');
    row.dataset.nodeId = `anno-${annotation.id}`;
    const anchor = annotation.nodeId
      ? `node ${annotation.nodeId}`
      : annotation.kind === 'region'
        ? `region ${annotation.rect?.x ?? 0},${annotation.rect?.y ?? 0}`
        : annotation.regionId ?? annotation.selector ?? 'element';
    const badge = el('span', 'badge', anchor);
    badge.title = 'Locate anchor';
    badge.addEventListener('click', () => handlers.locateAnnotation(annotation.id));
    badge.style.cursor = 'pointer';
    row.appendChild(badge);
    row.appendChild(el('span', 'annotation-text', annotation.text));
    if (annotation.context) row.appendChild(el('span', 'muted small', ` ${annotation.context}`));
    row.appendChild(el('span', 'muted', ` ${annotation.actorUid} · ${annotation.at.slice(11, 19)}`));
    const retract = button('×', () => handlers.retractAnnotation(annotation.id), 'ann-retract');
    retract.title = 'Retract annotation';
    row.appendChild(retract);
    card.appendChild(row);
  }
  return card;
}

function renderJournal(view: AppView): HTMLElement {
  const card = el('section', 'card');
  card.appendChild(el('h2', '', 'Activity journal'));
  if (view.journal.length === 0) {
    card.appendChild(el('p', 'muted', 'Semantic events will appear here — this is also what the Agent reads.'));
    return card;
  }
  const list = el('ul', 'journal');
  for (const entry of view.journal.slice(-20).reverse()) {
    const item = el('li');
    item.appendChild(el('span', 'muted', `${entry.at.slice(11, 19)} `));
    item.appendChild(el('strong', '', `${entry.actor.username || entry.actor.uid} `));
    item.appendChild(el('span', '', `${entry.kind}${entry.target ? ` ${entry.target}` : ''} — ${entry.summary}`));
    list.appendChild(item);
  }
  card.appendChild(list);
  return card;
}

function renderAgentNotes(view: AppView): HTMLElement {
  const card = el('section', 'card');
  card.appendChild(el('h2', '', 'Agent notes & tasks'));
  for (const status of view.taskStatuses.slice(-5)) {
    card.appendChild(el('p', 'muted', `task ${status.task_id.slice(0, 16)}… → ${status.status}`));
  }
  for (const note of view.agentNotes.slice(-5)) {
    const p = el('p', 'note');
    p.appendChild(el('span', 'badge accent', 'note'));
    p.appendChild(el('span', '', ` ${note.summary}${note.row_ids.length > 0 ? ` (${note.row_ids.join(', ')})` : ''}`));
    card.appendChild(p);
  }
  if (view.taskStatuses.length === 0 && view.agentNotes.length === 0) {
    card.appendChild(el('p', 'muted', 'Submit a task from a finding; agent notes land here.'));
  }
  return card;
}
