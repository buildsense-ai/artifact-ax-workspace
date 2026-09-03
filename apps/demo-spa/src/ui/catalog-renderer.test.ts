import { describe, it, expect } from 'vitest';
import { surfaceAnchors } from './catalog-renderer.js';
import { LESSON_REPORT_DOCUMENT } from './lesson-report.document.js';

/**
 * The catalog renderer must emit a stable `data-node-id` anchor on every
 * document surface (region shell and focus composer), not only on table rows.
 * `surfaceAnchors` is the pure seam the renderer uses to derive those anchors,
 * so testing it proves each UiNode.id surfaces as its node anchor.
 */
describe('demo-spa · catalog renderer surface anchors', () => {
  it('renders every document surface with a data-node-id matching its UiNode.id', () => {
    for (const node of LESSON_REPORT_DOCUMENT.nodes) {
      const { regionId, nodeId } = surfaceAnchors(node);
      expect(nodeId).toBe(node.id);
      expect(regionId).toBe(String((node.props as { regionId?: string } | undefined)?.regionId ?? node.id));
    }
  });

  it('covers every surface kind the renderer implements', () => {
    const kinds = LESSON_REPORT_DOCUMENT.nodes.map((node) => node.kind).sort();
    expect(kinds).toEqual(
      ['agent-notes', 'approval-list', 'context-outbox', 'event-log', 'focus-composer', 'review-table', 'summary-list', 'ui-builder'].sort(),
    );
  });

  it('defaults the region anchor to the node id when no regionId prop is set', () => {
    expect(surfaceAnchors({ id: 'solo', kind: 'summary-list' })).toEqual({ regionId: 'solo', nodeId: 'solo' });
  });
});
