/**
 * React view layer for the collaboration template — same AppView/AppHandlers
 * contract the imperative renderApp used to take; main.ts drives renders.
 *
 * Stable hooks preserved for annotation anchors and e2e:
 *   data-node-id, data-region-id, data-focus, .rows, .notes-input,
 *   .presence .chip, .proposal, .review-summary, .ann-*
 */

import type { ReactElement } from 'react';
import { useRef } from 'react';
import type { CollabIdentity, TaskStatusUpdate } from '@artifact-ax/contract';
import { identityLabel } from '@artifact-ax/contract';
import type { JournalEntry, PresenceSnapshot } from '@artifact-ax/collab';
import type { ReviewRow, RowStatus } from '@artifact-ax/lesson-report';
import type { BoardSnapshot } from './board.js';
import type { ComparisonViewProposal, PrivateViewRecipe, ReopenedRecipe } from './domain.js';
import type { AnchorPick } from './annotate-anchor.js';
import { UiDocumentPreview } from './ui-render.js';
import { applyPatch } from '@artifact-ax/ui-document';
import type { UiDocument } from '@artifact-ax/ui-document';
import { Button } from './components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card.js';
import { Badge } from './components/ui/badge.js';
import { Input } from './components/ui/input.js';
import { Textarea } from './components/ui/textarea.js';
import { Checkbox } from './components/ui/checkbox.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { Avatar, AvatarFallback } from './components/ui/avatar.js';
import { ScrollArea } from './components/ui/scroll-area.js';
import { Bot, PenLine, Pin, X } from 'lucide-react';
import { cn } from './lib/utils.js';

export interface AppView {
  identity: CollabIdentity;
  via: string;
  embedded: boolean;
  hostConnected: boolean;
  roomKey: string;
  presence: PresenceSnapshot | null;
  board: BoardSnapshot;
  canvas: UiDocument | null;
  selectedRowIds: Set<string>;
  journal: JournalEntry[];
  recipes: PrivateViewRecipe[];
  reopened: ReopenedRecipe | null;
  agentActivity: string | null;
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

export function App({ view, handlers }: { view: AppView; handlers: AppHandlers }): ReactElement {
  return (
    <main className="mx-auto max-w-[1100px] px-6 py-5">
      <AppHeader view={view} handlers={handlers} />
      {view.notice ? <NoticeBanner text={view.notice} /> : null}
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(340px,1fr))]">
        <ReviewTableCard view={view} handlers={handlers} />
        <WorkboardCard view={view} handlers={handlers} />
        <CanvasCard view={view} handlers={handlers} />
        <ProposalsCard view={view} handlers={handlers} />
        <JournalCard view={view} />
        <AgentNotesCard view={view} />
        <AnnotationsCard view={view} handlers={handlers} />
      </div>
    </main>
  );
}

function AppHeader({ view, handlers }: { view: AppView; handlers: AppHandlers }): ReactElement {
  const others = view.presence?.entries ?? [];
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <div className="flex items-baseline gap-2.5">
        <strong className="text-lg font-semibold tracking-tight">Lesson report</strong>
        <span className="text-xs text-muted-foreground">room {view.roomKey}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge variant={view.identity.authenticated ? 'ok' : 'outline'}>{identityLabel(view.identity)}</Badge>
        <span className="text-xs text-muted-foreground">
          via {view.via}
          {view.embedded ? ' · embedded' : ' · standalone'}
          {view.hostConnected ? ' · host connected' : ''}
        </span>
        {others.length > 0 ? (
          <span className="presence inline-flex gap-1.5">
            {others.map((entry) => (
              <PresenceChip key={entry.uid} username={entry.username || entry.uid} agent={entry.kind === 'agent'} focus={entry.focus} />
            ))}
          </span>
        ) : null}
        {view.agentActivity && !others.some((entry) => entry.kind === 'agent') ? (
          <Badge variant="agent" className="chip agent">
            <Bot /> {view.agentActivity}
          </Badge>
        ) : null}
        <Button size="sm" variant={view.annotateMode ? 'secondary' : 'outline'} onClick={handlers.toggleAnnotate}>
          <PenLine /> {view.annotateMode ? 'Annotating — click / drag / ⌥+scroll' : 'Annotate'}
        </Button>
      </div>
    </header>
  );
}

