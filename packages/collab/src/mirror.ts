import { isRecord } from '@artifact-ax/contract';
import type { RuntimeSession } from '@artifact-ax/runtime-client';
import type { Presence } from './presence.js';

/**
 * The semantic mirror: one leader-elected viewer materializes the merged
 * collaboration state into a plain JSON document an Agent can read without
 * understanding Yjs.
 *
 * Leader = smallest live uid in the presence set (deterministic, self-healing
 * when the leader's heartbeat expires). Only the leader writes
 * `semantic/snapshot`; the projection is explicitly a derived,
 * eventually-consistent view — the authoritative answers for an Agent remain
 * OBSERVE `runtime_view` plus the per-actor journals.
 */

export const SEMANTIC_NAMESPACE = 'semantic' as const;
export const SEMANTIC_SNAPSHOT_KEY = 'snapshot' as const;
export const SEMANTIC_SNAPSHOT_CONTRACT = 'artifact-ax.semantic-snapshot.v1' as const;

export interface SemanticSnapshot<T = unknown> {
  contract_version: typeof SEMANTIC_SNAPSHOT_CONTRACT;
  generated_by: string;
  generated_at: string;
  view: T;
}

export function normalizeSnapshot<T = unknown>(value: unknown): SemanticSnapshot<T> | null {
  if (!isRecord(value) || value.contract_version !== SEMANTIC_SNAPSHOT_CONTRACT) return null;
  return {
    contract_version: SEMANTIC_SNAPSHOT_CONTRACT,
    generated_by: String(value.generated_by ?? ''),
    generated_at: String(value.generated_at ?? ''),
    view: value.view as T,
  };
}

export interface MirrorOptions {
  session: RuntimeSession;
  presence: Presence;
  /** Produce the bounded semantic projection; return null to skip a write. */
  project: () => unknown | null;
  /** Debounce between a change and the snapshot write. */
  debounceMs?: number;
  key?: string;
  onError?: (error: Error) => void;
}

export class SemanticMirror {
  private readonly session: RuntimeSession;
  private readonly presence: Presence;
  private readonly project: () => unknown | null;
  private readonly debounceMs: number;
  private readonly key: string;
  private readonly onError?: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(options: MirrorOptions) {
    this.session = options.session;
    this.presence = options.presence;
    this.project = options.project;
    this.debounceMs = options.debounceMs ?? 800;
    this.key = options.key ?? SEMANTIC_SNAPSHOT_KEY;
    this.onError = options.onError;
  }

  /** True when this client currently leads the presence set. */
  isLeader(): boolean {
    const uids = this.presence.liveUids().sort();
    return uids[0] === this.session.identity.uid;
  }

  /** Schedule a snapshot write; a no-op on followers. */
  notifyChanged(): void {
    if (this.closed || !this.isLeader() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publish();
    }, this.debounceMs);
  }

  private async publish(): Promise<void> {
    if (this.closed || !this.isLeader()) return;
    const view = this.project();
    if (view === null || view === undefined) return;
    try {
      const stored = await this.session.stateGet(SEMANTIC_NAMESPACE, this.key);
      const snapshot: SemanticSnapshot = {
        contract_version: SEMANTIC_SNAPSHOT_CONTRACT,
        generated_by: this.session.identity.uid,
        generated_at: new Date().toISOString(),
        view,
      };
      await this.session.statePut(SEMANTIC_NAMESPACE, this.key, stored.revision, snapshot);
    } catch (error) {
      // A conflict means leadership raced; the next change republishes.
      if (!(error instanceof Error && /conflict/i.test(error.message))) {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.publish();
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
