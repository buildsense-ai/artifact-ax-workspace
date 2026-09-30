/**
 * Teaching-report domain vocabulary shared by the collaborative demo
 * artifact: review rows, statuses, and the seed data the shared document
 * starts from when a room is first opened.
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
  filter: { status: RowStatus | 'all' };
}

export const REVIEW_REGION_ID = 'review-table' as const;

export function filterRows(table: ReviewTableState): ReviewRow[] {
  const status = table.filter.status;
  if (status === 'all') return table.rows;
  return table.rows.filter((row) => row.status === status);
}

export function summarize(table: ReviewTableState): { total: number; pending: number; approved: number; rejected: number } {
  return {
    total: table.rows.length,
    pending: table.rows.filter((row) => row.status === 'pending').length,
    approved: table.rows.filter((row) => row.status === 'approved').length,
    rejected: table.rows.filter((row) => row.status === 'rejected').length,
  };
}

export function seedReviewTable(): ReviewTableState {
  return {
    rows: [
      { id: 'r-1', student: 'A. Chen', topic: 'Linear equations', status: 'pending' },
      { id: 'r-2', student: 'B. Li', topic: 'Poetry analysis', status: 'pending' },
      { id: 'r-3', student: 'C. Wang', topic: 'Photosynthesis', status: 'pending' },
      { id: 'r-4', student: 'D. Zhao', topic: 'Fractions', status: 'approved' },
      { id: 'r-5', student: 'E. Sun', topic: 'Essay draft', status: 'pending' },
    ],
    filter: { status: 'pending' },
  };
}

export function isReviewRow(value: unknown): value is ReviewRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.student === 'string'
    && typeof row.topic === 'string'
    && (row.status === 'pending' || row.status === 'approved' || row.status === 'rejected');
}