function PresenceChip({ username, agent, focus }: { username: string; agent: boolean; focus?: string }): ReactElement {
  const initials = username.slice(0, 2).toUpperCase();
  return (
    <span
      className={cn(
        'chip inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
        agent ? 'agent bg-[--violet-soft] text-[#c4b5fd]' : 'bg-secondary text-secondary-foreground',
      )}
      title={focus}
    >
      <Avatar className="h-4 w-4">
        <AvatarFallback className={cn('text-[8px]', agent && 'bg-transparent')}>{initials}</AvatarFallback>
      </Avatar>
      {username}
      {agent && focus ? <span className="italic text-[#a78bfa]"> · {focus}</span> : null}
    </span>
  );
}

function NoticeBanner({ text }: { text: string }): ReactElement {
  return (
    <p className="notice mb-4 rounded-lg border border-border bg-secondary px-4 py-3 text-[13px]">{text}</p>
  );
}

const FILTERS = ['pending', 'approved', 'rejected', 'all'] as const;

function ReviewTableCard({ view, handlers }: { view: AppView; handlers: AppHandlers }): ReactElement {
  const rows = view.board.state.rows.filter(
    (row) => view.board.state.filter === 'all' || row.status === view.board.state.filter,
  );
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Review table</CardTitle>
        <div className="flex gap-1.5">
          {FILTERS.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={view.board.state.filter === status ? 'secondary' : 'ghost'}
              onClick={() => handlers.setFilter(status)}
            >
              {status}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <Table className="rows">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Student</TableHead>
              <TableHead>Topic</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row: ReviewRow) => (
              <TableRow key={row.id} data-node-id={row.id} data-region-id="review-table" data-state={view.selectedRowIds.has(row.id) ? 'selected' : undefined}>
                <TableCell className="w-8">
                  <Checkbox checked={view.selectedRowIds.has(row.id)} onCheckedChange={() => handlers.toggleRow(row.id)} aria-label={`select ${row.student}`} />
                </TableCell>
                <TableCell>{row.student}</TableCell>
                <TableCell>{row.topic}</TableCell>
                <TableCell>
                  <Badge variant={row.status === 'approved' ? 'ok' : row.status === 'rejected' ? 'danger' : 'warn'}>
                    {row.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={handlers.approveSelected}>
            Approve selected
          </Button>
          <Button size="sm" onClick={handlers.createWorkItem}>
            New work item from selected
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkboardCard({ view, handlers }: { view: AppView; handlers: AppHandlers }): ReactElement {
  const items = view.board.workItems;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Work items</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">Select rows and create a work item to start a shared comparison.</p>
        ) : (
          items.map((item) => <WorkItem key={item.id} item={item} view={view} handlers={handlers} />)
        )}
      </CardContent>
    </Card>
  );
}

function WorkItem({ item, view, handlers }: { item: BoardSnapshot['workItems'][number]; view: AppView; handlers: AppHandlers }): ReactElement {
  const findings = view.board.findings.filter((finding) => finding.workItemId === item.id);
  const typingEntries = (view.presence?.entries ?? []).filter((entry) => entry.focus === `notes:${item.id}`);
  const newFindingRef = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-3 border-t border-border pt-3 first:mt-0 first:border-t-0 first:pt-0" data-node-id={item.id} data-region-id="workboard">
      <h3 className="mb-1 text-sm font-semibold">
        {item.title}{' '}
        <span className="font-normal text-xs text-muted-foreground">
          rows {item.rowIds.join(', ')} · {item.state}
        </span>
      </h3>
      <div className="my-2.5">
        <div className="mb-1 flex items-center gap-2.5 text-xs">
          <span className="text-muted-foreground">Shared notes · live</span>
          {typingEntries.map((entry) => (
            <span key={entry.uid} className="italic text-[--color-ok]">
              {entry.username || entry.uid} typing…
            </span>
          ))}
        </div>
        <Textarea
          className="notes-input"
          rows={3}
          placeholder="Everyone types into the same notes — edits merge live."
          data-focus={`notes:${item.id}`}
          ref={(el) => {
            if (el) handlers.bindNotes(el, item.id);
          }}
        />
      </div>
      {findings.length === 0 ? <p className="text-xs text-muted-foreground">No findings yet.</p> : null}
      {findings.map((finding) => (
        <FindingBlock key={finding.findingId} finding={finding} view={view} handlers={handlers} />
      ))}
      <div className="mt-2 flex items-center gap-2">
        <Input ref={newFindingRef} type="text" placeholder="New finding summary…" maxLength={200} data-focus={`newfinding:${item.id}`} className="h-8 text-xs" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const value = newFindingRef.current?.value.trim();
            if (value) {
              handlers.createFinding(item.id, value);
              if (newFindingRef.current) newFindingRef.current.value = '';
            }
          }}
        >
          Add finding
        </Button>
      </div>
    </div>
  );
}

