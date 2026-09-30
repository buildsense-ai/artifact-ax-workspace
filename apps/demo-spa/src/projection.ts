import {
  PAGE_CONTEXT_CONTRACT,
  type ArtifactPageContext,
} from '@artifact-ax/contract';
import type { JournalEntry } from '@artifact-ax/collab';
import type { PresenceSnapshot } from '@artifact-ax/collab';
import type { CollabBoard, BoardSnapshot } from './board.js';

/**
 * Agent-legible projection of the live board.
 *
 * The OBSERVE `semantic_context.runtime_view` is synthesized from the fully
 * merged local document — the most authoritative semantic view the page can
 * offer — plus the tail of the journal. Everything below is bounded; an
 * over-budget view simply carries fewer recent entries.
 */

const MAX_JOURNAL_TAIL = 20;
const MAX_WORK_ITEMS = 20;
const MAX_FINDINGS = 30;
const MAX_PROPOSALS = 20;
const MAX_ROWS = 40;
const MAX_FIELD = 80;
const MAX_FEEDBACK_PER_FINDING = 5;

const textField = (value: string): string => value.slice(0, MAX_FIELD);

export interface RuntimeView {
  board_revision: number;
  online: Array<{ uid: string; username: string; authenticated: boolean; focus?: string; kind?: string }>;
  review: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    visible_row_ids: string[];
    /** Bounded row content — the agent must be able to see what it reviews. */
    rows: Array<{ id: string; student: string; topic: string; status: string }>;
  };
  work_items: Array<{
    id: string;
    title: string;
    row_ids: string[];
    state: string;
    notes_chars?: number;
    notes_excerpt?: string;
    findings: Array<{
      id: string;
      revision: number;
      summary: string;
      row_ids: string[];
      feedback_count: number;
      feedback: Array<{ actor: string; text: string }>;
    }>;
  }>;
  proposals: Array<{ id: string; work_item_id: string; state: string; origin?: string; row_ids: string[] }>;
  /** JEV verdicts — supplementary evidence on staged proposals. */
  judgments: Array<{ proposal_id: string; verdict: string; rationale: string }>;
  /** Canvas annotations — humans marking elements/regions for the agent to see. */
  annotations: Array<{
    id: string;
    kind?: 'element' | 'region';
    node_id?: string;
    region_id?: string;
    selector?: string;
    rect?: { x: number; y: number; w: number; h: number };
    text: string;
    actor: string;
    at: string;
  }>;
  /** Live canvas — the agent-patchable shared document (node ids for anchor matching). */
  canvas?: { id: string; revision: number; node_ids: string[] };
  /** Staged canvas patches awaiting human Use/Discard. */
  patch_proposals: Array<{ id: string; annotation_id?: string; ops: string[]; state: string; at: string }>;
  recent_journal: Array<{ at: string; actor: string; kind: string; target?: string; summary: string }>;
}

