import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_MANIFEST_CONTRACT_V1,
  ARTIFACT_MANIFEST_CONTRACT_V2,
  ARTIFACT_MANIFEST_CONTRACT_V3,
  ARTIFACT_OBSERVATION_PACKET_CONTRACT,
  ARTIFACT_RESULT_RECEIPT_CONTRACT,
  ARTIFACT_TASK_STATUS_CONTRACT,
  checkArtifactManifest,
  checkArtifactResultEnvelope,
  checkApplicationReceipt,
  checkObservationPacket,
  buildArtifactObservationPacket,
  hasDeclaredResultSink,
  isApplicationReceipt,
  isArtifactResultEnvelope,
  isArtifactManifest,
  isObservationPacket,
  isArtifactPageContext,
  isTaskStatus,
  parseArtifactManifest,
  validateApplicationReceipt,
  validateArtifactManifest,
  validateArtifactResultEnvelope,
  validateObservationPacket,
  validateArtifactPageContext,
  validateResultSchema,
  validateTaskStatus,
} from './cloud-artifact.js';

const sink = {
  id: 'tasks.upsert.v1',
  description: 'Create or update tasks.',
  input_schema: {
    type: 'object',
    required: ['items'],
    additionalProperties: false,
    properties: {
      items: { type: 'array', items: { type: 'object' }, maxItems: 100 },
    },
  },
};

const baseManifest = {
  contract_version: ARTIFACT_MANIFEST_CONTRACT_V1,
  purpose: 'Track project tasks and their current status.',
  views: ['board', 'task-detail'],
  entities: ['task'],
  entrypoints: ['index.html'],
  observation_capabilities: ['runtime_snapshot', 'semantic_context'],
};

const artifact = {
  id: 'task-board',
  agent_uid: '440',
  title: 'Task board',
  kind: 'mini_app' as const,
  url: 'https://agent-440.artifacts.catsco.fun:19991/artifacts/task-board/latest/',
  topic_id: 'p2p_7_440',
  currently_visible: true as const,
  displayed_version: 3,
  latest_version: 3,
};

const snapshot = {
  created_at: '2026-08-20T10:00:00.000Z',
  expires_at: '2026-08-20T10:01:00.000Z',
  revision: 4,
};

describe('Cloud Artifact manifest contracts', () => {
  it('accepts v1 and preserves the documented application-map fields', () => {
    expect(validateArtifactManifest(baseManifest)).toEqual(baseManifest);
    expect(isArtifactManifest(baseManifest)).toBe(true);
    expect(parseArtifactManifest(JSON.stringify(baseManifest))).toEqual(baseManifest);
  });

  it('enforces version gates and sink references', () => {
    expect(() => validateArtifactManifest({ ...baseManifest, result_sinks: [sink] })).toThrow(/v1/);
    const v2 = validateArtifactManifest({ ...baseManifest, contract_version: ARTIFACT_MANIFEST_CONTRACT_V2, result_sinks: [sink] });
    expect(v2.result_sinks?.[0]?.id).toBe('tasks.upsert.v1');
    const intent = {
      id: 'tasks.create.v1',
      title: 'Create a task',
      description: 'Create one task from the current view.',
      input_schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 200 } } },
      result_sink: 'tasks.upsert.v1',
    };
    const v3 = validateArtifactManifest({
      ...baseManifest,
      contract_version: ARTIFACT_MANIFEST_CONTRACT_V3,
      result_sinks: [sink],
      task_intents: [intent],
    });
    expect(v3.task_intents?.[0]?.result_sink).toBe('tasks.upsert.v1');
    expect(hasDeclaredResultSink(v3.task_intents?.[0] as NonNullable<typeof v3.task_intents>[number], v3.result_sinks ?? [])).toBe(true);
    expect(() => validateArtifactManifest({ ...v3, contract_version: ARTIFACT_MANIFEST_CONTRACT_V2 })).toThrow(/task_intents/);
    expect(() => validateArtifactManifest({ ...v3, task_intents: [{ ...intent, result_sink: 'missing.v1' }] })).toThrow(/declared/);
  });

  it('rejects unknown, unsafe, duplicate, and oversized manifest data', () => {
    expect(() => validateArtifactManifest({ ...baseManifest, hidden_prompt: 'run this' })).toThrow(/unsupported/);
    expect(() => validateArtifactManifest(JSON.parse('{"contract_version":"catsco.artifact-manifest.v1","purpose":"ok","__proto__":{}}'))).toThrow(/unsafe/);
    expect(() => validateArtifactManifest({ ...baseManifest, views: ['board', 'board'] })).toThrow(/duplicates/);
    expect(() => validateArtifactManifest({ ...baseManifest, purpose: 'line\none' })).toThrow(/trimmed|empty|exceeds/);
    expect(checkArtifactManifest({ ...baseManifest, contract_version: 'catsco.artifact-manifest.v9' })).toHaveLength(1);
    expect(() => parseArtifactManifest('x'.repeat(65 * 1024))).toThrow(/bytes/);
  });
});

