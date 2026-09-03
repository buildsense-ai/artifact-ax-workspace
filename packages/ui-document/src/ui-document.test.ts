import { describe, it, expect } from 'vitest';
import {
  checkDocument,
  assertDocument,
  validateNode,
  applyPatch,
  validatePatch,
  resolvePath,
  resolveNodeBindings,
  asList,
  asRecord,
  asString,
  UiDocumentError,
  UI_DOCUMENT_CONTRACT_VERSION,
  UI_DOCUMENT_PATCH_CONTRACT_VERSION,
  CATALOG,
} from './index.js';
import type { Catalog, UiDocument } from './types.js';

function lessonReportDocument(): UiDocument {
  return {
    contract_version: UI_DOCUMENT_CONTRACT_VERSION,
    id: 'lesson-report.v1',
    revision: 1,
    layout: { template: 'main-side' },
    nodes: [
      {
        id: 'review-table',
        kind: 'review-table',
        placement: 'main',
        props: { regionId: 'review-table', regionTitle: 'Review table', emptyText: 'No rows' },
        bindings: { rows: 'reviewTable.rows', filter: 'reviewTable.filter', selected: 'reviewTable.selected' },
        events: { filter: 'filterRows', rowToggle: 'toggleRow', selectAll: 'selectAll', approve: 'approveRows' },
      },
      {
        id: 'summary-list',
        kind: 'summary-list',
        placement: 'side',
        props: { regionId: 'summary-panel', regionTitle: 'Summary' },
        bindings: { counts: 'summary' },
        events: { focus: 'focusRegion' },
      },
      {
        id: 'approval-list',
        kind: 'approval-list',
        placement: 'side',
        props: { regionId: 'approval-panel', regionTitle: 'Approvals' },
        bindings: { approvals: 'approvals' },
        events: { approve: 'resolveApproval', reject: 'resolveApproval' },
      },
      {
        id: 'focus-composer',
        kind: 'focus-composer',
        placement: 'side',
        props: { regionId: 'focus-set', regionTitle: 'Focus set', hint: 'Selection is context' },
        bindings: {
          count: 'focus.count',
          selections: 'focus.selections',
          assessment: 'focus.assessment',
          intent: 'focus.intent',
          runNote: 'focus.runNote',
        },
        events: { toggle: 'toggleFocus', note: 'focusNote', remove: 'focusRemove', move: 'focusMove', commit: 'commitFocus' },
      },
      {
        id: 'agent-notes',
        kind: 'agent-notes',
        placement: 'full',
        props: { regionId: 'agent-notes', regionTitle: 'Agent notes' },
        bindings: { notes: 'agentNotes' },
      },
      {
        id: 'event-log',
        kind: 'event-log',
        placement: 'full',
        props: { regionId: 'event-log', regionTitle: 'Recent events' },
        bindings: { lines: 'eventLines' },
      },
      {
        id: 'context-outbox',
        kind: 'context-outbox',
        placement: 'full',
        props: { regionId: 'context-outbox', regionTitle: 'Context bundles' },
        bindings: { label: 'outbox.label', items: 'outbox.items' },
        events: { resume: 'resumeBundle' },
      },
    ],
  };
}

