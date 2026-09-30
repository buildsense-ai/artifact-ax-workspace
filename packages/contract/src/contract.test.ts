import { describe, expect, it } from 'vitest';
import { validateManifestV4 } from './manifest.js';
import {
  normalizeContextRequest,
  normalizeResultRequest,
  normalizeRuntimeEventMessage,
  normalizeRuntimeResponse,
  normalizeRuntimeStateDoc,
  normalizeTaskAccepted,
  normalizeTaskStatusMessage,
  RESULT_CONTRACT,
  RUNTIME_EVENT_CONTRACT_V2,
  TASK_REF_CONTRACT,
  TASK_STATUS_CONTRACT,
} from './messages.js';

const validManifest = {
  contract_version: 'catsco.artifact-manifest.v4',
  purpose: 'Collaborative lesson report',
  views: ['report', 'workboard'],
  entities: ['work-item', 'finding'],
  entrypoints: ['index.html'],
  observation_capabilities: ['runtime_state', 'semantic_context'],
  result_sinks: [{ id: 'lesson-report.agent-notes.upsert.v1' }],
  task_intents: [
    {
      id: 'lesson-report.collab-review.v1',
      title: 'Review a finding',
      description: 'Revise one bounded finding in the shared work item.',
      completion: { mode: 'runtime_state' },
    },
    {
      id: 'lesson-report.review-selection.v1',
      title: 'Review selection',
      description: 'Write a bounded review note.',
      result_sink: 'lesson-report.agent-notes.upsert.v1',
    },
  ],
  runtime: {
    version: '0.2',
    surfaces: [{ id: 'report' }, { id: 'workboard', title: 'Workboard' }],
    state: [
      { namespace: 'shared', mode: 'read-write' },
      { namespace: 'presence', mode: 'read-write' },
      { namespace: 'journal', mode: 'read-write' },
      { namespace: 'result', mode: 'read-write' },
    ],
  },
};

