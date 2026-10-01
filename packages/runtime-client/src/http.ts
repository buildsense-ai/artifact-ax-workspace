/**
 * HTTP runtime session — the standalone-deploy transport.
 *
 * When the page is served directly from the artifact origin (no embedding
 * host, no frame bridge), runtime calls ride same-origin `api/runtime/*`
 * endpoints on the app's own backend, which forwards them to the artifact
 * gateway with the app-scoped credential. This is the same pattern as the
 * `api/whoami` viewer lookup: the browser never holds a gateway secret.
 *
 * Wire contract (implemented by the app backend, e.g. the connector host):
 *
 *   POST api/runtime/connect                  → {artifact, runtime, event_cursor, runs?}
 *   POST api/runtime/state.get   {ns,key}     → {state}
 *   POST api/runtime/state.list              → {state_refs, truncated}
 *   POST api/runtime/state.put   {ns,key,base_revision,value} → {state, event?}
 *   POST api/runtime/state.patch {ns,key,base_revision,patch} → {state, event?}
 *   GET  api/runtime/events?after=<cursor>   → {events: RuntimeEvent[], cursor}
 *       long-poll; backend may inject `{type:'task.status', task:{...}}`
 *       and `{type:'task.rejected', rejected:{...}}` pseudo-events.
 *   POST api/runtime/task.submit {intent_id, payload} → {task} or 4xx {code,message}
 *   GET  api/whoami                           → catsco.artifact-viewer.v1 (identity.ts)
 *
 * Missing backend → the caller falls back to the mock session.
 */

