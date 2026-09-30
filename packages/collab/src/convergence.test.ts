import { describe, expect, it } from 'vitest';
import { createMockSession, devIdentity } from '@artifact-ax/runtime-client';
import { CollabDoc } from './doc.js';

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two mock sessions on one BroadcastChannel room — the closest vitest can
 * get to two browser tabs. Reproduces the concurrent-edit convergence path.
 */
describe('two-tab convergence over BroadcastChannel mock', () => {
  it('concurrent inserts at different positions converge', async () => {
    const room = `conv-${Math.random().toString(36).slice(2)}`;
    const sa = createMockSession({ identity: devIdentity('alice'), artifactId: 'x', room });
    const sb = createMockSession({ identity: devIdentity('bob'), artifactId: 'x', room });
    const docA = new CollabDoc({ session: sa, key: 'collab:r', persistDelayMs: 5 });
    const docB = new CollabDoc({ session: sb, key: 'collab:r', persistDelayMs: 5 });
    await docA.open();
    await docB.open();
    await sa.eventsSubscribe((event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      void docA.onStateEvent(String(data.namespace), String(data.key));
    }, 0);
    await sb.eventsSubscribe((event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      void docB.onStateEvent(String(data.namespace), String(data.key));
    }, 0);

    // Seed a base line, let it settle.
    docA.doc.getText('notes').insert(0, 'base');
    await waitMs(120);
    expect(docB.doc.getText('notes').toString()).toBe('base');

    // Concurrent: A prepends, B appends — before either persist lands.
    docA.doc.getText('notes').insert(0, 'A>> ');
    docB.doc.getText('notes').insert(4, ' <<B');

    for (let i = 0; i < 40; i += 1) {
      await waitMs(50);
      if (docA.doc.getText('notes').toString() === docB.doc.getText('notes').toString()) break;
    }
    const a = docA.doc.getText('notes').toString();
    const b = docB.doc.getText('notes').toString();
    expect(a).toBe(b);
    expect(a).toContain('A>>');
    expect(a).toContain('<<B');
    await docA.close();
    await docB.close();
    sa.close();
    sb.close();
  });
});
