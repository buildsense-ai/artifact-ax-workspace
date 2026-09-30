import {
  RUNTIME_EVENT_CONTRACT_V2,
  RUNTIME_MAX_PAYLOAD_BYTES,
  RUNTIME_PATCH_MAX_OPS,
  RUNTIME_STATE_CONTRACT,
  TASK_REF_CONTRACT,
  isRuntimeKey,
  isRuntimeName,
  newRequestId,
  type ArtifactPageContext,
  type CollabIdentity,
  type ResultReceipt,
  type ResultRequestMessage,
  type RuntimeEvent,
  type RuntimeStateDoc,
  type RuntimeStateRef,
  type TaskCreated,
  type TaskRejectedMessage,
  type TaskStatusUpdate,
} from '@artifact-ax/contract';
import type {
  ConnectResult,
  PutResult,
  RuntimeSession,
  StateListResult,
  Unsubscribe,
} from './types.js';

/**
 * In-memory mock of the platform runtime for local development (`?mock=1`).
 *
 * Each tab keeps its own store and replicates writes over BroadcastChannel,
 * so two browser windows pointed at the same `room` collaborate for real.
 * Ordering is a lamport clock per document — approximate, not the platform's
 * transaction-serialized CAS. That is honest enough for a dev surface and is
 * documented as such; production ordering comes from the gateway store.
 */

interface StoredDoc {
  namespace: string;
  key: string;
  value: unknown;
  revision: number;
  updatedBy: string;
  updatedByUid: string;
  updatedAt: string;
}

interface WireDoc extends StoredDoc {
  kind: 'state';
  writer: string;
  lamport: number;
}

interface WireEvent {
  kind: 'event';
  event: RuntimeEvent;
}

/** New store announcing itself; live stores answer with a `dump`. */
interface WireHello {
  kind: 'hello';
  writer: string;
}

/** Full state snapshot handed to a joining store. */
interface WireDump {
  kind: 'dump';
  from: string;
  docs: WireDoc[];
}

type WireMessage = WireDoc | WireEvent | WireHello | WireDump;

export interface MockSessionOptions {
  identity: CollabIdentity;
  /** Room isolates collaboration groups; maps onto BroadcastChannel name. */
  room?: string;
  artifactId?: string;
  /**
   * Simulated agent: called after a task is accepted; may write result docs.
   * Receives the intent id + submitted input — a real agent sees exactly
   * these through the platform's task input.
   */
  agent?: (task: TaskCreated, input: { intentId: string; payload: unknown }, session: RuntimeSession) => void;
  /**
   * Reactive wake: forward the room event stream to the agent session —
   * whether a real bot may subscribe is a platform open question, but the
   * colleague loop needs it in mock mode to be more than a task responder.
   */
  agentEvents?: (event: RuntimeEvent, session: RuntimeSession) => void;
  broadcast?: BroadcastChannel | null;
}

class MockStore {
  private readonly docs = new Map<string, StoredDoc>();
  private readonly events: RuntimeEvent[] = [];
  private lamport = 0;
  private lamportEvent = 0;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private bc: BroadcastChannel | null = null;
  readonly writerId = newRequestId('mock');

  constructor(channelName: string | null) {
    if (channelName && typeof BroadcastChannel !== 'undefined') {
      this.bc = new BroadcastChannel(channelName);
      this.bc.onmessage = (event: MessageEvent<WireMessage>) => this.receive(event.data);
      // Announce to already-open tabs; they reply with a state dump so a
      // late joiner starts from the room's actual history, not empty.
      this.broadcast({ kind: 'hello', writer: this.writerId });
    }
  }

  private docId(namespace: string, key: string): string {
    return `${namespace}/${key}`;
  }

  private tick(): number {
    this.lamport += 1;
    return this.lamport;
  }

  get(namespace: string, key: string): RuntimeStateDoc {
    const doc = this.docs.get(this.docId(namespace, key));
    if (!doc) {
      return {
        contract_version: RUNTIME_STATE_CONTRACT,
        exists: false, namespace, key, revision: 0,
      };
    }
    return this.toDoc(doc);
  }

  private toDoc(doc: StoredDoc): RuntimeStateDoc {
    return {
      contract_version: RUNTIME_STATE_CONTRACT,
      exists: true,
      namespace: doc.namespace,
      key: doc.key,
      revision: doc.revision,
      updated_at: doc.updatedAt,
      updated_by: doc.updatedBy,
      updated_by_uid: doc.updatedByUid,
      value: doc.value,
    };
  }