function FindingBlock({ finding, view, handlers }: { finding: BoardSnapshot['findings'][number]; view: AppView; handlers: AppHandlers }): ReactElement {
  const feedbackList = view.board.feedback.filter((entry) => entry.findingId === finding.findingId);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="my-2 rounded-lg border border-border bg-secondary/30 p-3">
      <p className="review-summary mb-1.5 text-[13px]">
        rev {finding.revision} — {finding.summary}
      </p>
      {feedbackList.map((feedback, i) => (
        <p key={i} className="my-1 border-l border-border pl-2.5 text-xs text-muted-foreground">
          {feedback.actorId ?? 'someone'}: {feedback.text}
        </p>
      ))}
      <div className="mt-2 flex items-center gap-2">
        <Input ref={inputRef} type="text" placeholder="Add feedback…" maxLength={200} data-focus={`feedback:${finding.findingId}`} className="h-8 text-xs" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const value = inputRef.current?.value.trim();
            if (value) {
              handlers.addFeedback(finding.findingId, finding.revision, value);
              if (inputRef.current) inputRef.current.value = '';
            }
          }}
        >
          Add
        </Button>
        <Button size="sm" onClick={() => handlers.askAgent(finding.findingId)}>
          Ask agent
        </Button>
      </div>
    </div>
  );
}

/** JEV verdict badge — evidence shown to humans, never authorization. */
function JevBadge({ verdict, confidence, rationale }: { verdict: string; confidence?: number; rationale: string }): ReactElement {
  const variant = verdict === 'allow' ? 'ok' : verdict === 'flag' ? 'danger' : 'warn';
  return (
    <Badge variant={variant} title={rationale} className={`jev-${verdict}`}>
      jev {verdict}
      {confidence !== undefined ? ` ${confidence.toFixed(2)}` : ''}
    </Badge>
  );
}

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
    view.board.findings.filter((finding) => finding.workItemId === proposal.workItemId).map((finding) => finding.findingId),
  );
  const notes = view.board.feedback
    .filter((entry) => findingIds.has(entry.findingId))
    .slice(0, 5)
    .map((entry) => `[${entry.actorId ?? 'unknown'}] ${entry.text.slice(0, 120)}`);
  return { rows, counts, notes, lines: [] };
}