describe('validateManifestV4', () => {
  it('accepts a complete v4 manifest', () => {
    const check = validateManifestV4(validManifest);
    expect(check.errors).toEqual([]);
    expect(check.manifest?.runtime?.state.map((s) => s.namespace)).toEqual(
      ['shared', 'presence', 'journal', 'result'],
    );
  });

  it('rejects non-v4 contract versions', () => {
    const check = validateManifestV4({ ...validManifest, contract_version: 'catsco.artifact-manifest.v3' });
    expect(check.ok).toBe(false);
    expect(check.errors[0]).toContain('v4');
  });

  it('requires exactly one completion channel per intent', () => {
    const both = validateManifestV4({
      ...validManifest,
      task_intents: [{
        id: 'lesson-report.collab-review.v1', title: 't', description: 'd',
        result_sink: 'lesson-report.agent-notes.upsert.v1', completion: { mode: 'runtime_state' },
      }],
    });
    expect(both.ok).toBe(false);
    const neither = validateManifestV4({
      ...validManifest,
      task_intents: [{ id: 'lesson-report.collab-review.v1', title: 't', description: 'd' }],
    });
    expect(neither.ok).toBe(false);
  });

  it('accepts and validates agent_participants', () => {
    const good = validateManifestV4({
      ...validManifest,
      runtime: {
        ...validManifest.runtime,
        agent_participants: [{ uid: 'bot-1', name: 'reviewer', kind: 'agent' }, { name: 'assistant' }],
      },
    });
    expect(good.errors).toEqual([]);
    expect(good.manifest?.runtime?.agent_participants).toHaveLength(2);
    expect(good.manifest?.runtime?.agent_participants?.[0]?.uid).toBe('bot-1');

    const bad = validateManifestV4({
      ...validManifest,
      runtime: {
        ...validManifest.runtime,
        agent_participants: [{ kind: 'agent' }, { name: 'x', kind: 'bot' }],
      },
    });
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('rejects runtime_state completion without runtime 0.2', () => {
    const check = validateManifestV4({
      ...validManifest,
      task_intents: [{
        id: 'lesson-report.collab-review.v1', title: 't', description: 'd',
        completion: { mode: 'runtime_state' },
      }],
      runtime: { ...validManifest.runtime, version: '0.1' },
    });
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toContain('0.2');
  });

  it('rejects undeclared sink references and duplicate namespaces', () => {
    const check = validateManifestV4({
      ...validManifest,
      task_intents: [{
        id: 'lesson-report.review-selection.v1', title: 't', description: 'd',
        result_sink: 'lesson-report.missing.v1',
      }],
      runtime: {
        ...validManifest.runtime,
        state: [
          { namespace: 'shared', mode: 'read-write' },
          { namespace: 'shared', mode: 'read-write' },
        ],
      },
    });
    expect(check.ok).toBe(false);
  });
});

describe('message normalization', () => {
  it('accepts a context request', () => {
    expect(normalizeContextRequest({ type: 'catsco.artifact.context.request.v1', request_id: 'req_123456' }))
      .toEqual({ type: 'catsco.artifact.context.request.v1', request_id: 'req_123456' });
    expect(normalizeContextRequest({ type: 'catsco.artifact.context.request.v1', request_id: 'x' })).toBeNull();
  });

  it('accepts a bounded result request and drops unsafe payloads', () => {
    const request = {
      type: 'catsco.artifact.result.request.v1',
      request_id: 'req_123456',
      result: {
        contract_version: RESULT_CONTRACT,
        artifact_id: 'lesson-report',
        sink_id: 'lesson-report.agent-notes.upsert.v1',
        result_id: `arr_${'a'.repeat(43)}`,
        payload: { summary: 'ok', row_ids: ['r-1'] },
      },
    };
    expect(normalizeResultRequest(request)?.result.sink_id).toBe('lesson-report.agent-notes.upsert.v1');
    // A JSON.parse'd payload can carry an own '__proto__' key — it must be
    // rejected even though object literals cannot express it.
    const malicious = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(normalizeResultRequest({
      ...request,
      result: { ...request.result, payload: malicious },
    })).toBeNull();
  });

  it('accepts task accepted/status envelopes', () => {
    const accepted = normalizeTaskAccepted({
      type: 'catsco.artifact.task.accepted.v1',
      request_id: 'req_123456',
      task: {
        contract_version: TASK_REF_CONTRACT,
        task_id: `atk_${'b'.repeat(43)}`,
        task_ref: `atr_${'c'.repeat(43)}`,
        status: 'submitted',
        visible_message: 'Reviewing',
        run_id: `run_${'d'.repeat(43)}`,
        completion_mode: 'runtime_state',
      },
    });
    expect(accepted?.task.completion_mode).toBe('runtime_state');

    const status = normalizeTaskStatusMessage({
      type: 'catsco.artifact.task.status.v1',
      task: {
        contract_version: TASK_STATUS_CONTRACT,
        task_id: `atk_${'b'.repeat(43)}`,
        status: 'completed',
        result_id: `arr_${'e'.repeat(43)}`,
      },
    });
    expect(status?.task.status).toBe('completed');
    expect(normalizeTaskStatusMessage({
      type: 'catsco.artifact.task.status.v1',
      task: { contract_version: TASK_STATUS_CONTRACT, task_id: 'bad', status: 'completed' },
    })).toBeNull();
  });

  it('accepts runtime responses, events, and state docs', () => {
    expect(normalizeRuntimeResponse({
      type: 'catsco.artifact.runtime.response.v1',
      request_id: 'req_123456',
      response: { ok: true, operation: 'connect' },
    })?.request_id).toBe('req_123456');

    const event = normalizeRuntimeEventMessage({
      type: 'catsco.artifact.runtime.event.v1',
      event: {
        contract_version: RUNTIME_EVENT_CONTRACT_V2,
        event_id: 12,
        type: 'state.updated',
        data: { namespace: 'shared', key: 'collab', revision: 3 },
      },
    });
    expect(event?.event.event_id).toBe(12);

    const doc = normalizeRuntimeStateDoc({
      contract_version: 'catsco.artifact-runtime-state.v1',
      exists: true, namespace: 'shared', key: 'collab', revision: 3,
      value: { update: 'AAAA' },
    });
    expect(doc?.revision).toBe(3);
    expect(normalizeRuntimeStateDoc({
      contract_version: 'catsco.artifact-runtime-state.v1',
      exists: true, namespace: 'BAD NS', key: 'collab', revision: 3,
    })).toBeNull();
  });
});