  list(): RuntimeStateRef[] {
    return [...this.docs.values()].map((doc) => ({
      namespace: doc.namespace,
      key: doc.key,
      revision: doc.revision,
      updated_at: doc.updatedAt,
    }));
  }

  put(namespace: string, key: string, baseRevision: number, value: unknown, by: CollabIdentity): PutResult {
    if (!isRuntimeName(namespace) || !isRuntimeKey(key)) {
      throw new Error('invalid_state_key');
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined || new TextEncoder().encode(encoded).length > RUNTIME_MAX_PAYLOAD_BYTES) {
      throw new Error('invalid_state_value');
    }
    const id = this.docId(namespace, key);
    const current = this.docs.get(id);
    const currentRevision = current?.revision ?? 0;
    if (baseRevision !== currentRevision) {
      const error = new Error('revision_conflict') as Error & { code: string; currentRevision: number };
      error.code = 'revision_conflict';
      error.currentRevision = currentRevision;
      throw error;
    }
    const revision = this.tick();
    const doc: StoredDoc = {
      namespace, key,
      value: JSON.parse(encoded),
      revision,
      updatedBy: by.username,
      updatedByUid: by.uid,
      updatedAt: new Date().toISOString(),
    };
    this.docs.set(id, doc);
    this.broadcast({ kind: 'state', writer: this.writerId, lamport: revision, ...doc });
    const event = this.emit('state.updated', { namespace, key, revision }, by);
    return { state: this.toDoc(doc), event };
  }

  private emit(type: string, data: Record<string, unknown>, by: CollabIdentity): RuntimeEvent {
    this.lamportEvent += 1;
    const event: RuntimeEvent = {
      contract_version: RUNTIME_EVENT_CONTRACT_V2,
      event_id: this.lamportEvent,
      type,
      namespace: typeof data.namespace === 'string' ? data.namespace : undefined,
      key: typeof data.key === 'string' ? data.key : undefined,
      revision: typeof data.revision === 'number' ? data.revision : undefined,
      updated_by: by.username,
      created_at: new Date().toISOString(),
      data: { ...data },
    };
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();
    this.broadcast({ kind: 'event', event });
    for (const listener of [...this.listeners]) listener(event);
    return event;
  }

  /** Emit a non-state event (task/run markers) — mock-side only. */
  emitMarker(type: string, data: Record<string, unknown>, by: CollabIdentity): RuntimeEvent {
    return this.emit(type, data, by);
  }