function ProposalsCard({ view, handlers }: { view: AppView; handlers: AppHandlers }): ReactElement {
  const proposals = view.board.proposals.filter((proposal) => proposal.state !== 'discarded');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Comparison views</CardTitle>
      </CardHeader>
      <CardContent>
        {proposals.length === 0 ? (
          <p className="text-xs text-muted-foreground">Agent or human proposals will appear here for explicit Use / Discard.</p>
        ) : null}
        {proposals.map((proposal) => {
          const judgment = view.board.judgments.find((entry) => entry.proposalId === proposal.id);
          return (
            <div key={proposal.id} className="proposal border-b border-border py-2.5 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={proposal.origin === 'agent' ? 'secondary' : 'outline'}>
                  {proposal.id} · {proposal.state}
                  {proposal.origin === 'agent' ? ' · agent' : ''}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  rows {proposal.rowIds.join(', ')} · base rev {proposal.baseRevision}
                </span>
                {judgment ? <JevBadge verdict={judgment.verdict} confidence={judgment.confidence} rationale={judgment.rationale} /> : null}
                {proposal.state === 'staged' ? (
                  <>
                    <Button size="sm" onClick={() => handlers.useProposal(proposal.id)}>Use</Button>
                    <Button size="sm" variant="outline" onClick={() => handlers.discardProposal(proposal.id)}>Discard</Button>
                  </>
                ) : null}
                {proposal.state === 'used' ? (
                  <Button size="sm" variant="outline" onClick={() => handlers.saveRecipe(proposal.id)}>Save private view</Button>
                ) : null}
              </div>
              {proposal.document ? (
                <UiDocumentPreview document={proposal.document} model={proposalViewModel(view, proposal)} />
              ) : null}
            </div>
          );
        })}
        {view.recipes.length > 0 ? (
          <>
            <h3 className="mt-4 mb-1.5 text-xs font-medium text-muted-foreground">Private views</h3>
            {view.recipes.map((recipe) => (
              <div key={recipe.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <Badge variant="outline">{recipe.id}</Badge>
                <span className="text-xs text-muted-foreground">rows {recipe.rowIds.join(', ')}</span>
                <Button size="sm" variant="outline" onClick={() => handlers.reopenRecipe(recipe.id)}>Reopen</Button>
              </div>
            ))}
          </>
        ) : null}
        {view.reopened ? (
          <div className="mt-3 rounded-lg border border-dashed border-border bg-secondary/30 p-3">
            <p className="text-[13px]">Reopened {view.reopened.recipe.id}: {view.reopened.status}</p>
            <p className="text-xs text-muted-foreground">
              {view.reopened.rows.length} rows
              {view.reopened.missingRowIds.length > 0 ? `, missing ${view.reopened.missingRowIds.join(', ')}` : ''}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function canvasViewModel(view: AppView): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const row of view.board.state.rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  const notes = view.agentNotes.slice(-5).map((n) => n.summary.slice(0, 120));
  return { counts, notes, rows: view.board.state.rows, lines: [] };
}

function CanvasCard({ view, handlers }: { view: AppView; handlers: AppHandlers }): ReactElement {
  const canvas = view.canvas;
  const staged = view.board.patchProposals.filter((p) => p.state === 'staged');
  const settled = view.board.patchProposals.filter((p) => p.state !== 'staged').slice(-5);
  return (
    <Card data-region-id="canvas">
      <CardHeader>
        <CardTitle>Canvas</CardTitle>
        {canvas ? (
          <CardDescription>
            document {canvas.id} · revision {canvas.revision} — annotate a node to have the agent propose a patch
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        {!canvas ? (
          <p className="text-xs text-muted-foreground">No canvas document.</p>
        ) : (
          <UiDocumentPreview document={canvas} model={canvasViewModel(view)} />
        )}
        {staged.map((proposal) => {
          const stale = canvas ? proposal.patch.base_revision !== canvas.revision : true;
          const preview = canvas && !stale ? applyPatch(canvas, proposal.patch) : null;
          return (
            <div key={proposal.id} className="my-2 rounded-lg border border-[--violet]/40 bg-[--violet-soft] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warn">patch {proposal.id.slice(0, 18)}</Badge>
                <span className="text-xs text-muted-foreground">
                  ops: {proposal.patch.ops.map((op) => `${op.op}${'id' in op ? ` ${op.id}` : ''}`).join(', ')}
                  {proposal.annotationId ? ` · from ${proposal.annotationId}` : ''}
                </span>
                {proposal.rationale ? <span className="text-xs text-muted-foreground"> “{proposal.rationale}”</span> : null}
              </div>
              {stale ? (
                <Badge variant="outline" className="mt-2">
                  stale (base r{proposal.patch.base_revision} ≠ canvas r{canvas?.revision})
                </Badge>
              ) : preview && preview.ok ? (
                <div className="mt-2">
                  <div className="mb-1 text-xs text-muted-foreground">after:</div>
                  <UiDocumentPreview document={preview.document} model={canvasViewModel(view)} />
                </div>
              ) : preview && !preview.ok ? (
                <Badge variant="destructive" className="mt-2">invalid: {preview.message.slice(0, 80)}</Badge>
              ) : null}
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => handlers.useCanvasPatch(proposal.id)}>Use</Button>
                <Button size="sm" variant="outline" onClick={() => handlers.discardCanvasPatch(proposal.id)}>Discard</Button>
              </div>
            </div>
          );
        })}
        {settled.map((proposal) => (
          <div key={proposal.id} className="flex items-center gap-2 py-1 opacity-70">
            <Badge variant="outline">patch {proposal.id.slice(0, 18)}</Badge>
            <span className="text-xs text-muted-foreground">{proposal.state}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AnnotationsCard({ view, handlers }: { view: AppView; handlers: AppHandlers }): ReactElement {
  const annotations = [...view.board.annotations].sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Annotations</CardTitle>
      </CardHeader>
      <CardContent>
        {annotations.length === 0 ? (
          <p className="text-xs text-muted-foreground">Toggle Annotate, click any element, leave a note — the agent reads these.</p>
        ) : (
          <ScrollArea className="max-h-72">
            {annotations.map((annotation) => {
              const anchor = annotation.nodeId
                ? `node ${annotation.nodeId}`
                : annotation.kind === 'region'
                  ? `region ${annotation.rect?.x ?? 0},${annotation.rect?.y ?? 0}`
                  : (annotation.regionId ?? annotation.selector ?? 'element');
              return (
                <div key={annotation.id} className="annotation flex items-baseline gap-2 border-b border-border py-1.5 text-[13px] last:border-b-0" data-node-id={`anno-${annotation.id}`}>
                  <button
                    type="button"
                    className="cursor-pointer"
                    title="Locate anchor"
                    onClick={() => handlers.locateAnnotation(annotation.id)}
                  >
                    <Badge variant="outline"><Pin className="size-3" />{anchor}</Badge>
                  </button>
                  <span className="annotation-text flex-1">{annotation.text}</span>
                  {annotation.context ? <span className="text-[11px] text-muted-foreground"> {annotation.context}</span> : null}
                  <span className="text-xs text-muted-foreground">
                    {annotation.actorUid} · {annotation.at.slice(11, 19)}
                  </span>
                  <button
                    type="button"
                    className="ann-retract cursor-pointer border-none bg-none p-0 text-muted-foreground hover:text-[--color-danger]"
                    title="Retract annotation"
                    onClick={() => handlers.retractAnnotation(annotation.id)}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function JournalCard({ view }: { view: AppView }): ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity journal</CardTitle>
      </CardHeader>
      <CardContent>
        {view.journal.length === 0 ? (
          <p className="text-xs text-muted-foreground">Semantic events will appear here — this is also what the Agent reads.</p>
        ) : (
          <ScrollArea className="max-h-72">
            <ul className="journal m-0 list-none p-0">
              {view.journal.slice(-20).reverse().map((entry, i) => (
                <li key={i} className="border-b border-border py-1.5 text-xs text-muted-foreground last:border-b-0">
                  <span>{entry.at.slice(11, 19)} </span>
                  <strong className="font-medium text-foreground">{entry.actor.username || entry.actor.uid} </strong>
                  <span>
                    {entry.kind}
                    {entry.target ? ` ${entry.target}` : ''} — {entry.summary}
                  </span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function AgentNotesCard({ view }: { view: AppView }): ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent notes & tasks</CardTitle>
      </CardHeader>
      <CardContent>
        {view.taskStatuses.slice(-5).map((status) => (
          <p key={status.task_id} className="my-1 text-xs text-muted-foreground">
            task {status.task_id.slice(0, 16)}… → {status.status}
          </p>
        ))}
        {view.agentNotes.slice(-5).map((note, i) => (
          <p key={i} className="note my-1.5 text-[13px]">
            <Badge variant="secondary" className="mr-1.5">note</Badge>
            {note.summary}
            {note.row_ids.length > 0 ? ` (${note.row_ids.join(', ')})` : ''}
          </p>
        ))}
        {view.taskStatuses.length === 0 && view.agentNotes.length === 0 ? (
          <p className="text-xs text-muted-foreground">Submit a task from a finding; agent notes land here.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
