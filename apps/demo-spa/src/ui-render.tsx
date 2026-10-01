/**
 * Read-only React renderer for catalog-validated UiDocuments.
 *
 * Same scope as the DOM version it replaces: staged previews only — bindings
 * resolve against a snapshot model, events never wire. Text lands as React
 * children, never markup.
 */

import type { ReactElement } from 'react';
import { asList, asRecord, asString, resolveNodeBindings } from '@artifact-ax/ui-document';
import type { UiDocument, UiNode } from '@artifact-ax/ui-document';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { Badge } from './components/ui/badge.js';
import { cn } from './lib/utils.js';

export function UiDocumentPreview({ document, model }: { document: UiDocument; model: Record<string, unknown> }): ReactElement {
  return (
    <div className="my-2 rounded-lg border border-dashed border-border bg-secondary/30 p-3 text-[13px]">
      {document.title ? <div className="mb-1.5 font-semibold">{document.title}</div> : null}
      {document.nodes.map((node) => (
        <UiNodeView key={node.id} node={node} model={model} />
      ))}
    </div>
  );
}

function UiNodeView({ node, model }: { node: UiNode; model: Record<string, unknown> }): ReactElement {
  const bindings = resolveNodeBindings(node, model);
  const regionId = node.props?.regionId;
  const title = node.props?.regionTitle;
  return (
    <section
      className="my-1.5"
      data-node-id={node.id}
      {...(typeof regionId === 'string' ? { 'data-region-id': regionId } : {})}
      {...(node.placement ? { 'data-placement': node.placement } : {})}
    >
      {typeof title === 'string' && title ? (
        <div className="mb-1 text-xs text-muted-foreground">{title}</div>
      ) : null}
      <NodeBody node={node} bindings={bindings} />
      {(node.children ?? []).map((child) => (
        <UiNodeView key={child.id} node={child} model={model} />
      ))}
    </section>
  );
}

const ROW_COLUMNS = ['id', 'student', 'topic', 'status'] as const;

function NodeBody({ node, bindings }: { node: UiNode; bindings: Record<string, unknown> }): ReactElement {
  switch (node.kind) {
    case 'review-table':
      return <DocRows rows={asList(bindings.rows)} empty={asString(node.props?.emptyText)} />;
    case 'summary-list':
      return <DocCounts counts={asRecord(bindings.counts)} />;
    case 'agent-notes':
      return <DocLines lines={asList(bindings.notes)} empty={asString(node.props?.emptyText, '(no notes)')} />;
    case 'event-log':
      return <DocLines lines={asList(bindings.lines)} empty="(no events)" />;
    case 'approval-list':
      return <DocLines lines={asList(bindings.approvals).map((a) => asString(a))} empty={asString(node.props?.emptyText, '(no approvals)')} />;
    case 'focus-composer':
      return <DocLines lines={asList(bindings.selections).map((a) => asString(a))} empty={asString(node.props?.hint, '(no selections)')} />;
    case 'context-outbox':
      return <DocLines lines={asList(bindings.items).map((a) => asString(a))} empty={asString(node.props?.emptyText, '(empty outbox)')} />;
    case 'ui-builder': {
      const proposal = asRecord(bindings.proposal);
      const intent = asString(bindings.intent);
      return (
        <div className="text-xs text-muted-foreground">
          {intent ? <div>intent: {intent}</div> : null}
          <DocLines lines={Object.keys(proposal)} empty="(no staged proposal)" />
        </div>
      );
    }
    default:
      return <div className="text-xs text-muted-foreground">preview unavailable for {node.kind}</div>;
  }
}

function DocRows({ rows, empty }: { rows: unknown[]; empty: string }): ReactElement {
  if (rows.length === 0) return <div className="text-xs text-muted-foreground">{empty || '(no rows)'}</div>;
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          {ROW_COLUMNS.map((column) => (
            <TableHead key={column} className="h-7">{column}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((raw, i) => {
          const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
          return (
            <TableRow key={asString(row.id, String(i))}>
              {ROW_COLUMNS.map((column) => (
                <TableCell key={column} className="px-2 py-1">{asString(row[column] ?? '—')}</TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function DocCounts({ counts }: { counts: Record<string, unknown> }): ReactElement {
  const entries = Object.entries(counts);
  if (entries.length === 0) return <div className="text-xs text-muted-foreground">(no counts)</div>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([name, value]) => (
        <Badge key={name} variant="secondary">
          {name} {asString(value, '0')}
        </Badge>
      ))}
    </div>
  );
}

function DocLines({ lines, empty }: { lines: unknown[]; empty: string }): ReactElement {
  if (lines.length === 0) return <div className={cn('text-xs text-muted-foreground')}>{empty}</div>;
  return (
    <ul className="m-0 list-disc pl-4 text-xs text-muted-foreground">
      {lines.slice(0, 10).map((line, i) => (
        <li key={i}>{typeof line === 'string' ? line : asString(line)}</li>
      ))}
    </ul>
  );
}
