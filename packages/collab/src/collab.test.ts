import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createMockSession, devIdentity } from '@artifact-ax/runtime-client';
import type { RuntimeSession } from '@artifact-ax/runtime-client';
import { AgentLoop } from './agent-loop.js';
import { CollabDoc, YJS_UPDATE_FORMAT } from './doc.js';
import { Journal, journalKey } from './journal.js';
import { Presence, presenceKey } from './presence.js';
import { SemanticMirror, normalizeSnapshot } from './mirror.js';

function session(name: string): RuntimeSession {
  return createMockSession({
    identity: devIdentity(name),
    artifactId: 'lesson-report',
    room: `test-${Math.random().toString(36).slice(2)}`,
    broadcast: null,
  });
}

describe('CollabDoc', () => {
  it('persists a Yjs document into one state doc and reloads it', async () => {
    const s = session('alice');
    const doc = new CollabDoc({ session: s, key: 'collab:test', persistDelayMs: 10 });
    await doc.open();
    doc.doc.getMap('workitems').set('w-1', { title: 'Compare rows' });
    await doc.flush();
    const stored = await s.stateGet('shared', 'collab:test');
    expect((stored.value as Record<string, unknown>).format).toBe(YJS_UPDATE_FORMAT);

    const doc2 = new CollabDoc({ session: s, key: 'collab:test', persistDelayMs: 10 });
    await doc2.open();
    expect(doc2.doc.getMap('workitems').get('w-1')).toEqual({ title: 'Compare rows' });
    await doc.close();
    await doc2.close();
    s.close();
  });

  it('merges a remote update delivered through a state event', async () => {
    const s = session('alice');
    const doc = new CollabDoc({ session: s, key: 'collab:test', persistDelayMs: 10 });
    await doc.open();

    // A second writer commits a state doc with a different Yjs update.
    const remote = new Y.Doc();
    remote.getMap('findings').set('f-1', { summary: 'remote finding' });
    const update = Buffer.from(Y.encodeStateAsUpdate(remote)).toString('base64');
    const current = await s.stateGet('shared', 'collab:test');
    await s.statePut('shared', 'collab:test', current.revision, {
      format: YJS_UPDATE_FORMAT, update,
    });

    await doc.onStateEvent('shared', 'collab:test');
    expect(doc.doc.getMap('findings').get('f-1')).toEqual({ summary: 'remote finding' });
    await doc.close();
    s.close();
  });

  it('repersists when a remote merge added unseen ops — no silent divergence', async () => {
    const s = session('alice');
    const doc = new CollabDoc({ session: s, key: 'collab:test', persistDelayMs: 5 });
    await doc.open();
    doc.doc.getMap('a').set('x', 1);
    await doc.flush();

    // A remote peer writes a doc containing ONLY its own ops (store clobber).
    const remote = new Y.Doc();
    remote.getMap('b').set('y', 2);
    const update = Buffer.from(Y.encodeStateAsUpdate(remote)).toString('base64');
    const current = await s.stateGet('shared', 'collab:test');
    await s.statePut('shared', 'collab:test', current.revision, { format: YJS_UPDATE_FORMAT, update });

    await doc.onStateEvent('shared', 'collab:test');
    expect(doc.doc.getMap('b').get('y')).toBe(2);
    await doc.flush();

    // The persisted doc must now carry the MERGE, not just the remote subset.
    const stored = await s.stateGet('shared', 'collab:test');
    const merged = new Y.Doc();
    const storedUpdate = CollabDoc.decode(stored.value);
    expect(storedUpdate).not.toBeNull();
    Y.applyUpdate(merged, storedUpdate!);
    expect(merged.getMap('a').get('x')).toBe(1);
    expect(merged.getMap('b').get('y')).toBe(2);
    await doc.close();
    s.close();
  });
});