  subscribe(handler: (event: RuntimeEvent) => void, afterEventId: number): Unsubscribe {
    const replay = this.events.filter((event) => event.event_id > afterEventId);
    for (const event of replay) handler(event);
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  latestEventId(): number {
    return this.lamportEvent;
  }

  private broadcast(message: WireMessage): void {
    try {
      this.bc?.postMessage(message);
    } catch {
      // BroadcastChannel quota or closed channel — the local store stays truth.
    }
  }

  /** Merge a remote doc (wire write or dump entry); returns true if it won. */
  private mergeRemoteDoc(remote: WireDoc): boolean {
    this.lamport = Math.max(this.lamport, remote.lamport);
    const id = this.docId(remote.namespace, remote.key);
    const local = this.docs.get(id);
    // Last-writer-wins on (lamport, writer) — deterministic across tabs.
    if (local && (local.revision > remote.lamport
      || (local.revision === remote.lamport && this.writerId > remote.writer))) return false;
    this.docs.set(id, {
      namespace: remote.namespace,
      key: remote.key,
      value: remote.value,
      revision: remote.lamport,
      updatedBy: remote.updatedBy,
      updatedByUid: remote.updatedByUid,
      updatedAt: remote.updatedAt,
    });
    return true;
  }

  /** Notify subscribers of a doc that arrived out-of-band (join dump). */
  private emitLocalStateUpdated(doc: StoredDoc): void {
    const event: RuntimeEvent = {
      contract_version: RUNTIME_EVENT_CONTRACT_V2,
      event_id: -1,
      type: 'state.updated',
      namespace: doc.namespace,
      key: doc.key,
      revision: doc.revision,
      updated_by: doc.updatedBy,
      created_at: doc.updatedAt,
      data: { namespace: doc.namespace, key: doc.key, revision: doc.revision },
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  private receive(message: WireMessage): void {
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'hello') {
      const hello = message as WireHello;
      if (hello.writer === this.writerId) return;
      const docs: WireDoc[] = [...this.docs.values()].map((doc) => ({
        kind: 'state', writer: this.writerId, lamport: doc.revision, ...doc,
      }));
      if (docs.length > 0) this.broadcast({ kind: 'dump', from: this.writerId, docs });
      return;
    }
    if (message.kind === 'dump') {
      const dump = message as WireDump;
      if (dump.from === this.writerId) return;
      for (const remote of dump.docs) {
        if (this.mergeRemoteDoc(remote)) {
          const stored = this.docs.get(this.docId(remote.namespace, remote.key));
          if (stored) this.emitLocalStateUpdated(stored);
        }
      }
      return;
    }
    if (message.kind === 'state') {
      const remote = message as WireDoc & { kind: 'state' };
      if (remote.writer === this.writerId) return;
      if (this.mergeRemoteDoc(remote)) {
        // On the platform every committed write produces an event for all
        // viewers — mirror that: a winning remote doc notifies subscribers.
        const stored = this.docs.get(this.docId(remote.namespace, remote.key));
        if (stored) this.emitLocalStateUpdated(stored);
      }
      return;
    }
    if (message.kind === 'event') {
      const remote = (message as WireEvent).event;
      this.lamportEvent = Math.max(this.lamportEvent, remote.event_id);
      // Dedup on (event_id, updated_by, created_at): two tabs can emit the
      // same lamport event id inside one millisecond — id+timestamp alone
      // collides and silently drops a real event.
      if (this.events.some((event) => event.event_id === remote.event_id
        && event.updated_by === remote.updated_by && event.created_at === remote.created_at)) return;
      this.events.push(remote);
      this.events.sort((a, b) => a.event_id - b.event_id);
      if (this.events.length > 500) this.events.shift();
      for (const listener of [...this.listeners]) listener(remote);
    }
  }

  close(): void {
    try {
      this.bc?.close();
    } catch {
      // Already closed.
    }
    this.listeners.clear();
  }
}

/** The mock agent writes under its own identity — own presence, journal, notes. */
export const MOCK_AGENT_IDENTITY: CollabIdentity = {
  uid: 'bot-mock-agent',
  username: 'agent-bot',
  authenticated: true,
};

class MockRuntimeSession implements RuntimeSession {
  readonly identity: CollabIdentity;
  readonly hostConnected = true;
  private readonly store: MockStore;
  private readonly artifactId: string;
  private readonly agent?: (task: TaskCreated, input: { intentId: string; payload: unknown }, session: RuntimeSession) => void;
  private agentSession: RuntimeSession = this;

  /** Attach the sibling session the mock agent writes under. */
  setAgentSession(session: RuntimeSession): void {
    this.agentSession = session;
  }
  private readonly taskStatusHandlers = new Set<(status: TaskStatusUpdate) => void>();
  private readonly taskRejectedHandlers = new Set<(rejected: TaskRejectedMessage) => void>();
  private closed = false;

  constructor(options: MockSessionOptions, store: MockStore) {
    this.identity = options.identity;
    this.store = store;
    this.artifactId = options.artifactId ?? 'lesson-report';
    this.agent = options.agent;
  }

  async connect(): Promise<ConnectResult> {
    return {
      artifact: { id: this.artifactId, currently_visible: true, kind: 'html' },
      runtime: {
        version: '0.2',
        surfaces: [{ id: 'report' }, { id: 'workboard' }],
        state: [
          { namespace: 'shared', mode: 'read-write' },
          { namespace: 'presence', mode: 'read-write' },
          { namespace: 'semantic', mode: 'read-write' },
          { namespace: 'journal', mode: 'read-write' },
          { namespace: 'result', mode: 'read-write' },
          { namespace: 'agent', mode: 'read-write' },
        ],
        agent_participants: [{ uid: MOCK_AGENT_IDENTITY.uid, name: MOCK_AGENT_IDENTITY.username, kind: 'agent' }],
      },
      event_cursor: this.store.latestEventId(),
      runs: [],
    };
  }

  async stateGet(namespace: string, key: string): Promise<RuntimeStateDoc> {
    return this.store.get(namespace, key);
  }

  async stateList(): Promise<StateListResult> {
    return { refs: this.store.list(), truncated: false };
  }

  async statePut(namespace: string, key: string, baseRevision: number, value: unknown): Promise<PutResult> {
    return this.store.put(namespace, key, baseRevision, value, this.identity);
  }

  async statePatch(namespace: string, key: string, baseRevision: number, patch: unknown[]): Promise<PutResult> {
    if (!Array.isArray(patch) || patch.length === 0 || patch.length > RUNTIME_PATCH_MAX_OPS) {
      throw new Error('invalid_state_patch');
    }
    const current = this.store.get(namespace, key);
    if (!current.exists || current.revision !== baseRevision) {
      const error = new Error('revision_conflict') as Error & { code: string };
      error.code = 'revision_conflict';
      throw error;
    }
    const next = JSON.parse(JSON.stringify(current.value ?? {}));
    // Minimal JSON-merge patch semantics for the mock: set/delete by path.
    for (const op of patch) {
      const o = op as { op?: string; path?: string; value?: unknown };
      if (typeof o.path !== 'string' || !o.path.startsWith('/')) throw new Error('invalid_state_patch');
      const segments = o.path.slice(1).split('/');
      let node: Record<string, unknown> = next;
      for (const segment of segments.slice(0, -1)) {
        const child = node[segment];
        if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error('invalid_state_patch');
        node = child as Record<string, unknown>;
      }
      const last = segments[segments.length - 1];
      if (last === undefined) throw new Error('invalid_state_patch');
      if (o.op === 'remove') delete node[last];
      else if (o.op === 'add' || o.op === 'replace') node[last] = o.value;
      else throw new Error('invalid_state_patch');
    }
    return this.statePut(namespace, key, baseRevision, next);
  }

  async eventsSubscribe(handler: (event: RuntimeEvent) => void, afterEventId = 0): Promise<Unsubscribe> {
    return this.store.subscribe(handler, afterEventId);
  }

  async taskSubmit(intentId: string, payload: unknown): Promise<TaskCreated> {
    const suffix = '0'.repeat(43).split('').map((_, i) => ((Date.now() + i) % 36).toString(36)).join('');
    const task: TaskCreated = {
      contract_version: TASK_REF_CONTRACT,
      task_id: `atk_${suffix}`,
      task_ref: `atr_${suffix}`,
      status: 'submitted',
      visible_message: `Mock agent accepted ${intentId}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const emit = (status: TaskStatusUpdate['status']) => {
      const update: TaskStatusUpdate = {
        contract_version: 'catsco.artifact-task-status.v1',
        task_id: task.task_id,
        status,
        updated_at: new Date().toISOString(),
      };
      for (const handler of [...this.taskStatusHandlers]) handler(update);
    };
    setTimeout(() => emit('running'), 120);
    setTimeout(() => {
      emit('completed');
      if (this.agent) {
        try {
          this.agent(task, { intentId, payload }, this.agentSession);
        } catch {
          // A broken mock agent must not break the session.
        }
      }
    }, 400);
    return task;
  }

  onTaskStatus(handler: (status: TaskStatusUpdate) => void): Unsubscribe {
    this.taskStatusHandlers.add(handler);
    return () => this.taskStatusHandlers.delete(handler);
  }

  onTaskRejected(handler: (rejected: TaskRejectedMessage) => void): Unsubscribe {
    this.taskRejectedHandlers.add(handler);
    return () => this.taskRejectedHandlers.delete(handler);
  }

  servePageContext(_handler: () => ArtifactPageContext | null): void {
    // The mock host never OBSERVEs; kept for interface parity.
  }

  serveResult(_handler: (request: ResultRequestMessage) => Promise<ResultReceipt> | ResultReceipt): void {
    // The mock host never delivers result sinks.
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
  }
}

export function createMockSession(options: MockSessionOptions): RuntimeSession {
  const room = (options.room ?? 'default').replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 64) || 'default';
  const channelName = `artifact-ax-mock:${options.artifactId ?? 'lesson-report'}:${room}`;
  const store = new MockStore(channelName);
  const session = new MockRuntimeSession(options, store);
  if (options.agent) {
    // The agent gets a sibling session on the same store — distinct identity,
    // so presence/journal/state writes are attributed to it like a real
    // colleague, not to the page's visitor.
    const agentSession = new MockRuntimeSession(
      { identity: MOCK_AGENT_IDENTITY, artifactId: options.artifactId },
      store,
    );
    session.setAgentSession(agentSession);
    if (options.agentEvents) {
      // Synchronous store subscription — not the async eventsSubscribe
      // wrapper — so no event can be lost between session creation and
      // subscription completing. A real bot has a durable subscription;
      // the mock should behave the same way.
      store.subscribe((event) => options.agentEvents?.(event, agentSession), 0);
    }
  }
  return session;
}