import {
  normalizeRuntimeStateDoc,
  type ArtifactPageContext,
  type CollabIdentity,
  type ResultReceipt,
  type ResultRequestMessage,
  type RuntimeEvent,
  type RuntimeStateDoc,
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

const EVENT_POLL_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_500;

export interface HttpSessionOptions {
  identity: CollabIdentity;
  /** Same-origin base path for the runtime bridge, default 'api/runtime'. */
  base?: string;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export class HttpRuntimeSession implements RuntimeSession {
  readonly identity: CollabIdentity;
  /** From the page's perspective the backend bridge IS the host. */
  hostConnected = true;
  private readonly base: string;
  private readonly eventHandlers = new Set<(event: RuntimeEvent) => void>();
  private readonly taskStatusHandlers = new Set<(status: TaskStatusUpdate) => void>();
  private readonly taskRejectedHandlers = new Set<(rejected: TaskRejectedMessage) => void>();
  private closed = false;

  constructor(options: HttpSessionOptions) {
    this.identity = options.identity;
    this.base = (options.base ?? 'api/runtime').replace(/\/+$/, '');
  }

  private async call(operation: string, payload?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response: FetchResponse = await fetch(`${this.base}/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
        throw new Error(body?.message ?? body?.code ?? `runtime ${operation} failed (${response.status})`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (body.ok === false) {
        const error = body.error as { code?: string; message?: string } | undefined;
        throw new Error(error?.message ?? error?.code ?? `runtime ${operation} failed`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async connect(): Promise<ConnectResult> {
    const response = await this.call('connect');
    return {
      artifact: (response.artifact as Record<string, unknown>) ?? {},
      runtime: (response.runtime as ConnectResult['runtime']) ?? {},
      event_cursor: Number(response.event_cursor ?? 0),
      ...(Array.isArray(response.runs) ? { runs: response.runs } : {}),
    };
  }

  async stateGet(namespace: string, key: string): Promise<RuntimeStateDoc> {
    const response = await this.call('state.get', { namespace, key });
    const doc = normalizeRuntimeStateDoc(response.state);
    if (!doc) throw new Error('runtime state.get returned an invalid state document');
    return doc;
  }

  async stateList(): Promise<StateListResult> {
    const response = await this.call('state.list');
    return {
      refs: Array.isArray(response.state_refs) ? (response.state_refs as StateListResult['refs']) : [],
      truncated: response.truncated === true,
    };
  }

  async statePut(namespace: string, key: string, baseRevision: number, value: unknown): Promise<PutResult> {
    const response = await this.call('state.put', { namespace, key, base_revision: baseRevision, value });
    const state = normalizeRuntimeStateDoc(response.state);
    if (!state) throw new Error('runtime state.put returned an invalid state document');
    return { state, event: response.event as RuntimeEvent | undefined };
  }

  async statePatch(namespace: string, key: string, baseRevision: number, patch: unknown[]): Promise<PutResult> {
    const response = await this.call('state.patch', { namespace, key, base_revision: baseRevision, patch });
    const state = normalizeRuntimeStateDoc(response.state);
    if (!state) throw new Error('runtime state.patch returned an invalid state document');
    return { state, event: response.event as RuntimeEvent | undefined };
  }

  async eventsSubscribe(handler: (event: RuntimeEvent) => void, afterEventId = 0): Promise<Unsubscribe> {
    this.eventHandlers.add(handler);
    if (this.eventHandlers.size === 1) void this.pollEvents(afterEventId);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Long-poll the backend's event stream. The backend forwards gateway
   * runtime events verbatim and may inject task pseudo-events; transient
   * failures just retry — a dead backend makes the stream go quiet, which
   * surfaces through missing updates rather than a crash.
   */
  private async pollEvents(after: number): Promise<void> {
    let cursor = after;
    while (!this.closed && this.eventHandlers.size > 0) {
      try {
        const response = await fetch(
          `${this.base}/events?after=${cursor}&timeout=${EVENT_POLL_TIMEOUT_MS - 1000}`,
          { credentials: 'same-origin', signal: AbortSignal.timeout(EVENT_POLL_TIMEOUT_MS) },
        );
        if (!response.ok) {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          continue;
        }
        const body = (await response.json()) as { events?: RuntimeEvent[]; cursor?: number };
        for (const event of body.events ?? []) {
          // Skip replays: a backend may re-send already-cursed events.
          if (event.event_id <= cursor) continue;
          cursor = event.event_id;
          this.dispatchEvent(event);
        }
        if (typeof body.cursor === 'number' && body.cursor > cursor) cursor = body.cursor;
        // A backend that answers instantly (instead of holding the long
        // poll) would otherwise spin a hot loop — pace every iteration.
        await new Promise((resolve) => setTimeout(resolve, 30));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    }
  }

  private dispatchEvent(event: RuntimeEvent): void {
    if (event.type === 'task.status') {
      const status = (event.data ?? event) as unknown as TaskStatusUpdate | { task?: TaskStatusUpdate };
      const update = 'task' in status && status.task ? status.task : (status as TaskStatusUpdate);
      if (update?.task_id) for (const handler of [...this.taskStatusHandlers]) handler(update);
      return;
    }
    if (event.type === 'task.rejected') {
      const rejected = (event.data ?? {}) as TaskRejectedMessage;
      for (const handler of [...this.taskRejectedHandlers]) handler(rejected);
      return;
    }
    for (const handler of [...this.eventHandlers]) handler(event);
  }

  async taskSubmit(intentId: string, payload: unknown): Promise<TaskCreated> {
    const response = await this.call('task.submit', { intent_id: intentId, payload });
    const task = response.task as TaskCreated | undefined;
    if (!task?.task_id) throw new Error('runtime task.submit returned no task');
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

  /** No embedding host serves OBSERVE requests to a standalone page. */
  servePageContext(_handler: () => ArtifactPageContext | null): void {}

  /** Result delivery rides the `result:` state docs + event stream. */
  serveResult(_handler: (request: ResultRequestMessage) => Promise<ResultReceipt> | ResultReceipt): void {}

  close(): void {
    this.closed = true;
    this.eventHandlers.clear();
    this.taskStatusHandlers.clear();
    this.taskRejectedHandlers.clear();
  }
}

/**
 * Probe `api/runtime/connect` briefly; returns a live HTTP session or null.
 * Null → the deploy has no backend bridge → caller falls back to the mock.
 */
export async function openHttpSession(options: HttpSessionOptions): Promise<RuntimeSession | null> {
  const session = new HttpRuntimeSession(options);
  const connected = await Promise.race([
    session.connect().then(() => true).catch(() => false),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), PROBE_TIMEOUT_MS)),
  ]);
  if (!connected) {
    session.close();
    return null;
  }
  return session;
}
