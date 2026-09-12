import { describe, expect, it } from 'vitest';
import { UI_DOCUMENT_PATCH_CONTRACT_VERSION, validateDocument, type UiDocument, type UiNode } from '@artifact-ax/ui-document';
import { LESSON_REPORT_DOCUMENT } from './lesson-report.document.js';
import { applyUiDocumentPatch, checkUiDocument, PROTECTED_NODE_IDS } from './ui-draft.js';
import { loadActiveDocument, loadUiProposals, saveActiveDocument, saveUiProposals, UiProposalManager } from '../ui-builder.js';

function replaceSurface(id: string, change: (node: UiNode) => UiNode): UiDocument {
  const copy = structuredClone(LESSON_REPORT_DOCUMENT);
  copy.nodes = copy.nodes.map((node) => node.id === id ? change(node) : node);
  return copy;
}

function storageFor(document: UiDocument): Storage {
  const map = new Map([['document', JSON.stringify(document)]]);
  return {
    get length() { return map.size; },
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
  };
}

const corruptions: Array<[string, (node: UiNode) => UiNode]> = [
  ['component replacement', (node) => ({ id: node.id, kind: 'event-log', props: { regionId: node.props!.regionId! } })],
  ['missing data bindings', (node) => ({ ...node, bindings: {} })],
  ['redirected data bindings', (node) => ({ ...node, bindings: Object.fromEntries(Object.keys(node.bindings!).map((key) => [key, 'other.safePath'])) })],
  ['missing action bindings', (node) => ({ ...node, events: {} })],
];

describe.each(PROTECTED_NODE_IDS)('protected surface integrity: %s', (id) => {
  it.each(corruptions)('rejects %s although the node ID and catalog shape remain valid', (_label, change) => {
    const document = replaceSurface(id, change);
    // Generic catalog membership alone cannot protect application governance.
    expect(validateDocument(document)).toEqual([]);
    expect(checkUiDocument(document).length).toBeGreaterThan(0);
    const storage = storageFor(document);
    expect(loadActiveDocument(storage, 'document', LESSON_REPORT_DOCUMENT)).toBe(LESSON_REPORT_DOCUMENT);
    expect(saveActiveDocument(storage, document, 'document')).toBe(false);
  });

  it('rejects a patch that redirects one required binding, without staging or persisting it', () => {
    const source = LESSON_REPORT_DOCUMENT.nodes.find((node) => node.id === id)!;
    const binding = Object.keys(source.bindings!)[0]!;
    const patch = {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: LESSON_REPORT_DOCUMENT.id,
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [{ op: 'update', id, update: { bindings: { [binding]: 'other.safePath' } } }],
    };
    expect(applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, patch)).toMatchObject({ ok: false, code: 'protected_surface' });
    const storage = storageFor(LESSON_REPORT_DOCUMENT);
    const manager = new UiProposalManager({ storage, storageKey: 'proposals', documentStorageKey: 'document' });
    expect(manager.stage({ result_id: 'test-proposal', payload: patch, document: LESSON_REPORT_DOCUMENT }))
      .toMatchObject({ ok: false, code: 'protected_surface' });
    expect(manager.current()).toBeNull();
    expect(storage.getItem('proposals')).toBeNull();
  });

  it('revalidates stored proposals and a forged base against shipped wiring, not against themselves', () => {
    const source = LESSON_REPORT_DOCUMENT.nodes.find((node) => node.id === id)!;
    const binding = Object.keys(source.bindings!)[0]!;
    const patch = {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: LESSON_REPORT_DOCUMENT.id,
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [{ op: 'update' as const, id, update: { props: { regionTitle: 'Localized' } } }],
    };
    const forgedBase = replaceSurface(id, (node) => ({ ...node, bindings: { ...node.bindings, [binding]: 'other.safePath' } }));
    expect(applyUiDocumentPatch(forgedBase, patch)).toMatchObject({ ok: false, code: 'protected_surface' });

    const storage = storageFor(LESSON_REPORT_DOCUMENT);
    const manager = new UiProposalManager({ storage, storageKey: 'proposals', documentStorageKey: 'document' });
    const staged = manager.stage({ result_id: 'test-proposal', payload: patch, document: LESSON_REPORT_DOCUMENT });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    // A stored patch can pass structural checks but must never bypass the
    // current application-policy check at Apply.
    staged.record.patch.ops = [{ op: 'update', id, update: { bindings: { [binding]: 'other.safePath' } } }];
    expect(saveUiProposals(storage, [staged.record], 'proposals')).toBe(true);
    const reopened = new UiProposalManager({
      storage, storageKey: 'proposals', documentStorageKey: 'document',
      initial: loadUiProposals(storage, 'proposals'),
    });
    expect(reopened.apply(LESSON_REPORT_DOCUMENT)).toMatchObject({ ok: false, code: 'protected_surface' });
    expect(reopened.current()?.state).toBe('stale');
    expect(loadActiveDocument(storage, 'document', LESSON_REPORT_DOCUMENT)).toEqual(LESSON_REPORT_DOCUMENT);
  });

  it('keeps ordinary copy and placement edits valid without freezing the whole surface', () => {
    const document = replaceSurface(id, (node) => ({
      ...node, placement: 'main', props: { ...node.props, regionTitle: 'Localized title' },
    }));
    expect(checkUiDocument(document)).toEqual([]);
    const storage = storageFor(LESSON_REPORT_DOCUMENT);
    expect(saveActiveDocument(storage, document, 'document')).toBe(true);
    expect(loadActiveDocument(storage, 'document', LESSON_REPORT_DOCUMENT)).toEqual(document);
    expect(applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: LESSON_REPORT_DOCUMENT.id,
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [{ op: 'update', id, update: { props: { regionTitle: 'Localized title' } } }],
    }).ok).toBe(true);
  });
});

it('cannot repurpose a protected region to another known, now-vacant region ID', () => {
  const patch = {
    contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
    document_id: LESSON_REPORT_DOCUMENT.id,
    base_revision: LESSON_REPORT_DOCUMENT.revision,
    ops: [
      { op: 'remove', id: 'event-log' },
      { op: 'update', id: 'ui-builder', update: { props: { regionId: 'event-log' } } },
    ],
  };
  expect(applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, patch)).toMatchObject({ ok: false, code: 'protected_surface' });
});
