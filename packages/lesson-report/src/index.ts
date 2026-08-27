import { type Role, type Membership } from '@artifact-ax/contract';
import { type ArtifactSpec, type CapabilityHandler, type HandlerContext } from '@artifact-ax/domain';

/**
 * Teaching-report domain vocabulary (region ids, row statuses) shared by the
 * capability handlers, the demo SPA, and tests.
 */

export type RowStatus = 'pending' | 'approved' | 'rejected';

export interface ReviewRow {
  id: string;
  student: string;
  topic: string;
  status: RowStatus;
  score?: number;
}

export interface ReviewTableState {
  rows: ReviewRow[];
  filter: { status?: RowStatus | 'all' };
}

export function filterRows(table: ReviewTableState): ReviewTableState['rows'] {
  const status = table.filter.status ?? 'all';
  if (status === 'all') return table.rows;
  return table.rows.filter((row) => row.status === status);
}

export function summarize(table: ReviewTableState): { total: number; pending: number; approved: number; rejected: number } {
  return {
    total: table.rows.length,
    pending: table.rows.filter((r) => r.status === 'pending').length,
    approved: table.rows.filter((r) => r.status === 'approved').length,
    rejected: table.rows.filter((r) => r.status === 'rejected').length,
  };
}

const filterRowsHandler: CapabilityHandler = (ctx: HandlerContext) => {
  const table = ctx.regions.get('review-table') as ReviewTableState;
  const status = ctx.args['status'] as RowStatus | 'all' | undefined;
  const next: ReviewTableState = { ...table, filter: { status: status ?? 'all' } };
  const visible = filterRows(next);
  return {
    result: { visible_row_ids: visible.map((r) => r.id), count: visible.length },
    region_updates: [{ region_id: 'review-table', data: next }],
  };
};

const approveRowsHandler: CapabilityHandler = (ctx: HandlerContext) => {
  const table = ctx.regions.get('review-table') as ReviewTableState;
  const rowIds = (ctx.args['row_ids'] ?? []) as string[];
  const byId = new Map(table.rows.map((row) => [row.id, row]));
  const missing = rowIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`unknown rows: ${missing.join(', ')}`);
  }
  const next: ReviewTableState = {
    ...table,
    rows: table.rows.map((row) => (rowIds.includes(row.id) ? { ...row, status: 'approved' as const } : row)),
  };
  return {
    result: { approved: rowIds.length, row_ids: rowIds },
    region_updates: [{ region_id: 'review-table', data: next }],
  };
};

export const LESSON_REPORT_SPEC: ArtifactSpec = {
  workspace_id: 'ws_demo',
  artifact_id: 'lesson-report',
  title: 'Lesson report',
  kind: 'mini_app',
  agent_uid: '440',
  policy_hints: [
    'rows are approved only after a reviewer resolves the approval',
    'publishing a new version requires a resolved publish approval',
  ],
  regions: [
    {
      id: 'review-table',
      title: 'Review table',
      summary: 'Rows awaiting teacher review',
      order: 1,
      schema: {
        type: 'object',
        properties: {
          rows: { type: 'array', items: { type: 'object' } },
          filter: { type: 'object' },
        },
        required: ['rows', 'filter'],
      },
      initial_data: {
        rows: [
          { id: 'r-1', student: 'A. Chen', topic: 'Linear equations', status: 'pending' },
          { id: 'r-2', student: 'B. Li', topic: 'Poetry analysis', status: 'pending' },
          { id: 'r-3', student: 'C. Wang', topic: 'Photosynthesis', status: 'pending' },
          { id: 'r-4', student: 'D. Zhao', topic: 'Fractions', status: 'approved' },
          { id: 'r-5', student: 'E. Sun', topic: 'Essay draft', status: 'pending' },
        ],
        filter: { status: 'pending' },
      },
    },
    {
      id: 'summary-panel',
      title: 'Summary',
      summary: 'Counts by review status',
      order: 2,
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          pending: { type: 'integer' },
          approved: { type: 'integer' },
          rejected: { type: 'integer' },
        },
      },
      initial_data: {},
    },
    {
      id: 'approval-panel',
      title: 'Approvals',
      summary: 'Pending approvals and resolution',
      order: 3,
      schema: { type: 'object', properties: {}, additionalProperties: false },
      initial_data: {},
    },
  ],
  capabilities: [
    {
      name: 'filter_rows',
      description: 'Filter the review table rows by status',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['all', 'pending', 'approved', 'rejected'] },
        },
      },
      requires: ['artifact:execute'],
      handler: filterRowsHandler,
    },
    {
      name: 'approve_rows',
      description: 'Approve selected rows after a reviewer resolves the approval',
      input_schema: {
        type: 'object',
        properties: {
          row_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['row_ids'],
      },
      requires: ['artifact:execute'],
      requires_approval: {
        message: 'Approve selected rows in the published report',
        assignees: ['human_reviewer'],
      },
      handler: approveRowsHandler,
    },
  ],
};

export const LESSON_REPORT_MEMBERS: Membership[] = [
  { actor_id: 'human_teacher', roles: ['owner', 'reviewer'] as Role[] },
  { actor_id: 'human_reviewer', roles: ['reviewer'] as Role[] },
  // Demo convenience: the agent can also publish; consequential approval still
  // lands with the human assignees below. Production policy separates roles.
  { actor_id: 'agent_440', roles: ['operator', 'builder', 'reviewer'] as Role[] },
];