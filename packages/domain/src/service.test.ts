import { describe, expect, it } from 'vitest';
import { type ArtifactSpec, ArtifactService } from './service.js';

/** Self-contained demo spec: domain must not depend on the lesson-report example. */
const DEMO_SPEC: ArtifactSpec = {
  workspace_id: 'ws_demo',
  artifact_id: 'lesson-report',
  title: 'Lesson report',
  kind: 'mini_app',
  agent_uid: '440',
  regions: [
    {
      id: 'review-table',
      title: 'Review table',
      order: 1,
      schema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } }, filter: { type: 'object' } } },
      initial_data: {
        rows: [
          { id: 'r-1', student: 'A. Chen', topic: 'Linear equations', status: 'pending' },
          { id: 'r-2', student: 'B. Li', topic: 'Poetry analysis', status: 'pending' },
          { id: 'r-3', student: 'C. Wang', topic: 'Photosynthesis', status: 'pending' },
        ],
        filter: { status: 'pending' },
      },
    },
    { id: 'summary-panel', title: 'Summary', order: 2, schema: { type: 'object', properties: {} }, initial_data: {} },
    { id: 'approval-panel', title: 'Approvals', order: 3, schema: { type: 'object', properties: {} }, initial_data: {} },
  ],
  capabilities: [
    {
      name: 'filter_rows',
      description: 'Filter rows by status',
      input_schema: { type: 'object', properties: { status: { type: 'string' } } },
      requires: ['artifact:execute'],
      handler: (ctx) => ({
        result: { count: 1 },
        region_updates: [{ region_id: 'review-table', data: { ...(ctx.regions.get('review-table') as object), filter: { status: ctx.args['status'] } } }],
      }),
    },
    {
      name: 'approve_rows',
      description: 'Approve selected rows',
      input_schema: { type: 'object', properties: { row_ids: { type: 'array', items: { type: 'string' } } }, required: ['row_ids'] },
      requires: ['artifact:execute'],
      requires_approval: { message: 'Approve selected rows', assignees: ['human_reviewer'] },
      handler: (ctx) => {
        const table = ctx.regions.get('review-table') as { rows: { id: string; status: string }[] };
        const rowIds = ctx.args['row_ids'] as string[];
        return {
          result: { approved: rowIds.length },
          region_updates: [
            {
              region_id: 'review-table',
              data: { ...table, rows: table.rows.map((r) => (rowIds.includes(r.id) ? { ...r, status: 'approved' } : r)) },
            },
          ],
        };
      },
    },
  ],
};

function demoService(): ArtifactService {
  return new ArtifactService({
    specs: [DEMO_SPEC],
    workspaces: [
      {
        id: 'ws_demo',
        members: [
          { actor_id: 'human_teacher', roles: ['owner', 'reviewer'] },
          { actor_id: 'human_reviewer', roles: ['reviewer'] },
          { actor_id: 'agent_440', roles: ['operator', 'builder', 'reviewer'] },
        ],
      },
    ],
  });
}

const agent = { id: 'agent_440', type: 'agent' as const };
const reviewer = { id: 'human_reviewer', type: 'human' as const };
const stranger = { id: 'unknown_99', type: 'human' as const };

async function baseProjection(service: ArtifactService) {
  return service.inspect({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: agent, max_events: -1 });
}

describe('describe', () => {
  it('returns the manifest with capabilities filtered by actor scopes', async () => {
    const service = demoService();
    const manifest = await service.describe({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: agent });
    expect(manifest.contract_version).toBe('artifact.ax.v1');
    expect(manifest.artifact_id).toBe('lesson-report');
    expect(manifest.regions.map((r) => r.id)).toEqual(['review-table', 'summary-panel', 'approval-panel']);
    expect(manifest.capabilities.map((c) => c.name)).toEqual(['filter_rows', 'approve_rows']);

    // A non-member sees the identity but no capabilities.
    const strangerManifest = await service.describe({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      actor: stranger,
    });
    expect(strangerManifest.capabilities).toEqual([]);
  });

  it('rejects unknown artifacts with artifact_not_found', async () => {
    const service = demoService();
    await expect(
      service.describe({ workspace_id: 'ws_demo', artifact_id: 'nope', actor: agent }),
    ).rejects.toMatchObject({ code: 'artifact_not_found' });
  });
});

