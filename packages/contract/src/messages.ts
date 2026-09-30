import {
  isRequestId,
  isResultSinkId,
  isRuntimeKey,
  isRuntimeName,
  RESULT_ID_PATTERN,
  RUNTIME_RUN_ID_PATTERN,
  TASK_ID_PATTERN,
  TASK_REF_PATTERN,
} from './ids.js';
import { isRecord } from './validate.js';

/**
 * Page-side message contracts for a managed Artifact.
 *
 * Every type string and payload bound mirrors cats-company/webapp
 * artifact-context.js, artifact-task-host.js, and artifact-runtime-host.js.
 * The page treats all inbound envelopes as untrusted input and validates
 * before acting; the host does the same in the other direction.
 */

// --- Opaque frame bridge ---------------------------------------------------

export const ARTIFACT_FRAME_BRIDGE_CONTRACT = 'catsco.artifact-frame-bridge.v1' as const;
export const FRAME_BRIDGE_REQUEST_TYPE = 'catsco.artifact.frame-bridge.request.v1' as const;
export const FRAME_BRIDGE_READY_TYPE = 'catsco.artifact.frame-bridge.ready.v1' as const;
export const FRAME_BRIDGE_NONCE_PARAM = 'catsco_bridge_nonce' as const;

export interface FrameBridgeRequest {
  type: typeof FRAME_BRIDGE_REQUEST_TYPE;
  contract_version: typeof ARTIFACT_FRAME_BRIDGE_CONTRACT;
  parent_origin?: string;
}

export interface FrameBridgeReady {
  type: typeof FRAME_BRIDGE_READY_TYPE;
  contract_version: typeof ARTIFACT_FRAME_BRIDGE_CONTRACT;
  nonce: string;
  bridge_id: string;
}

// --- Application ready / host connect --------------------------------------

export const BRIDGE_READY_TYPE = 'catsco.artifact.bridge.ready.v1' as const;
export const HOST_CONNECT_TYPE = 'catsco.artifact.host.connect.v1' as const;

// --- Page context (OBSERVE) -------------------------------------------------

export const PAGE_CONTEXT_CONTRACT = 'catsco.artifact-page-context.v1' as const;
export const CONTEXT_REQUEST_TYPE = 'catsco.artifact.context.request.v1' as const;
export const CONTEXT_RESPONSE_TYPE = 'catsco.artifact.context.response.v1' as const;
export const PAGE_CONTEXT_MAX_BYTES = 16 * 1024;
export const SEMANTIC_CONTEXT_MAX_BYTES = 8 * 1024;

/**
 * The bounded context object the page returns for one OBSERVE request.
 * `semantic_context` is the trust-separated application view; for a
 * collaborative artifact it carries `runtime_view` — a semantic projection of
 * the shared state plus recent journal entries — never credentials, refs, or
 * transport envelopes.
 */
export interface ArtifactPageContext {
  contract_version: typeof PAGE_CONTEXT_CONTRACT;
  observed_at: string;
  title?: string;
  location?: string;
  selected_text?: string;
  dirty?: boolean;
  artifact_version?: number;
  semantic_context?: Record<string, unknown>;
}

export interface ContextRequestMessage {
  type: typeof CONTEXT_REQUEST_TYPE;
  request_id: string;
}

export interface ContextResponseMessage {
  type: typeof CONTEXT_RESPONSE_TYPE;
  request_id: string;
  context: ArtifactPageContext;
}

// --- Result delivery --------------------------------------------------------

export const RESULT_CONTRACT = 'catsco.artifact-result.v1' as const;
export const RESULT_RECEIPT_CONTRACT = 'catsco.artifact-result-receipt.v1' as const;
export const RESULT_REQUEST_TYPE = 'catsco.artifact.result.request.v1' as const;
export const RESULT_RESPONSE_TYPE = 'catsco.artifact.result.response.v1' as const;
export const RESULT_MAX_BYTES = 64 * 1024;
export const RESULT_RECEIPT_MAX_BYTES = 8 * 1024;

export interface ArtifactResult {
  contract_version: typeof RESULT_CONTRACT;
  artifact_id: string;
  displayed_version?: number;
  sink_id: string;
  result_id: string;
  payload: unknown;
  expected_state_revision?: string;
}

export interface ResultRequestMessage {
  type: typeof RESULT_REQUEST_TYPE;
  request_id: string;
  result: ArtifactResult;
}

export type ResultReceiptStatus = 'applied' | 'rejected' | 'failed';

