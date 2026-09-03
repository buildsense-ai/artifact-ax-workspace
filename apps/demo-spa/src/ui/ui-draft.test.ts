import { describe, it, expect } from 'vitest';
import { LESSON_REPORT_DOCUMENT } from './lesson-report.document.js';
import { applyUiDocumentPatch, checkUiDocument, missingProtectedNodes, PROTECTED_NODE_IDS } from './ui-draft.js';
import { UI_DOCUMENT_PATCH_CONTRACT_VERSION } from '@artifact-ax/ui-document';

describe('demo-spa · UI-document draft/patch boundary (draft-only)', () => {
  it('accepts the shipped lesson-report document', () => {
    expect(checkUiDocument(LESSON_REPORT_DOCUMENT)).toEqual([]);
  });

  it('applies a validated patch to a bound surface without mutating the base', () => {
    const baseRevision = LESSON_REPORT_DOCUMENT.revision;
    const result = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: baseRevision,
      ops: [
        { op: 'update', id: 'review-table', update: { props: { regionId: 'review-table', regionTitle: 'Review table', emptyText: 'No rows.' } } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.id).toBe('lesson-report.v1');
    expect(result.document.revision).toBe(baseRevision + 1);
    // The shipped document is immutable.
    expect(LESSON_REPORT_DOCUMENT.revision).toBe(baseRevision);
  });

  it('rejects a patch that introduces an unknown prop (allowlist enforcement)', () => {
    const result = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [
        { op: 'update', id: 'review-table', update: { props: { innerHTML: '<script>alert(1)</script>' } } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/blocked executable presentation key|unknown prop|not allowed/);
  });

  it('rejects a stale draft (base revision mismatch)', () => {
    const result = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: LESSON_REPORT_DOCUMENT.revision + 99,
      ops: [{ op: 'remove', id: 'event-log' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('does not match document revision');
  });

  it('rejects a patch that drifts the region/node anchors outside the deployed document', () => {
    const result = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [{ op: 'update', id: 'review-table', update: { props: { regionId: 'admin-panel', regionTitle: 'Review table' } } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('anchor_drift');
  });

  it('accepts a patch that stays within the deployed anchors', () => {
    const result = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [{ op: 'update', id: 'review-table', update: { props: { regionId: 'review-table', regionTitle: 'Review table' } } }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.applied).toBe(1);
  });

  it('rejects removal of a protected governance surface with code protected_surface', () => {
    // The shipped document retains every protected surface.
    expect(PROTECTED_NODE_IDS).toEqual(['review-table', 'approval-list', 'ui-builder']);
    expect(missingProtectedNodes(LESSON_REPORT_DOCUMENT)).toEqual([]);
    for (const id of PROTECTED_NODE_IDS) {
      const result = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
        contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
        document_id: 'lesson-report.v1',
        base_revision: LESSON_REPORT_DOCUMENT.revision,
        ops: [{ op: 'remove', id }],
      });
      expect(result.ok, `removing ${id} must be rejected`).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('protected_surface');
        expect(result.message).toContain(id);
      }
    }
  });

  it('rejects a multi-op patch that removes a protected surface among otherwise valid ops', () => {
    const result = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [
        { op: 'update', id: 'summary-list', update: { props: { regionId: 'summary-panel', regionTitle: 'Summary' } } },
        { op: 'remove', id: 'approval-list' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('protected_surface');
  });

  it('still allows removing a surface that is not protected (event-log)', () => {
    const result = applyUiDocumentPatch(LESSON_REPORT_DOCUMENT, {
      contract_version: UI_DOCUMENT_PATCH_CONTRACT_VERSION,
      document_id: 'lesson-report.v1',
      base_revision: LESSON_REPORT_DOCUMENT.revision,
      ops: [{ op: 'remove', id: 'event-log' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(missingProtectedNodes(result.document)).toEqual([]);
  });
});