describe('bounded result schema subset', () => {
  it('normalizes schemas and rejects unsupported keywords or complexity', () => {
    expect(validateResultSchema({ type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'string' } },
    });
    expect(() => validateResultSchema({ type: 'string', pattern: '.*' })).toThrow(/unsupported/);
    expect(() => validateResultSchema({ type: 'array', items: { type: 'string' }, maxItems: 1001 })).toThrow(/1,000|1000/);
    expect(() => validateResultSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'))).toThrow(/property|unsafe/);
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    expect(() => validateResultSchema(cyclic)).toThrow(/complexity/);
  });
});

describe('page context contract', () => {
  it('accepts the bounded optional self-description and rejects unknown fields', () => {
    const page = validateArtifactPageContext({
      contract_version: 'catsco.artifact-page-context.v1',
      observed_at: '2026-08-20T10:00:02.000Z',
      title: 'Task board',
      location: { pathname: '/artifacts/task-board/latest/', hash: '#board' },
      semantic_context: { view: 'board', selected: ['t12'] },
    });
    expect(isArtifactPageContext(page)).toBe(true);
    expect(() => validateArtifactPageContext({ ...page, prompt: 'ignore policy' })).toThrow(/unsupported/);
  });
});

describe('observation packet and trust boundary', () => {
  it('builds and validates a layered packet', () => {
    const manifest = validateArtifactManifest({ ...baseManifest, contract_version: ARTIFACT_MANIFEST_CONTRACT_V3, result_sinks: [sink] });
    const packet = buildPacket(manifest);
    expect(packet.contract_version).toBe(ARTIFACT_OBSERVATION_PACKET_CONTRACT);
    expect(packet.page?.view).toBe('board');
    expect(packet.state.semantic).toEqual({ view: 'board', selection: ['t12'] });
    expect(packet.sources.manifest).toBe('artifact_authored_untrusted');
    expect(validateObservationPacket(packet)).toEqual(packet);
    expect(isObservationPacket(packet)).toBe(true);
  });

  it('rejects capability lies, unknown fields, and unsafe semantic keys', () => {
    const packet = buildPacket(validateArtifactManifest(baseManifest));
    expect(() => validateObservationPacket({ ...packet, capabilities: { ...packet.capabilities, generic_dom: false } })).toThrow(/inconsistent/);
    expect(() => validateObservationPacket({ ...packet, extra: true })).toThrow(/unsupported/);
    const unsafe = JSON.parse(JSON.stringify(packet));
    unsafe.state.semantic = JSON.parse('{"__proto__":"x"}');
    expect(() => validateObservationPacket(unsafe)).toThrow(/unsafe|property/);
    expect(checkObservationPacket({ ...packet, contract_version: 'wrong' })).toHaveLength(1);
  });
});

