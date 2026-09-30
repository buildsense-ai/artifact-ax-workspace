import { describe, it, expect } from 'vitest';
import { createMockSession, devIdentity } from '@artifact-ax/runtime-client';
import { CollabRoom, AgentLoop } from '@artifact-ax/collab';
import { CollabBoard } from './board.js';
import { colleagueDecider } from './colleague.js';
import { buildRuntimeView } from './projection.js';
import type { CollaborationScope } from './domain.js';

const memStorage = () => ({
  getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
}) as Storage;

/**
 * The annotation → canvas-patch loop end to end through the real mock
 * transport: a `ui.annotate` journal entry wakes the colleague (surviving
 * same-window `shared` Yjs-blob events), which writes an `agent/patch:*`
 * doc + an `agent.annotate-ack` journal entry — all agent-legible,
 * nothing written outside its own namespaces.
 */
describe('annotate → canvas patch loop', () => {
  it('journal wake survives coalescing; colleague stages a canvas patch doc', async () => {
    const roomKey = `t-${Math.random().toString(36).slice(2)}`;
    let loop: AgentLoop | null = null;
    const session = createMockSession({
      identity: devIdentity('local'), artifactId: 'lesson-report', room: roomKey,
      agent: () => {},
      agentEvents: (event, agentSession) => {
        loop ??= new AgentLoop({ session: agentSession, decider: colleagueDecider(), onError: () => {} });
        loop.wakeEvent(event);
      },
    });
    const boardRef: { current?: CollabBoard } = {};
    const room = new CollabRoom(session, {
      roomKey,
      project: () => (boardRef.current ? buildRuntimeView(boardRef.current, null, []) : null),
    });
    await room.open();
    const scope: CollaborationScope = { workspaceId: 'ws', artifactId: 'lesson-report', actorId: session.identity.uid };
    const board = new CollabBoard(room, scope, memStorage());
    boardRef.current = board;
    board.seed([{ id: 'r1', student: 'a', topic: 't', status: 'pending' } as never]);
    board.seedCanvas();
    board.annotate({ id: 'an-1', nodeId: 'canvas-notes', text: 'hi', actorUid: session.identity.uid });
    await new Promise((res) => setTimeout(res, 2_500));

    const keys = (await session.stateList()).refs.map((x) => `${x.namespace}:${x.key}`);
    expect(keys.some((k) => k.startsWith('agent:patch:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('journal:journal:bot'))).toBe(true);
  });
});
