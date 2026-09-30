/**
 * AgentLoop — the colleague's perceive → decide → act cycle.
 *
 * What makes this agentic rather than scripted: the decider is a pure
 * function of `AgentContext` — the projection mirror, the merged journal
 * tail, bounded doc reads, and the wake (a task or a room event). It never
 * touches the page's domain objects. Actions come back as a typed union the
 * loop executes one by one; a real agent swaps the decider, not the loop.
 *
 * Wake sources: task submission (the platform's task path) and room
 * `state.updated` events (reactive wake — whether a real bot may subscribe
 * is a platform open question; the mock supports it). Event wakes coalesce;
 * task wakes never do.
 */

import type { RuntimeEvent, RuntimeStateDoc } from '@artifact-ax/contract';
import type { RuntimeSession } from '@artifact-ax/runtime-client';
import { Journal } from './journal.js';
import type { JournalEntry } from './journal.js';
import { SEMANTIC_NAMESPACE, SEMANTIC_SNAPSHOT_KEY } from './mirror.js';

const PRESENCE_NAMESPACE = 'presence' as const;
const JOURNAL_NAMESPACE = 'journal' as const;
const RESULT_NAMESPACE = 'result' as const;
const JOURNAL_TAIL_REFS = 8;
const JOURNAL_TAIL_ENTRIES = 30;
const EVENT_COALESCE_MS = 250;

export type AgentAction =
  | { kind: 'presence'; focus?: string; ttlMs: number }
  | { kind: 'pause'; ms: number }
  | { kind: 'journal'; entryKind: string; summary: string; target?: string; detail?: Record<string, unknown> }
  | { kind: 'state-put'; namespace: string; key: string; value: unknown }
  /** Write `result:<taskId>` once; a pre-existing doc is never overwritten. */
  | { kind: 'result'; taskId: string; value: unknown }
  | { kind: 'wait'; reason?: string };

export interface AgentWake {
  task?: { task_id: string; intentId: string; payload: unknown };
  event?: RuntimeEvent;
}

export interface AgentContext {
  session: RuntimeSession;
  wake: AgentWake;
  /** Latest leader-mirrored semantic projection (plain JSON), or null. */
  projection: unknown | null;
  /** Merged journal tail across actors, oldest→newest. */
  journalTail: JournalEntry[];
  /** Bounded doc read — the agent's only room-state channel. */
  get(namespace: string, key: string): Promise<RuntimeStateDoc | null>;
}

export type AgentDecider = (ctx: AgentContext) => Promise<AgentAction[]> | AgentAction[];

export interface AgentLoopOptions {
  session: RuntimeSession;
  decider: AgentDecider;
  onError?: (error: unknown) => void;
}

export class AgentLoop {
  private readonly session: RuntimeSession;
  private readonly decider: AgentDecider;
  private readonly journal: Journal;
  private readonly onError: (error: unknown) => void;
  private readonly queue: AgentWake[] = [];
  private draining = false;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvents = new Map<string, RuntimeEvent>();

  constructor(options: AgentLoopOptions) {
    this.session = options.session;
    this.decider = options.decider;
    this.onError = options.onError ?? (() => {});
    this.journal = new Journal(options.session);
  }

  /** Task wakes are never dropped or merged. */
  wakeTask(task: { task_id: string; intentId: string; payload: unknown }): void {
    this.queue.push({ task });
    void this.drain();
  }

  /**
   * Event wakes coalesce within a short window — but per namespace, not
   * globally. A burst like presence→journal→shared (the annotate path
   * writes the journal entry and the Yjs blob back-to-back) must surface
   * each signal: keeping only the LAST event silently swallowed journal
   * wakes whenever a `shared` Yjs blob landed in the same window.
   */
  wakeEvent(event: RuntimeEvent): void {
    this.pendingEvents.set(event.namespace ?? '', event);
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const pending = [...this.pendingEvents.values()];
      this.pendingEvents.clear();
      for (const event of pending) this.queue.push({ event });
      void this.drain();
    }, EVENT_COALESCE_MS);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let wake: AgentWake | undefined;
      while ((wake = this.queue.shift())) {
        try {
          await this.pass(wake);
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async pass(wake: AgentWake): Promise<void> {
    const ctx = await this.context(wake);
    const actions = await this.decider(ctx);
    for (const action of actions) {
      const ok = await this.apply(action);
      if (!ok || action.kind === 'wait') return;
    }
  }

  private async context(wake: AgentWake): Promise<AgentContext> {
    const get = (namespace: string, key: string) => this.session.stateGet(namespace, key).catch(() => null);
    const projectionDoc = await get(SEMANTIC_NAMESPACE, SEMANTIC_SNAPSHOT_KEY);
    const projection = projectionDoc?.exists
      ? (projectionDoc.value as { view?: unknown }).view ?? null
      : null;

    // Merge the per-actor journals into a bounded tail — what happened,
    // in the agent's own legible channel.
    const list = await this.session.stateList().catch(() => null);
    const journalRefs = (list?.refs ?? [])
      .filter((ref) => ref.namespace === JOURNAL_NAMESPACE)
      .slice(0, JOURNAL_TAIL_REFS);
    const entries: JournalEntry[] = [];
    for (const ref of journalRefs) {
      const doc = await get(JOURNAL_NAMESPACE, ref.key);
      if (!doc?.exists) continue;
      const value = doc.value as { entries?: JournalEntry[] };
      if (Array.isArray(value.entries)) entries.push(...value.entries);
    }
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));

    return {
      session: this.session,
      wake,
      projection,
      journalTail: entries.slice(-JOURNAL_TAIL_ENTRIES),
      get,
    };
  }

  /** Execute one action; returns false when the pass should stop. */
  private async apply(action: AgentAction): Promise<boolean> {
    const uid = this.session.identity.uid;
    try {
      switch (action.kind) {
        case 'pause':
          await new Promise((resolve) => setTimeout(resolve, action.ms));
          return true;
        case 'presence': {
          const key = `${PRESENCE_NAMESPACE}:${uid}`;
          const cur = await this.session.stateGet(PRESENCE_NAMESPACE, key).catch(() => null);
          await this.session.statePut(PRESENCE_NAMESPACE, key, cur?.revision ?? 0, {
            uid,
            username: this.session.identity.username,
            authenticated: true,
            online_at: new Date().toISOString(),
            ttl_ms: action.ttlMs,
            kind: 'agent',
            ...(action.focus ? { focus: action.focus } : {}),
          });
          return true;
        }
        case 'journal':
          await this.journal.append({
            kind: action.entryKind,
            summary: action.summary,
            ...(action.target ? { target: action.target } : {}),
            ...(action.detail ? { detail: action.detail } : {}),
          });
          return true;
        case 'state-put': {
          const cur = await this.session.stateGet(action.namespace, action.key).catch(() => null);
          const doc = await this.session.statePut(action.namespace, action.key, cur?.revision ?? 0, action.value);
          return doc.state.revision > (cur?.revision ?? 0);
        }
        case 'result': {
          const key = `${RESULT_NAMESPACE}:${action.taskId}`;
          const cur = await this.session.stateGet(RESULT_NAMESPACE, key).catch(() => null);
          if (cur?.exists) return true; // write-once: a duplicate task result is a no-op
          await this.session.statePut(RESULT_NAMESPACE, key, 0, action.value);
          return true;
        }
        case 'wait':
          return false;
      }
    } catch (error) {
      this.onError(error);
      return true; // a failed action stops nothing else in the pass
    }
  }

  close(): void {
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.journal.close();
  }
}
