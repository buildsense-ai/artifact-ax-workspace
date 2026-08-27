import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ContextBundle } from '@artifact-ax/trigger';
import { ArtifactBridgeServer } from '../../../apps/artifact-bridge/src/server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = join(root, 'apps/artifactctl/src/cli.ts');
const TOKEN = 'artifact-bridge-e2e-pairing-token-0123456789';

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', cliPath, ...args],
      { cwd: root, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ stdout, stderr, code: typeof error.code === 'number' ? error.code : 1 });
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
  });
}

function bundleJson(bundleId: string, revision: number, over: Partial<ContextBundle> = {}): string {
  const b: ContextBundle = {
    contract_version: 'trigger.context-bundle.v1',
    bundle_id: bundleId,
    session_id: 'topic_demo',
    actor_id: 'human_teacher',
    artifact_id: 'lesson-report',
    revision,
    selections: [
      { selection_id: 'sel-1', artifact_id: 'lesson-report', revision, region_id: 'review-table', node_id: 'r-1', label: 'Row r-1' },
    ],
    intent: { text: 'review' },
    assessment: { intent_kind: 'review', confidence: 0.9, risk: 'low', rationale: ['read intent'], complete: true },
    decision: 'send',
    delivery: 'sent',
    created_at: '2026-08-26T00:00:00.000Z',
    ...over,
  };
  return JSON.stringify(b);
}