export interface ResultReceipt {
  contract_version: typeof RESULT_RECEIPT_CONTRACT;
  result_id: string;
  status: ResultReceiptStatus;
  code?: string;
  message?: string;
  receipt?: unknown;
}

export interface ResultResponseMessage {
  type: typeof RESULT_RESPONSE_TYPE;
  request_id: string;
  receipt: ResultReceipt;
}

// --- Page-initiated tasks ----------------------------------------------------

export const TASK_REQUEST_TYPE = 'catsco.artifact.task.request.v1' as const;
export const TASK_ACCEPTED_TYPE = 'catsco.artifact.task.accepted.v1' as const;
export const TASK_REJECTED_TYPE = 'catsco.artifact.task.rejected.v1' as const;
export const TASK_STATUS_TYPE = 'catsco.artifact.task.status.v1' as const;
export const TASK_REF_CONTRACT = 'catsco.artifact-task-ref.v1' as const;
export const TASK_STATUS_CONTRACT = 'catsco.artifact-task-status.v1' as const;
export const TASK_PAYLOAD_MAX_BYTES = 64 * 1024;

export interface TaskRequestMessage {
  type: typeof TASK_REQUEST_TYPE;
  request_id: string;
  intent_id: string;
  payload: unknown;
}

export interface TaskCreated {
  contract_version: typeof TASK_REF_CONTRACT;
  task_id: string;
  task_ref: string;
  status: 'submitted';
  visible_message: string;
  expires_at?: string;
  run_id?: string;
  completion_mode?: 'runtime_state';
}

export interface TaskAcceptedMessage {
  type: typeof TASK_ACCEPTED_TYPE;
  request_id: string;
  task: TaskCreated;
}

export interface TaskRejectedMessage {
  type: typeof TASK_REJECTED_TYPE;
  request_id: string;
  code?: string;
  message?: string;
}

export type TaskStatus = 'submitted' | 'running' | 'completed' | 'failed';

export interface TaskStatusUpdate {
  contract_version: typeof TASK_STATUS_CONTRACT;
  task_id: string;
  status: TaskStatus;
  updated_at?: string;
  expires_at?: string;
  code?: string;
  message?: string;
  run_id?: string;
  executor_run_id?: string;
  result_id?: string;
  completion_mode?: 'runtime_state';
  delivery_status?: 'pending' | 'delivered' | 'failed';
}

export interface TaskStatusMessage {
  type: typeof TASK_STATUS_TYPE;
  task: TaskStatusUpdate;
}

// --- Artifact Runtime ---------------------------------------------------------

export const RUNTIME_REQUEST_CONTRACT = 'catsco.artifact-runtime-request.v1' as const;
export const RUNTIME_REQUEST_TYPE = 'catsco.artifact.runtime.request.v1' as const;
export const RUNTIME_RESPONSE_TYPE = 'catsco.artifact.runtime.response.v1' as const;
export const RUNTIME_EVENT_TYPE = 'catsco.artifact.runtime.event.v1' as const;
export const RUNTIME_STATE_CONTRACT = 'catsco.artifact-runtime-state.v1' as const;
export const RUNTIME_EVENT_CONTRACT = 'catsco.artifact-runtime-event.v1' as const;
export const RUNTIME_EVENT_CONTRACT_V2 = 'catsco.artifact-runtime-event.v2' as const;
export const RUNTIME_RUN_CONTRACT = 'catsco.artifact-runtime-run.v1' as const;
export const RUNTIME_RESPONSE_CONTRACT = 'catsco.artifact-runtime-response.v1' as const;
export const RUNTIME_MAX_PAYLOAD_BYTES = 300 * 1024;
export const RUNTIME_PATCH_MAX_OPS = 64;

export type RuntimeOperation =
  | 'connect'
  | 'state.list'
  | 'state.get'
  | 'state.put'
  | 'state.patch'
  | 'run.get'
  | 'run.list'
  | 'events.subscribe'
  | 'events.unsubscribe';

export interface RuntimeRequestMessage {
  type: typeof RUNTIME_REQUEST_TYPE;
  request_id: string;
  operation: RuntimeOperation;
  payload?: unknown;
}

export interface RuntimeResponseMessage {
  type: typeof RUNTIME_RESPONSE_TYPE;
  request_id: string;
  response: Record<string, unknown>;
}

export interface RuntimeStateDoc {
  contract_version: typeof RUNTIME_STATE_CONTRACT;
  exists: boolean;
  namespace: string;
  key: string;
  revision: number;
  updated_at?: string;
  /** Server-stamped writer name — structural attribution for every doc. */
  updated_by?: string;
  updated_by_uid?: string;
  value?: unknown;
}