describe('@artifact-ax/ui-document · document validation', () => {
  it('accepts a valid lesson-report document', () => {
    const doc = lessonReportDocument();
    expect(checkDocument(doc)).toEqual([]);
    expect(assertDocument(doc)).toBe(doc);
  });

  it('rejects an unknown catalog kind', () => {
    const doc = lessonReportDocument();
    doc.nodes[0]!.kind = 'wacky-widget';
    expect(checkDocument(doc).some((e) => e.includes('unknown catalog kind "wacky-widget"'))).toBe(true);
  });

  it('rejects unknown props (allowlist)', () => {
    const doc = lessonReportDocument();
    (doc.nodes[0]!.props as Record<string, unknown>)['evilLabel'] = 'x';
    expect(checkDocument(doc).some((e) => e.includes('unknown prop'))).toBe(true);
  });

  it('rejects blocked executable presentation keys', () => {
    const doc = lessonReportDocument();
    (doc.nodes[0]!.props as Record<string, unknown>)['innerHTML'] = '<b>hi</b>';
    expect(checkDocument(doc).some((e) => e.includes('blocked executable presentation key'))).toBe(true);
  });

  it('rejects executable presentation text in a string prop', () => {
    const doc = lessonReportDocument();
    (doc.nodes[0]!.props as Record<string, unknown>)['regionTitle'] = 'X <script>alert(1)</script>';
    expect(checkDocument(doc).some((e) => e.includes('must not contain executable presentation markup'))).toBe(true);
  });

  it('rejects an unknown binding name', () => {
    const doc = lessonReportDocument();
    (doc.nodes[0]!.bindings as Record<string, string>)['bogus'] = 'a.b';
    expect(checkDocument(doc).some((e) => e.includes('unknown binding'))).toBe(true);
  });

  it('rejects a proto-polluting or bracket binding path', () => {
    const doc = lessonReportDocument();
    (doc.nodes[0]!.bindings as Record<string, string>)['rows'] = '__proto__.polluted';
    expect(checkDocument(doc).some((e) => e.includes('not a safe data path'))).toBe(true);

    const doc2 = lessonReportDocument();
    (doc2.nodes[0]!.bindings as Record<string, string>)['rows'] = 'a[0]';
    expect(checkDocument(doc2).some((e) => e.includes('not a safe data path'))).toBe(true);
  });

  it('rejects an unknown semantic event and a non-allowlisted action', () => {
    const doc = lessonReportDocument();
    (doc.nodes[0]!.events as Record<string, string>)['publish'] = 'x';
    expect(checkDocument(doc).some((e) => e.includes('unknown event'))).toBe(true);

    const doc2 = lessonReportDocument();
    (doc2.nodes[0]!.events as Record<string, string>)['filter'] = 'totallyWrong';
    expect(checkDocument(doc2).some((e) => e.includes('must be one of: filterRows'))).toBe(true);
  });

  it('rejects unsafe node ids and duplicate node/region ids', () => {
    const doc = lessonReportDocument();
    doc.nodes[0]!.id = 'BAD ID!';
    expect(checkDocument(doc).some((e) => e.includes('not a safe node id'))).toBe(true);

    const doc2 = lessonReportDocument();
    doc2.nodes[1]!.id = 'review-table';
    expect(checkDocument(doc2).some((e) => e.includes('duplicate node id'))).toBe(true);

    const doc3 = lessonReportDocument();
    (doc3.nodes[1]!.props as Record<string, unknown>)['regionId'] = 'review-table';
    expect(checkDocument(doc3).some((e) => e.includes('duplicate region id'))).toBe(true);
  });

  it('rejects child nodes when the catalog entry does not allow them', () => {
    const doc = lessonReportDocument();
    (doc.nodes[0] as unknown as { children: unknown }).children = [
      { id: 'child-1', kind: 'summary-list', props: { regionId: 'x-panel', regionTitle: 'x' } },
    ];
    expect(checkDocument(doc).some((e) => e.includes('does not allow child nodes'))).toBe(true);
  });

  it('rejects a wrong contract version and a non-array nodes list', () => {
    const doc = lessonReportDocument();
    (doc as { contract_version: string }).contract_version = 'artifact-ax.ui-document.v2';
    expect(checkDocument(doc).some((e) => e.includes('contract_version'))).toBe(true);

    const doc2 = lessonReportDocument();
    (doc2 as { nodes: unknown }).nodes = [];
    expect(checkDocument(doc2).some((e) => e.includes('non-empty array'))).toBe(true);
  });

  it('assertDocument throws UiDocumentError for an invalid document', () => {
    const doc = lessonReportDocument();
    (doc.nodes[0]!.events as Record<string, string>)['approve'] = 'hack';
    expect(() => assertDocument(doc)).toThrow(UiDocumentError);
  });

  it('validates a single node and reports the catalog constant surface', () => {
    expect(validateNode({ id: 'review-table', kind: 'review-table' })).toEqual([]);
    expect(CATALOG['review-table']).toBeDefined();
  });

  it('validates the ui-builder catalog surface and enforces its allowlists', () => {
    const node = {
      id: 'ui-builder',
      kind: 'ui-builder',
      placement: 'full' as const,
      props: { regionId: 'ui-builder', regionTitle: 'UI Builder', hint: 'Describe a change.' },
      bindings: {
        intent: 'uiBuilder.intent',
        status: 'uiBuilder.status',
        proposal: 'uiBuilder.proposal',
        requestDisabled: 'uiBuilder.requestDisabled',
      },
      events: { request: 'requestUiProposal', apply: 'applyUiProposal', discard: 'discardUiProposal', intent: 'uiIntentInput' },
    };
    expect(validateNode(node)).toEqual([]);
    // Unknown prop / binding / event and an unset request action are rejected.
    expect(validateNode({ ...node, props: { ...node.props, onClick: 'hack' } }).some((e) => e.includes('blocked executable presentation'))).toBe(true);
    expect(validateNode({ ...node, bindings: { ...node.bindings, evil: 'x' } }).some((e) => e.includes('unknown binding'))).toBe(true);
    expect(validateNode({ ...node, events: { ...node.events, apply: 'totallyWrong' } }).some((e) => e.includes('must be one of'))).toBe(true);
  });
});

