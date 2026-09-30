import type { RuntimeEvent } from '@artifact-ax/contract';
import type { RuntimeSession, Unsubscribe } from '@artifact-ax/runtime-client';
import { CollabDoc } from './doc.js';
import { Journal, JOURNAL_NAMESPACE, isJournalKey } from './journal.js';
import { SemanticMirror } from './mirror.js';
import { PRESENCE_NAMESPACE, Presence } from './presence.js';

/**
 * A collaboration room: one Yjs document for human convergence plus the
 * agent-legible channels (presence, journal, semantic mirror) wired onto one
 * runtime event subscription.
 *
 * Usage:
 *   const room = new CollabRoom(session, { roomKey: topicId, project });
 *   await room.open();
 *   room.doc.getMap('workitems').set(...);        // human-facing shared state
 *   await room.journal.append({ kind, summary }); // agent-legible event
 */

export interface CollabRoomOptions {
  /** Room discriminator: state keys are `collab:<roomKey>` etc. */
  roomKey: string;
  /** Namespace for the Yjs doc; defaults to 'shared'. */
  sharedNamespace?: string;
  /** Semantic projection producer for the mirror. */
  project?: () => unknown | null;
  /** Manifest-declared agent uids — excluded from leadership like kind 'agent'. */
  agentUids?: ReadonlySet<string>;
  /** Called for every runtime event not consumed by doc/presence. */
  onEvent?: (event: RuntimeEvent) => void;
  /** Called when a journal event arrives (any actor's journal doc changed). */
  onJournal?: (event: RuntimeEvent) => void;
  onError?: (error: Error) => void;
}

export class CollabRoom {
  readonly session: RuntimeSession;
  readonly doc: CollabDoc;
  readonly presence: Presence;
  readonly journal: Journal;
  readonly mirror: SemanticMirror | null;
  private readonly onEvent?: (event: RuntimeEvent) => void;
  private readonly onJournal?: (event: RuntimeEvent) => void;
  private readonly onError?: (error: Error) => void;
  private unsubscribe: Unsubscribe | null = null;

  constructor(session: RuntimeSession, options: CollabRoomOptions) {
    this.session = session;
    this.onEvent = options.onEvent;
    this.onJournal = options.onJournal;
    this.onError = options.onError;
    const key = `collab:${options.roomKey.replace(/[^A-Za-z0-9._:-]+/g, '_')}`;
    this.doc = new CollabDoc({
      session,
      namespace: options.sharedNamespace ?? 'shared',
      key,
      onError: (error) => this.onError?.(error),
    });
    this.presence = new Presence(session, { agentUids: options.agentUids });
    this.journal = new Journal(session);
    this.mirror = options.project
      ? new SemanticMirror({ session, presence: this.presence, project: options.project, onError: options.onError })
      : null;
    // Doc-local edits (including Y.Text notes keystrokes) never reach the
    // room's event dispatch — piggyback the debounced mirror on the doc's
    // own update stream so the snapshot still tracks them.
    this.doc.doc.on('update', () => this.mirror?.notifyChanged());
  }

  /**
   * Connect, subscribe, then load state: subscribing first closes the race
   * where a doc arrives between the initial read and the subscription
   * (e.g. a mock join-dump) — the event path re-reads and merges anyway.
   */
  async open(): Promise<void> {
    const connect = await this.session.connect();
    this.unsubscribe = await this.session.eventsSubscribe(
      (event) => void this.dispatch(event),
      connect.event_cursor,
    );
    await this.doc.open();
    await this.presence.start();
  }

  private async dispatch(event: RuntimeEvent): Promise<void> {
    try {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const namespace = typeof data.namespace === 'string' ? data.namespace : event.namespace;
      const key = typeof data.key === 'string' ? data.key : event.key;
      if (event.type === 'state.updated' && namespace && key) {
        if (await this.doc.onStateEvent(namespace, key)) {
          this.mirror?.notifyChanged();
          return;
        }
        if (await this.presence.onStateEvent(namespace, key)) {
          this.mirror?.notifyChanged();
          return;
        }
        if (namespace === JOURNAL_NAMESPACE && isJournalKey(key)) {
          this.onJournal?.(event);
          this.mirror?.notifyChanged();
          return;
        }
      }
      this.onEvent?.(event);
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Record a domain mutation. Journal failures surface through onError but
   * never reject: activity logging must not break the mutation it describes.
   */
  async record(kind: string, summary: string, target?: string, detail?: Record<string, unknown>): Promise<void> {
    try {
      await this.journal.append({ kind, summary, ...(target ? { target } : {}), ...(detail ? { detail } : {}) });
      this.mirror?.notifyChanged();
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.presence.close();
    this.journal.close();
    this.mirror?.close();
    await this.doc.close();
  }

  /** Smallest live uid leads — the deterministic applier for shared-doc writes. */
  isLeader(): boolean {
    const uids = this.presence.liveUids().sort();
    return uids[0] === this.session.identity.uid;
  }

  static namespaces(): string[] {
    return ['shared', PRESENCE_NAMESPACE, 'semantic', JOURNAL_NAMESPACE, 'result', 'agent'];
  }
}
