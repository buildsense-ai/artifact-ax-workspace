import type { Approval, Manifest, Projection } from '@artifact-ax/contract';
import type { ReviewRow, ReviewTableState } from '@artifact-ax/lesson-report';
import type { Selection } from '@artifact-ax/trigger';
import type { AgentNoteRecord } from '../cloud-surface.js';

/**
 * The projection-derived view model the SPA feeds into the UI-document
 * renderer. Binding paths in `LESSON_REPORT_DOCUMENT` resolve against this
 * object; it is the single seam between the domain/gateway (semantic commands,
 * projections, receipts) and the declarative document.
 */

export interface OutboxItemView {
  kind: 'bundle' | 'receipt';
  bundleId: string;
  state: string;
  /** Visual badge tone: approved / rejected / pending / decision (accent). */
  stateKind: 'approved' | 'rejected' | 'pending' | 'decision';
  title?: string;
  message?: string;
  meta?: string[];
  canResume?: boolean;
}

export interface FocusComposerView {
  count: number;
  selections: Selection[];
  assessment: string;
  intent: string;
  runNote: string;
  expanded: boolean;
  commitLabel: string;
}

/** The compact proposal summary the Builder panel renders from a staged record. */
export interface UiBuilderProposalView {
  state: string;
  summary: string;
  base_revision: number;
  op_count: number;
  created_at?: string;
  applied_revision?: number;
  error?: string;
}

export interface UiBuilderView {
  intent: string;
  status: string;
  requestLabel: string;
  applyLabel: string;
  discardLabel: string;
  proposal: UiBuilderProposalView;
  requestDisabled: boolean;
  applyDisabled: boolean;
  discardDisabled: boolean;
}

export interface UIDocumentView {
  manifest: Manifest;
  projection: Projection;
  reviewTable: {
    rows: ReviewRow[];
    filter: ReviewTableState['filter'];
    selected: string[];
    actionStatus: string;
  };
  summary: Record<string, number>;
  approvals: Approval[];
  focus: FocusComposerView;
  agentNotes: AgentNoteRecord[];
  eventLines: string[];
  outbox: { label: string; items: OutboxItemView[] };
  uiBuilder: UiBuilderView;
  transportNote: string;
}

export const EMPTY_FOCUS: FocusComposerView = {
  count: 0,
  selections: [],
  assessment: '',
  intent: '',
  runNote: '',
  expanded: false,
  commitLabel: 'Compose context bundle',
};

export const EMPTY_UI_BUILDER: UiBuilderView = {
  intent: '',
  status: '',
  requestLabel: 'Request UI change',
  applyLabel: 'Apply proposal',
  discardLabel: 'Discard proposal',
  proposal: { state: 'none', summary: '', base_revision: 0, op_count: 0 },
  requestDisabled: false,
  applyDisabled: true,
  discardDisabled: true,
};
