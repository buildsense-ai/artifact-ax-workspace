import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactService } from '@artifact-ax/domain';
import { LESSON_REPORT_MEMBERS, LESSON_REPORT_SPEC } from '@artifact-ax/lesson-report';
import {
  validateCloudArtifactIndex,
  validateCloudArtifactManagementList,
  validateCloudArtifactNodeURL,
} from '@artifact-ax/contract';
import { ArtifactNodeServer } from './node-server.js';
import { HttpAxGateway } from './http-client.js';
import { renderIndex, renderManagementList, renderOperation } from './render.js';

const MGMT_TOKEN = 'test-node-management-token-0123456789abcdef';
const PUBLIC_BASE = 'https://nodes.example.test';

function demoService(): ArtifactService {
  return new ArtifactService({
    specs: [LESSON_REPORT_SPEC],
    workspaces: [{ id: 'ws_demo', members: [...LESSON_REPORT_MEMBERS] }],
  });
}

describe('renderers produce CatsCo-valid JSON', () => {
  it('renderIndex passes validateCloudArtifactIndex and publishes URLs under /by-agent/', () => {
    const service = demoService();
    const index = renderIndex(service.exportArtifacts(), { publicBaseURL: PUBLIC_BASE });
    expect(validateCloudArtifactIndex(index)).toEqual([]);
    expect(index.contract_version).toBe('cloud-artifacts.index.v1');
    expect(index.artifacts[0]?.url).toBe(`${PUBLIC_BASE}/by-agent/440/lesson-report/latest/`);
    expect(index.artifacts[0]?.kind).toBe('mini_app');
    expect(index.artifacts[0]?.publish_version).toBe(1);
    expect(index.artifacts[0]?.agent_uid).toBe('440');
  });

  it('renderManagementList passes validation for active and deleted and agent scopes', () => {
    const service = demoService();
    const active = renderManagementList(service.exportArtifacts(), 'active', { publicBaseURL: PUBLIC_BASE });
    expect(validateCloudArtifactManagementList(active, 'active')).toEqual([]);
    expect(active.count).toBe(1);
    expect(active.artifacts[0]?.can_delete).toBe(true);

    const scoped = renderManagementList(service.exportArtifacts(), 'active', {
      publicBaseURL: PUBLIC_BASE,
      agentUID: '440',
    });
    expect(scoped.artifacts[0]?.agent_uid).toBe('440');
    expect(validateCloudArtifactManagementList(scoped, 'active')).toEqual([]);

    const wrongAgent = renderManagementList(service.exportArtifacts(), 'active', {
      publicBaseURL: PUBLIC_BASE,
      agentUID: '512',
    });
    expect(wrongAgent.count).toBe(0);

    expect(renderManagementList(service.exportArtifacts(), 'deleted', { publicBaseURL: PUBLIC_BASE }).count).toBe(0);
  });

  it('rendered URLs satisfy the node URL validation used by cats-company', () => {
    const service = demoService();
    const index = renderIndex(service.exportArtifacts(), { publicBaseURL: PUBLIC_BASE });
    for (const artifact of index.artifacts) {
      expect(validateCloudArtifactNodeURL(artifact.url, PUBLIC_BASE, 440)).toBeNull();
    }
  });

  it('renderOperation shapes a deletable active artifact', () => {
    const service = demoService();
    const exported = service.exportArtifacts()[0]!;
    const operation = renderOperation(exported, { publicBaseURL: PUBLIC_BASE });
    expect(operation.ok).toBe(true);
    expect(operation.artifact.status).toBe('active');
    expect(operation.artifact.can_delete).toBe(true);
  });
});

