import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpRuntimeSession, openHttpSession } from './http.js';
import { devIdentity } from './identity.js';

const IDENTITY = devIdentity('tester');
const STATE_DOC = {
  contract_version: 'catsco.artifact-runtime-state.v1',
  namespace: 'shared',
  key: 'collab:demo',
  revision: 3,
  exists: true,
  value: { ok: true },
};

function fakeFetch(map: Record<string, unknown>) {
  return vi.fn(async (url: unknown) => {
    const path = String(url);
    for (const [route, body] of Object.entries(map)) {
      if (path.includes(route)) {
        return { ok: true, status: 200, json: async () => body } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) } as Response;
  });
}

describe('HttpRuntimeSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps state.get through api/runtime and normalizes the doc', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'state.get': { state: STATE_DOC } }));
    const session = new HttpRuntimeSession({ identity: IDENTITY });
    const doc = await session.stateGet('shared', 'collab:demo');
    expect(doc.revision).toBe(3);
    expect(doc.exists).toBe(true);
    expect((doc.value as Record<string, unknown>).ok).toBe(true);
  });

  it('routes task.status pseudo-events to taskStatus handlers', async () => {
    vi.stubGlobal('fetch', fakeFetch({
      'events?': {
        events: [
          {
            contract_version: 'catsco.artifact-runtime-event.v2',
            event_id: 5,
            type: 'task.status',
            data: { contract_version: 'catsco.artifact-task-status.v1', task_id: 't-1', status: 'running' },
          },
          {
            contract_version: 'catsco.artifact-runtime-event.v2',
            event_id: 6,
            type: 'state.updated',
            namespace: 'agent',
            key: 'note:w-1',
          },
        ],
        cursor: 6,
      },
    }));
    const session = new HttpRuntimeSession({ identity: IDENTITY });
    const statuses: string[] = [];
    const events: string[] = [];
    session.onTaskStatus((s) => statuses.push(`${s.task_id}:${s.status}`));
    await session.eventsSubscribe((event) => events.push(`${event.namespace}:${event.key}`));
    await new Promise((resolve) => setTimeout(resolve, 80));
    session.close();
    expect(statuses).toEqual(['t-1:running']);
    expect(events).toEqual(['agent:note:w-1']);
  });

  it('openHttpSession returns null when no bridge exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    const session = await openHttpSession({ identity: IDENTITY });
    expect(session).toBeNull();
  });
});