export function buildRuntimeView(
  board: CollabBoard,
  presence: PresenceSnapshot | null,
  journalTail: JournalEntry[],
): RuntimeView {
  const snapshot: BoardSnapshot = board.snapshot();
  const counts = {
    total: snapshot.state.rows.length,
    pending: snapshot.state.rows.filter((row) => row.status === 'pending').length,
    approved: snapshot.state.rows.filter((row) => row.status === 'approved').length,
    rejected: snapshot.state.rows.filter((row) => row.status === 'rejected').length,
  };
  const feedbackCount = new Map<string, number>();
  for (const item of snapshot.feedback) {
    feedbackCount.set(item.findingId, (feedbackCount.get(item.findingId) ?? 0) + 1);
  }
  const findingsByWorkItem = new Map<string, BoardSnapshot['findings']>();
  for (const finding of snapshot.findings) {
    const list = findingsByWorkItem.get(finding.workItemId) ?? [];
    list.push(finding);
    findingsByWorkItem.set(finding.workItemId, list);
  }
  return {
    board_revision: snapshot.state.revision,
    online: (presence?.entries ?? [])
      .filter((entry) => Date.now() - Date.parse(entry.onlineAt) <= entry.ttlMs)
      .map((entry) => ({
        uid: entry.uid,
        username: entry.username,
        authenticated: entry.authenticated,
        ...(entry.focus ? { focus: entry.focus } : {}),
        ...(entry.kind ? { kind: entry.kind } : {}),
      })),
    review: {
      ...counts,
      visible_row_ids: snapshot.state.rows
        .filter((row) => snapshot.state.filter === 'all' || row.status === snapshot.state.filter)
        .map((row) => row.id),
      rows: snapshot.state.rows.slice(0, MAX_ROWS).map((row) => ({
        id: row.id,
        student: textField(row.student),
        topic: textField(row.topic),
        status: row.status,
      })),
    },
    work_items: snapshot.workItems.slice(0, MAX_WORK_ITEMS).map((item) => {
      const notes = board.notesExcerpt(item.id, 200);
      return {
        id: item.id,
        title: item.title,
        row_ids: [...item.rowIds],
        state: item.state,
        ...(notes.chars > 0 ? { notes_chars: notes.chars, notes_excerpt: notes.excerpt } : {}),
        findings: (findingsByWorkItem.get(item.id) ?? []).slice(0, MAX_FINDINGS).map((finding) => ({
          id: finding.findingId,
          revision: finding.revision,
          summary: finding.summary,
          row_ids: [...finding.rowIds],
          feedback_count: feedbackCount.get(finding.findingId) ?? 0,
          feedback: snapshot.feedback
            .filter((item2) => item2.findingId === finding.findingId)
            .slice(0, MAX_FEEDBACK_PER_FINDING)
            .map((item2) => ({ actor: item2.actorId ?? 'unknown', text: item2.text.slice(0, 200) })),
        })),
      };
    }),
    proposals: snapshot.proposals.slice(0, MAX_PROPOSALS).map((proposal) => ({
      id: proposal.id,
      work_item_id: proposal.workItemId,
      state: proposal.state,
      ...(proposal.origin ? { origin: proposal.origin } : {}),
      ...(proposal.document ? { document: 'artifact-ax.ui-document.v1' } : {}),
      row_ids: [...proposal.rowIds],
    })),
    judgments: snapshot.judgments.slice(0, MAX_PROPOSALS).map((judgment) => ({
      proposal_id: judgment.proposalId,
      verdict: judgment.verdict,
      rationale: judgment.rationale.slice(0, 200),
    })),
    annotations: snapshot.annotations.slice(-20).map((annotation) => ({
      id: annotation.id,
      ...(annotation.kind ? { kind: annotation.kind } : {}),
      node_id: annotation.nodeId,
      region_id: annotation.regionId,
      ...(annotation.selector ? { selector: annotation.selector } : {}),
      ...(annotation.rect ? { rect: annotation.rect } : {}),
      text: annotation.text.slice(0, 200),
      actor: annotation.actorUid,
      at: annotation.at,
    })),
    ...(() => {
      const canvas = board.canvas();
      return canvas ? { canvas: { id: canvas.id, revision: canvas.revision, node_ids: canvas.nodes.map((n) => n.id) } } : {};
    })(),
    patch_proposals: snapshot.patchProposals.slice(-10).map((p) => ({
      id: p.id,
      ...(p.annotationId ? { annotation_id: p.annotationId } : {}),
      ops: p.patch.ops.map((op) => `${op.op}${'id' in op ? ` ${op.id}` : ''}`).slice(0, 10),
      state: p.state,
      at: p.at,
    })),
    recent_journal: journalTail.slice(-MAX_JOURNAL_TAIL).map((entry) => ({
      at: entry.at,
      actor: entry.actor.username || entry.actor.uid,
      kind: entry.kind,
      ...(entry.target ? { target: entry.target } : {}),
      summary: entry.summary,
    })),
  };
}

/** Build the OBSERVE page context envelope for one request. */
export function buildPageContext(
  board: CollabBoard,
  presence: PresenceSnapshot | null,
  journalTail: JournalEntry[],
  extras: { title?: string; location?: string; artifactVersion?: number } = {},
): ArtifactPageContext {
  return {
    contract_version: PAGE_CONTEXT_CONTRACT,
    observed_at: new Date().toISOString(),
    ...(extras.title ? { title: extras.title } : {}),
    ...(extras.location ? { location: extras.location } : {}),
    ...(extras.artifactVersion ? { artifact_version: extras.artifactVersion } : {}),
    semantic_context: {
      semantic_mode: 'final-state',
      runtime_view: buildRuntimeView(board, presence, journalTail) as unknown as Record<string, unknown>,
    },
  };
}