describe('apply: optimistic revisions and capability execution', () => {
  it('applies filter_rows with a matching base_revision', async () => {
    const service = demoService();
    const initial = await baseProjection(service);
    const result = await service.apply({
      command_id: 'cmd-1',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision,
      actor: agent,
      name: 'filter_rows',
      args: { status: 'approved' },
    });
    expect(result.outcome).toBe('accepted');
    expect(result.revision).toBe(initial.revision + 1);
    expect(result.result).toMatchObject({ count: 1 });
  });

  it('rejects a stale base_revision with a conflict outcome', async () => {
    const service = demoService();
    const initial = await baseProjection(service);
    const conflict = await service.apply({
      command_id: 'cmd-stale',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision - 999,
      actor: agent,
      name: 'filter_rows',
      args: { status: 'all' },
    });
    expect(conflict.outcome).toBe('conflict');
    expect(conflict.error).toMatchObject({ code: 'base_revision_stale' });
  });

  it('rejects invalid args by schema', async () => {
    const service = demoService();
    const initial = await baseProjection(service);
    const result = await service.apply({
      command_id: 'cmd-bad',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision,
      actor: agent,
      name: 'approve_rows',
      args: {}, // row_ids is required
    });
    expect(result.outcome).toBe('rejected');
    expect(result.error?.code).toBe('invalid_args');
  });

  it('rejects actors without the required scope', async () => {
    const service = demoService();
    const initial = await baseProjection(service);
    const result = await service.apply({
      command_id: 'cmd-forbidden',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision,
      actor: stranger,
      name: 'filter_rows',
      args: { status: 'all' },
    });
    expect(result.outcome).toBe('rejected');
    expect(result.error?.code).toBe('forbidden');
  });

  it('replays an idempotency key with idempotent_replay=true', async () => {
    const service = demoService();
    const initial = await baseProjection(service);
    const first = await service.apply({
      command_id: 'cmd-idem',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision,
      actor: agent,
      name: 'filter_rows',
      args: { status: 'all' },
      idempotency_key: 'filter-cmd-idem',
    });
    const second = await service.apply({
      command_id: 'cmd-idem-2',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision,
      actor: agent,
      name: 'filter_rows',
      args: { status: 'all' },
      idempotency_key: 'filter-cmd-idem',
    });
    expect(first.outcome).toBe('accepted');
    expect(second.idempotent_replay).toBe(true);
    expect(second.revision).toBe(first.revision); // no new event
  });

  it('rejects unknown capabilities', async () => {
    const service = demoService();
    const initial = await baseProjection(service);
    const result = await service.apply({
      command_id: 'cmd-unknown',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision,
      actor: agent,
      name: 'explode',
      args: {},
    });
    expect(result.outcome).toBe('rejected');
    expect(result.error?.code).toBe('capability_not_found');
  });
});