describe('ArtifactNodeServer CatsCo management surface', () => {
  let server: ArtifactNodeServer;
  let port: number;
  let base: string;

  beforeAll(async () => {
    server = new ArtifactNodeServer({
      service: demoService(),
      publicBaseURL: PUBLIC_BASE,
      managementToken: MGMT_TOKEN,
    });
    await server.listen(0);
    port = server.address()!.port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves the public index', async () => {
    const response = await fetch(`${base}/artifacts-index.json`);
    expect(response.status).toBe(200);
    const index = (await response.json()) as Record<string, unknown>;
    expect(validateCloudArtifactIndex(index)).toEqual([]);
  });

  it('requires the management token for the internal list', async () => {
    const unauthorized = await fetch(`${base}/internal/artifacts?status=active`);
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`${base}/internal/artifacts?status=active`, {
      headers: { Authorization: `Bearer ${MGMT_TOKEN}` },
    });
    expect(authorized.status).toBe(200);
    const list = (await authorized.json()) as Record<string, unknown>;
    expect(validateCloudArtifactManagementList(list, 'active')).toEqual([]);
  });

  it('serves the agent-scoped list and rejects invalid status', async () => {
    const response = await fetch(`${base}/internal/agents/440/artifacts?status=active`, {
      headers: { Authorization: `Bearer ${MGMT_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const list = (await response.json()) as Record<string, unknown>;
    expect(list['status']).toBe('active');
    const bad = await fetch(`${base}/internal/artifacts?status=bogus`, {
      headers: { Authorization: `Bearer ${MGMT_TOKEN}` },
    });
    expect(bad.status).toBe(400);
  });

  it('deletes and restores an artifact through the agent namespace with actor_uid', async () => {
    const deleted = await fetch(`${base}/internal/agents/440/artifacts/lesson-report`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${MGMT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_uid: '7' }),
    });
    expect(deleted.status).toBe(200);
    const deletedOp = (await deleted.json()) as Record<string, unknown>;
    expect(deletedOp).toMatchObject({ ok: true });
    expect((deletedOp['artifact'] as Record<string, unknown>)['status']).toBe('deleted');

    // Repeat delete → upstream conflict code 409 artifact_already_deleted.
    const again = await fetch(`${base}/internal/agents/440/artifacts/lesson-report`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${MGMT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_uid: '7' }),
    });
    expect(again.status).toBe(409);
    const conflictBody = (await again.json()) as Record<string, unknown>;
    expect(conflictBody).toMatchObject({ error: { code: 'artifact_already_deleted' } });

    // Deleted list shows it with can_restore.
    const deletedList = await fetch(`${base}/internal/artifacts?status=deleted`, {
      headers: { Authorization: `Bearer ${MGMT_TOKEN}` },
    });
    const deletedListBody = (await deletedList.json()) as Record<string, unknown>;
    expect(validateCloudArtifactManagementList(deletedListBody, 'deleted')).toEqual([]);
    expect(((deletedListBody['artifacts'] as unknown[])[0] as Record<string, unknown>)['can_restore']).toBe(true);

    const restored = await fetch(`${base}/internal/agents/440/artifacts/lesson-report/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MGMT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_uid: '7' }),
    });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as Record<string, unknown>)['artifact']).toMatchObject({
      status: 'active',
      can_delete: true,
    });

    // Restore again → 409 artifact_not_deleted.
    const restoreAgain = await fetch(`${base}/internal/agents/440/artifacts/lesson-report/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MGMT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_uid: '7' }),
    });
    expect(restoreAgain.status).toBe(409);
  });

  it('rejects management requests for a foreign agent', async () => {
    const response = await fetch(`${base}/internal/agents/999/artifacts/lesson-report`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${MGMT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_uid: '7' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('AX HTTP gateway end to end', () => {
  let server: ArtifactNodeServer;
  let client: HttpAxGateway;
  let port: number;

  beforeAll(async () => {
    server = new ArtifactNodeServer({
      service: demoService(),
      publicBaseURL: PUBLIC_BASE,
      managementToken: MGMT_TOKEN,
    });
    await server.listen(0);
    port = server.address()!.port;
    client = new HttpAxGateway(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    await server.close();
  });

  it('describe/inspect round trip', async () => {
    const manifest = await client.describe({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: { id: 'agent_440', type: 'agent' } });
    expect(manifest.capabilities.map((c) => c.name)).toEqual(['filter_rows', 'approve_rows']);
    const projection = await client.inspect({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: { id: 'agent_440', type: 'agent' } });
    expect(projection.regions.map((r) => r.region.id)).toEqual(['review-table', 'summary-panel', 'approval-panel']);
  });

  it('apply → pending approval → resolve → rows approved', async () => {
    const projection = await client.inspect({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: { id: 'agent_440', type: 'agent' } });
    const result = await client.apply({
      command_id: 'http-approve-1',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: projection.version,
      base_revision: projection.revision,
      actor: { id: 'agent_440', type: 'agent' },
      name: 'approve_rows',
      args: { row_ids: ['r-3'] },
    });
    expect(result.outcome).toBe('pending_approval');
    const resolution = await client.resolveApproval({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      approval_id: result.approval!.approval_id,
      decision: 'approved',
      reviewer: { id: 'human_reviewer', type: 'human' },
    });
    expect(resolution.command_result?.outcome).toBe('accepted');
    const after = await client.inspect({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: { id: 'agent_440', type: 'agent' } });
    const table = after.regions.find((r) => r.region.id === 'review-table')!.data as { rows: { id: string; status: string }[] };
    expect(table.rows.find((r) => r.id === 'r-3')?.status).toBe('approved');
  });

  it('publish loop through the gateway returns pending_approval then publishes', async () => {
    const draft = await client.createDraft({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      builder: { id: 'agent_440', type: 'agent' },
      change_set: { title: 'Lesson report HTTP v2' },
    });
    await client.validateDraft({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      draft_id: draft.draft_id,
      actor: { id: 'agent_440', type: 'agent' },
    });
    const pending = await client.publish({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      draft_id: draft.draft_id,
      actor: { id: 'agent_440', type: 'agent' },
    });
    expect(pending.outcome).toBe('pending_approval');
    await client.resolveApproval({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      approval_id: pending.approval!.approval_id,
      decision: 'approved',
      reviewer: { id: 'human_reviewer', type: 'human' },
    });
    const published = await client.publish({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      draft_id: draft.draft_id,
      actor: { id: 'agent_440', type: 'agent' },
      approval_id: pending.approval!.approval_id,
    });
    expect(published.outcome).toBe('published');
    expect(published.new_version).toBe(2);
  });

  it('watch streams replay + live events over SSE', async () => {
    const current = await client.inspect({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: { id: 'agent_440', type: 'agent' } });
    await client.apply({
      command_id: 'http-filter-pre',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: current.version,
      base_revision: current.revision,
      actor: { id: 'agent_440', type: 'agent' },
      name: 'filter_rows',
      args: { status: 'all' },
      idempotency_key: 'http-filter-pre-watch',
    });
    const afterPre = await client.inspect({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: { id: 'agent_440', type: 'agent' } });
    const seen: string[] = [];
    const iterator = client.watch({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      actor: { id: 'agent_440', type: 'agent' },
      cursor: current.revision,
      timeout_ms: 8_000,
      max_events: 2,
      include_types: ['capability.executed'],
    });
    const pump = (async () => {
      for await (const envelope of iterator) {
        if (envelope.kind === 'event') seen.push(envelope.event.type);
        if (envelope.kind === 'done') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await client.apply({
      command_id: 'http-filter-live',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: afterPre.version,
      base_revision: afterPre.revision,
      actor: { id: 'agent_440', type: 'agent' },
      name: 'filter_rows',
      args: { status: 'pending' },
      idempotency_key: 'http-filter-live',
    });
    await pump;
    expect(seen).toContain('capability.executed');
  });
});