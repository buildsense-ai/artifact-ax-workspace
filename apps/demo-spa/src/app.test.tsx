/**
 * Render smoke test: the React tree must mount without throwing — SSR via
 * renderToString catches component/JSX assembly errors without a DOM env.
 */

import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { GUEST_IDENTITY } from '@artifact-ax/contract';
import { seedReviewTable } from '@artifact-ax/lesson-report';
import { App, type AppHandlers, type AppView } from './app.js';
import { CollabBoard } from './board.js';
import type { CollaborationScope } from './domain.js';
import { CollabRoom } from '@artifact-ax/collab';
import { createMockSession, devIdentity } from '@artifact-ax/runtime-client';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

function noopHandlers(): AppHandlers {
  return {
    bindNotes: () => {},
    setFilter: () => {},
    toggleRow: () => {},
    approveSelected: () => {},
    createWorkItem: () => {},
    createFinding: () => {},
    addFeedback: () => {},
    askAgent: () => {},
    useProposal: () => {},
    discardProposal: () => {},
    useCanvasPatch: () => {},
    discardCanvasPatch: () => {},
    saveRecipe: () => {},
    toggleAnnotate: () => {},
    submitAnnotations: () => {},
    retractAnnotation: () => {},
    locateAnnotation: () => {},
    reopenRecipe: () => {},
  };
}

describe('App', () => {
  it('mounts the full shell without throwing', async () => {
    const session = createMockSession({ identity: devIdentity('tester'), artifactId: 'lesson-report', room: 't', broadcast: null });
    const room = new CollabRoom(session, { roomKey: 'test' });
    await room.open();
    const scope: CollaborationScope = { workspaceId: 'ws_demo', artifactId: 'lesson-report', actorId: session.identity.uid };
    const board = new CollabBoard(room, scope, memoryStorage());
    board.seed(seedReviewTable().rows);

    const view: AppView = {
      identity: GUEST_IDENTITY,
      via: 'dev',
      embedded: false,
      hostConnected: false,
      roomKey: 'r1',
      presence: null,
      board: board.snapshot(),
      canvas: board.canvas(),
      selectedRowIds: new Set<string>(),
      journal: [],
      recipes: [],
      reopened: null,
      agentActivity: null,
      annotateMode: false,
      agentNotes: [],
      taskStatuses: [],
      notice: null,
    };
    const html = renderToString(createElement(App, { view, handlers: noopHandlers() }));
    expect(html).toContain('Review table');
    expect(html).toContain('Activity journal');
    expect(html).toContain('Canvas');
  });
});
