import { describe, expect, it, vi } from 'vitest';
import { devIdentity } from './identity.js';
import { createMockSession, type MockSessionOptions } from './mock.js';

function session(options: Partial<MockSessionOptions> = {}) {
  return createMockSession({
    identity: devIdentity('alice'),
    artifactId: 'lesson-report',
    room: `test-${Math.random().toString(36).slice(2)}`,
    broadcast: null,
    ...options,
  });
}

describe('mock runtime session', () => {
  it('connects with a runtime 0.2 shape', async () => {
    const s = session();
    const connect = await s.connect();
    expect(connect.runtime.version).toBe('0.2');
    expect(connect.artifact.id).toBe('lesson-report');
    s.close();
  });

  it('round-trips state with CAS revisions', async () => {
    const s = session();
    const missing = await s.stateGet('shared', 'collab');
    expect(missing.exists).toBe(false);

    const put = await s.statePut('shared', 'collab', 0, { update: 'AAAA' });
    expect(put.state.revision).toBe(1);
    expect(put.event?.type).toBe('state.updated');

    const got = await s.stateGet('shared', 'collab');
    expect(got.value).toEqual({ update: 'AAAA' });

    await expect(s.statePut('shared', 'collab', 0, { update: 'BBBB' }))
      .rejects.toThrow('revision_conflict');
    const put2 = await s.statePut('shared', 'collab', 1, { update: 'BBBB' });
    expect(put2.state.revision).toBe(2);
    s.close();
  });

  it('lists state refs and rejects oversized values', async () => {
    const s = session();
    await s.statePut('journal', 'journal:dev-alice', 0, { entries: [] });
    const list = await s.stateList();
    expect(list.refs.some((ref) => ref.key === 'journal:dev-alice')).toBe(true);
    await expect(s.statePut('shared', 'big', 0, { blob: 'x'.repeat(310 * 1024) }))
      .rejects.toThrow('invalid_state_value');
    s.close();
  });

  it('delivers events to subscribers with cursor replay', async () => {
    const s = session();
    const seen: string[] = [];
    const off = await s.eventsSubscribe((event) => {
      if (typeof event.data === 'object' && event.data) {
        seen.push(`${(event.data as Record<string, unknown>).key}`);
      }
    });
    await s.statePut('shared', 'doc', 0, { v: 1 });
    await s.statePut('presence', 'presence:dev-alice', 0, { online: true });
    expect(seen).toEqual(['doc', 'presence:dev-alice']);
    off();
    s.close();
  });

  it('progresses tasks and runs the optional mock agent', async () => {
    const agent = vi.fn();
    const s = session({ agent });
    const statuses: string[] = [];
    s.onTaskStatus((status) => statuses.push(status.status));
    const task = await s.taskSubmit('lesson-report.collab-review.v1', { work_item_id: 'w-1' });
    expect(task.status).toBe('submitted');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(statuses).toEqual(['running', 'completed']);
    expect(agent).toHaveBeenCalledOnce();
    s.close();
  });
});
