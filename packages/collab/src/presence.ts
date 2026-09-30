import type { CollabIdentity } from '@artifact-ax/contract';
import type { RuntimeSession } from '@artifact-ax/runtime-client';
import { isRecord } from '@artifact-ax/contract';

/**
 * Presence over Runtime State.
 *
 * There is no ephemeral channel in the platform contract, so presence is a
 * heartbeat document per actor: `presence:<uid>` carries the actor's
 * identity, an optional selection summary, and a TTL. Entries older than
 * their TTL are dead. The server-stamped `updated_by` on each document keeps
 * attribution honest — an actor can only heartbeat its own key usefully.
 */

export const PRESENCE_NAMESPACE = 'presence' as const;
export const PRESENCE_TTL_MS = 15_000;
export const PRESENCE_HEARTBEAT_MS = 5_000;

export interface PresenceEntry {
  uid: string;
  username: string;
  authenticated: boolean;
  onlineAt: string;
  ttlMs: number;
  /** Free-form bounded summary, e.g. current work item or selection. */
  focus?: string;
  /** Actor class — e.g. 'agent' — lets the UI mark non-human colleagues. */
  kind?: string;
}

export interface PresenceSnapshot {
  entries: PresenceEntry[];
  self: PresenceEntry;
}

export function presenceKey(identity: CollabIdentity): string {
  return `presence:${identity.uid.replace(/[^A-Za-z0-9._:-]+/g, '_')}`;
}

export function isPresenceKey(key: string): boolean {
  return key.startsWith('presence:');
}

export function presenceUidFromKey(key: string): string {
  return key.slice('presence:'.length);
}

function normalizeEntry(value: unknown): PresenceEntry | null {
  if (!isRecord(value)) return null;
  const uid = typeof value.uid === 'string' ? value.uid : '';
  const username = typeof value.username === 'string' ? value.username : '';
  const onlineAt = typeof value.online_at === 'string' ? value.online_at : '';
  const ttlMs = typeof value.ttl_ms === 'number' && value.ttl_ms > 0 ? value.ttl_ms : PRESENCE_TTL_MS;
  if (!uid || !onlineAt) return null;
  return {
    uid,
    username,
    authenticated: value.authenticated === true,
    onlineAt,
    ttlMs,
    ...(typeof value.focus === 'string' && value.focus.length <= 200 ? { focus: value.focus } : {}),
    ...(typeof value.kind === 'string' && value.kind.length <= 32 ? { kind: value.kind } : {}),
  };
}

export class Presence {
  private readonly session: RuntimeSession;
  private readonly identity: CollabIdentity;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly listeners = new Set<(snapshot: PresenceSnapshot) => void>();
  private readonly remote = new Map<string, PresenceEntry>();
  private readonly agentUids: ReadonlySet<string>;
  private revision = 0;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private focus?: string;
  private closed = false;

  constructor(session: RuntimeSession, options: { heartbeatMs?: number; ttlMs?: number; agentUids?: ReadonlySet<string> } = {}) {
    this.session = session;
    this.identity = session.identity;
    this.heartbeatMs = options.heartbeatMs ?? PRESENCE_HEARTBEAT_MS;
    this.ttlMs = options.ttlMs ?? PRESENCE_TTL_MS;
    this.agentUids = options.agentUids ?? new Set();
  }

  self(): PresenceEntry {
    return {
      uid: this.identity.uid,
      username: this.identity.username,
      authenticated: this.identity.authenticated,
      onlineAt: new Date().toISOString(),
      ttlMs: this.ttlMs,
      ...(this.focus ? { focus: this.focus } : {}),
    };
  }

  private serialize(entry: PresenceEntry): Record<string, unknown> {
    return {
      uid: entry.uid,
      username: entry.username,
      authenticated: entry.authenticated,
      online_at: entry.onlineAt,
      ttl_ms: entry.ttlMs,
      ...(entry.focus ? { focus: entry.focus } : {}),
      ...(entry.kind ? { kind: entry.kind } : {}),
    };
  }

  /**
   * Publish focus metadata (e.g. "notes:w-1") and beat immediately — typing
   * indicators are only useful when they are not a heartbeat behind.
   */
  setFocus(focus: string | undefined): void {
    this.focus = focus && focus.length <= 200 ? focus : undefined;
    if (this.started) void this.beat();
  }

  async start(): Promise<void> {
    // Discover existing presence docs once; the event stream keeps them fresh.
    const list = await this.session.stateList();
    await Promise.all(
      list.refs
        .filter((ref) => ref.namespace === PRESENCE_NAMESPACE && isPresenceKey(ref.key))
        .map(async (ref) => {
          const doc = await this.session.stateGet(ref.namespace, ref.key);
          const entry = normalizeEntry(doc.value);
          if (entry && entry.uid !== this.identity.uid) this.remote.set(entry.uid, entry);
        }),
    );
    await this.beat();
    this.started = true;
    this.timer = setInterval(() => void this.beat(), this.heartbeatMs);
    this.notify();
  }

  private async beat(): Promise<void> {
    if (this.closed) return;
    try {
      const doc = await this.session.stateGet(PRESENCE_NAMESPACE, presenceKey(this.identity));
      const result = await this.session.statePut(
        PRESENCE_NAMESPACE, presenceKey(this.identity), doc.revision, this.serialize(this.self()),
      );
      this.revision = result.state.revision;
    } catch (error) {
      // Conflict on our own key means another tab holds it — retry next beat.
      if (!(error instanceof Error && /conflict/i.test(error.message))) throw error;
    }
  }

  /** Feed a runtime event (state.updated) into the presence map. */
  async onStateEvent(namespace: string, key: string): Promise<boolean> {
    if (namespace !== PRESENCE_NAMESPACE || !isPresenceKey(key)) return false;
    const uid = presenceUidFromKey(key);
    if (uid === this.identity.uid) return true;
    const doc = await this.session.stateGet(PRESENCE_NAMESPACE, key);
    const entry = normalizeEntry(doc.value);
    if (entry) {
      this.remote.set(entry.uid, entry);
      this.notify();
    }
    return true;
  }

  onChange(handler: (snapshot: PresenceSnapshot) => void): () => void {
    this.listeners.add(handler);
    handler(this.snapshot());
    return () => this.listeners.delete(handler);
  }

  snapshot(): PresenceSnapshot {
    const now = Date.now();
    const entries = [...this.remote.values()]
      .filter((entry) => now - Date.parse(entry.onlineAt) <= entry.ttlMs)
      .sort((a, b) => a.username.localeCompare(b.username));
    return { entries, self: this.self() };
  }

  /**
   * Live page actors including self, for leader election and badges.
   * Agents are colleagues, not leaders: entries marked kind 'agent' or
   * matching a manifest-declared agent uid must never become leader — only
   * pages may apply shared-doc mutations.
   */
  liveUids(): string[] {
    return [this.identity.uid, ...this.snapshot().entries
      .filter((entry) => entry.kind !== 'agent' && !this.agentUids.has(entry.uid))
      .map((entry) => entry.uid)];
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
    this.remote.clear();
  }
}
