import {
  BRIDGE_READY_TYPE,
  CONTEXT_REQUEST_TYPE,
  HOST_CONNECT_TYPE,
  RESULT_REQUEST_TYPE,
  RUNTIME_EVENT_TYPE,
  RUNTIME_RESPONSE_TYPE,
  TASK_ACCEPTED_TYPE,
  TASK_REJECTED_TYPE,
  TASK_STATUS_TYPE,
  buildContextResponse,
  buildResultResponse,
  buildRuntimeRequest,
  buildTaskRequest,
  newRequestId,
  normalizeContextRequest,
  normalizeResultRequest,
  normalizeRuntimeEventMessage,
  normalizeRuntimeResponse,
  normalizeRuntimeStateDoc,
  normalizeTaskAccepted,
  normalizeTaskRejected,
  normalizeTaskStatusMessage,
  type ArtifactPageContext,
  type CollabIdentity,
  type ResultReceipt,
  type RuntimeEvent,
  type RuntimeOperation,
  type RuntimeStateDoc,
  type RuntimeStateRef,
  type TaskCreated,
  type TaskRejectedMessage,
  type TaskStatusUpdate,
} from '@artifact-ax/contract';
import { answerFrameBridge, createChannel, type ChannelOptions, type MultiplexedChannel } from './channel.js';
import type {
  ConnectResult,
  PutResult,
  RuntimeSession,
  StateListResult,
  Unsubscribe,
} from './types.js';

const REQUEST_TIMEOUT_MS = 5000;

export interface SessionOptions extends ChannelOptions {
  identity: CollabIdentity;
  /** Announce bridge.ready and wait for host.connect (tasks need it). */
  awaitHostConnect?: boolean;
  hostConnectTimeoutMs?: number;
  /** Injectable caller — the mock host wires its own. */
  caller?: (channel: MultiplexedChannel) => (message: unknown) => void;
}

class PendingRequests {
  private readonly pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }>();

  register(requestId: string, resolve: (v: Record<string, unknown>) => void, reject: (e: Error) => void): void {
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      reject(new Error(`runtime request timed out: ${requestId}`));
    }, REQUEST_TIMEOUT_MS);
    this.pending.set(requestId, { resolve, timer });
  }

  resolve(requestId: string, response: Record<string, unknown>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(response);
    return true;
  }

  clear(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}

class ClientRuntimeSession implements RuntimeSession {
  readonly identity: CollabIdentity;
  hostConnected = false;
  private readonly channel: MultiplexedChannel;
  private readonly pending = new PendingRequests();
  private readonly eventHandlers = new Set<(event: RuntimeEvent) => void>();
  private readonly taskStatusHandlers = new Set<(status: TaskStatusUpdate) => void>();
  private readonly taskRejectedHandlers = new Set<(rejected: TaskRejectedMessage) => void>();
  private readonly taskWaiters = new Map<string, { resolve: (t: TaskCreated) => void; reject: (e: Error) => void }>();
  private pageContextHandler: (() => ArtifactPageContext | null) | null = null;
  private resultHandler: ((request: import('@artifact-ax/contract').ResultRequestMessage) => Promise<ResultReceipt> | ResultReceipt) | null = null;
  private offChannel: Unsubscribe;
  private closed = false;

  constructor(channel: MultiplexedChannel, identity: CollabIdentity) {
    this.channel = channel;
    this.identity = identity;
    this.offChannel = channel.onMessage((message) => this.dispatch(message));
  }

  private dispatch(message: unknown): void {
    if (this.closed || !message || typeof message !== 'object') return;
    const type = (message as Record<string, unknown>).type;

    if (type === RUNTIME_RESPONSE_TYPE) {
      const response = normalizeRuntimeResponse(message);
      if (response) this.pending.resolve(response.request_id, response.response);
      return;
    }
    if (type === RUNTIME_EVENT_TYPE) {
      const event = normalizeRuntimeEventMessage(message);
      if (event) for (const handler of [...this.eventHandlers]) handler(event.event);
      return;
    }
    if (type === TASK_STATUS_TYPE) {
      const status = normalizeTaskStatusMessage(message);
      if (status) for (const handler of [...this.taskStatusHandlers]) handler(status.task);
      return;
    }
    if (type === TASK_ACCEPTED_TYPE) {
      const accepted = normalizeTaskAccepted(message);
      const waiter = accepted && this.taskWaiters.get(accepted.request_id);
      if (accepted && waiter) {
        this.taskWaiters.delete(accepted.request_id);
        waiter.resolve(accepted.task);
      }
      return;
    }
    if (type === TASK_REJECTED_TYPE) {
      const rejected = normalizeTaskRejected(message);
      const waiter = rejected && this.taskWaiters.get(rejected.request_id);
      if (rejected && waiter) {
        this.taskWaiters.delete(rejected.request_id);
        waiter.reject(new Error(rejected.message ?? rejected.code ?? 'task rejected'));
      }
      if (rejected) for (const handler of [...this.taskRejectedHandlers]) handler(rejected);
      return;
    }
    if (type === HOST_CONNECT_TYPE) {
      this.hostConnected = true;
      return;
    }
    if (type === CONTEXT_REQUEST_TYPE) {
      const request = normalizeContextRequest(message);
      const context = request && this.pageContextHandler ? this.pageContextHandler() : null;
      if (request && context) {
        this.channel.send(buildContextResponse(request.request_id, context));
      }
      return;
    }
    if (type === RESULT_REQUEST_TYPE) {
      const request = normalizeResultRequest(message);
      if (!request) return;
      void Promise.resolve()
        .then(() => (this.resultHandler
          ? this.resultHandler(request)
          : {
              contract_version: 'catsco.artifact-result-receipt.v1' as const,
              result_id: request.result.result_id,
              status: 'failed' as const,
              code: 'no_result_handler',
            }))
        .then((receipt) => this.channel.send(buildResultResponse(request.request_id, receipt)))
        .catch(() => {
          this.channel.send(buildResultResponse(request.request_id, {
            contract_version: 'catsco.artifact-result-receipt.v1',
            result_id: request.result.result_id,
            status: 'failed',
            code: 'result_handler_error',
          }));
        });
      return;
    }
  }

