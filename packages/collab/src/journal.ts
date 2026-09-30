import { isRecord } from '@artifact-ax/contract';
import type { CollabIdentity, RuntimeStateDoc } from '@artifact-ax/contract';
import type { RuntimeSession } from '@artifact-ax/runtime-client';

/**
 * The semantic journal — the authoritative "who did what" channel.
 *
 * Every domain mutation appends one compact entry to the actor's own
 * `journal:<uid>` document. Per-actor keys mean an actor only ever CAS-writes
 * its own document, and the platform's server-stamped `updated_by` makes the
 * claimed actor identity auditable: an entry in `journal:42` really was
 * committed by uid 42's session.
 *
 * Agents read these documents directly (state.list + state.get) or receive
 * the tail of them inside the OBSERVE semantic context. Entries are bounded
 * so the document never approaches the 300KB state limit.
 */

export const JOURNAL_NAMESPACE = 'journal' as const;
export const JOURNAL_CONTRACT = 'artifact-ax.journal.v1' as const;
export const JOURNAL_MAX_ENTRIES = 50;

export interface JournalEntry {
  seq: number;
  at: string;
  actor: { uid: string; username: string };
  /** Stable kind, e.g. 'workitem.create', 'finding.revise', 'feedback.add'. */
  kind: string;
  /** Target entity id (work item, finding, proposal, result...). */
  target?: string;
  /** One-line human/agent-readable summary of the change. */
  summary: string;
  /** Optional bounded structured detail (base revision, row ids, verdict). */
  detail?: Record<string, unknown>;
}

export interface JournalDoc {
  contract_version: typeof JOURNAL_CONTRACT;
  actor: { uid: string; username: string };
  entries: JournalEntry[];
}

export function journalKey(identity: CollabIdentity): string {
  return `journal:${identity.uid.replace(/[^A-Za-z0-9._:-]+/g, '_')}`;
}

export function isJournalKey(key: string): boolean {
  return key.startsWith('journal:');
}

export function normalizeJournalDoc(value: unknown): JournalDoc | null {
  if (!isRecord(value) || value.contract_version !== JOURNAL_CONTRACT || !isRecord(value.actor)) {
    return null;
  }
  const entries = Array.isArray(value.entries) ? value.entries.filter(isRecord) : [];
  return {
    contract_version: JOURNAL_CONTRACT,
    actor: { uid: String(value.actor.uid ?? ''), username: String(value.actor.username ?? '') },
    entries: entries.map((entry) => ({
      seq: Number(entry.seq) || 0,
      at: String(entry.at ?? ''),
      actor: isRecord(entry.actor)
        ? { uid: String(entry.actor.uid ?? ''), username: String(entry.actor.username ?? '') }
        : { uid: '', username: '' },
      kind: String(entry.kind ?? ''),
      ...(typeof entry.target === 'string' ? { target: entry.target } : {}),
      summary: String(entry.summary ?? '').slice(0, 500),
      ...(isRecord(entry.detail) ? { detail: entry.detail as Record<string, unknown> } : {}),
    })),
  };
}

export class Journal {
  private readonly session: RuntimeSession;
  private readonly identity: CollabIdentity;
  private readonly maxEntries: number;
  private seq = 0;
  private closed = false;
  /** Serializes appends: one writer, one key — no self-conflicts. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(session: RuntimeSession, options: { maxEntries?: number } = {}) {
    this.session = session;
    this.identity = session.identity;
    this.maxEntries = options.maxEntries ?? JOURNAL_MAX_ENTRIES;
  }

  /** Append one semantic event to this actor's own journal document. */
  append(entry: Omit<JournalEntry, 'seq' | 'at' | 'actor'>): Promise<JournalEntry | null> {
    const task = this.queue.then(() => this.write(entry));
    this.queue = task.catch(() => {});
    return task;
  }

  private async write(entry: Omit<JournalEntry, 'seq' | 'at' | 'actor'>): Promise<JournalEntry | null> {
    if (this.closed) return null;
    const key = journalKey(this.identity);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const stored = await this.session.stateGet(JOURNAL_NAMESPACE, key);
        const doc = normalizeJournalDoc(stored.value) ?? {
          contract_version: JOURNAL_CONTRACT,
          actor: { uid: this.identity.uid, username: this.identity.username },
          entries: [],
        };
        const nextSeq = Math.max(this.seq + 1, (doc.entries.at(-1)?.seq ?? 0) + 1);
        const appended: JournalEntry = {
          seq: nextSeq,
          at: new Date().toISOString(),
          actor: { uid: this.identity.uid, username: this.identity.username },
          kind: entry.kind.slice(0, 64),
          ...(entry.target ? { target: entry.target.slice(0, 128) } : {}),
          summary: entry.summary.slice(0, 500),
          ...(entry.detail ? { detail: entry.detail } : {}),
        };
        const nextDoc: JournalDoc = {
          ...doc,
          entries: [...doc.entries, appended].slice(-this.maxEntries),
        };
        await this.session.statePut(JOURNAL_NAMESPACE, key, stored.revision, nextDoc);
        this.seq = nextSeq;
        return appended;
      } catch (error) {
        const conflict = error instanceof Error && /conflict/i.test(error.message);
        if (!conflict || attempt === 2) throw error;
      }
    }
    return null;
  }

  /**
   * Read every actor journal in the room and return merged, ordered entries.
   * Ordering is per-actor seq then timestamp — cross-actor order is
   * approximate, which is documented and sufficient for "what happened".
   */
  static async readAll(session: RuntimeSession): Promise<JournalEntry[]> {
    const list = await session.stateList();
    const docs = await Promise.all(
      list.refs
        .filter((ref) => ref.namespace === JOURNAL_NAMESPACE && isJournalKey(ref.key))
        .map((ref) => session.stateGet(ref.namespace, ref.key)),
    );
    const entries = docs
      .map((doc: RuntimeStateDoc) => normalizeJournalDoc(doc.value))
      .flatMap((doc) => (doc ? doc.entries : []));
    return entries.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq || a.actor.uid.localeCompare(b.actor.uid));
  }

  close(): void {
    this.closed = true;
  }
}
