import { describe, expect, it, vi } from 'vitest';
import {
  CLOUD_HOST_TASK_STATUS_CONTRACT,
  CloudHostOutbox,
  defaultCloudHostPayloadMapper,
  isArtifactHostPort,
  normalizeCloudHostTaskStatus,
  type ArtifactHostPort,
  type CloudHostTaskStatus,
} from './cloud-host.js';
import type { ContextBundle } from './types.js';

function bundle(over: Partial<ContextBundle> = {}): ContextBundle {
  const id = over.bundle_id ?? 'bdl-cloud-host';
  const revision = over.revision ?? 3;
  return {
    contract_version: 'trigger.context-bundle.v1',
    bundle_id: id,
    session_id: 'topic-cloud-host',
    actor_id: 'human_teacher',
    artifact_id: 'lesson-report',
    revision,
    selections: [
      {
        selection_id: 'sel-1',
        artifact_id: 'lesson-report',
        revision,
        region_id: 'review-table',
        node_id: 'row-1',
        label: 'Row 1',
        note: 'check this',
        ref: 'opaque-ref-must-not-be-in-default-payload',
      },
    ],
    intent: { text: 'review this row' },
    assessment: {
      intent_kind: 'review',
      confidence: 0.9,
      risk: 'low',
      rationale: ['read intent'],
      complete: true,
    },
    decision: 'send',
    delivery: 'sent',
    created_at: '2026-08-28T00:00:00.000Z',
    context_ref: 'mock://private-context',
    ...over,
  };
}

class FakeHost implements ArtifactHostPort {
  connected = true;
  calls: Array<{ intentId: string; payload: unknown }> = [];
  private readonly listeners = new Set<(status: CloudHostTaskStatus) => void>();
  response: CloudHostTaskStatus | Promise<CloudHostTaskStatus> = {
    task_id: 'task-1',
    status: 'submitted',
  };

  requestTask(intentId: string, payload: unknown): CloudHostTaskStatus | Promise<CloudHostTaskStatus> {
    this.calls.push({ intentId, payload });
    return this.response;
  }