export interface RuntimeStateRef {
  namespace: string;
  key: string;
  revision: number;
  updated_at?: string;
}

export interface RuntimeEvent {
  contract_version: typeof RUNTIME_EVENT_CONTRACT | typeof RUNTIME_EVENT_CONTRACT_V2;
  event_id: number;
  type: string;
  namespace?: string;
  key?: string;
  revision?: number;
  updated_by?: string;
  created_at?: string;
  artifact_id?: string;
  data?: unknown;
  task_id?: string;
  run_id?: string;
  result_id?: string;
}

export interface RuntimeEventMessage {
  type: typeof RUNTIME_EVENT_TYPE;
  event: RuntimeEvent;
}

// --- Inbound normalization -----------------------------------------------------

function bounded(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value)
    ? value : null;
}

function plainJSON(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 16_384;
  if (Array.isArray(value)) return value.length <= 1000 && value.every((item) => plainJSON(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.keys(value).length <= 256
    && Object.entries(value).every(([key, item]) => key.length <= 128
      && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
      && plainJSON(item, depth + 1));
}

function jsonSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function normalizeContextRequest(value: unknown): ContextRequestMessage | null {
  if (!isRecord(value) || value.type !== CONTEXT_REQUEST_TYPE || !isRequestId(value.request_id)) return null;
  if (!Object.keys(value).every((key) => ['type', 'request_id'].includes(key))) return null;
  return { type: CONTEXT_REQUEST_TYPE, request_id: value.request_id as string };
}

export function normalizeResultRequest(value: unknown): ResultRequestMessage | null {
  if (!isRecord(value) || value.type !== RESULT_REQUEST_TYPE || !isRequestId(value.request_id)) return null;
  if (!Object.keys(value).every((key) => ['type', 'request_id', 'result'].includes(key))) return null;
  const result = value.result;
  if (!isRecord(result) || result.contract_version !== RESULT_CONTRACT
    || typeof result.artifact_id !== 'string' || !isResultSinkId(result.sink_id)
    || !RESULT_ID_PATTERN.test(String(result.result_id))
    || !plainJSON(result.payload)) return null;
  if (jsonSize(result) > RESULT_MAX_BYTES) return null;
  const message: ResultRequestMessage = {
    type: RESULT_REQUEST_TYPE,
    request_id: value.request_id as string,
    result: {
      contract_version: RESULT_CONTRACT,
      artifact_id: result.artifact_id,
      sink_id: result.sink_id,
      result_id: result.result_id as string,
      payload: result.payload,
      ...(typeof result.displayed_version === 'number' ? { displayed_version: result.displayed_version } : {}),
      ...(typeof result.expected_state_revision === 'string' ? { expected_state_revision: result.expected_state_revision } : {}),
    },
  };
  return message;
}

export function normalizeTaskAccepted(value: unknown): TaskAcceptedMessage | null {
  if (!isRecord(value) || value.type !== TASK_ACCEPTED_TYPE || !isRequestId(value.request_id)) return null;
  const task = value.task;
  if (!isRecord(task) || task.contract_version !== TASK_REF_CONTRACT
    || !TASK_ID_PATTERN.test(String(task.task_id)) || !TASK_REF_PATTERN.test(String(task.task_ref))
    || task.status !== 'submitted') return null;
  return {
    type: TASK_ACCEPTED_TYPE,
    request_id: value.request_id as string,
    task: {
      contract_version: TASK_REF_CONTRACT,
      task_id: task.task_id as string,
      task_ref: task.task_ref as string,
      status: 'submitted',
      visible_message: String(task.visible_message ?? ''),
      ...(typeof task.expires_at === 'string' ? { expires_at: task.expires_at } : {}),
      ...(RUNTIME_RUN_ID_PATTERN.test(String(task.run_id)) ? { run_id: task.run_id as string } : {}),
      ...(task.completion_mode === 'runtime_state' ? { completion_mode: 'runtime_state' as const } : {}),
    },
  };
}

export function normalizeTaskRejected(value: unknown): TaskRejectedMessage | null {
  if (!isRecord(value) || value.type !== TASK_REJECTED_TYPE) return null;
  return {
    type: TASK_REJECTED_TYPE,
    request_id: String(value.request_id ?? ''),
    ...(bounded(value.code, 64) ? { code: value.code as string } : {}),
    ...(bounded(value.message, 500) ? { message: value.message as string } : {}),
  };
}

const TASK_STATUSES = new Set<TaskStatus>(['submitted', 'running', 'completed', 'failed']);

export function normalizeTaskStatusMessage(value: unknown): TaskStatusMessage | null {
  if (!isRecord(value) || value.type !== TASK_STATUS_TYPE) return null;
  const task = value.task;
  if (!isRecord(task) || task.contract_version !== TASK_STATUS_CONTRACT
    || !TASK_ID_PATTERN.test(String(task.task_id))
    || !TASK_STATUSES.has(task.status as TaskStatus)) return null;
  return {
    type: TASK_STATUS_TYPE,
    task: {
      contract_version: TASK_STATUS_CONTRACT,
      task_id: task.task_id as string,
      status: task.status as TaskStatus,
      ...(bounded(task.updated_at, 64) ? { updated_at: task.updated_at as string } : {}),
      ...(bounded(task.expires_at, 64) ? { expires_at: task.expires_at as string } : {}),
      ...(bounded(task.code, 64) ? { code: task.code as string } : {}),
      ...(bounded(task.message, 500) ? { message: task.message as string } : {}),
      ...(RUNTIME_RUN_ID_PATTERN.test(String(task.run_id)) ? { run_id: task.run_id as string } : {}),
      ...(RESULT_ID_PATTERN.test(String(task.result_id)) ? { result_id: task.result_id as string } : {}),
      ...(task.completion_mode === 'runtime_state' ? { completion_mode: 'runtime_state' as const } : {}),
      ...(['pending', 'delivered', 'failed'].includes(String(task.delivery_status))
        ? { delivery_status: task.delivery_status as TaskStatusUpdate['delivery_status'] } : {}),
    },
  };
}

export function normalizeRuntimeResponse(value: unknown): RuntimeResponseMessage | null {
  if (!isRecord(value) || value.type !== RUNTIME_RESPONSE_TYPE || !isRequestId(value.request_id)
    || !isRecord(value.response)) return null;
  return { type: RUNTIME_RESPONSE_TYPE, request_id: value.request_id as string, response: value.response };
}

export function normalizeRuntimeEventMessage(value: unknown): RuntimeEventMessage | null {
  if (!isRecord(value) || value.type !== RUNTIME_EVENT_TYPE || !isRecord(value.event)) return null;
  const event = value.event;
  if (!Number.isSafeInteger(event.event_id) || typeof event.type !== 'string'
    || (event.contract_version !== RUNTIME_EVENT_CONTRACT
      && event.contract_version !== RUNTIME_EVENT_CONTRACT_V2)) return null;
  return { type: RUNTIME_EVENT_TYPE, event: event as unknown as RuntimeEvent };
}

export function normalizeRuntimeStateDoc(value: unknown): RuntimeStateDoc | null {
  if (!isRecord(value) || value.contract_version !== RUNTIME_STATE_CONTRACT
    || typeof value.exists !== 'boolean' || !isRuntimeName(value.namespace)
    || !isRuntimeKey(value.key) || !Number.isSafeInteger(value.revision)) return null;
  return {
    contract_version: RUNTIME_STATE_CONTRACT,
    exists: value.exists,
    namespace: value.namespace as string,
    key: value.key as string,
    revision: value.revision as number,
    ...(bounded(value.updated_at, 64) ? { updated_at: value.updated_at as string } : {}),
    ...(value.exists && value.value !== undefined && plainJSON(value.value) ? { value: value.value } : {}),
  };
}

// --- Outbound builders ---------------------------------------------------------

export function buildContextResponse(requestId: string, context: ArtifactPageContext): ContextResponseMessage {
  return { type: CONTEXT_RESPONSE_TYPE, request_id: requestId, context };
}

export function buildResultResponse(requestId: string, receipt: ResultReceipt): ResultResponseMessage {
  return { type: RESULT_RESPONSE_TYPE, request_id: requestId, receipt };
}

export function buildTaskRequest(requestId: string, intentId: string, payload: unknown): TaskRequestMessage {
  return { type: TASK_REQUEST_TYPE, request_id: requestId, intent_id: intentId, payload };
}

export function buildRuntimeRequest(requestId: string, operation: RuntimeOperation, payload?: unknown): RuntimeRequestMessage {
  return payload === undefined
    ? { type: RUNTIME_REQUEST_TYPE, request_id: requestId, operation }
    : { type: RUNTIME_REQUEST_TYPE, request_id: requestId, operation, payload };
}

export function buildFrameBridgeReady(nonce: string, bridgeId: string): FrameBridgeReady {
  return { type: FRAME_BRIDGE_READY_TYPE, contract_version: ARTIFACT_FRAME_BRIDGE_CONTRACT, nonce, bridge_id: bridgeId };
}