describe('approval-gated command flow', () => {
  it('requests approval, is resumable, and resumes after approval', async () => {
    const service = demoService();
    const initial = await baseProjection(service);

    const requested = await service.apply({
      command_id: 'cmd-approve',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision,
      actor: agent,
      name: 'approve_rows',
      args: { row_ids: ['r-1', 'r-2'] },
    });
    expect(requested.outcome).toBe('pending_approval');
    expect(requested.approval).toMatchObject({ kind: 'command', status: 'pending', assignees: ['human_reviewer'] });

    // Re-apply with the same command id returns the same pending approval.
    const replay = await service.apply({
      command_id: 'cmd-approve',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: initial.version,
      base_revision: initial.revision,
      actor: agent,
      name: 'approve_rows',
      args: { row_ids: ['r-1', 'r-2'] },
    });
    expect(replay.outcome).toBe('pending_approval');
    expect(replay.idempotent_replay).toBe(true);

    // A stranger cannot resolve.
    await expect(
      service.resolveApproval({
        workspace_id: 'ws_demo',
        artifact_id: 'lesson-report',
        approval_id: requested.approval!.approval_id,
        decision: 'approved',
        reviewer: stranger,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const resolution = await service.resolveApproval({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      approval_id: requested.approval!.approval_id,
      decision: 'approved',
      reviewer,
    });
    expect(resolution.approval.status).toBe('approved');
    expect(resolution.command_result?.outcome).toBe('accepted');

    // The pending command actually applied: rows r-1/r-2 approved.
    const after = await baseProjection(service);
    const table = after.regions.find((r) => r.region.id === 'review-table')!.data as {
      rows: { id: string; status: string }[];
    };
    expect(table.rows.find((r) => r.id === 'r-1')?.status).toBe('approved');
    expect(table.rows.find((r) => r.id === 'r-2')?.status).toBe('approved');

    // Resolving again is rejected.
    await expect(
      service.resolveApproval({
        workspace_id: 'ws_demo',
        artifact_id: 'lesson-report',
        approval_id: requested.approval!.approval_id,
        decision: 'approved',
        reviewer,
      }),
    ).rejects.toMatchObject({ code: 'approval_resolved' });
  });
});

describe('inspect projection bounds', () => {
  it('returns events after cursor, capped by max_events, with a resumable cursor', async () => {
    const service = demoService();
    const p1 = await baseProjection(service);
    expect(p1.events).toEqual([]);
    expect(p1.cursor).toBe(0);

    await service.apply({
      command_id: 'c1', workspace_id: 'ws_demo', artifact_id: 'lesson-report',
      version: 1, base_revision: 0, actor: agent, name: 'filter_rows', args: { status: 'all' },
    });
    await service.apply({
      command_id: 'c2', workspace_id: 'ws_demo', artifact_id: 'lesson-report',
      version: 1, base_revision: 1, actor: agent, name: 'filter_rows', args: { status: 'pending' },
    });

    const replay = await service.inspect({
      workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: agent, cursor: 0, max_events: 1,
    });
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]?.seq).toBe(2);

    const resume = await service.inspect({
      workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: agent, cursor: 2,
    });
    expect(resume.events).toHaveLength(0);
  });
});

describe('watch', () => {
  it('replays events after cursor and streams live events', async () => {
    const service = demoService();
    await service.apply({
      command_id: 'pre-watch', workspace_id: 'ws_demo', artifact_id: 'lesson-report',
      version: 1, base_revision: 0, actor: agent, name: 'filter_rows', args: { status: 'all' },
    });
    const events: string[] = [];
    const iterator = service.watch({
      workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: agent, cursor: 0, max_events: 2, timeout_ms: 5_000,
    });
    const pump = (async () => {
      for await (const envelope of iterator) {
        if (envelope.kind === 'event') events.push(envelope.event.type);
        if (envelope.kind === 'done') break;
      }
    })();
    await new Promise((r) => setTimeout(r, 10));
    await service.apply({
      command_id: 'live-1', workspace_id: 'ws_demo', artifact_id: 'lesson-report',
      version: 1, base_revision: 1, actor: agent, name: 'filter_rows', args: { status: 'approved' },
    });
    await pump;
    expect(events).toContain('capability.executed');
  });
});

describe('draft and publish lifecycle', () => {
  it('creates, validates, and publishes a structured change set', async () => {
    const service = demoService();
    const before = await baseProjection(service);

    const draft = await service.createDraft({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      builder: agent,
      change_set: { title: 'Lesson report v2', region_updates: [{ region_id: 'review-table' }] },
    });
    expect(draft.status).toBe('open');
    expect(draft.base_version).toBe(1);

    const validated = await service.validateDraft({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      draft_id: draft.draft_id,
      actor: agent,
    });
    expect(validated.status).toBe('validated');
    expect(validated.validation?.ok).toBe(true);

    // Publishing without an approval requests one (consequential action gate).
    const pending = await service.publish({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      draft_id: draft.draft_id,
      actor: agent,
    });
    expect(pending.outcome).toBe('pending_approval');
    expect(pending.approval?.status).toBe('pending');

    // Reviewer approves publication, then publish with the approval id completes.
    const approval = await service.resolveApproval({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      approval_id: pending.approval!.approval_id,
      decision: 'approved',
      reviewer,
    });
    expect(approval.approval.status).toBe('approved');

    const published = await service.publish({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      draft_id: draft.draft_id,
      actor: agent,
      approval_id: pending.approval!.approval_id,
    });
    expect(published.outcome).toBe('published');
    expect(published.new_version).toBe(2);
    expect(published.new_revision).toBeGreaterThan(before.revision);

    const after = await service.describe({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: agent });
    expect(after.title).toBe('Lesson report v2');
    expect(after.published_version).toBe(2);
  });

  it('rejects validation failures before publishing', async () => {
    const service = demoService();
    const draft = await service.createDraft({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      builder: agent,
      change_set: { region_updates: [{ region_id: 'does-not-exist', data: {} }] },
    });
    const validated = await service.validateDraft({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      draft_id: draft.draft_id,
      actor: agent,
    });
    expect(validated.validation?.ok).toBe(false);

    const result = await service.publish({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      draft_id: draft.draft_id,
      actor: agent,
    });
    expect(result.outcome).toBe('rejected');
    expect(result.error?.code).toBe('validation_failed');
  });
});

describe('management: soft delete and restore', () => {
  it('deletes then restores with stable CatsCo error codes', async () => {
    const service = demoService();
    const deleted = await service.softDeleteArtifact('ws_demo', 'lesson-report', agent);
    expect(deleted.status).toBe('deleted');
    expect(deleted.can_restore).toBe(true);
    expect(deleted.deleted_at).toBeDefined();

    await expect(service.softDeleteArtifact('ws_demo', 'lesson-report', agent)).rejects.toMatchObject({
      code: 'artifact_already_deleted',
    });

    const restored = await service.restoreArtifact('ws_demo', 'lesson-report', agent);
    expect(restored.status).toBe('active');

    await expect(service.restoreArtifact('ws_demo', 'lesson-report', agent)).rejects.toMatchObject({
      code: 'artifact_not_deleted',
    });
  });

  it('hides deleted artifacts from the exported collection used by the index', async () => {
    const service = demoService();
    await service.softDeleteArtifact('ws_demo', 'lesson-report', agent);
    const exported = service.exportArtifacts();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.status).toBe('deleted');
  });
});