  private call(operation: RuntimeOperation, payload?: unknown): Promise<Record<string, unknown>> {
    const requestId = newRequestId('rt');
    return new Promise((resolve, reject) => {
      this.pending.register(requestId, (response) => {
        if (response.ok === true) {
          resolve(response);
        } else {
          const error = response.error as Record<string, unknown> | undefined;
          reject(new Error(String(error?.message ?? `runtime ${operation} failed`)));
        }
      }, reject);
      this.channel.send(buildRuntimeRequest(requestId, operation, payload));
    });
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
    const refs = Array.isArray(response.state_refs) ? (response.state_refs as RuntimeStateRef[]) : [];
    return { refs, truncated: response.truncated === true };
  }

  async statePut(namespace: string, key: string, baseRevision: number, value: unknown): Promise<PutResult> {
    const response = await this.call('state.put', {
      namespace, key, base_revision: baseRevision, value,
    });
    const state = normalizeRuntimeStateDoc(response.state);
    if (!state) throw new Error('runtime state.put returned an invalid state document');
    return { state, event: response.event as RuntimeEvent | undefined };
  }

  async statePatch(namespace: string, key: string, baseRevision: number, patch: unknown[]): Promise<PutResult> {
    const response = await this.call('state.patch', {
      namespace, key, base_revision: baseRevision, patch,
    });
    const state = normalizeRuntimeStateDoc(response.state);
    if (!state) throw new Error('runtime state.patch returned an invalid state document');
    return { state, event: response.event as RuntimeEvent | undefined };
  }

  async eventsSubscribe(handler: (event: RuntimeEvent) => void, afterEventId = 0): Promise<Unsubscribe> {
    this.eventHandlers.add(handler);
    await this.call('events.subscribe', { after_event_id: afterEventId });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.eventHandlers.delete(handler);
      if (this.eventHandlers.size === 0) {
        void this.call('events.unsubscribe').catch(() => {});
      }
    };
  }

  taskSubmit(intentId: string, payload: unknown): Promise<TaskCreated> {
    const requestId = newRequestId('task');
    return new Promise((resolve, reject) => {
      this.taskWaiters.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (this.taskWaiters.delete(requestId)) {
          reject(new Error('task submit timed out'));
        }
      }, REQUEST_TIMEOUT_MS);
      this.channel.send(buildTaskRequest(requestId, intentId, payload));
    });
  }

  onTaskStatus(handler: (status: TaskStatusUpdate) => void): Unsubscribe {
    this.taskStatusHandlers.add(handler);
    return () => this.taskStatusHandlers.delete(handler);
  }

  onTaskRejected(handler: (rejected: TaskRejectedMessage) => void): Unsubscribe {
    this.taskRejectedHandlers.add(handler);
    return () => this.taskRejectedHandlers.delete(handler);
  }

  servePageContext(handler: () => ArtifactPageContext | null): void {
    this.pageContextHandler = handler;
  }

  serveResult(handler: (request: import('@artifact-ax/contract').ResultRequestMessage) => Promise<ResultReceipt> | ResultReceipt): void {
    this.resultHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offChannel();
    this.pending.clear();
    this.eventHandlers.clear();
    this.taskStatusHandlers.clear();
    this.taskRejectedHandlers.clear();
    this.channel.close();
  }
}

/**
 * Open a runtime session on a multiplexed channel: answer the opaque
 * frame-bridge handshake when a nonce exists, announce bridge.ready, and wait
 * briefly for host.connect. Standalone pages resolve immediately with
 * hostConnected=false and a session whose calls will simply time out — the
 * app uses the mock host instead.
 */
export async function openRuntimeSession(options: SessionOptions): Promise<ClientRuntimeSession> {
  const channel = createChannel(options);
  const session = new ClientRuntimeSession(channel, options.identity);
  await answerFrameBridge(channel);
  if (options.awaitHostConnect !== false) {
    channel.send({ type: BRIDGE_READY_TYPE });
    const deadline = Date.now() + (options.hostConnectTimeoutMs ?? 1500);
    while (!session.hostConnected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  return session;
}