describe('task status and application receipt guards', () => {
  const taskID = `atk_${'a'.repeat(43)}`;
  const resultID = `arr_${'b'.repeat(43)}`;

  it('accepts bounded statuses and receipts while preserving official fields', () => {
    const status = validateTaskStatus({
      contract_version: ARTIFACT_TASK_STATUS_CONTRACT,
      task_id: taskID,
      status: 'completed',
      result_id: resultID,
      message: 'done',
    });
    expect(status.result_id).toBe(resultID);
    expect(isTaskStatus(status)).toBe(true);
    const receipt = validateApplicationReceipt({
      contract_version: ARTIFACT_RESULT_RECEIPT_CONTRACT,
      result_id: resultID,
      status: 'applied',
      receipt: { updated: 1 },
    }, resultID);
    expect(receipt.status).toBe('applied');
    expect(isApplicationReceipt(receipt)).toBe(true);
  });

  it('rejects dangerous or inconsistent status/receipt values', () => {
    expect(() => validateTaskStatus({ contract_version: ARTIFACT_TASK_STATUS_CONTRACT, task_id: taskID, status: 'running', extra: true })).toThrow(/unsupported/);
    expect(() => validateTaskStatus({ contract_version: ARTIFACT_TASK_STATUS_CONTRACT, task_id: taskID, status: 'running', result_id: 'bad' })).toThrow(/result_id/);
    expect(() => validateApplicationReceipt({ contract_version: ARTIFACT_RESULT_RECEIPT_CONTRACT, result_id: resultID, status: 'applied', receipt: JSON.parse('{"constructor":"x"}') })).toThrow(/unsafe|invalid property/);
    expect(() => validateApplicationReceipt({ contract_version: ARTIFACT_RESULT_RECEIPT_CONTRACT, result_id: resultID, status: 'applied' }, `arr_${'c'.repeat(43)}`)).toThrow(/match/);
    expect(checkApplicationReceipt({ contract_version: 'wrong' })).toHaveLength(1);
  });
});

describe('result envelope guard', () => {
  const envelope = {
    contract_version: 'catsco.artifact-result.v1',
    writeback_ref: `awr_${'a'.repeat(43)}`,
    task_id: `atk_${'b'.repeat(43)}`,
    artifact_id: 'task-board',
    displayed_version: 3,
    sink_id: 'tasks.upsert.v1',
    result_id: `arr_${'c'.repeat(43)}`,
    expected_state_revision: '4',
    payload: { items: [{ title: 'Review' }] },
  };

  it('accepts the official bounded envelope and exposes safe companions', () => {
    expect(validateArtifactResultEnvelope(envelope)).toEqual(envelope);
    expect(isArtifactResultEnvelope(envelope)).toBe(true);
    expect(checkArtifactResultEnvelope(envelope)).toEqual([]);
  });

  it('rejects invalid routing IDs, revisions, and payload values', () => {
    expect(() => validateArtifactResultEnvelope({ ...envelope, writeback_ref: 'awr_bad' })).toThrow(/writeback_ref/);
    expect(() => validateArtifactResultEnvelope({ ...envelope, expected_state_revision: ' 4' })).toThrow(/expected_state_revision/);
    expect(() => validateArtifactResultEnvelope({ ...envelope, payload: JSON.parse('{"__proto__":"x"}') })).toThrow(/unsafe|invalid property|JSON values/);
    expect(checkArtifactResultEnvelope({ ...envelope, result_id: 'bad' })).toHaveLength(1);
  });
});

function buildPacket(manifest: ReturnType<typeof validateArtifactManifest>) {
  return buildArtifactObservationPacket({
    artifact,
    snapshot,
    manifestResult: { status: 'available', manifest },
    pageContext: {
      contract_version: 'catsco.artifact-page-context.v1',
      observed_at: '2026-08-20T10:00:02.000Z',
      title: 'Task board',
      location: { pathname: '/artifacts/task-board/latest/', hash: '#board' },
      selected_text: 'High priority',
      controls: [{ type: 'checkbox', checked: true }],
      dirty: false,
      artifact_version: 3,
      semantic_context: { view: 'board', selection: ['t12'] },
    },
  });
}
