import {
  UI_DOCUMENT_CONTRACT_VERSION,
  type UiDocument,
} from '@artifact-ax/ui-document';

/**
 * The declarative UiDocument that drives the teaching-report business surfaces.
 *
 * This is the single source of screen structure for the lesson-report demo. It
 * references only components in the fixed, approved catalog
 * (`@artifact-ax/ui-document`), binds named data paths from the projection-derived
 * view model, and binds semantic events to allowlisted application actions. No
 * layout, surface, or control here is ever a one-off static DOM template.
 *
 * It is validated before first render; a builder may propose a validated patch
 * (draft-only) that re-renders the same surfaces without ever emitting raw HTML.
 */
export const LESSON_REPORT_DOCUMENT: UiDocument = {
  contract_version: UI_DOCUMENT_CONTRACT_VERSION,
  id: 'lesson-report.v1',
  title: 'Lesson report',
  revision: 1,
  layout: { template: 'main-side' },
  nodes: [
    {
      id: 'review-table',
      kind: 'review-table',
      placement: 'main',
      props: {
        regionId: 'review-table',
        regionTitle: 'Review table',
        emptyText: 'No rows to show.',
      },
      bindings: {
        rows: 'reviewTable.rows',
        filter: 'reviewTable.filter',
        selected: 'reviewTable.selected',
        actionStatus: 'reviewTable.actionStatus',
      },
      events: {
        filter: 'filterRows',
        rowToggle: 'toggleRow',
        selectAll: 'selectAll',
        approve: 'approveRows',
        focus: 'focusRegion',
      },
    },
    {
      id: 'focus-composer',
      kind: 'focus-composer',
      placement: 'side',
      props: {
        regionId: 'focus-set',
        regionTitle: 'Focus set',
        hint: 'Selection is context, not a command. Pick regions or items, then give one intent; the arbiter decides what to do.',
      },
      bindings: {
        count: 'focus.count',
        selections: 'focus.selections',
        assessment: 'focus.assessment',
        intent: 'focus.intent',
        runNote: 'focus.runNote',
        commitLabel: 'focus.commitLabel',
      },
      events: {
        toggle: 'toggleFocus',
        note: 'focusNote',
        remove: 'focusRemove',
        move: 'focusMove',
        commit: 'commitFocus',
        intent: 'intentInput',
      },
    },
    {
      id: 'summary-list',
      kind: 'summary-list',
      placement: 'side',
      props: {
        regionId: 'summary-panel',
        regionTitle: 'Summary',
      },
      bindings: {
        counts: 'summary',
      },
      events: {
        focus: 'focusRegion',
      },
    },
    {
      id: 'approval-list',
      kind: 'approval-list',
      placement: 'side',
      props: {
        regionId: 'approval-panel',
        regionTitle: 'Approvals',
        emptyText: 'No pending approvals.',
      },
      bindings: {
        approvals: 'approvals',
      },
      events: {
        approve: 'resolveApproval',
        reject: 'resolveApproval',
      },
    },
    {
      id: 'event-log',
      kind: 'event-log',
      placement: 'full',
      props: {
        regionId: 'event-log',
        regionTitle: 'Recent events',
      },
      bindings: {
        lines: 'eventLines',
      },
    },
    {
      id: 'context-outbox',
      kind: 'context-outbox',
      placement: 'full',
      props: {
        regionId: 'context-outbox',
        regionTitle: 'Context bundles',
        emptyText: 'No context bundles yet. Compose a focus set to create one.',
      },
      bindings: {
        label: 'outbox.label',
        items: 'outbox.items',
      },
      events: {
        resume: 'resumeBundle',
      },
    },
    {
      id: 'agent-notes',
      kind: 'agent-notes',
      placement: 'full',
      props: {
        regionId: 'agent-notes',
        regionTitle: 'Agent notes',
        emptyText: 'No Agent notes yet. A completed Cloud task will appear here.',
      },
      bindings: {
        notes: 'agentNotes',
      },
    },
  ],
};

/** The region-id → node-id lookup used to set data-region anchors on surfaces. */
export const REGION_NODE_MAP: Record<string, string> = Object.fromEntries(
  LESSON_REPORT_DOCUMENT.nodes.map((node) => [
    String((node.props as { regionId?: string })?.regionId ?? node.id),
    node.id,
  ]),
);
