/**
 * Read-only renderer for catalog-validated UiDocuments (json-render).
 *
 * Scope is deliberately narrow: this renders *staged previews* inside
 * proposal cards — the Agent composes a bounded document from the fixed
 * catalog, the page resolves its data bindings against a snapshot view
 * model and paints the result. Events never wire here: a staged view is a
 * preview, not a live surface. `Use` applies only the row-selection recipe.
 */

import { asList, asRecord, asString, resolveNodeBindings } from '@artifact-ax/ui-document';
import type { UiDocument, UiNode } from '@artifact-ax/ui-document';
import { el } from './view.js';

export function renderUiDocumentPreview(document: UiDocument, model: Record<string, unknown>): HTMLElement {
  const host = el('div', 'ui-doc');
  if (document.title) host.appendChild(el('div', 'ui-doc-title', document.title));
  for (const node of document.nodes) {
    host.appendChild(renderNode(node, model));
  }
  return host;
}

function renderNode(node: UiNode, model: Record<string, unknown>): HTMLElement {
  const bindings = resolveNodeBindings(node, model);
  const region = el('section', 'ui-doc-node');
  region.dataset.nodeId = node.id;
  const regionId = node.props?.regionId;
  if (typeof regionId === 'string') region.dataset.regionId = regionId;
  if (node.placement) region.dataset.placement = node.placement;
  const title = node.props?.regionTitle;
  if (typeof title === 'string' && title) {
    region.appendChild(el('div', 'ui-doc-node-title', title));
  }
  switch (node.kind) {
    case 'review-table':
      region.appendChild(renderRows(asList(bindings.rows), asString(node.props?.emptyText)));
      break;
    case 'summary-list':
      region.appendChild(renderCounts(asRecord(bindings.counts)));
      break;
    case 'agent-notes':
      region.appendChild(renderLines(asList(bindings.notes), asString(node.props?.emptyText, '(no notes)')));
      break;
    case 'event-log':
      region.appendChild(renderLines(asList(bindings.lines), '(no events)'));
      break;
    default:
      region.appendChild(el('div', 'muted', `preview unavailable for ${node.kind}`));
  }
  for (const child of node.children ?? []) {
    region.appendChild(renderNode(child, model));
  }
  return region;
}

const ROW_COLUMNS = ['id', 'student', 'topic', 'status'] as const;

function renderRows(rows: unknown[], emptyText: string): HTMLElement {
  if (rows.length === 0) return el('div', 'muted', emptyText || '(no rows)');
  const table = el('table', 'ui-doc-table');
  const head = el('tr', '');
  for (const column of ROW_COLUMNS) head.appendChild(el('th', '', column));
  table.appendChild(head);
  for (const raw of rows) {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const tr = el('tr', '');
    for (const column of ROW_COLUMNS) {
      tr.appendChild(el('td', '', asString(row[column] ?? '—')));
    }
    table.appendChild(tr);
  }
  return table;
}

function renderCounts(counts: Record<string, unknown>): HTMLElement {
  const host = el('div', 'ui-doc-counts');
  const entries = Object.entries(counts);
  if (entries.length === 0) return el('div', 'muted', '(no counts)');
  for (const [name, value] of entries) {
    host.appendChild(el('span', 'chip', `${name} ${asString(value, '0')}`));
  }
  return host;
}

function renderLines(lines: unknown[], emptyText: string): HTMLElement {
  if (lines.length === 0) return el('div', 'muted', emptyText);
  const host = el('ul', 'ui-doc-lines');
  for (const line of lines.slice(0, 10)) {
    host.appendChild(el('li', '', asString(line)));
  }
  return host;
}
