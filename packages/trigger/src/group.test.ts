import { describe, expect, it } from 'vitest';
import { groupSelections, mutationIntent } from './group.js';
import { type Selection } from './types.js';

function sel(regionId: string, revision = 0, artifactId = 'lesson-report', nodeId?: string): Selection {
  return {
    selection_id: `sel-${regionId}-${nodeId ?? ''}`,
    artifact_id: artifactId,
    revision,
    region_id: regionId,
    ...(nodeId ? { node_id: nodeId } : {}),
    label: regionId,
  };
}

describe('groupSelections', () => {
  it('groups only selections in the same artifact/revision/region', () => {
    const groups = groupSelections([
      sel('review-table', 0, 'lesson-report', 'r-1'),
      sel('review-table', 0, 'lesson-report', 'r-2'),
      sel('summary-panel', 0, 'lesson-report'),
    ]);
    expect(groups).toHaveLength(2);
    const table = groups.find((g) => g.region_id === 'review-table')!;
    const summary = groups.find((g) => g.region_id === 'summary-panel')!;
    expect(table.selections.map((s) => s.node_id)).toEqual(['r-1', 'r-2']);
    expect(summary.selections).toHaveLength(1);
  });

  it('splits different revisions and artifacts rather than merging silently', () => {
    const groups = groupSelections([
      sel('review-table', 0, 'lesson-report'),
      sel('review-table', 3, 'lesson-report'),
      sel('review-table', 0, 'other-artifact'),
    ]);
    expect(groups).toHaveLength(3);
  });

  it('preserves selection order within a group and group order across groups', () => {
    const groups = groupSelections([
      sel('a', 0, 'x'),
      sel('b', 0, 'x'),
      sel('a', 0, 'x'),
      sel('c', 0, 'x'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['x|0|a', 'x|0|b', 'x|0|c']);
    const a = groups[0]!;
    expect(a.selections.map((s) => s.region_id)).toEqual(['a', 'a']);
  });

  it('returns empty for no selections', () => {
    expect(groupSelections([])).toEqual([]);
  });

  it('mutationIntent is true only for change and destructive', () => {
    expect(mutationIntent('change')).toBe(true);
    expect(mutationIntent('destructive')).toBe(true);
    for (const k of ['collect', 'inspect', 'explain', 'review', 'compare', 'ambiguous'] as const) {
      expect(mutationIntent(k)).toBe(false);
    }
  });
});
