import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  UI_DOCUMENT_CONTRACT_VERSION,
  UI_DOCUMENT_PATCH_CONTRACT_VERSION,
  UI_DOCUMENT_PATCH_MAX_SERIALIZED_CHARS,
  validateDocument,
  validatePatchStructure,
  type UiDocument,
} from './index.js';

const document: UiDocument = {
  contract_version: UI_DOCUMENT_CONTRACT_VERSION,
  id: 'test.v1', revision: 1,
  nodes: [{ id: 'table', kind: 'review-table', props: { regionTitle: 'Review' } }],
};
const patch = (ops: unknown[]) => ({
  contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
  document_id: document.id,
  base_revision: document.revision,
  ops,
});

describe('shared patch structure', () => {
  it.each([
    ['extra envelope', { ...patch([{ op: 'remove', id: 'table' }]), authority: true }],
    ['empty key', { ...patch([{ op: 'remove', id: 'table' }]), '': true }],
    ['extra op', patch([{ op: 'remove', id: 'table', execute: 'anything' }])],
    ['extra node', patch([{ op: 'insert', index: 0, node: { id: 'new', kind: 'summary-list', html: 'raw' } }])],
    ['extra child', patch([{ op: 'insert', index: 0, node: { id: 'new', kind: 'summary-list', children: [{ id: 'child', kind: 'summary-list', unknown: true }] } }])],
    ['nested prop', patch([{ op: 'update', id: 'table', update: { props: { regionTitle: { html: 'raw' } } } }])],
    ['null prop', patch([{ op: 'update', id: 'table', update: { props: { regionTitle: null } } }])],
    ['non-finite prop', patch([{ op: 'update', id: 'table', update: { props: { count: Infinity } } }])],
    ['function prop', patch([{ op: 'update', id: 'table', update: { props: { regionTitle: () => 'bad' } } }])],
    ['non-string binding', patch([{ op: 'update', id: 'table', update: { bindings: { rows: [] } } }])],
    ['unsafe key', patch([{ op: 'update', id: 'table', update: { props: JSON.parse('{"__proto__":"unsafe"}') } }])],
    ['empty update', patch([{ op: 'update', id: 'table', update: { props: {} } }])],
    ['unsafe revision', { ...patch([{ op: 'remove', id: 'table' }]), base_revision: Number.MAX_SAFE_INTEGER }],
    ['too many ops', patch(Array.from({ length: 33 }, () => ({ op: 'remove', id: 'table' })))],
  ])('rejects %s consistently at structure and apply boundaries', (_label, input) => {
    expect(validatePatchStructure(input).length).toBeGreaterThan(0);
    expect(applyPatch(document, input)).toMatchObject({ ok: false, code: 'invalid_patch' });
  });

  it('enforces the exact serialized-character bound, independent of catalog semantics', () => {
    const input = patch([{ op: 'update', id: 'table', update: { props: { regionTitle: '' } } }]);
    const op = input.ops[0] as { update: { props: { regionTitle: string } } };
    op.update.props.regionTitle = '字'.repeat(UI_DOCUMENT_PATCH_MAX_SERIALIZED_CHARS - JSON.stringify(input).length);
    expect(JSON.stringify(input)).toHaveLength(UI_DOCUMENT_PATCH_MAX_SERIALIZED_CHARS);
    expect(validatePatchStructure(input)).toEqual([]);
    // Structure is not a substitute for value-level catalog validation.
    expect(applyPatch(document, input).ok).toBe(false);
    op.update.props.regionTitle += '字';
    expect(validatePatchStructure(input).length).toBeGreaterThan(0);
  });

  it('rejects cycles and deeply nested children without throwing', () => {
    const cyclic: Record<string, unknown> = { id: 'new', kind: 'summary-list' };
    cyclic.children = [cyclic];
    expect(validatePatchStructure(patch([{ op: 'insert', index: 0, node: cyclic }])).length).toBeGreaterThan(0);
    let deep: unknown = { id: 'leaf', kind: 'summary-list' };
    for (let i = 0; i < 34; i += 1) deep = { id: 'parent', kind: 'summary-list', children: [deep] };
    expect(validatePatchStructure(patch([{ op: 'insert', index: 0, node: deep }])).length).toBeGreaterThan(0);
  });

  it('leaves target and catalog validation at the cumulative apply boundary', () => {
    const input = patch([{ op: 'update', id: 'missing', update: { props: { regionTitle: 'Safe' } } }]);
    expect(validatePatchStructure(input)).toEqual([]);
    expect(applyPatch(document, input).ok).toBe(false);
    const valid = patch([{ op: 'update', id: 'table', update: { props: { regionTitle: 'Safe' } } }]);
    expect(validatePatchStructure(valid)).toEqual([]);
    expect(applyPatch(document, valid).ok).toBe(true);
    expect(applyPatch({ ...document, revision: 2 }, valid).ok).toBe(false);
    expect(document.nodes[0]?.props?.regionTitle).toBe('Review');
  });

  it.each([
    { ...document, unknown: true },
    { ...document, layout: { template: 'main-side', script: 'bad' } },
    { ...document, nodes: [null] },
    { ...document, nodes: [{ id: 'table', kind: '__proto__' }] },
    { ...document, nodes: [{ id: 'table', kind: 'review-table', unknown: true }] },
  ])('rejects malformed stored document shape without throwing', (input) => {
    expect(validateDocument(input as unknown as UiDocument).length).toBeGreaterThan(0);
  });
});
