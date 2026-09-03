import type { Catalog, CatalogComponent, PropSchema } from './types.js';

/**
 * The fixed, approved component catalog for the teaching-report Artifact surface.
 *
 * This is deliberately small and closed. Every component the document may
 * reference is listed here with hard allowlists for props, data bindings, and
 * semantic events. Adding a surface requires extending the catalog, its renderer
 * in the SPA, and its tests — never by emitting raw HTML/JS/CSS from a document.
 *
 * Prop hosts/ids are validated by `validate.ts` (region-id / node-id patterns),
 * and all text is escaped by the renderer. No prop is ever treated as executable
 * presentation markup.
 */

const regionIdProp: PropSchema = { type: 'string', maxLength: 64 };
const titleProp = (maxLength = 64): PropSchema => ({ type: 'string', maxLength });
const stringProp = (maxLength: number): PropSchema => ({ type: 'string', maxLength });

/** Location of a rendered region within the page. */
export const LAYOUT_PLACEMENTS = ['main', 'side', 'full'] as const;

/** Fixed catalog keyed by component kind. */
export const CATALOG: Catalog = {
  'review-table': {
    kind: 'review-table',
    description: 'The review table surface: filter select, select-all, row list, and the approve action.',
    props: {
      regionId: regionIdProp,
      regionTitle: titleProp(),
      emptyText: stringProp(120),
    },
    bindings: {
      rows: 'list',
      filter: 'record',
      selected: 'list',
      actionStatus: 'scalar',
    },
    events: {
      filter: ['filterRows'],
      rowToggle: ['toggleRow'],
      selectAll: ['selectAll'],
      approve: ['approveRows'],
      focus: ['focusRegion'],
    },
  },

  'summary-list': {
    kind: 'summary-list',
    description: 'Summary/state panel: counts by review status.',
    props: {
      regionId: regionIdProp,
      regionTitle: titleProp(),
    },
    bindings: {
      counts: 'record',
    },
    events: {
      focus: ['focusRegion'],
    },
  },

  'approval-list': {
    kind: 'approval-list',
    description: 'Approval/action surface: pending approvals and their resolve actions.',
    props: {
      regionId: regionIdProp,
      regionTitle: titleProp(),
      emptyText: stringProp(120),
    },
    bindings: {
      approvals: 'list',
    },
    events: {
      approve: ['resolveApproval'],
      reject: ['resolveApproval'],
    },
  },

  'focus-composer': {
    kind: 'focus-composer',
    description: 'Focus/context composer: ordered selections, one intent, live assessment, and the commit action.',
    props: {
      regionId: regionIdProp,
      regionTitle: titleProp(),
      hint: stringProp(200),
    },
    bindings: {
      count: 'scalar',
      selections: 'list',
      assessment: 'scalar',
      intent: 'scalar',
      runNote: 'scalar',
      commitLabel: 'scalar',
    },
    events: {
      toggle: ['toggleFocus'],
      note: ['focusNote'],
      remove: ['focusRemove'],
      move: ['focusMove'],
      commit: ['commitFocus'],
      intent: ['intentInput'],
    },
  },

  'agent-notes': {
    kind: 'agent-notes',
    description: 'Durable application writeback: the applied Agent review notes.',
    props: {
      regionId: regionIdProp,
      regionTitle: titleProp(),
      emptyText: stringProp(160),
    },
    bindings: {
      notes: 'list',
    },
    events: {},
  },

  'event-log': {
    kind: 'event-log',
    description: 'Recent structured event/receipt visibility.',
    props: {
      regionId: regionIdProp,
      regionTitle: titleProp(),
    },
    bindings: {
      lines: 'list',
    },
    events: {},
  },

  'context-outbox': {
    kind: 'context-outbox',
    description: 'Context bundle / receipt visibility, with an explicit resume action when staged.',
    props: {
      regionId: regionIdProp,
      regionTitle: titleProp(),
      emptyText: stringProp(160),
    },
    bindings: {
      label: 'scalar',
      items: 'list',
    },
    events: {
      resume: ['resumeBundle'],
    },
  },

  'ui-builder': {
    kind: 'ui-builder',
    description: 'Formal UI Builder surface: a user UI intent request action, a staged declarative UI-document proposal summary, and human apply/discard controls.',
    props: {
      regionId: regionIdProp,
      regionTitle: titleProp(),
      hint: stringProp(300),
    },
    bindings: {
      intent: 'scalar',
      status: 'scalar',
      requestLabel: 'scalar',
      applyLabel: 'scalar',
      discardLabel: 'scalar',
      proposal: 'record',
      requestDisabled: 'scalar',
      applyDisabled: 'scalar',
      discardDisabled: 'scalar',
    },
    events: {
      request: ['requestUiProposal'],
      apply: ['applyUiProposal'],
      discard: ['discardUiProposal'],
      intent: ['uiIntentInput'],
    },
  },
};

export const CATALOG_KIND = Object.freeze(Object.keys(CATALOG));

export function catalogComponent(kind: string): CatalogComponent | undefined {
  return CATALOG[kind];
}

export function isCatalogKind(kind: unknown): kind is keyof typeof CATALOG {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, kind);
}