describe('artifactctl context / inbox against a live bridge', () => {
  let server: ArtifactBridgeServer;
  let base: string;

  beforeAll(async () => {
    server = new ArtifactBridgeServer({ token: TOKEN });
    await server.listen(0);
    base = `http://127.0.0.1:${server.address()!.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('context send returns an accepted receipt, and a replay is idempotent', async () => {
    const first = await runCli([
      'context', 'send',
      '--bridge-url', base, '--token', TOKEN,
      '--bundle', bundleJson('cli-once', 1),
    ]);
    expect(first.code).toBe(0);
    const r1 = JSON.parse(first.stdout) as { state: string; bundle_id: string; idempotent: boolean };
    expect(r1.state).toBe('accepted');
    expect(r1.bundle_id).toBe('cli-once');

    const second = await runCli([
      'context', 'send',
      '--bridge-url', base, '--token', TOKEN,
      '--bundle', bundleJson('cli-once', 1),
    ]);
    const r2 = JSON.parse(second.stdout) as { state: string; idempotent: boolean };
    expect(r2.idempotent).toBe(true);
    expect(r2.state).toBe('accepted');
  });

  it('context send --mode queue stages as queued, then resume acknowledges', async () => {
    const sent = await runCli([
      'context', 'send',
      '--bridge-url', base, '--token', TOKEN,
      '--bundle', bundleJson('cli-queue', 2), '--mode', 'queue',
    ]);
    expect(JSON.parse(sent.stdout).state).toBe('queued');

    const resumed = await runCli([
      'context', 'resume', '--bundle-id', 'cli-queue',
      '--bridge-url', base, '--token', TOKEN,
    ]);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout).state).toBe('acknowledged');
  });

  it('context status returns a single receipt and the list shape', async () => {
    const single = await runCli([
      'context', 'status', '--bundle-id', 'cli-once',
      '--bridge-url', base, '--token', TOKEN,
    ]);
    expect(single.code).toBe(0);
    expect(JSON.parse(single.stdout).state).toBe('accepted');

    const list = await runCli(['context', 'status', '--bridge-url', base, '--token', TOKEN]);
    expect(list.code).toBe(0);
    const payload = JSON.parse(list.stdout) as { count: number; receipts: { bundle_id: string }[] };
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.receipts.some((r) => r.bundle_id === 'cli-queue')).toBe(true);
  });

  it('context fetch returns the authorized full payload while status stays compact', async () => {
    const fetched = await runCli([
      'context', 'fetch', '--bundle-id', 'cli-once',
      '--bridge-url', base, '--token', TOKEN,
    ]);
    expect(fetched.code).toBe(0);
    const payload = JSON.parse(fetched.stdout) as { protocol_version: string; bundle: ContextBundle };
    expect(payload.protocol_version).toBe('artifact.ax.bridge.v1');
    expect(payload.bundle.bundle_id).toBe('cli-once');
    expect(payload.bundle.selections[0]?.node_id).toBe('r-1');
  });

  it('context ack and complete walk a receipt to acknowledged then completed', async () => {
    await runCli([
      'context', 'send', '--bridge-url', base, '--token', TOKEN,
      '--bundle', bundleJson('cli-confirm', 3), '--mode', 'confirm',
    ]);
    const acked = await runCli([
      'context', 'ack', '--bundle-id', 'cli-confirm',
      '--bridge-url', base, '--token', TOKEN,
    ]);
    expect(JSON.parse(acked.stdout).state).toBe('acknowledged');
    const done = await runCli([
      'context', 'complete', '--bundle-id', 'cli-confirm',
      '--bridge-url', base, '--token', TOKEN,
    ]);
    expect(JSON.parse(done.stdout).state).toBe('completed');
  });

  it('context reject records an explicit receiver refusal', async () => {
    await runCli([
      'context', 'send', '--bridge-url', base, '--token', TOKEN,
      '--bundle', bundleJson('cli-reject', 5), '--mode', 'confirm',
    ]);
    const rejected = await runCli([
      'context', 'reject', '--bundle-id', 'cli-reject', '--reason', 'not relevant',
      '--bridge-url', base, '--token', TOKEN,
    ]);
    expect(rejected.code).toBe(0);
    expect(JSON.parse(rejected.stdout).state).toBe('rejected');
  });

  it('context watch emits stable NDJSON receipt lines', async () => {
    const { stdout, code } = await runCli([
      'context', 'watch', '--bridge-url', base, '--token', TOKEN, '--timeout', '1',
    ]);
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]!) as { type: string; state: string; bundle_id: string };
    expect(first.type).toBe('receipt');
    expect(first.state).toBeTruthy();
  }, 15_000);

  it('context ag-ui emits raw AG-UI-compatible lifecycle events', async () => {
    const sent = await runCli([
      'context', 'send', '--bridge-url', base, '--token', TOKEN,
      '--bundle', bundleJson('cli-ag-ui', 50), '--mode', 'confirm',
    ]);
    expect(sent.code).toBe(0);

    const streamed = await runCli([
      'context', 'ag-ui', '--bundle-id', 'cli-ag-ui', '--include-context',
      '--bridge-url', base, '--token', TOKEN, '--timeout', '1',
    ]);
    expect(streamed.code).toBe(0);
    const events = streamed.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'CUSTOM']);
    expect(events[0]).toMatchObject({ threadId: 'topic_demo', runId: 'cli-ag-ui' });
    expect(events[1]).toMatchObject({ type: 'CUSTOM', name: 'artifact.ax.bridge.receipt.v1' });
    expect(events[2]).toMatchObject({ type: 'CUSTOM', name: 'artifact.ax.bridge.context.v1' });
  }, 15_000);

  it('malformed bundle is refused via the CLI (non-zero exit)', async () => {
    const { stdout, stderr, code } = await runCli([
      'context', 'send',
      '--bridge-url', base, '--token', TOKEN,
      '--bundle', JSON.stringify({ not_a_bundle: true }),
    ]);
    // readBundle validation fails first, or the bridge refuses — either way, no success JSON on stdout.
    expect(code).not.toBe(0);
    expect(stdout).not.toContain('"state"');
    expect(stderr).toMatch(/bundle/i);
  });

  it('a wrong pairing token is refused with unauthorized', async () => {
    const { stderr, code } = await runCli([
      'context', 'send',
      '--bridge-url', base, '--token', 'wrong-token',
      '--bundle', bundleJson('cli-auth', 4),
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/token/i);
  });
});
