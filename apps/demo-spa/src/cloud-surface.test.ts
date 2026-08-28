import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseArtifactManifest } from '@artifact-ax/contract';
import {
  AGENT_NOTES_STORAGE_KEY,
  CLOUD_RESULT_SINK_ID,
  agentNotesStorageKey,
  buildSemanticContext,
  noteFingerprint,
  validateAgentNotePayload,
} from './cloud-surface.js';

describe('demo cloud surface helpers', () => {
  it('keeps semantic context bounded to stable application anchors', () => {
    const context = buildSemanticContext({
      revision: 3,
      table: { rows: [{ id: 'r-1', student: 'A', topic: 'Linear', status: 'pending' }], filter: { status: 'pending' } },
      visibleRows: [{ id: 'r-1', student: 'A', topic: 'Linear', status: 'pending' }],
      selections: [{
        selection_id: 'sel-1',
        artifact_id: 'lesson-report',
        revision: 3,
        region_id: 'review-table',
        node_id: 'r-1',
        label: 'A · Linear',
        note: 'check evidence',
      }],
      notes: [],
    });
    expect(context).toMatchObject({
      view: 'lesson-report',
      state_revision: '3',
      selected_rows: ['r-1'],
      dirty: false,
    });
    expect(CLOUD_RESULT_SINK_ID).toBe('lesson-report.agent-notes.upsert.v1');
  });

  it('keeps a large page-authored snapshot below the bridge semantic limit', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: `r-${index}`,
      student: 'Student '.repeat(30),
      topic: 'Topic '.repeat(30),
      status: 'pending' as const,
    }));
    const context = buildSemanticContext({
      revision: 1,
      table: { rows, filter: { status: 'all' } },
      visibleRows: rows,
      selections: [],
      notes: [],
    });
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(7_500);
  });

  it('rejects unknown rows and unsupported fields', () => {
    const known = new Set(['r-1']);
    expect(validateAgentNotePayload({ summary: 'ok', row_ids: ['r-2'] }, known)).toMatchObject({
      ok: false,
      code: 'unknown_row',
    });
    expect(validateAgentNotePayload({ summary: 'ok', prompt: 'do something' }, known)).toMatchObject({
      ok: false,
      code: 'invalid_payload',
    });
  });

  it('normalizes optional arrays and produces a stable fingerprint', () => {
    const result = validateAgentNotePayload(
      { summary: '  concise finding  ', row_ids: ['r-1'], recommendations: ['Keep evidence'] },
      new Set(['r-1']),
    );
    expect(result).toEqual({
      ok: true,
      value: { summary: 'concise finding', row_ids: ['r-1'], recommendations: ['Keep evidence'] },
    });
    if (result.ok) expect(noteFingerprint(result.value)).toContain('concise finding');
  });

  it('can scope browser-local notes without changing the legacy default key', () => {
    expect(agentNotesStorageKey('ws/demo', 'lesson report', 'teacher@example.com')).toBe(
      `${AGENT_NOTES_STORAGE_KEY}:ws%2Fdemo:lesson%20report:teacher%40example.com`,
    );
  });

  it('keeps the checked-in v3 manifest wired to the implemented sink', () => {
    const text = readFileSync(new URL('../public/artifact-manifest.json', import.meta.url), 'utf8');
    const manifest = parseArtifactManifest(text);
    expect(manifest.contract_version).toBe('catsco.artifact-manifest.v3');
    expect(manifest.result_sinks?.some((sink) => sink.id === 'lesson-report.agent-notes.upsert.v1')).toBe(true);
    expect(manifest.task_intents?.find((intent) => intent.id === 'lesson-report.review-selection.v1')?.result_sink)
      .toBe('lesson-report.agent-notes.upsert.v1');
  });
});
