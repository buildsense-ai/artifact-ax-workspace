import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createMockSession, devIdentity } from '@artifact-ax/runtime-client';
import { CollabDoc, YJS_UPDATE_FORMAT } from './doc.js';
import { adjustCursorAfterEdit, bindTextarea, diffTextEdit, type TextAreaLike } from './text-binding.js';

class FakeTextarea implements TextAreaLike {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  focused = false;
  private listeners = new Map<string, Set<() => void>>();

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'input' | 'focus' | 'blur'): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  /** Simulate a user typing `text` at `index`, replacing `count` chars. */
  splice(index: number, count: number, text: string): void {
    this.value = this.value.slice(0, index) + text + this.value.slice(index + count);
    const caret = index + text.length;
    this.setSelectionRange(caret, caret);
    this.emit('input');
  }
}

describe('diffTextEdit', () => {
  it('computes minimal splices', () => {
    expect(diffTextEdit('', 'hello')).toEqual({ index: 0, remove: 0, insert: 'hello' });
    expect(diffTextEdit('hello', 'hello')).toEqual({ index: 5, remove: 0, insert: '' });
    expect(diffTextEdit('hello', 'hello!')).toEqual({ index: 5, remove: 0, insert: '!' });
    expect(diffTextEdit('hello', 'helo')).toEqual({ index: 3, remove: 1, insert: '' });
    expect(diffTextEdit('cat', 'cut')).toEqual({ index: 1, remove: 1, insert: 'u' });
    expect(diffTextEdit('abcdef', 'abXYef')).toEqual({ index: 2, remove: 2, insert: 'XY' });
    expect(diffTextEdit('abc', 'xyz')).toEqual({ index: 0, remove: 3, insert: 'xyz' });
  });
});

describe('adjustCursorAfterEdit', () => {
  const edit = { index: 4, remove: 3, insert: 'XY' }; // "abcd[efg]hij" → "abcdXYhij"

  it('keeps positions before the edit', () => {
    expect(adjustCursorAfterEdit(2, edit)).toBe(2);
    expect(adjustCursorAfterEdit(4, edit)).toBe(4);
  });

  it('clamps positions inside the replaced range', () => {
    expect(adjustCursorAfterEdit(5, edit)).toBe(6); // end of "XY"
    expect(adjustCursorAfterEdit(6, edit)).toBe(6);
  });

  it('shifts positions after the edit by the delta', () => {
    expect(adjustCursorAfterEdit(8, edit)).toBe(7); // delta = 2 - 3 = -1
  });
});

describe('bindTextarea', () => {
  it('splices local input into the Y.Text', () => {
    const doc = new Y.Doc();
    const text = doc.getText('notes');
    const area = new FakeTextarea();
    const dispose = bindTextarea(area, text);

    area.splice(0, 0, 'hello');
    expect(text.toString()).toBe('hello');

    area.splice(5, 0, ' world');
    expect(text.toString()).toBe('hello world');

    area.splice(0, 6, 'bye ');
    expect(text.toString()).toBe('bye world');
    dispose();
  });

  it('applies remote edits to the textarea and keeps the caret sane', () => {
    const doc = new Y.Doc();
    const text = doc.getText('notes');
    const area = new FakeTextarea();
    bindTextarea(area, text);
    area.splice(0, 0, 'hello');

    // Caret at the end; a remote insert before it must shift it.
    area.setSelectionRange(5, 5);
    doc.transact(() => text.insert(0, '>> '));
    expect(area.value).toBe('>> hello');
    expect(area.selectionStart).toBe(8);
  });

  it('two clients typing at once converge — the Yjs point', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const sync = () => {
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    };
    const areaA = new FakeTextarea();
    const areaB = new FakeTextarea();
    bindTextarea(areaA, a.getText('notes'));
    bindTextarea(areaB, b.getText('notes'));

    // Alice types "AA" at the front, Bob types "BB" at the end — concurrently.
    areaA.splice(0, 0, 'AA');
    areaB.splice(0, 0, 'BB'); // Bob hadn't received Alice's update yet.
    sync();
    expect(a.getText('notes').toString()).toBe(b.getText('notes').toString());
    expect(a.getText('notes').toString()).toContain('AA');
    expect(a.getText('notes').toString()).toContain('BB');
    expect(areaA.value).toBe(b.getText('notes').toString());
    expect(areaB.value).toBe(b.getText('notes').toString());
  });

  it('reports focus changes', () => {
    const doc = new Y.Doc();
    const area = new FakeTextarea();
    const seen: boolean[] = [];
    bindTextarea(area, doc.getText('notes'), { onFocusChange: (f) => seen.push(f) });
    area.emit('focus');
    area.emit('blur');
    expect(seen).toEqual([true, false]);
  });
});

describe('Y.Text through CollabDoc', () => {
  it('text edits persist into the same single state doc', async () => {
    const session = createMockSession({
      identity: devIdentity('alice'),
      artifactId: 'lesson-report',
      room: `test-${Math.random().toString(36).slice(2)}`,
      broadcast: null,
    });
    const collab = new CollabDoc({ session, key: 'collab:test', persistDelayMs: 5 });
    await collab.open();
    const doc = collab.doc;

    const area = new FakeTextarea();
    bindTextarea(area, doc.getText('notes:w-1'));
    area.splice(0, 0, 'shared notes');
    await collab.flush();

    const stored = await session.stateGet('shared', 'collab:test');
    expect((stored.value as Record<string, unknown>).format).toBe(YJS_UPDATE_FORMAT);

    const reloaded = new CollabDoc({ session, key: 'collab:test', persistDelayMs: 5 });
    await reloaded.open();
    expect(reloaded.doc.getText('notes:w-1').toString()).toBe('shared notes');
    await collab.close();
    await reloaded.close();
    session.close();
  });
});