  onTaskStatus(listener: (status: CloudHostTaskStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isConnected(): boolean {
    return this.connected;
  }

  emit(status: CloudHostTaskStatus): void {
    for (const listener of this.listeners) listener(status);
  }
}

describe('Cloud Host feature detection and payload mapping', () => {
  it('only feature-detects an injected host port', () => {
    const requestTask = vi.fn();
    expect(isArtifactHostPort({ requestTask })).toBe(true);
    expect(isArtifactHostPort({ requestTask, isConnected: false })).toBe(false);
    expect(isArtifactHostPort({ requestTask, getTaskStatus: false })).toBe(false);
    expect(isArtifactHostPort({ onTaskStatus: () => undefined })).toBe(false);
    expect(isArtifactHostPort(null)).toBe(false);
  });

  it('maps stable anchors and omits opaque refs by default', () => {
    const payload = defaultCloudHostPayloadMapper(bundle());
    expect(payload).toMatchObject({
      bundle_id: 'bdl-cloud-host',
      artifact_id: 'lesson-report',
      revision: 3,
      intent: { text: 'review this row' },
      selections: [{ selection_id: 'sel-1', region_id: 'review-table', node_id: 'row-1', note: 'check this' }],
    });
    expect(payload.selections[0]).not.toHaveProperty('ref');
    expect(payload).not.toHaveProperty('context_ref');
    expect(defaultCloudHostPayloadMapper(bundle({
      selections: [{ ...bundle().selections[0]!, note: '   ', node_id: '' }],
    })).selections[0]).not.toHaveProperty('note');
  });

  it('enforces official task/result IDs when the status contract marker is present', () => {
    const host = new FakeHost();
    host.response = {
      contract_version: CLOUD_HOST_TASK_STATUS_CONTRACT,
      task_id: 'task-not-an-official-id',
      status: 'submitted',
    };
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    return expect(outbox.send(bundle({ bundle_id: 'bdl-invalid-status-id' }))).resolves.toMatchObject({
      ok: false,
      code: 'invalid_response',
    });
  });

  it('fails closed for status objects with throwing getters', () => {
    const hostile: Record<string, unknown> = { task_id: 'task-1', status: 'submitted' };
    Object.defineProperty(hostile, 'message', { enumerable: true, get: () => { throw new Error('boom'); } });
    expect(() => normalizeCloudHostTaskStatus(hostile)).not.toThrow();
    expect(normalizeCloudHostTaskStatus(hostile)).toBeUndefined();
  });

  it('fails closed for a revoked Host proxy', () => {
    const revocable = Proxy.revocable({ requestTask: () => ({ task_id: 'task-1', status: 'submitted' }) }, {});
    revocable.revoke();
    expect(() => isArtifactHostPort(revocable.proxy)).not.toThrow();
    expect(isArtifactHostPort(revocable.proxy)).toBe(false);
  });
});

describe('CloudHostOutbox', () => {
  it('submits one declared task intent and maps submitted/running/completed without treating running as complete', async () => {
    const host = new FakeHost();
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    const observed: string[] = [];
    outbox.onReceipt((receipt) => observed.push(`${receipt.task_status}:${receipt.kind}`));

    const submitted = await outbox.send(bundle());
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]).toMatchObject({ intentId: 'tasks.review.v1' });
    expect(submitted).toMatchObject({ ok: true, kind: 'accepted', task_id: 'task-1', task_status: 'submitted', status: 'submitted' });

    host.emit({ task_id: 'task-1', status: 'running', run_id: 'run-1' });
    expect(outbox.getReceipt('bdl-cloud-host')).toMatchObject({ ok: true, kind: 'acknowledged', task_status: 'running', run_id: 'run-1' });
    expect(outbox.getReceipt('bdl-cloud-host')?.kind).not.toBe('completed');

    host.emit({ task_id: 'task-1', status: 'completed', result_id: 'result-1', application_receipt: { status: 'applied' } });
    expect(outbox.getReceipt('bdl-cloud-host')).toMatchObject({ ok: true, kind: 'completed', task_status: 'completed', result_id: 'result-1', application_status: 'applied' });
    expect(observed).toEqual(['submitted:accepted', 'running:acknowledged', 'completed:completed']);
  });

  it('maps failed tasks and application rejection to unsuccessful receipts', async () => {
    const host = new FakeHost();
    host.response = { task_id: 'task-failed', status: 'failed', code: 'agent_error', message: 'Agent failed' };
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    await expect(outbox.send(bundle({ bundle_id: 'bdl-failed' }))).resolves.toMatchObject({
      ok: false,
      kind: 'rejected',
      task_id: 'task-failed',
      task_status: 'failed',
      code: 'agent_error',
    });

    const applicationRejected = new FakeHost();
    applicationRejected.response = {
      task_id: 'task-rejected',
      status: 'completed',
      application_receipt: { status: 'rejected', code: 'state_conflict' },
    };
    const second = new CloudHostOutbox({ host: applicationRejected, taskIntentId: 'tasks.review.v1' });
    await expect(second.send(bundle({ bundle_id: 'bdl-rejected' }))).resolves.toMatchObject({
      ok: false,
      kind: 'rejected',
      task_status: 'completed',
      application_status: 'rejected',
    });
  });

  it('treats an official completed status as applied when the Host omits the private receipt fields', async () => {
    const host = new FakeHost();
    host.response = {
      contract_version: CLOUD_HOST_TASK_STATUS_CONTRACT,
      task_id: `atk_${'c'.repeat(43)}`,
      status: 'completed',
      result_id: `arr_${'d'.repeat(43)}`,
    };
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    await expect(outbox.send(bundle({ bundle_id: 'bdl-official-complete' }))).resolves.toMatchObject({
      ok: true,
      kind: 'completed',
      task_status: 'completed',
      application_status: 'applied',
    });
    expect(outbox.getReceipt('bdl-official-complete')?.application_receipt).toBeUndefined();
  });

  it('returns an explicit unavailable receipt without a Host or declared intent, with no local fallback', async () => {
    const noHost = new CloudHostOutbox({ taskIntentId: 'tasks.review.v1' });
    await expect(noHost.send(bundle({ bundle_id: 'bdl-no-host' }))).resolves.toMatchObject({
      ok: false,
      kind: 'rejected',
      status: 'unavailable',
      task_status: 'unavailable',
      code: 'host_unavailable',
    });
    expect(noHost.list()).toEqual([]);

    const undeclared = new FakeHost();
    const noIntent = new CloudHostOutbox({ host: undeclared });
    await expect(noIntent.send(bundle({ bundle_id: 'bdl-no-intent' }))).resolves.toMatchObject({
      ok: false,
      status: 'unavailable',
      code: 'task_intent_required',
    });
    expect(undeclared.calls).toHaveLength(0);
  });

  it('stages non-send decisions without creating a Host task, then permits an explicit send resume', async () => {
    const host = new FakeHost();
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });

    await expect(outbox.send(bundle({ bundle_id: 'bdl-collected', decision: 'collect', delivery: 'collecting' }))).resolves.toMatchObject({
      ok: true,
      kind: 'collected',
      code: 'not_dispatched',
      status: 'unavailable',
    });
    await expect(outbox.send(bundle({ bundle_id: 'bdl-suggested', decision: 'suggest', delivery: 'suggested' }))).resolves.toMatchObject({
      ok: true,
      kind: 'suggested',
      code: 'not_dispatched',
    });
    await expect(outbox.send(bundle({ bundle_id: 'bdl-confirm', decision: 'confirm', delivery: 'needs_confirm' }))).resolves.toMatchObject({
      ok: true,
      kind: 'needs_confirm',
      code: 'not_dispatched',
    });
    await expect(outbox.send(bundle({ bundle_id: 'bdl-queued', decision: 'send', delivery: 'queued' }))).resolves.toMatchObject({
      ok: true,
      kind: 'queued',
      code: 'not_dispatched',
    });
    expect(host.calls).toHaveLength(0);

    // A later explicit user action can resume the deferred bundle. The same
    // bundle ID does not cause a second task because no task existed yet.
    await expect(outbox.send(bundle({ bundle_id: 'bdl-queued', decision: 'send', delivery: 'sent' }))).resolves.toMatchObject({
      task_id: 'task-1',
      task_status: 'submitted',
    });
    expect(host.calls).toHaveLength(1);
  });

  it('exposes an explicit resume path for deferred sends while keeping other decisions non-resumable', async () => {
    const host = new FakeHost();
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    await outbox.send(bundle({ bundle_id: 'bdl-resume', decision: 'send', delivery: 'queued' }));
    expect(outbox.isResumable('bdl-resume')).toBe(true);
    await expect(outbox.resume('bdl-resume')).resolves.toMatchObject({ ok: true, task_id: 'task-1' });
    expect(outbox.isResumable('bdl-resume')).toBe(false);
    expect(host.calls).toHaveLength(1);

    await outbox.send(bundle({ bundle_id: 'bdl-confirm-resume', decision: 'confirm', delivery: 'needs_confirm' }));
    expect(outbox.isResumable('bdl-confirm-resume')).toBe(false);
    await expect(outbox.resume('bdl-confirm-resume')).resolves.toMatchObject({ ok: false, code: 'not_resumable' });
    expect(host.calls).toHaveLength(1);
  });

  it('keeps a staged resume retryable when the Host is disconnected at the explicit send boundary', async () => {
    const host = new FakeHost();
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    await outbox.send(bundle({ bundle_id: 'bdl-reconnect', decision: 'send', delivery: 'queued' }));

    host.connected = false;
    await expect(outbox.send(bundle({ bundle_id: 'bdl-reconnect', decision: 'send', delivery: 'sent' }))).resolves.toMatchObject({
      ok: false,
      code: 'host_not_connected',
    });
    expect(host.calls).toHaveLength(0);

    host.connected = true;
    await expect(outbox.send(bundle({ bundle_id: 'bdl-reconnect', decision: 'send', delivery: 'sent' }))).resolves.toMatchObject({
      ok: true,
      task_id: 'task-1',
    });
    expect(host.calls).toHaveLength(1);
  });

  it('stages a user-activation rejection and retries only on a later explicit send', async () => {
    let attempts = 0;
    const host: ArtifactHostPort = {
      requestTask: () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('one recent user activation is required') as Error & { code: string };
          error.code = 'user_activation_required';
          throw error;
        }
        return { task_id: 'task-after-activation', status: 'submitted' };
      },
      isConnected: () => true,
    };
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    const first = await outbox.send(bundle({ bundle_id: 'bdl-activation' }));
    expect(first).toMatchObject({
      ok: true,
      kind: 'queued',
      status: 'unavailable',
      code: 'user_activation_required',
    });
    expect(first.message).toContain('explicit user action');
    expect(attempts).toBe(1);

    const second = await outbox.send(bundle({ bundle_id: 'bdl-activation' }));
    expect(second).toMatchObject({ ok: true, kind: 'accepted', task_id: 'task-after-activation' });
    expect(attempts).toBe(2);
  });

  it('also stages a failed-status activation rejection when the Host uses that response form', async () => {
    const host = new FakeHost();
    host.response = { task_id: 'task-not-created', status: 'failed', code: 'user_activation_required', message: 'activate first' };
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    await expect(outbox.send(bundle({ bundle_id: 'bdl-activation-status' }))).resolves.toMatchObject({
      ok: true,
      kind: 'queued',
      code: 'user_activation_required',
    });
    expect(outbox.taskIdFor('bdl-activation-status')).toBeUndefined();
  });

  it('exposes normalized task status updates separately from receipt updates', async () => {
    const host = new FakeHost();
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    const statuses: string[] = [];
    outbox.onTaskStatus((status) => statuses.push(`${status.task_id}:${status.status}`));

    await outbox.send(bundle({ bundle_id: 'bdl-status-listener' }));
    host.emit({ task_id: 'task-1', status: 'running' });
    host.emit({ task_id: 'task-1', status: 'completed' });
    expect(statuses).toEqual(['task-1:submitted', 'task-1:running', 'task-1:completed']);
    expect(outbox.getReceipt('bdl-status-listener')).toMatchObject({
      ok: false,
      kind: 'rejected',
      task_status: 'completed',
      code: 'application_receipt_missing',
    });
  });

  it('is idempotent for concurrent/repeated sends and refuses a changed payload without a second host task', async () => {
    const host = new FakeHost();
    let resolve!: (status: CloudHostTaskStatus) => void;
    host.response = new Promise<CloudHostTaskStatus>((done) => {
      resolve = done;
    });
    const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1' });
    const first = outbox.send(bundle({ bundle_id: 'bdl-once' }));
    const second = outbox.send(bundle({ bundle_id: 'bdl-once' }));
    expect(host.calls).toHaveLength(1);
    resolve({ task_id: 'task-once', status: 'submitted' });
    await expect(first).resolves.toMatchObject({ task_id: 'task-once' });
    await expect(second).resolves.toMatchObject({ task_id: 'task-once' });

    const conflict = await outbox.send(bundle({ bundle_id: 'bdl-once', intent: { text: 'different intent' } }));
    expect(conflict).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    expect(host.calls).toHaveLength(1);
  });

  it('does not retry a timed-out request, but reconciles a late Host response to the same task record', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      let resolve!: (status: CloudHostTaskStatus) => void;
      host.response = new Promise<CloudHostTaskStatus>((done) => {
        resolve = done;
      });
      const outbox = new CloudHostOutbox({ host, taskIntentId: 'tasks.review.v1', timeoutMs: 10 });
      const pending = outbox.send(bundle({ bundle_id: 'bdl-timeout' }));
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ ok: false, code: 'request_timeout', uncertain: true });
      expect(host.calls).toHaveLength(1);

      resolve({ task_id: 'task-late', status: 'submitted' });
      await Promise.resolve();
      await Promise.resolve();
      expect(outbox.getReceipt('bdl-timeout')).toMatchObject({ ok: true, task_id: 'task-late', task_status: 'submitted' });
      await expect(outbox.send(bundle({ bundle_id: 'bdl-timeout' }))).resolves.toMatchObject({ task_id: 'task-late' });
      expect(host.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds mapped payloads and never invokes the Host when the mapper is unsafe', async () => {
    const host = new FakeHost();
    const outbox = new CloudHostOutbox({
      host,
      taskIntentId: 'tasks.review.v1',
      payloadMapper: () => ({ huge: 'x'.repeat(100) }),
      maxPayloadBytes: 32,
    });
    await expect(outbox.send(bundle({ bundle_id: 'bdl-too-large' }))).resolves.toMatchObject({ ok: false, code: 'invalid_payload' });
    expect(host.calls).toHaveLength(0);
  });
});
