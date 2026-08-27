import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactService } from '@artifact-ax/domain';
import { LESSON_REPORT_MEMBERS, LESSON_REPORT_SPEC } from '@artifact-ax/lesson-report';
import { HttpAxGateway } from '@artifact-ax/catsco-adapter';
import { ArtifactNodeServer } from '../../../packages/catsco-adapter/src/node-server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = join(root, 'apps/artifactctl/src/cli.ts');

async function runCli(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', cliPath, ...args],
      { cwd: root, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ stdout, code: typeof error.code === 'number' ? error.code : 1 });
          return;
        }
        void stderr;
        resolve({ stdout, code: 0 });
      },
    );
  });
}

describe('artifactctl against a live demo node', () => {
  let server: ArtifactNodeServer;
  let base: string;
  let gateway: HttpAxGateway;

  beforeAll(async () => {
    server = new ArtifactNodeServer({
      service: new ArtifactService({
        specs: [LESSON_REPORT_SPEC],
        workspaces: [{ id: 'ws_demo', members: [...LESSON_REPORT_MEMBERS] }],
      }),
      publicBaseURL: 'https://nodes.example.test',
      managementToken: 'artifactctl-e2e-management-token-0123456789',
    });
    await server.listen(0);
    base = `http://127.0.0.1:${server.address()!.port}`;
    gateway = new HttpAxGateway(base);
  });

  afterAll(async () => {
    await server.close();
  });

  it('prints usage for --help and errors on unknown commands', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('artifactctl');
    const unknown = await runCli(['explode']);
    expect(unknown.code).toBe(2);
  });

  it('describe returns the manifest as JSON', async () => {
    const { stdout, code } = await runCli(['describe', '--artifact', 'lesson-report', '--as', 'agent_440', '--url', base]);
    expect(code).toBe(0);
    const manifest = JSON.parse(stdout) as { contract_version: string; capabilities: { name: string }[] };
    expect(manifest.contract_version).toBe('artifact.ax.v1');
    expect(manifest.capabilities.map((c) => c.name)).toEqual(['filter_rows', 'approve_rows']);
  });

  it('inspect returns a bounded projection', async () => {
    const { stdout, code } = await runCli(['inspect', '--artifact', 'lesson-report', '--as', 'agent_440', '--url', base]);
    expect(code).toBe(0);
    const projection = JSON.parse(stdout) as { version: number; revision: number; regions: { region: { id: string } }[] };
    expect(projection.regions.map((r) => r.region.id)).toEqual(['review-table', 'summary-panel', 'approval-panel']);
    expect(projection.version).toBe(1);
    expect(projection.revision).toBe(0);
  });

  it('apply accepts a command with a current revision', async () => {
    const { stdout, code } = await runCli([
      'apply', 'filter_rows',
      '--artifact', 'lesson-report',
      '--as', 'agent_440',
      '--url', base,
      '--revision', '0',
      '--version', '1',
      '--input', '{"status":"all"}',
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { outcome: string; revision: number };
    expect(result.outcome).toBe('accepted');
    expect(result.revision).toBe(1);
  });

  it('apply reports a conflict on a stale revision', async () => {
    const { stdout, code } = await runCli([
      'apply', 'filter_rows',
      '--artifact', 'lesson-report',
      '--as', 'agent_440',
      '--url', base,
      '--revision', '0',
      '--version', '1',
      '--input', '{"status":"pending"}',
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { outcome: string; error: { code: string } };
    expect(result.outcome).toBe('conflict');
    expect(result.error.code).toBe('base_revision_stale');
  });

  it('apply on an approval-gated capability returns pending_approval', async () => {
    const { stdout, code } = await runCli([
      'apply', 'approve_rows',
      '--artifact', 'lesson-report',
      '--as', 'agent_440',
      '--url', base,
      '--revision', '1',
      '--version', '1',
      '--input', '{"row_ids":["r-1"]}',
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as { outcome: string; approval: { approval_id: string } };
    expect(result.outcome).toBe('pending_approval');
    expect(result.approval.approval_id).toBeTruthy();

    // Resolve through the gateway (human reviewer), then confirm via CLI inspect.
    await gateway.resolveApproval({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      approval_id: result.approval.approval_id,
      decision: 'approved',
      reviewer: { id: 'human_reviewer', type: 'human' },
    });
    const after = await gateway.inspect({ workspace_id: 'ws_demo', artifact_id: 'lesson-report', actor: { id: 'human_reviewer', type: 'human' } });
    const table = after.regions.find((r) => r.region.id === 'review-table')!.data as { rows: { id: string; status: string }[] };
    expect(table.rows.find((r) => r.id === 'r-1')?.status).toBe('approved');
  });

  it('watch emits NDJSON event lines and exits on an apply', async () => {
    const cursor = 2; // after the two accepted applies above (revisions 1..2)
    const promised = runCli(['watch', '--artifact', 'lesson-report', '--as', 'agent_440', '--url', base, '--cursor', String(cursor), '--timeout', '3']);
    await new Promise((r) => setTimeout(r, 200));
    await gateway.apply({
      command_id: 'cli-watch-live',
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      version: 1,
      base_revision: 2,
      actor: { id: 'agent_440', type: 'agent' },
      name: 'filter_rows',
      args: { status: 'rejected' },
      idempotency_key: 'cli-watch-live',
    });
    const { stdout, code } = await promised;
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]!) as { type: string };
    expect(first.type).toBe('capability.executed');
  }, 20_000);

  it('publish returns pending_approval, then completes with --draft --approval', async () => {
    const { stdout, code } = await runCli([
      'publish',
      '--artifact', 'lesson-report',
      '--as', 'agent_440',
      '--url', base,
      '--input', '{"title":"Lesson report CLI v2"}',
    ]);
    expect(code).toBe(0);
    const first = JSON.parse(stdout) as {
      draft: { draft_id: string; status: string; validation: { ok: boolean } };
      publish: { outcome: string; approval?: { approval_id: string } };
    };
    expect(first.draft.validation.ok).toBe(true);
    expect(first.publish.outcome).toBe('pending_approval');
    const approvalId = first.publish.approval!.approval_id;

    // Human reviewer approves the publication request.
    await gateway.resolveApproval({
      workspace_id: 'ws_demo',
      artifact_id: 'lesson-report',
      approval_id: approvalId,
      decision: 'approved',
      reviewer: { id: 'human_reviewer', type: 'human' },
    });

    // Reviewer (or any actor with the publish scope) completes the publish.
    const second = await runCli([
      'publish',
      '--artifact', 'lesson-report',
      '--as', 'human_reviewer',
      '--url', base,
      '--draft', first.draft.draft_id,
      '--approval', approvalId,
    ]);
    expect(second.code).toBe(0);
    const payload = JSON.parse(second.stdout) as { publish: { outcome: string; new_version: number | null } };
    expect(payload.publish.outcome).toBe('published');
    expect(payload.publish.new_version).toBe(2);
  });
});