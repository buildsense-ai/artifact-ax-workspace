import { type IntentKind, type Selection } from './types.js';

/**
 * Semantic grouping: only selections that live in the same artifact, revision
 * and region are compatible enough to share one bundle. Regions / artifacts
 * that differ are split into separate groups rather than silently merged, so
 * an unrelated selection is never folded into an intent it does not apply to.
 */

export interface SelectionGroup {
  key: string;
  artifact_id: string;
  revision: number;
  region_id: string;
  region_title?: string;
  /** Ordered selections, preserving the order they were added. */
  selections: Selection[];
}

export function groupSelections(selections: Selection[]): SelectionGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, SelectionGroup>();
  for (const sel of selections) {
    const key = `${sel.artifact_id}|${sel.revision}|${sel.region_id}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        artifact_id: sel.artifact_id,
        revision: sel.revision,
        region_id: sel.region_id,
        ...(sel.region_title !== undefined ? { region_title: sel.region_title } : {}),
        selections: [],
      };
      byKey.set(key, group);
      order.push(key);
    }
    group.selections.push(sel);
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * Whether a region structurally supports a mutation intent. Derived /
 * read-only regions (summaries, approval panels) should not receive
 * write/destructive intents. Used by the service to hold an incompatible
 * group instead of sending it. Defaults to writable.
 */
export type RegionWritability = (regionId: string) => boolean;

export function mutationIntent(intent: IntentKind): boolean {
  return intent === 'change' || intent === 'destructive';
}