describe('@artifact-ax/ui-document · patch application', () => {
  it('applies an insert, update, and remove producing a new revision', () => {
    const doc = lessonReportDocument();
    const docBefore = JSON.parse(JSON.stringify(doc)) as UiDocument;

    const inserted = {
      id: 'extra-summary',
      kind: 'summary-list',
      placement: 'side',
      props: { regionId: 'extra-region', regionTitle: 'Extra summary' },
      bindings: { counts: 'summary' },
      events: { focus: 'focusRegion' },
    };

    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [
        { op: 'insert', index: 0, node: inserted },
        { op: 'update', id: 'agent-notes', update: { props: { regionId: 'agent-notes', regionTitle: 'Agent notes' } } },
        { op: 'remove', id: 'event-log' },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.revision).toBe(2);
    expect(result.document.nodes).toHaveLength(docBefore.nodes.length + 1 - 1);
    // The original document is not mutated.
    expect(doc.revision).toBe(1);
    expect(doc.nodes).toHaveLength(docBefore.nodes.length);
  });

  it('rejects a patch with a stale base revision', () => {
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 9,
      ops: [{ op: 'remove', id: 'event-log' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('does not match document revision');
  });

  it('rejects an update that introduces an unknown prop or event', () => {
    const doc = lessonReportDocument();
    const badProp = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'update', id: 'agent-notes', update: { props: { evil: 'x' } } }],
    });
    expect(badProp.ok).toBe(false);
    if (!badProp.ok) expect(badProp.message).toContain('unknown prop');

    const badEvent = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'update', id: 'review-table', update: { events: { selfDestruct: 'x' } } }],
    });
    expect(badEvent.ok).toBe(false);
    if (!badEvent.ok) expect(badEvent.message).toContain('unknown event');
  });

  it('rejects an update targeting a missing node or a raw insert', () => {
    const doc = lessonReportDocument();
    const missing = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'update', id: 'ghost', update: { props: {} } }],
    });
    expect(missing.ok).toBe(false);

    const raw = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'insert', index: 0, node: { id: 'evil', kind: 'review-table', props: { regionId: 'review-table', regionTitle: '<script>' } } }],
    });
    expect(raw.ok).toBe(false);
    if (!raw.ok) expect(raw.message).toContain('executable presentation markup');
  });

  it('exposes validatePatch errors and document-id guarding', () => {
    const doc = lessonReportDocument();
    const errors = validatePatch(
      { contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION, document_id: 'other',
        base_revision: 1, ops: [{ op: 'remove', id: 'event-log' }] },
      doc,
    );
    expect(errors.some((e) => e.includes('document_id must match'))).toBe(true);
  });

  it('rejects a multi-op patch whose cumulative result has a duplicate node id, without mutation', () => {
    const doc = lessonReportDocument();
    const duplicateSummary = { id: 'summary-list', kind: 'summary-list', placement: 'side', props: { regionId: 'summary-panel', regionTitle: 'Summary' } };
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'insert', index: 0, node: duplicateSummary }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('already exists');
    expect(doc.revision).toBe(1);
  });

  it('rejects a multi-op patch that introduces a duplicate region id (cross-op outcome)', () => {
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [
        { op: 'insert', index: 0, node: { id: 'summary-a', kind: 'summary-list', placement: 'side', props: { regionId: 'summary-panel', regionTitle: 'A' } } },
        { op: 'insert', index: 1, node: { id: 'summary-b', kind: 'summary-list', placement: 'side', props: { regionId: 'summary-panel', regionTitle: 'B' } } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('duplicate region id');
    expect(doc.revision).toBe(1);
  });

  it('rejects an invalid cross-op outcome (removing a node twice)', () => {
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [
        { op: 'remove', id: 'agent-notes' },
        { op: 'remove', id: 'agent-notes' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('does not exist');
  });

  it('rejects malformed ops (null, primitive, missing discriminant/fields) as invalid_patch, never throws', () => {
    const doc = lessonReportDocument();
    const malformedOps: unknown[][] = [
      [null],
      [123],
      ['insert'],
      [{}],
      [{ op: 'bogus' }],
      [{ op: 'insert' }],
      [{ op: 'insert', index: 0 }],
      [{ op: 'update' }],
      [{ op: 'remove' }],
    ];
    for (const ops of malformedOps) {
      const result = applyPatch(doc, {
        contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
        document_id: 'lesson-report.v1',
        base_revision: 1,
        ops,
      });
      expect(result.ok, `ops: ${JSON.stringify(ops)}`).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid_patch');
    }
  });

  it('applies a chained patch (insert then update the inserted node) atomically', () => {
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [
        { op: 'insert', index: 0, node: { id: 'extra-summary', kind: 'summary-list', placement: 'side', props: { regionId: 'extra-region', regionTitle: 'Extra' } } },
        { op: 'update', id: 'extra-summary', update: { props: { regionId: 'extra-region', regionTitle: 'Extra updated' } } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]!.id).toBe('extra-summary');
  });

  it('rejects an update op that is missing the update object', () => {
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'update', id: 'summary-list' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('requires an update object');
  });

  it('rejects an empty update object', () => {
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'update', id: 'summary-list', update: {} }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('is empty');
  });

  it('rejects an update object with an unknown field', () => {
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'update', id: 'summary-list', update: { unknown: 'x' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('unknown field');
  });

  it('rejects a no-op update whose props are empty', () => {
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'update', id: 'summary-list', update: { props: {} } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('no-op update');
  });

  it('honors a passed custom catalog in validateNode and applyPatch', () => {
    const customCatalog: Catalog = {
      ...CATALOG,
      'summary-list': {
        ...CATALOG['summary-list']!,
        props: { regionId: { type: 'string', maxLength: 6 }, regionTitle: { type: 'string', maxLength: 8 } },
      },
    };
    // validateNode uses the injected catalog's prop schema, not the default.
    expect(validateNode({ id: 's', kind: 'summary-list', props: { regionId: 'panel', regionTitle: 'Summary' } }, customCatalog)).toEqual([]);
    expect(
      validateNode({ id: 's', kind: 'summary-list', props: { regionId: 'toolongvalue', regionTitle: 'Summary' } }, customCatalog)
        .some((e) => e.includes('at most 6')),
    ).toBe(true);
    // With the default catalog the same value passes (max length 64).
    expect(validateNode({ id: 's', kind: 'summary-list', props: { regionId: 'toolongvalue', regionTitle: 'Summary' } })).toEqual([]);

    // applyPatch validates an update against the injected catalog.
    const doc = lessonReportDocument();
    const result = applyPatch(doc, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: 1,
      ops: [{ op: 'update', id: 'summary-list', update: { props: { regionId: 'toolongvalue' } } }],
    }, customCatalog);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('at most 6');
  });
});

describe('@artifact-ax/ui-document · binding resolution', () => {
  const model = {
    reviewTable: { rows: [{ id: 'r-1' }], filter: { status: 'pending' }, selected: ['r-1'] },
    summary: { total: 5, pending: 3, approved: 1, rejected: 1 },
    focus: { count: 1, selections: ['s-1'] as unknown[], assessment: 'review · low', intent: 'review these', runNote: '' },
    agentNotes: [{ result_id: 'arr_abc' }],
    outbox: { label: 'mock outbox', items: [{ bundle_id: 'bdl-1' }] },
    secret: 'nope',
  };

  it('resolves dot-path bindings against the model', () => {
    expect(resolvePath(model, 'reviewTable.rows')).toEqual([{ id: 'r-1' }]);
    expect(resolvePath(model, 'summary.total')).toBe(5);
    expect(resolvePath(model, 'focus.assessment')).toBe('review · low');
  });

  it('never resolves proto-polluting or missing paths', () => {
    expect(resolvePath(model, '__proto__.polluted')).toBeUndefined();
    expect(resolvePath(model, 'constructor')).toBeUndefined();
    expect(resolvePath(model, 'does.not.exist')).toBeUndefined();
    expect(resolvePath(model, 'secret')).toBe('nope'); // keep bound data
  });

  it('resolves node bindings and coerces to list/record/scalar helpers', () => {
    const node = lessonReportDocument().nodes[0]!;
    const resolved = resolveNodeBindings(node, model);
    expect(resolved.rows).toEqual([{ id: 'r-1' }]);
    expect(asList(resolved.rows)).toHaveLength(1);
    expect(asList(resolved.filter)).toEqual([]);
    expect(asRecord(asList(resolved.filter))).toEqual({});
    expect(asRecord(resolved.filter)).toEqual({ status: 'pending' });
    expect(asString(resolved.rows)).toBe('');
    expect(asString(resolved.rows, 'fallback')).toBe('fallback');
  });
});
