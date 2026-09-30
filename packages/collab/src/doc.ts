import * as Y from 'yjs';
import type { RuntimeSession } from '@artifact-ax/runtime-client';
import type { RuntimeStateDoc } from '@artifact-ax/contract';

/**
 * Yjs document synced through one Runtime State document.
 *
 * The state value is `{format:'artifact-ax.yjs-update.v1', update:<base64>}` —
 * opaque to the platform and to the Agent by design. Agent-legible semantics
 * live in the journal/mirror documents; this key is only the convergence
 * substrate between human viewers.
 *
 * Write path (optimistic + merge-on-conflict):
 *   local update → debounce → stateGet → applyUpdate(remote) → encode merged
 *   state → CAS state.put → on revision_conflict re-read/merge/retry.
 * Remote path:
 *   runtime event on the key → stateGet → applyUpdate (Yjs dedupes our own).
 */

export const YJS_UPDATE_FORMAT = 'artifact-ax.yjs-update.v1' as const;
export const YJS_UPDATE_MAX_BYTES = 240 * 1024;

export interface CollabDocOptions {
  session: RuntimeSession;
  namespace?: string;
  key: string;
  /** Debounce for outbound persistence; defaults to 200ms. */
  persistDelayMs?: number;
  /** CAS retries before surfacing an error; defaults to 4. */
  maxWriteRetries?: number;
  onError?: (error: Error) => void;
  /** Fired when the stored update would exceed the state size budget. */
  onOversize?: (bytes: number) => void;
}

function encodeUpdate(doc: Y.Doc): string {
  const update = Y.encodeStateAsUpdate(doc);
  let binary = '';
  for (let i = 0; i < update.length; i += 1) binary += String.fromCharCode(update[i]!);
  return btoa(binary);
}

function decodeUpdate(value: unknown): Uint8Array | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.format !== YJS_UPDATE_FORMAT || typeof record.update !== 'string') return null;
  try {
    const binary = atob(record.update);
    const update = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) update[i] = binary.charCodeAt(i);
    return update;
  } catch {
    return null;
  }
}

export class CollabDoc {
  readonly doc = new Y.Doc();
  readonly namespace: string;
  readonly key: string;
  private readonly session: RuntimeSession;
  private readonly persistDelayMs: number;
  private readonly maxWriteRetries: number;
  private readonly onError?: (error: Error) => void;
  private readonly onOversize?: (bytes: number) => void;
  private revision = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;

  constructor(options: CollabDocOptions) {
    this.session = options.session;
    this.namespace = options.namespace ?? 'shared';
    this.key = options.key;
    this.persistDelayMs = options.persistDelayMs ?? 200;
    this.maxWriteRetries = options.maxWriteRetries ?? 4;
    this.onError = options.onError;
    this.onOversize = options.onOversize;
  }

  /** Load the stored state and start the local→remote persistence hook. */
  async open(): Promise<void> {
    const stored = await this.session.stateGet(this.namespace, this.key);
    this.revision = stored.revision;
    const update = stored.exists ? decodeUpdate(stored.value) : null;
    if (update) Y.applyUpdate(this.doc, update, 'remote');
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote' && !this.closed) this.schedulePersist();
    });
  }

  /**
   * Handle a runtime event for this document's key. Returns true when the
   * event targeted this doc (caller may ignore it otherwise).
   *
   * If the remote update merged NEW content into our doc, schedule a
   * persist: the merged state must be written back or convergence depends
   * on whoever edits next — a store that lost a CAS race would otherwise
   * leave both sides diverged.
   */
  async onStateEvent(namespace: string, key: string): Promise<boolean> {
    if (this.closed || namespace !== this.namespace || key !== this.key) return false;
    const stored = await this.session.stateGet(this.namespace, this.key);
    this.revision = Math.max(this.revision, stored.revision);
    const update = decodeUpdate(stored.value);
    if (update && this.applyRemote(update)) this.schedulePersist();
    return true;
  }

  /** Apply a remote update; returns true when it added unseen operations. */
  private applyRemote(update: Uint8Array): boolean {
    const before = Y.encodeStateVector(this.doc);
    Y.applyUpdate(this.doc, update, 'remote');
    const after = Y.encodeStateVector(this.doc);
    if (before.length !== after.length) return true;
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) return true;
    }
    return false;
  }

  /** Persist pending local changes now (also called by flush()/close()). */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushing = this.persist();
    }, this.persistDelayMs);
  }

  private async persist(): Promise<void> {
    if (this.closed) return;
    for (let attempt = 0; attempt <= this.maxWriteRetries; attempt += 1) {
      try {
        const remote = await this.session.stateGet(this.namespace, this.key);
        if (remote.revision > this.revision) {
          const update = decodeUpdate(remote.value);
          if (update) Y.applyUpdate(this.doc, update, 'remote');
        }
        const encoded = encodeUpdate(this.doc);
        const bytes = new TextEncoder().encode(encoded).length;
        if (bytes > YJS_UPDATE_MAX_BYTES) {
          this.onOversize?.(bytes);
        }
        const value = { format: YJS_UPDATE_FORMAT, update: encoded };
        const result = await this.session.statePut(this.namespace, this.key, remote.revision, value);
        this.revision = result.state.revision;
        return;
      } catch (error) {
        const conflict = error instanceof Error
          && /revision_conflict|conflict/i.test(error.message);
        if (!conflict || attempt === this.maxWriteRetries) {
          this.report(error);
          return;
        }
      }
    }
  }

  /** Wait for pending persistence; used by tests and by close(). */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.flushing = this.persist();
    }
    await this.flushing;
  }

  private report(error: unknown): void {
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.flushing;
    this.doc.destroy();
  }

  static decode(value: unknown): Uint8Array | null {
    return decodeUpdate(value);
  }

  static isUpdateDoc(state: RuntimeStateDoc): boolean {
    return decodeUpdate(state.value) !== null;
  }
}