describe('Journal', () => {
  it('appends bounded entries to the actor-owned document', async () => {
    const s = session('alice');
    const journal = new Journal(s, { maxEntries: 3 });
    for (let i = 1; i <= 5; i += 1) {
      await journal.append({ kind: 'finding.revise', target: 'f-1', summary: `rev ${i}` });
    }
    const doc = await s.stateGet('journal', journalKey(devIdentity('alice')));
    const entries = (doc.value as { entries: Array<{ seq: number; summary: string }> }).entries;
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(entries[2]?.summary).toBe('rev 5');
    journal.close();
    s.close();
  });

  it('reads all journals merged by timestamp', async () => {
    const s = session('alice');
    const journal = new Journal(s);
    await journal.append({ kind: 'workitem.create', summary: 'created w-1' });
    const entries = await Journal.readAll(s);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor.username).toBe('alice');
    journal.close();
    s.close();
  });
});

describe('Presence', () => {
  it('publishes a heartbeat doc under presence:<uid>', async () => {
    const identity = devIdentity('alice');
    const s = session('alice');
    const presence = new Presence(s, { heartbeatMs: 60_000 });
    await presence.start();
    const doc = await s.stateGet('presence', presenceKey(identity));
    expect(doc.exists).toBe(true);
    const value = doc.value as Record<string, unknown>;
    expect(value.uid).toBe(identity.uid);
    expect(typeof value.online_at).toBe('string');
    presence.close();
    s.close();
  });
});

describe('AgentLoop', () => {
  it('a conflicting state-put must not strand the result action', async () => {
    const s = session('bot');
    // Pre-existing agent doc at revision ≥1 — the colleague's second put
    // on this key will not advance the revision. If apply() aborted the
    // pass on a no-op put, the 'result' write that follows would never land
    // (the exact "task completed, result missing" strand found in deploy).
    await s.statePut('agent', 'note:w-1', 0, { contract_version: 'x', text: 'old' });
    const prior = await s.stateGet('agent', 'note:w-1');
    await s.statePut('agent', 'note:w-1', prior!.revision, { contract_version: 'x', text: 'same' });

    const loop = new AgentLoop({
      session: s,
      decider: async () => [
        { kind: 'state-put', namespace: 'agent', key: 'note:w-1', value: { contract_version: 'x', text: 'same' } },
        { kind: 'result', taskId: 'task-1', value: { ok: true } },
      ],
    });
    loop.wakeTask({ task_id: 'task-1', intentId: 'test.v1', payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await s.stateGet('result', 'result:task-1');
    expect(result.exists).toBe(true);
    loop.close();
  });

  it('a wake enqueued mid-drain is not stranded', async () => {
    const s = session('bot2');
    const seen: string[] = [];
    let loop!: AgentLoop;
    const decider = async (ctx: import('./agent-loop.js').AgentContext) => {
      const id = ctx.wake.task?.task_id ?? ctx.wake.event?.key ?? '?';
      seen.push(id);
      if (id === 't-1') {
        // Enqueue a second task from inside the running pass — exercises
        // the drain tail path.
        loop.wakeTask({ task_id: 't-2', intentId: 'x', payload: {} });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ kind: 'wait', reason: 'done' }];
    };
    loop = new AgentLoop({ session: s, decider });
    loop.wakeTask({ task_id: 't-1', intentId: 'x', payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toContain('t-1');
    expect(seen).toContain('t-2');
    loop.close();
  });
});

describe('SemanticMirror', () => {
  it('writes the projection only when leader', async () => {
    const s = session('alice');
    const presence = new Presence(s, { heartbeatMs: 60_000 });
    await presence.start();
    const mirror = new SemanticMirror({
      session: s,
      presence,
      project: () => ({ work_items: 1, recent: [] }),
      debounceMs: 10,
    });
    expect(mirror.isLeader()).toBe(true);
    mirror.notifyChanged();
    await mirror.flush();
    const doc = await s.stateGet('semantic', 'snapshot');
    const snapshot = normalizeSnapshot(doc.value);
    expect(snapshot?.generated_by).toBe(devIdentity('alice').uid);
    expect((snapshot?.view as { work_items: number }).work_items).toBe(1);
    mirror.close();
    presence.close();
    s.close();
  });
});
