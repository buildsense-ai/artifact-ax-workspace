import type {
  AgentParticipant,
  ArtifactPageContext,
  CollabIdentity,
  ResultRequestMessage,
  ResultReceipt,
  RuntimeEvent,
  RuntimeOperation,
  RuntimeStateDoc,
  RuntimeStateRef,
  TaskCreated,
  TaskRejectedMessage,
  TaskStatusUpdate,
} from '@artifact-ax/contract';

/**
 * Transport seam between the Artifact page and the embedding host. One
 * channel carries every envelope type; concrete channels are the window
 * postMessage pair (cross-origin frames) and the bridge MessagePort (opaque
 * managed frames). The client never assumes which one the host prefers — it
 * listens on both and answers on the channel a request arrived on.
 */
export interface RuntimeChannel {
  /** Send one envelope toward the host. */
  send(message: unknown): void;
  /** Subscribe to every inbound envelope; returns an unsubscribe. */
  onMessage(handler: (message: unknown) => void): () => void;
  /** Release the channel. */
  close(): void;
}

/** Low-level request/response for one runtime operation. */
export interface RuntimeCaller {
  call(operation: RuntimeOperation, payload?: unknown): Promise<Record<string, unknown>>;
}

export interface ConnectResult {
  artifact: Record<string, unknown>;
  runtime: {
    version?: string;
    surfaces?: unknown[];
    state?: Array<{ namespace: string; mode: string }>;
    agent_participants?: AgentParticipant[];
  };
  event_cursor: number;
  runs?: unknown[];
}

export interface StateListResult {
  refs: RuntimeStateRef[];
  truncated: boolean;
}

export interface PutResult {
  state: RuntimeStateDoc;
  event?: RuntimeEvent;
}

export type Unsubscribe = () => void;

export interface RuntimeSession {
  identity: CollabIdentity;
  /** True when embedded in a host that answered bridge.ready. */
  hostConnected: boolean;
  connect(): Promise<ConnectResult>;
  stateGet(namespace: string, key: string): Promise<RuntimeStateDoc>;
  stateList(): Promise<StateListResult>;
  statePut(namespace: string, key: string, baseRevision: number, value: unknown): Promise<PutResult>;
  statePatch(namespace: string, key: string, baseRevision: number, patch: unknown[]): Promise<PutResult>;
  /** Subscribe to the ordered runtime event stream; handler gets each event. */
  eventsSubscribe(handler: (event: RuntimeEvent) => void, afterEventId?: number): Promise<Unsubscribe>;
  /** Submit a declared task intent; resolves with the created task ref. */
  taskSubmit(intentId: string, payload: unknown): Promise<TaskCreated>;
  /** Subscribe to task status updates for one task id. */
  onTaskStatus(handler: (status: TaskStatusUpdate) => void): Unsubscribe;
  /** Rejection for a page-submitted task request. */
  onTaskRejected(handler: (rejected: TaskRejectedMessage) => void): Unsubscribe;
  /** Serve OBSERVE page-context requests from the host. */
  servePageContext(handler: () => ArtifactPageContext | null): void;
  /** Serve result deliveries; the handler returns the application receipt. */
  serveResult(handler: (request: ResultRequestMessage) => Promise<ResultReceipt> | ResultReceipt): void;
  close(): void;
}
