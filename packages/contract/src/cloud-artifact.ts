import { isCloudArtifactId } from './ids.js';
import { isRFC3339 } from './time.js';

/**
 * Transport-neutral contracts shared by the Cloud Artifact reader, publisher,
 * and page bridge.  The implementation intentionally contains only bounded
 * data validation; it does not know about Agents, HTTP, or a runtime.
 */

export const ARTIFACT_MANIFEST_FILENAME = 'artifact-manifest.json' as const;
export const ARTIFACT_MANIFEST_CONTRACT_V1 = 'catsco.artifact-manifest.v1' as const;
export const ARTIFACT_MANIFEST_CONTRACT_V2 = 'catsco.artifact-manifest.v2' as const;
export const ARTIFACT_MANIFEST_CONTRACT_V3 = 'catsco.artifact-manifest.v3' as const;
export const ARTIFACT_MANIFEST_CONTRACT = ARTIFACT_MANIFEST_CONTRACT_V3;
export const ARTIFACT_PAGE_CONTEXT_CONTRACT = 'catsco.artifact-page-context.v1' as const;
export const PAGE_CONTEXT_CONTRACT = ARTIFACT_PAGE_CONTEXT_CONTRACT;
export const ARTIFACT_OBSERVATION_PACKET_CONTRACT = 'cloud-html-artifact.observation-packet.v1' as const;
export const OBSERVATION_PACKET_CONTRACT = ARTIFACT_OBSERVATION_PACKET_CONTRACT;
export const ARTIFACT_CONTEXT_READ_RESULT_CONTRACT = 'cloud-html-artifact.context-read-result.v1' as const;
export const ARTIFACT_CONTEXT_SNAPSHOT_CONTRACT = 'catsco.artifact-context-snapshot.v1' as const;
export const ARTIFACT_WRITEBACK_TARGET_CONTRACT = 'catsco.artifact-writeback-target.v1' as const;
export const ARTIFACT_TASK_SNAPSHOT_CONTRACT = 'catsco.artifact-task-snapshot.v1' as const;
export const ARTIFACT_TASK_READ_RESULT_CONTRACT = 'cloud-html-artifact.task-read-result.v1' as const;
export const ARTIFACT_TASK_STATUS_CONTRACT = 'catsco.artifact-task-status.v1' as const;
export const TASK_STATUS_CONTRACT = ARTIFACT_TASK_STATUS_CONTRACT;
export const ARTIFACT_RESULT_CONTRACT = 'catsco.artifact-result.v1' as const;
export const ARTIFACT_RESULT_RECEIPT_CONTRACT = 'catsco.artifact-result-receipt.v1' as const;
export const APPLICATION_RECEIPT_CONTRACT = ARTIFACT_RESULT_RECEIPT_CONTRACT;
export const RESULT_CONTRACT = ARTIFACT_RESULT_CONTRACT;

export const MAX_ARTIFACT_MANIFEST_BYTES = 64 * 1024;
export const MAX_RESULT_SINKS = 16;
export const MAX_ARTIFACT_TASK_INTENTS = 16;
export const MAX_RESULT_SCHEMA_BYTES = 24 * 1024;
export const MAX_RESULT_SCHEMA_DEPTH = 8;
export const MAX_RESULT_SCHEMA_NODES = 256;
export const MAX_RESULT_SCHEMA_PROPERTIES = 64;
export const MAX_RESULT_SCHEMA_ENUM_ITEMS = 64;
export const MAX_RESULT_PAYLOAD_BYTES = 64 * 1024;
export const MAX_RESULT_RECEIPT_BYTES = 8 * 1024;
export const MAX_RESULT_ARRAY_ITEMS = 1_000;
export const MAX_RESULT_JSON_DEPTH = 12;
export const MAX_RESULT_JSON_NODES = 16_384;
export const MAX_RESULT_STRING_LENGTH = 16_384;
export const MAX_RECEIPT_STRING_LENGTH = 2_000;
export const MAX_SEMANTIC_BYTES = 8 * 1024;
export const MAX_SEMANTIC_DEPTH = 6;
export const MAX_SEMANTIC_ARRAY_ITEMS = 50;
export const MAX_SEMANTIC_OBJECT_KEYS = 50;
export const MAX_SEMANTIC_STRING_LENGTH = 1_000;
export const MAX_SEMANTIC_NODES = 4_096;

// Short aliases retained for callers porting the upstream browser contract.
export const MAX_RESULT_BYTES = MAX_RESULT_PAYLOAD_BYTES;
export const MAX_RECEIPT_BYTES = MAX_RESULT_RECEIPT_BYTES;
export const MAX_RESULT_DEPTH = MAX_RESULT_JSON_DEPTH;
export const MAX_RESULT_VISITS = MAX_RESULT_JSON_NODES;

const MAX_PURPOSE_LENGTH = 1_000;
const MAX_LIST_ITEM_LENGTH = 256;
const MAX_VIEWS = 32;
const MAX_ENTITIES = 32;
const MAX_ENTRYPOINTS = 16;
const MAX_CAPABILITIES = 8;
const MAX_SINK_ID_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TASK_MESSAGE_LENGTH = 500;
const MAX_ARTIFACT_ID_LENGTH = 64;
const MAX_ARTIFACT_AGENT_UID_LENGTH = 128;
const MAX_WRITEBACK_REF_LENGTH = 47;
const MAX_TITLE_LENGTH = 512;
const MAX_PAGE_TITLE_LENGTH = 256;
const MAX_PATHNAME_LENGTH = 1_024;
const MAX_HASH_LENGTH = 512;
const MAX_LOCATION_LENGTH = 2_048;
const MAX_SELECTED_TEXT_LENGTH = 2_000;
const MAX_OBSERVED_AT_LENGTH = 64;
const MAX_RUN_ID_LENGTH = 128;
const MAX_CODE_LENGTH = 64;
const MAX_SCHEMA_TEXT_LENGTH = 1_000;
const MAX_SCHEMA_TITLE_LENGTH = 256;
const MAX_SCHEMA_PROPERTY_NAME_LENGTH = 128;
const MAX_SNAPSHOT_REVISION = Number.MAX_SAFE_INTEGER;

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MANIFEST_KEYS = new Set([
  'contract_version',
  'purpose',
  'views',
  'entities',
  'entrypoints',
  'observation_capabilities',
  'result_sinks',
  'task_intents',
]);
const SINK_KEYS = new Set(['id', 'description', 'input_schema']);
const INTENT_KEYS = new Set(['id', 'title', 'description', 'input_schema', 'result_sink']);
const PACKET_KEYS = new Set([
  'contract_version',
  'artifact',
  'application',
  'page',
  'state',
  'capabilities',
  'observed_at',
  'snapshot',
  'sources',
]);
const APPLICATION_KEYS = new Set(['manifest_status', 'manifest']);
const PAGE_KEYS = new Set(['title', 'location', 'view']);
const LOCATION_KEYS = new Set(['pathname', 'hash']);
const PAGE_CONTEXT_KEYS = new Set([
  'contract_version',
  'observed_at',
  'title',
  'location',
  'selected_text',
  'last_interaction',
  'controls',
  'dirty',
  'artifact_version',
  'semantic_context',
]);
const STATE_KEYS = new Set(['generic', 'semantic']);
const GENERIC_STATE_KEYS = new Set(['selected_text', 'last_interaction', 'controls', 'dirty', 'artifact_version']);
const CAPABILITY_KEYS = new Set([
  'application_manifest',
  'generic_snapshot',
  'generic_dom',
  'runtime_snapshot',
  'semantic_context',
  'result_writeback',
  'agent_tasks',
]);
const SOURCE_KEYS = new Set(['artifact', 'manifest', 'generic_state', 'semantic_state']);
const TASK_STATUS_KEYS = new Set([
  'contract_version',
  'task_id',
  'status',
  'code',
  'message',
  'run_id',
  'result_id',
  'updated_at',
  'expires_at',
]);
const RECEIPT_KEYS = new Set(['contract_version', 'result_id', 'status', 'code', 'message', 'receipt']);
const ARTIFACT_KEYS = new Set([
  'id',
  'agent_uid',
  'title',
  'kind',
  'url',
  'topic_id',
  'currently_visible',
  'displayed_version',
  'latest_version',
]);
const SNAPSHOT_KEYS = new Set(['created_at', 'expires_at', 'revision']);
const SCHEMA_COMMON_KEYS = new Set(['type', 'title', 'description', 'enum']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const SCHEMA_TYPE_KEYS: Record<string, Set<string>> = {
  object: new Set(['properties', 'required', 'additionalProperties']),
  array: new Set(['items', 'minItems', 'maxItems']),
  string: new Set(['minLength', 'maxLength']),
  number: new Set(['minimum', 'maximum']),
  integer: new Set(['minimum', 'maximum']),
  boolean: new Set(),
  null: new Set(),
};
const OBSERVATION_CAPABILITIES = new Set(['runtime_snapshot', 'semantic_context']);
const MANIFEST_STATUSES = new Set(['available', 'missing', 'invalid', 'unavailable']);
const SINK_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[1-9]\d*$/;
const TASK_ID_PATTERN = /^atk_[A-Za-z0-9_-]{43}$/;
const RESULT_ID_PATTERN = /^arr_[A-Za-z0-9_-]{43}$/;
const WRITEBACK_REF_PATTERN = /^awr_[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class CloudArtifactContractError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(message: string, options: { code?: string; path?: string } = {}) {
    super(message);
    this.name = 'CloudArtifactContractError';
    this.code = options.code?.trim() || 'cloud_artifact_contract_invalid';
    this.path = options.path?.trim() || '';
  }
}

export class ArtifactObservationContractError extends CloudArtifactContractError {
  constructor(message: string, options: { code?: string; path?: string } = {}) {
    super(message, { code: options.code || 'artifact_observation_contract_invalid', path: options.path });
    this.name = 'ArtifactObservationContractError';
  }
}

export class ArtifactResultContractError extends CloudArtifactContractError {
  constructor(message: string, options: { code?: string; path?: string } = {}) {
    super(message, { code: options.code || 'artifact_result_contract_invalid', path: options.path });
    this.name = 'ArtifactResultContractError';
  }
}

export class ArtifactTaskContractError extends CloudArtifactContractError {
  constructor(message: string, options: { code?: string; path?: string } = {}) {
    super(message, { code: options.code || 'artifact_task_contract_invalid', path: options.path });
    this.name = 'ArtifactTaskContractError';
  }
}

export type ArtifactManifestContractVersion =
  | typeof ARTIFACT_MANIFEST_CONTRACT_V1
  | typeof ARTIFACT_MANIFEST_CONTRACT_V2
  | typeof ARTIFACT_MANIFEST_CONTRACT_V3;
export type ObservationCapability = 'runtime_snapshot' | 'semantic_context';

export type BoundedJsonSchema =
  | BoundedObjectSchema
  | BoundedArraySchema
  | BoundedStringSchema
  | BoundedNumberSchema
  | BoundedIntegerSchema
  | BoundedBooleanSchema
  | BoundedNullSchema;

interface BoundedSchemaBase {
  type: string;
  title?: string;
  description?: string;
  enum?: JsonPrimitive[];
}
export interface BoundedObjectSchema extends BoundedSchemaBase {
  type: 'object';
  properties?: Record<string, BoundedJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
}
export interface BoundedArraySchema extends BoundedSchemaBase {
  type: 'array';
  items: BoundedJsonSchema;
  minItems?: number;
  maxItems?: number;
}
export interface BoundedStringSchema extends BoundedSchemaBase {
  type: 'string';
  minLength?: number;
  maxLength?: number;
}
export interface BoundedNumberSchema extends BoundedSchemaBase {
  type: 'number';
  minimum?: number;
  maximum?: number;
}
export interface BoundedIntegerSchema extends BoundedSchemaBase {
  type: 'integer';
  minimum?: number;
  maximum?: number;
}
export interface BoundedBooleanSchema extends BoundedSchemaBase {
  type: 'boolean';
}
export interface BoundedNullSchema extends BoundedSchemaBase {
  type: 'null';
}

export interface ResultSink {
  id: string;
  description: string;
  input_schema: BoundedJsonSchema;
}

export interface TaskIntent {
  id: string;
  title: string;
  description: string;
  input_schema: BoundedJsonSchema;
  result_sink: string;
}

export interface ArtifactManifestCommon {
  purpose: string;
  views?: string[];
  entities?: string[];
  entrypoints?: string[];
  observation_capabilities?: ObservationCapability[];
}
export interface ArtifactManifestV1 extends ArtifactManifestCommon {
  contract_version: typeof ARTIFACT_MANIFEST_CONTRACT_V1;
  result_sinks?: undefined;
  task_intents?: undefined;
}
export interface ArtifactManifestV2 extends ArtifactManifestCommon {
  contract_version: typeof ARTIFACT_MANIFEST_CONTRACT_V2;
  result_sinks?: ResultSink[];
  task_intents?: undefined;
}
export interface ArtifactManifestV3 extends ArtifactManifestCommon {
  contract_version: typeof ARTIFACT_MANIFEST_CONTRACT_V3;
  result_sinks?: ResultSink[];
  task_intents?: TaskIntent[];
}
export type ArtifactManifest = ArtifactManifestV1 | ArtifactManifestV2 | ArtifactManifestV3;

export type ArtifactManifestStatus = 'available' | 'missing' | 'invalid' | 'unavailable';
export interface ArtifactManifestResult {
  status: ArtifactManifestStatus;
  manifest: ArtifactManifest | null;
  warnings?: string[];
}

export interface TrustedArtifactIdentity {
  id: string;
  agent_uid: string;
  title: string;
  kind: 'html' | 'mini_app';
  url: string;
  topic_id: string;
  currently_visible: true;
  displayed_version: number;
  latest_version?: number | null;
}
export interface TrustedSnapshot {
  created_at: string;
  expires_at: string;
  revision: number;
}
export interface TrustedWritebackTarget {
  contract_version: typeof ARTIFACT_WRITEBACK_TARGET_CONTRACT;
  writeback_ref: string;
  expires_at: string;
  task_id?: string;
}
export type ManifestTrust = 'artifact_authored_untrusted' | 'absent';
export type GenericStateTrust = 'bridge_observed_untrusted' | 'absent';
export type SemanticStateTrust = 'page_authored_untrusted' | 'absent';
export interface ObservationApplication {
  manifest_status: ArtifactManifestStatus;
  manifest: ArtifactManifest | null;
}
export interface ObservationPage {
  title: string | null;
  location: { pathname?: string; hash?: string } | null;
  view: string | null;
}
export interface ObservationGenericState {
  selected_text?: string;
  last_interaction?: JsonValue;
  controls?: JsonValue[];
  dirty?: boolean;
  artifact_version?: number;
}
export interface ObservationCapabilities {
  application_manifest: boolean;
  generic_snapshot: boolean;
  generic_dom: boolean;
  runtime_snapshot: boolean;
  semantic_context: boolean;
  result_writeback: boolean;
  agent_tasks: boolean;
}
export interface ObservationSources {
  artifact: 'platform_confirmed';
  manifest: ManifestTrust;
  generic_state: GenericStateTrust;
  semantic_state: SemanticStateTrust;
}
export interface ObservationPacket {
  contract_version: typeof ARTIFACT_OBSERVATION_PACKET_CONTRACT;
  artifact: TrustedArtifactIdentity;
  application: ObservationApplication;
  page: ObservationPage | null;
  state: {
    generic: ObservationGenericState | null;
    semantic: JsonValue | null;
  };
  capabilities: ObservationCapabilities;
  observed_at: string | null;
  snapshot: TrustedSnapshot | null;
  sources: ObservationSources;
}

/** Explicit trust-separated view used by readers and callers. */
export interface TrustedObservation {
  artifact: TrustedArtifactIdentity;
  snapshot: TrustedSnapshot | null;
  writeback_target?: TrustedWritebackTarget | null;
}
export interface UntrustedObservation {
  trust: 'untrusted_page_supplied';
  observed_at: string | null;
  page_context: JsonObject | null;
  application_manifest_status: ArtifactManifestStatus;
  application_manifest_trust: ManifestTrust;
}
export interface ObservationReadResult {
  trusted: TrustedObservation;
  untrusted: UntrustedObservation;
  observation_packet: ObservationPacket;
}

export interface ArtifactPageContext {
  contract_version: typeof ARTIFACT_PAGE_CONTEXT_CONTRACT;
  observed_at?: string;
  title?: string;
  location?: { pathname?: string; hash?: string } | null;
  selected_text?: string;
  last_interaction?: JsonValue;
  controls?: JsonValue[];
  dirty?: boolean;
  artifact_version?: number;
  semantic_context?: JsonValue | null;
}

export type TaskStatusValue = 'submitted' | 'running' | 'completed' | 'failed';
export interface TaskStatus {
  contract_version: typeof ARTIFACT_TASK_STATUS_CONTRACT;
  task_id: string;
  status: TaskStatusValue;
  code?: string;
  message?: string;
  run_id?: string;
  result_id?: string;
  updated_at?: string;
  expires_at?: string;
}
export type ApplicationReceiptStatus = 'applied' | 'rejected' | 'failed';
export interface ApplicationReceipt {
  contract_version: typeof ARTIFACT_RESULT_RECEIPT_CONTRACT;
  result_id: string;
  status: ApplicationReceiptStatus;
  code?: string;
  message?: string;
  receipt?: JsonValue;
}

/** The bounded envelope sent by the bundled result writer to CatsCo. */
export interface ArtifactResultEnvelope {
  contract_version: typeof ARTIFACT_RESULT_CONTRACT;
  writeback_ref: string;
  task_id?: string;
  artifact_id: string;
  displayed_version: number;
  sink_id: string;
  result_id: string;
  expected_state_revision?: string;
  payload: JsonValue;
}

export interface BuildArtifactObservationPacketInput {
  artifact: Record<string, unknown>;
  snapshot?: Record<string, unknown> | TrustedSnapshot | null;
  pageContext?: Record<string, unknown> | ArtifactPageContext | null;
  manifestResult?: Partial<ArtifactManifestResult> & { status?: unknown; manifest?: unknown };
  observedAt?: string | null;
}

/**
 * Parse a UTF-8 manifest string and return its normalized, safe form.
 * `validateArtifactManifest` performs the same validation for an already
 * parsed value. Both throw ArtifactObservationContractError on failure, which
 * mirrors the upstream publisher contract.
 */
export function parseArtifactManifest(text: string): ArtifactManifest {
  if (typeof text !== 'string') {
    throw manifestError(`${ARTIFACT_MANIFEST_FILENAME} must contain valid JSON.`);
  }
  const bytes = utf8ByteLength(text);
  if (bytes < 2 || bytes > MAX_ARTIFACT_MANIFEST_BYTES) {
    throw manifestError(
      `${ARTIFACT_MANIFEST_FILENAME} must be between 2 and ${MAX_ARTIFACT_MANIFEST_BYTES} bytes.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw manifestError(`${ARTIFACT_MANIFEST_FILENAME} must contain valid JSON.`);
  }
  return validateArtifactManifest(value);
}

export function validateArtifactManifest(value: unknown): ArtifactManifest {
  const object = requirePlainObject(value, 'Artifact manifest', 'observation');
  rejectUnknownKeys(object, MANIFEST_KEYS, 'Artifact manifest', 'observation');
  const contractVersion = object.contract_version;
  if (
    contractVersion !== ARTIFACT_MANIFEST_CONTRACT_V1
    && contractVersion !== ARTIFACT_MANIFEST_CONTRACT_V2
    && contractVersion !== ARTIFACT_MANIFEST_CONTRACT_V3
  ) {
    throw manifestError(
      `Artifact manifest contract_version must be ${ARTIFACT_MANIFEST_CONTRACT_V1}, ${ARTIFACT_MANIFEST_CONTRACT_V2}, or ${ARTIFACT_MANIFEST_CONTRACT_V3}.`,
    );
  }
  if (contractVersion === ARTIFACT_MANIFEST_CONTRACT_V1 && object.result_sinks !== undefined) {
    throw manifestError('Artifact manifest v1 does not support result_sinks.');
  }
  if (contractVersion !== ARTIFACT_MANIFEST_CONTRACT_V3 && object.task_intents !== undefined) {
    throw manifestError('Only Artifact manifest v3 supports task_intents.');
  }

  const manifestBase = {
    contract_version: contractVersion,
    purpose: requiredText(object.purpose, MAX_PURPOSE_LENGTH, 'Artifact manifest purpose', 'observation'),
  } as ArtifactManifestCommon & { contract_version: ArtifactManifestContractVersion };
  const views = optionalTextList(object.views, MAX_VIEWS, 'Artifact manifest views', 'observation');
  const entities = optionalTextList(object.entities, MAX_ENTITIES, 'Artifact manifest entities', 'observation');
  const entrypoints = optionalTextList(object.entrypoints, MAX_ENTRYPOINTS, 'Artifact manifest entrypoints', 'observation');
  const capabilities = optionalEnumList(
    object.observation_capabilities,
    MAX_CAPABILITIES,
    OBSERVATION_CAPABILITIES,
    'Artifact manifest observation_capabilities',
    'observation',
  ) as ObservationCapability[];
  if (views.length) manifestBase.views = views;
  if (entities.length) manifestBase.entities = entities;
  if (entrypoints.length) manifestBase.entrypoints = entrypoints;
  if (capabilities.length) manifestBase.observation_capabilities = capabilities;

  let resultSinks: ResultSink[] = [];
  try {
    resultSinks = validateResultSinks(object.result_sinks);
  } catch (error) {
    throw manifestError(errorMessage(error));
  }
  if (resultSinks.length) (manifestBase as ArtifactManifestV2).result_sinks = resultSinks;

  let taskIntents: TaskIntent[] = [];
  try {
    taskIntents = validateTaskIntents(object.task_intents, resultSinks);
  } catch (error) {
    throw manifestError(errorMessage(error));
  }
  if (taskIntents.length) (manifestBase as ArtifactManifestV3).task_intents = taskIntents;
  return manifestBase as ArtifactManifest;
}

/** Repo-style non-throwing companion for callers that accumulate diagnostics. */
export function checkArtifactManifest(value: unknown): string[] {
  try {
    validateArtifactManifest(value);
    return [];
  } catch (error) {
    return [errorMessage(error)];
  }
}
export const validateArtifactManifestErrors = checkArtifactManifest;
export const assertArtifactManifest = validateArtifactManifest;
export function isArtifactManifest(value: unknown): value is ArtifactManifest {
  try {
    validateArtifactManifest(value);
    return true;
  } catch {
    return false;
  }
}

export function validateResultSchema(value: unknown, label = 'Result schema'): BoundedJsonSchema {
  const budget = { nodes: MAX_RESULT_SCHEMA_NODES };
  const normalized = normalizeSchema(value, label, 0, budget);
  if (utf8ByteLength(JSON.stringify(normalized)) > MAX_RESULT_SCHEMA_BYTES) {
    throw resultError(`${label} exceeds ${MAX_RESULT_SCHEMA_BYTES} bytes.`);
  }
  return normalized;
}

export function validateResultSinks(value: unknown): ResultSink[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_RESULT_SINKS) {
    throw resultError(`Artifact result_sinks must be an array with at most ${MAX_RESULT_SINKS} items.`);
  }
  assertDenseArray(value, 'Artifact result_sinks', 'result');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const label = `Artifact result_sinks[${index}]`;
    const sink = requirePlainObject(item, `${label} must be an object.`, 'result');
    rejectUnknownKeys(sink, SINK_KEYS, label, 'result');
    const id = requiredVersionedId(sink.id, `${label}.id`, 'result');
    if (seen.has(id)) throw resultError('Artifact result_sinks must not contain duplicate IDs.');
    seen.add(id);
    return {
      id,
      description: requiredText(sink.description, MAX_DESCRIPTION_LENGTH, `${label}.description`, 'result'),
      input_schema: validateResultSchema(sink.input_schema, `${label}.input_schema`),
    };
  });
}

export function validateTaskIntents(value: unknown, resultSinks: readonly ResultSink[] = []): TaskIntent[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_TASK_INTENTS) {
    throw taskError(`Artifact task_intents must be an array with at most ${MAX_ARTIFACT_TASK_INTENTS} items.`);
  }
  assertDenseArray(value, 'Artifact task_intents', 'task');
  const sinkIDs = new Set(resultSinks.map((sink) => sink.id));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const label = `Artifact task_intents[${index}]`;
    const intent = requirePlainObject(item, `${label} must be an object.`, 'task');
    rejectUnknownKeys(intent, INTENT_KEYS, label, 'task');
    const id = requiredVersionedId(intent.id, `${label}.id`, 'task');
    if (seen.has(id)) throw taskError('Artifact task_intents must not contain duplicate IDs.');
    seen.add(id);
    const resultSink = requiredVersionedId(intent.result_sink, `${label}.result_sink`, 'task');
    if (!sinkIDs.has(resultSink)) {
      throw taskError(`${label}.result_sink must reference a declared result_sinks ID.`);
    }
    return {
      id,
      title: requiredText(intent.title, MAX_LIST_ITEM_LENGTH, `${label}.title`, 'task'),
      description: requiredText(intent.description, MAX_DESCRIPTION_LENGTH, `${label}.description`, 'task'),
      input_schema: validateResultSchema(intent.input_schema, `${label}.input_schema`),
      result_sink: resultSink,
    };
  });
}

export function hasDeclaredResultSink(intent: Pick<TaskIntent, 'result_sink'> | string, sinks: readonly ResultSink[]): boolean {
  const sinkId = typeof intent === 'string' ? intent : intent.result_sink;
  return sinks.some((sink) => sink.id === sinkId);
}

export function validateResultPayload(schema: unknown, payload: unknown): JsonValue {
  const normalizedSchema = validateResultSchema(schema);
  assertBoundedJson(payload, {
    label: 'Artifact result payload',
    maxBytes: MAX_RESULT_PAYLOAD_BYTES,
    maxDepth: MAX_RESULT_JSON_DEPTH,
    maxNodes: MAX_RESULT_JSON_NODES,
    maxArrayItems: MAX_RESULT_ARRAY_ITEMS,
    maxStringLength: MAX_RESULT_STRING_LENGTH,
    maxObjectKeys: 256,
    errorKind: 'result',
  });
  validateValueAgainstSchema(normalizedSchema, payload, 'payload');
  return payload as JsonValue;
}

/** Validate the transport envelope used by the official result writer. */
export function validateArtifactResultEnvelope(value: unknown): ArtifactResultEnvelope {
  const envelope = requirePlainObject(value, 'Artifact result envelope must be an object.', 'result');
  const allowed = new Set([
    'contract_version',
    'writeback_ref',
    'task_id',
    'artifact_id',
    'displayed_version',
    'sink_id',
    'result_id',
    'expected_state_revision',
    'payload',
  ]);
  rejectUnknownKeys(envelope, allowed, 'Artifact result envelope', 'result');
  if (envelope.contract_version !== ARTIFACT_RESULT_CONTRACT) {
    throw resultError(`Artifact result contract_version must be ${ARTIFACT_RESULT_CONTRACT}.`);
  }
  if (typeof envelope.writeback_ref !== 'string'
      || envelope.writeback_ref.length !== MAX_WRITEBACK_REF_LENGTH
      || !WRITEBACK_REF_PATTERN.test(envelope.writeback_ref)) {
    throw resultError('Artifact result writeback_ref is invalid.');
  }
  if (envelope.task_id !== undefined
      && (typeof envelope.task_id !== 'string' || !TASK_ID_PATTERN.test(envelope.task_id))) {
    throw resultError('Artifact result task_id is invalid.');
  }
  if (typeof envelope.artifact_id !== 'string'
      || envelope.artifact_id.length > MAX_ARTIFACT_ID_LENGTH
      || !isCloudArtifactId(envelope.artifact_id)) {
    throw resultError('Artifact result artifact_id is invalid.');
  }
  if (!isPositiveSafeInteger(envelope.displayed_version)) {
    throw resultError('Artifact result displayed_version must be a positive integer.');
  }
  const sinkId = requiredVersionedId(envelope.sink_id, 'Artifact result sink_id', 'result');
  if (typeof envelope.result_id !== 'string' || !RESULT_ID_PATTERN.test(envelope.result_id)) {
    throw resultError('Artifact result result_id is invalid.');
  }
  const expectedRevision = optionalRevision(envelope.expected_state_revision, 'Artifact result expected_state_revision');
  assertBoundedJson(envelope.payload, {
    label: 'Artifact result payload',
    maxBytes: MAX_RESULT_PAYLOAD_BYTES,
    maxDepth: MAX_RESULT_JSON_DEPTH,
    maxNodes: MAX_RESULT_JSON_NODES,
    maxArrayItems: MAX_RESULT_ARRAY_ITEMS,
    maxStringLength: MAX_RESULT_STRING_LENGTH,
    maxObjectKeys: 256,
    errorKind: 'result',
  });
  return {
    contract_version: ARTIFACT_RESULT_CONTRACT,
    writeback_ref: envelope.writeback_ref,
    ...(envelope.task_id !== undefined ? { task_id: envelope.task_id } : {}),
    artifact_id: envelope.artifact_id,
    displayed_version: envelope.displayed_version,
    sink_id: sinkId,
    result_id: envelope.result_id,
    ...(expectedRevision !== null ? { expected_state_revision: expectedRevision } : {}),
    payload: envelope.payload as JsonValue,
  };
}

export function checkArtifactResultEnvelope(value: unknown): string[] {
  try {
    validateArtifactResultEnvelope(value);
    return [];
  } catch (error) {
    return [errorMessage(error)];
  }
}
export function isArtifactResultEnvelope(value: unknown): value is ArtifactResultEnvelope {
  try {
    validateArtifactResultEnvelope(value);
    return true;
  } catch {
    return false;
  }
}
export const assertArtifactResultEnvelope = validateArtifactResultEnvelope;

/** Build the fixed observation packet without inventing page/business fields. */
export function buildArtifactObservationPacket(input: BuildArtifactObservationPacketInput): ObservationPacket {
  const page = isPlainObject(input.pageContext) ? input.pageContext : null;
  const semanticRaw = page && Object.hasOwn(page, 'semantic_context') ? page.semantic_context : null;
  const semanticCandidate = semanticRaw === undefined ? null : boundedCloneOrNull(semanticRaw, {
    label: 'semantic_context',
    maxBytes: MAX_SEMANTIC_BYTES,
    maxDepth: MAX_SEMANTIC_DEPTH,
    maxNodes: MAX_SEMANTIC_NODES,
    maxArrayItems: MAX_SEMANTIC_ARRAY_ITEMS,
    maxStringLength: MAX_SEMANTIC_STRING_LENGTH,
    maxObjectKeys: MAX_SEMANTIC_OBJECT_KEYS,
    errorKind: 'observation',
  });
  const semantic = hasSemanticContent(semanticCandidate) ? semanticCandidate : null;
  const generic = extractGenericPageState(page);
  let manifest: ArtifactManifest | null = null;
  if (input.manifestResult?.status === 'available' && input.manifestResult.manifest !== null && input.manifestResult.manifest !== undefined) {
    try {
      manifest = validateArtifactManifest(input.manifestResult.manifest);
    } catch {
      manifest = null;
    }
  }
  const manifestStatus = normalizeManifestStatus(input.manifestResult?.status);
  const observedAt = firstText(
    page?.observed_at,
    input.observedAt,
    isPlainObject(input.snapshot) ? input.snapshot.created_at : undefined,
  );
  const pageOutput: ObservationPage | null = page
    ? {
        title: optionalText(page.title, MAX_PAGE_TITLE_LENGTH),
        location: normalizeLocation(page.location),
        view: semanticView(semantic),
      }
    : null;
  return {
    contract_version: ARTIFACT_OBSERVATION_PACKET_CONTRACT,
    artifact: { ...input.artifact } as unknown as TrustedArtifactIdentity,
    application: { manifest_status: manifestStatus, manifest },
    page: pageOutput,
    state: { generic, semantic },
    capabilities: {
      application_manifest: Boolean(manifest),
      generic_snapshot: Boolean(page),
      generic_dom: Boolean(generic),
      runtime_snapshot: semantic !== null,
      semantic_context: semantic !== null,
      result_writeback: Boolean(manifest?.result_sinks?.length),
      agent_tasks: Boolean(manifest?.task_intents?.length),
    },
    observed_at: observedAt,
    snapshot: isPlainObject(input.snapshot) ? { ...input.snapshot } as unknown as TrustedSnapshot : null,
    sources: {
      artifact: 'platform_confirmed',
      manifest: manifest ? 'artifact_authored_untrusted' : 'absent',
      generic_state: generic ? 'bridge_observed_untrusted' : 'absent',
      semantic_state: semantic !== null ? 'page_authored_untrusted' : 'absent',
    },
  };
}

/** Validate the optional page self-description before it enters an observation packet. */
export function validateArtifactPageContext(value: unknown): ArtifactPageContext {
  const page = requirePlainObject(value, 'Artifact page context must be an object.', 'observation');
  rejectUnknownKeys(page, PAGE_CONTEXT_KEYS, 'Artifact page context', 'observation');
  if (page.contract_version !== ARTIFACT_PAGE_CONTEXT_CONTRACT) {
    throw observationError(`Artifact page context contract_version must be ${ARTIFACT_PAGE_CONTEXT_CONTRACT}.`);
  }
  const result: ArtifactPageContext = { contract_version: ARTIFACT_PAGE_CONTEXT_CONTRACT };
  if (page.observed_at !== undefined) result.observed_at = requiredText(page.observed_at, MAX_OBSERVED_AT_LENGTH, 'page observed_at', 'observation');
  if (page.title !== undefined) result.title = requiredText(page.title, MAX_PAGE_TITLE_LENGTH, 'page title', 'observation');
  if (page.location !== undefined) {
    if (page.location === null) {
      result.location = null;
    } else {
      const location = requirePlainObject(page.location, 'page location must be an object.', 'observation');
      rejectUnknownKeys(location, LOCATION_KEYS, 'page location', 'observation');
      result.location = {
        ...(location.pathname !== undefined ? { pathname: requiredText(location.pathname, MAX_PATHNAME_LENGTH, 'page pathname', 'observation') } : {}),
        ...(location.hash !== undefined ? { hash: requiredText(location.hash, MAX_HASH_LENGTH, 'page hash', 'observation') } : {}),
      };
    }
  }
  if (page.selected_text !== undefined) result.selected_text = requiredText(page.selected_text, MAX_SELECTED_TEXT_LENGTH, 'page selected_text', 'observation');
  if (page.last_interaction !== undefined) {
    assertBoundedJson(page.last_interaction, genericBounds('page last_interaction'));
    result.last_interaction = cloneJson(page.last_interaction as JsonValue);
  }
  if (page.controls !== undefined) {
    if (!Array.isArray(page.controls) || page.controls.length > 24) throw observationError('page controls must contain at most 24 items.');
    assertDenseArray(page.controls, 'page controls', 'observation');
    result.controls = page.controls.map((item, index) => {
      assertBoundedJson(item, genericBounds(`page controls[${index}]`));
      return cloneJson(item as JsonValue);
    });
  }
  if (page.dirty !== undefined) {
    if (typeof page.dirty !== 'boolean') throw observationError('page dirty must be boolean.');
    result.dirty = page.dirty;
  }
  if (page.artifact_version !== undefined) {
    if (!isPositiveSafeInteger(page.artifact_version)) throw observationError('page artifact_version must be a positive integer.');
    result.artifact_version = page.artifact_version;
  }
  if (page.semantic_context !== undefined) {
    if (page.semantic_context === null) {
      result.semantic_context = null;
    } else {
      assertBoundedJson(page.semantic_context, {
        label: 'page semantic_context',
        maxBytes: MAX_SEMANTIC_BYTES,
        maxDepth: MAX_SEMANTIC_DEPTH,
        maxNodes: MAX_SEMANTIC_NODES,
        maxArrayItems: MAX_SEMANTIC_ARRAY_ITEMS,
        maxStringLength: MAX_SEMANTIC_STRING_LENGTH,
        maxObjectKeys: MAX_SEMANTIC_OBJECT_KEYS,
        errorKind: 'observation',
      });
      result.semantic_context = cloneJson(page.semantic_context as JsonValue);
    }
  }
  return result;
}
export function isArtifactPageContext(value: unknown): value is ArtifactPageContext {
  try {
    validateArtifactPageContext(value);
    return true;
  } catch {
    return false;
  }
}
export const assertArtifactPageContext = validateArtifactPageContext;
export const validatePageContext = validateArtifactPageContext;

export function validateObservationPacket(value: unknown): ObservationPacket {
  const packet = requirePlainObject(value, 'Artifact observation packet must be an object.', 'observation');
  rejectUnknownKeys(packet, PACKET_KEYS, 'Artifact observation packet', 'observation');
  requireOwnKeys(packet, PACKET_KEYS, 'Artifact observation packet', 'observation');
  if (packet.contract_version !== ARTIFACT_OBSERVATION_PACKET_CONTRACT) {
    throw observationError(`Artifact observation packet contract_version must be ${ARTIFACT_OBSERVATION_PACKET_CONTRACT}.`);
  }
  const artifact = validateTrustedArtifact(packet.artifact);
  const application = validateObservationApplication(packet.application);
  const page = validateObservationPage(packet.page);
  const state = validateObservationState(packet.state);
  const capabilities = validateObservationCapabilities(packet.capabilities, {
    applicationManifest: application.manifest !== null,
    genericSnapshot: page !== null,
    genericDom: state.generic !== null,
    runtimeSnapshot: state.semantic !== null,
    semanticContext: state.semantic !== null,
    resultWriteback: Boolean(application.manifest?.result_sinks?.length),
    agentTasks: Boolean(application.manifest?.task_intents?.length),
  });
  const observedAt = nullableText(packet.observed_at, MAX_OBSERVED_AT_LENGTH, 'observation observed_at', 'observation');
  const snapshot = packet.snapshot === null ? null : validateTrustedSnapshot(packet.snapshot);
  const sources = validateObservationSources(packet.sources, {
    manifest: application.manifest !== null,
    generic: state.generic !== null,
    semantic: state.semantic !== null,
  });
  return {
    contract_version: ARTIFACT_OBSERVATION_PACKET_CONTRACT,
    artifact,
    application,
    page,
    state,
    capabilities,
    observed_at: observedAt,
    snapshot,
    sources,
  };
}

export function checkObservationPacket(value: unknown): string[] {
  try {
    validateObservationPacket(value);
    return [];
  } catch (error) {
    return [errorMessage(error)];
  }
}
export function isObservationPacket(value: unknown): value is ObservationPacket {
  try {
    validateObservationPacket(value);
    return true;
  } catch {
    return false;
  }
}
export const assertObservationPacket = validateObservationPacket;
export const validateArtifactObservationPacket = validateObservationPacket;
export const assertArtifactObservationPacket = validateObservationPacket;

export function validateTaskStatus(value: unknown): TaskStatus {
  const status = requirePlainObject(value, 'Artifact task status must be an object.', 'task');
  rejectUnknownKeys(status, TASK_STATUS_KEYS, 'Artifact task status', 'task');
  if (status.contract_version !== ARTIFACT_TASK_STATUS_CONTRACT) {
    throw taskError(`Artifact task status contract_version must be ${ARTIFACT_TASK_STATUS_CONTRACT}.`);
  }
  if (typeof status.task_id !== 'string' || !TASK_ID_PATTERN.test(status.task_id)) {
    throw taskError('Artifact task status task_id is invalid.');
  }
  if (typeof status.status !== 'string' || !['submitted', 'running', 'completed', 'failed'].includes(status.status)) {
    throw taskError('Artifact task status status is invalid.');
  }
  const result: TaskStatus = {
    contract_version: ARTIFACT_TASK_STATUS_CONTRACT,
    task_id: status.task_id,
    status: status.status as TaskStatusValue,
  };
  copyOptionalText(status, result as unknown as Record<string, unknown>, 'code', MAX_CODE_LENGTH, CODE_PATTERN, 'Artifact task status code', 'task');
  copyOptionalText(status, result as unknown as Record<string, unknown>, 'message', MAX_TASK_MESSAGE_LENGTH, undefined, 'Artifact task status message', 'task');
  copyOptionalText(status, result as unknown as Record<string, unknown>, 'run_id', MAX_RUN_ID_LENGTH, undefined, 'Artifact task status run_id', 'task');
  if (status.result_id !== undefined && status.result_id !== '') {
    if (typeof status.result_id !== 'string' || !RESULT_ID_PATTERN.test(status.result_id)) {
      throw taskError('Artifact task status result_id is invalid.');
    }
    result.result_id = status.result_id;
  }
  copyOptionalText(status, result as unknown as Record<string, unknown>, 'updated_at', MAX_OBSERVED_AT_LENGTH, undefined, 'Artifact task status updated_at', 'task');
  copyOptionalText(status, result as unknown as Record<string, unknown>, 'expires_at', MAX_OBSERVED_AT_LENGTH, undefined, 'Artifact task status expires_at', 'task');
  return result;
}
export function checkTaskStatus(value: unknown): string[] {
  try {
    validateTaskStatus(value);
    return [];
  } catch (error) {
    return [errorMessage(error)];
  }
}
export function isTaskStatus(value: unknown): value is TaskStatus {
  try {
    validateTaskStatus(value);
    return true;
  } catch {
    return false;
  }
}
export const assertTaskStatus = validateTaskStatus;
export const validateArtifactTaskStatus = validateTaskStatus;
export const isArtifactTaskStatus = isTaskStatus;
export const assertArtifactTaskStatus = validateTaskStatus;

export function validateApplicationReceipt(value: unknown, expectedResultId = ''): ApplicationReceipt {
  const receipt = requirePlainObject(value, 'Artifact result receipt must be an object.', 'result');
  rejectUnknownKeys(receipt, RECEIPT_KEYS, 'Artifact result receipt', 'result');
  if (receipt.contract_version !== ARTIFACT_RESULT_RECEIPT_CONTRACT) {
    throw resultError(`Artifact result receipt contract_version must be ${ARTIFACT_RESULT_RECEIPT_CONTRACT}.`);
  }
  if (typeof receipt.result_id !== 'string' || !RESULT_ID_PATTERN.test(receipt.result_id)) {
    throw resultError('Artifact result receipt result_id is invalid.');
  }
  if (expectedResultId && receipt.result_id !== expectedResultId) {
    throw resultError('Artifact result receipt result_id does not match the request.');
  }
  if (typeof receipt.status !== 'string' || !['applied', 'rejected', 'failed'].includes(receipt.status)) {
    throw resultError('Artifact result receipt status is invalid.');
  }
  const result: ApplicationReceipt = {
    contract_version: ARTIFACT_RESULT_RECEIPT_CONTRACT,
    result_id: receipt.result_id,
    status: receipt.status as ApplicationReceiptStatus,
  };
  if (receipt.code !== undefined) {
    if (typeof receipt.code !== 'string' || receipt.code !== receipt.code.trim() || !CODE_PATTERN.test(receipt.code)) {
      throw resultError('Artifact result receipt code is invalid.');
    }
    result.code = receipt.code;
  }
  if (receipt.message !== undefined) {
    result.message = requiredText(receipt.message, MAX_RECEIPT_STRING_LENGTH, 'Artifact result receipt message', 'result');
  }
  if (receipt.receipt !== undefined) {
    assertBoundedJson(receipt.receipt, {
      label: 'Artifact result receipt data',
      maxBytes: MAX_RESULT_RECEIPT_BYTES,
      maxDepth: MAX_RESULT_JSON_DEPTH,
      maxNodes: 2_048,
      maxArrayItems: MAX_RESULT_ARRAY_ITEMS,
      maxStringLength: MAX_RECEIPT_STRING_LENGTH,
      maxObjectKeys: 256,
      errorKind: 'result',
    });
    result.receipt = receipt.receipt as JsonValue;
  }
  return result;
}
export function checkApplicationReceipt(value: unknown, expectedResultId = ''): string[] {
  try {
    validateApplicationReceipt(value, expectedResultId);
    return [];
  } catch (error) {
    return [errorMessage(error)];
  }
}
export function isApplicationReceipt(value: unknown): value is ApplicationReceipt {
  try {
    validateApplicationReceipt(value);
    return true;
  } catch {
    return false;
  }
}
export const assertApplicationReceipt = validateApplicationReceipt;
export const validateArtifactResultReceipt = validateApplicationReceipt;
export const isArtifactResultReceipt = isApplicationReceipt;
export const assertArtifactResultReceipt = validateApplicationReceipt;

/** Validate the short-lived, platform-issued writeback capability. */
export function validateTrustedWritebackTarget(value: unknown): TrustedWritebackTarget {
  const target = requirePlainObject(value, 'Artifact writeback target must be an object.', 'observation');
  const allowed = new Set(['contract_version', 'writeback_ref', 'expires_at', 'task_id']);
  rejectUnknownKeys(target, allowed, 'Artifact writeback target', 'observation');
  if (target.contract_version !== ARTIFACT_WRITEBACK_TARGET_CONTRACT
      || typeof target.writeback_ref !== 'string'
      || !WRITEBACK_REF_PATTERN.test(target.writeback_ref)) {
    throw observationError('Artifact writeback target is invalid.');
  }
  const expiresAt = requiredText(target.expires_at, MAX_OBSERVED_AT_LENGTH, 'writeback target expires_at', 'observation');
  if (!isRFC3339(expiresAt)) throw observationError('Artifact writeback target expires_at is invalid.');
  const result: TrustedWritebackTarget = {
    contract_version: ARTIFACT_WRITEBACK_TARGET_CONTRACT,
    writeback_ref: target.writeback_ref,
    expires_at: expiresAt,
  };
  if (target.task_id !== undefined) {
    if (typeof target.task_id !== 'string' || !TASK_ID_PATTERN.test(target.task_id)) {
      throw observationError('Artifact writeback target task_id is invalid.');
    }
    result.task_id = target.task_id;
  }
  return result;
}
export function isTrustedWritebackTarget(value: unknown): value is TrustedWritebackTarget {
  try {
    validateTrustedWritebackTarget(value);
    return true;
  } catch {
    return false;
  }
}

function validateTrustedArtifact(value: unknown): TrustedArtifactIdentity {
  const artifact = requirePlainObject(value, 'Artifact observation trusted artifact must be an object.', 'observation');
  rejectUnknownKeys(artifact, ARTIFACT_KEYS, 'Trusted Artifact identity', 'observation');
  if (typeof artifact.id !== 'string' || !isCloudArtifactId(artifact.id) || artifact.id.length > MAX_ARTIFACT_ID_LENGTH) {
    throw observationError('Trusted Artifact identity id is invalid.');
  }
  const agentUID = requiredText(artifact.agent_uid, MAX_ARTIFACT_AGENT_UID_LENGTH, 'Trusted Artifact agent_uid', 'observation');
  const title = requiredText(artifact.title, MAX_TITLE_LENGTH, 'Trusted Artifact title', 'observation');
  if (artifact.kind !== 'html' && artifact.kind !== 'mini_app') {
    throw observationError('Trusted Artifact kind is unsupported.');
  }
  if (typeof artifact.url !== 'string' || !isSafeHttpURL(artifact.url)) {
    throw observationError('Trusted Artifact url must be an absolute http(s) URL without credentials or a query.');
  }
  const topicID = requiredText(artifact.topic_id, MAX_TITLE_LENGTH, 'Trusted Artifact topic_id', 'observation');
  if (artifact.currently_visible !== true) throw observationError('Trusted Artifact currently_visible must be true.');
  if (!isPositiveSafeInteger(artifact.displayed_version)) {
    throw observationError('Trusted Artifact displayed_version must be a positive integer.');
  }
  let latestVersion: number | null | undefined;
  if (artifact.latest_version !== undefined && artifact.latest_version !== null) {
    if (!isPositiveSafeInteger(artifact.latest_version)) throw observationError('Trusted Artifact latest_version is invalid.');
    latestVersion = artifact.latest_version;
    if (artifact.displayed_version > artifact.latest_version) {
      throw observationError('Displayed Artifact version is newer than latest_version.');
    }
  } else if (artifact.latest_version === null) {
    latestVersion = null;
  }
  return {
    id: artifact.id,
    agent_uid: agentUID,
    title,
    kind: artifact.kind,
    url: artifact.url,
    topic_id: topicID,
    currently_visible: true,
    displayed_version: artifact.displayed_version,
    ...(latestVersion !== undefined ? { latest_version: latestVersion } : {}),
  };
}

function validateTrustedSnapshot(value: unknown): TrustedSnapshot {
  const snapshot = requirePlainObject(value, 'Artifact observation snapshot must be an object.', 'observation');
  rejectUnknownKeys(snapshot, SNAPSHOT_KEYS, 'Artifact observation snapshot', 'observation');
  const created = requiredText(snapshot.created_at, MAX_OBSERVED_AT_LENGTH, 'snapshot created_at', 'observation');
  const expires = requiredText(snapshot.expires_at, MAX_OBSERVED_AT_LENGTH, 'snapshot expires_at', 'observation');
  if (!isRFC3339(created) || !isRFC3339(expires) || Date.parse(expires) <= Date.parse(created)) {
    throw observationError('Artifact observation snapshot timestamps are invalid.');
  }
  if (!isPositiveSafeInteger(snapshot.revision) || snapshot.revision > MAX_SNAPSHOT_REVISION) {
    throw observationError('Artifact observation snapshot revision is invalid.');
  }
  return { created_at: created, expires_at: expires, revision: snapshot.revision };
}

function validateObservationApplication(value: unknown): ObservationApplication {
  const application = requirePlainObject(value, 'Artifact observation application must be an object.', 'observation');
  rejectUnknownKeys(application, APPLICATION_KEYS, 'Artifact observation application', 'observation');
  requireOwnKeys(application, APPLICATION_KEYS, 'Artifact observation application', 'observation');
  if (!isArtifactManifestStatus(application.manifest_status)) {
    throw observationError('Artifact observation manifest_status is invalid.');
  }
  const manifest = application.manifest === null ? null : validateArtifactManifest(application.manifest);
  if (application.manifest_status === 'available' && manifest === null) {
    throw observationError('Available Artifact manifest must be present.');
  }
  if (application.manifest_status !== 'available' && manifest !== null) {
    throw observationError('Only an available Artifact manifest may be present.');
  }
  return { manifest_status: application.manifest_status, manifest };
}

function validateObservationPage(value: unknown): ObservationPage | null {
  if (value === null) return null;
  const page = requirePlainObject(value, 'Artifact observation page must be an object or null.', 'observation');
  rejectUnknownKeys(page, PAGE_KEYS, 'Artifact observation page', 'observation');
  requireOwnKeys(page, PAGE_KEYS, 'Artifact observation page', 'observation');
  const title = nullableText(page.title, MAX_PAGE_TITLE_LENGTH, 'observation page title', 'observation');
  const view = nullableText(page.view, MAX_LIST_ITEM_LENGTH, 'observation page view', 'observation');
  let location: ObservationPage['location'] = null;
  if (page.location !== null && page.location !== undefined) {
    const raw = requirePlainObject(page.location, 'Artifact observation location must be an object or null.', 'observation');
    rejectUnknownKeys(raw, LOCATION_KEYS, 'Artifact observation location', 'observation');
    const pathname = optionalText(raw.pathname, MAX_PATHNAME_LENGTH);
    const hash = optionalText(raw.hash, MAX_HASH_LENGTH);
    location = {
      ...(pathname !== null ? { pathname } : {}),
      ...(hash !== null ? { hash } : {}),
    };
  }
  return { title, location, view };
}

function validateObservationState(value: unknown): ObservationPacket['state'] {
  const state = requirePlainObject(value, 'Artifact observation state must be an object.', 'observation');
  rejectUnknownKeys(state, STATE_KEYS, 'Artifact observation state', 'observation');
  requireOwnKeys(state, STATE_KEYS, 'Artifact observation state', 'observation');
  let generic: ObservationGenericState | null = null;
  if (state.generic !== null) {
    const raw = requirePlainObject(state.generic, 'Artifact observation generic state must be an object or null.', 'observation');
    rejectUnknownKeys(raw, GENERIC_STATE_KEYS, 'Artifact observation generic state', 'observation');
    generic = {};
    if (raw.selected_text !== undefined) generic.selected_text = requiredText(raw.selected_text, MAX_SELECTED_TEXT_LENGTH, 'selected_text', 'observation');
    if (raw.last_interaction !== undefined) {
      assertBoundedJson(raw.last_interaction, genericBounds('generic last_interaction'));
      generic.last_interaction = raw.last_interaction as JsonValue;
    }
    if (raw.controls !== undefined) {
      if (!Array.isArray(raw.controls) || raw.controls.length > 24) throw observationError('generic controls must contain at most 24 items.');
      raw.controls.forEach((item, index) => assertBoundedJson(item, genericBounds(`generic controls[${index}]`)));
      generic.controls = raw.controls as JsonValue[];
    }
    if (raw.dirty !== undefined) {
      if (typeof raw.dirty !== 'boolean') throw observationError('generic dirty must be boolean.');
      generic.dirty = raw.dirty;
    }
    if (raw.artifact_version !== undefined) {
      if (!isPositiveSafeInteger(raw.artifact_version)) throw observationError('generic artifact_version must be a positive integer.');
      generic.artifact_version = raw.artifact_version;
    }
    if (!Object.keys(generic).length) throw observationError('Artifact observation generic state must contain at least one field.');
    assertBoundedJson(generic, genericBounds('Artifact observation generic state'));
  }
  let semantic: JsonValue | null = null;
  if (state.semantic !== null) {
    assertBoundedJson(state.semantic, {
      label: 'Artifact observation semantic state',
      maxBytes: MAX_SEMANTIC_BYTES,
      maxDepth: MAX_SEMANTIC_DEPTH,
      maxNodes: MAX_SEMANTIC_NODES,
      maxArrayItems: MAX_SEMANTIC_ARRAY_ITEMS,
      maxStringLength: MAX_SEMANTIC_STRING_LENGTH,
      maxObjectKeys: MAX_SEMANTIC_OBJECT_KEYS,
      errorKind: 'observation',
    });
    semantic = state.semantic as JsonValue;
    if (!hasSemanticContent(semantic)) throw observationError('Artifact observation semantic state must contain data.');
  }
  return { generic, semantic };
}

function validateObservationCapabilities(value: unknown, expected: {
  applicationManifest: boolean;
  genericSnapshot: boolean;
  genericDom: boolean;
  runtimeSnapshot: boolean;
  semanticContext: boolean;
  resultWriteback: boolean;
  agentTasks: boolean;
}): ObservationCapabilities {
  const capabilities = requirePlainObject(value, 'Artifact observation capabilities must be an object.', 'observation');
  rejectUnknownKeys(capabilities, CAPABILITY_KEYS, 'Artifact observation capabilities', 'observation');
  requireOwnKeys(capabilities, CAPABILITY_KEYS, 'Artifact observation capabilities', 'observation');
  const result = {
    application_manifest: requireBoolean(capabilities.application_manifest, 'application_manifest'),
    generic_snapshot: requireBoolean(capabilities.generic_snapshot, 'generic_snapshot'),
    generic_dom: requireBoolean(capabilities.generic_dom, 'generic_dom'),
    runtime_snapshot: requireBoolean(capabilities.runtime_snapshot, 'runtime_snapshot'),
    semantic_context: requireBoolean(capabilities.semantic_context, 'semantic_context'),
    result_writeback: requireBoolean(capabilities.result_writeback, 'result_writeback'),
    agent_tasks: requireBoolean(capabilities.agent_tasks, 'agent_tasks'),
  };
  const pairs: Array<[boolean, boolean, string]> = [
    [result.application_manifest, expected.applicationManifest, 'application_manifest'],
    [result.generic_snapshot, expected.genericSnapshot, 'generic_snapshot'],
    [result.generic_dom, expected.genericDom, 'generic_dom'],
    [result.runtime_snapshot, expected.runtimeSnapshot, 'runtime_snapshot'],
    [result.semantic_context, expected.semanticContext, 'semantic_context'],
    [result.result_writeback, expected.resultWriteback, 'result_writeback'],
    [result.agent_tasks, expected.agentTasks, 'agent_tasks'],
  ];
  for (const [actual, wanted, key] of pairs) {
    if (actual !== wanted) throw observationError(`Artifact observation capability ${key} is inconsistent with packet data.`);
  }
  return result;
}

function validateObservationSources(value: unknown, expected: { manifest: boolean; generic: boolean; semantic: boolean }): ObservationSources {
  const sources = requirePlainObject(value, 'Artifact observation sources must be an object.', 'observation');
  rejectUnknownKeys(sources, SOURCE_KEYS, 'Artifact observation sources', 'observation');
  requireOwnKeys(sources, SOURCE_KEYS, 'Artifact observation sources', 'observation');
  if (sources.artifact !== 'platform_confirmed') throw observationError('Artifact observation artifact source is invalid.');
  const manifest = expected.manifest ? 'artifact_authored_untrusted' : 'absent';
  const generic = expected.generic ? 'bridge_observed_untrusted' : 'absent';
  const semantic = expected.semantic ? 'page_authored_untrusted' : 'absent';
  if (sources.manifest !== manifest || sources.generic_state !== generic || sources.semantic_state !== semantic) {
    throw observationError('Artifact observation source labels are inconsistent with packet data.');
  }
  return { artifact: 'platform_confirmed', manifest, generic_state: generic, semantic_state: semantic };
}

function normalizeSchema(value: unknown, label: string, depth: number, budget: { nodes: number }): BoundedJsonSchema {
  if (depth > MAX_RESULT_SCHEMA_DEPTH || budget.nodes <= 0) throw resultError(`${label} exceeds the supported schema complexity.`);
  budget.nodes -= 1;
  const schema = requirePlainObject(value, `${label} must be an object.`, 'result');
  const type = requiredText(schema.type, 32, `${label}.type`, 'result');
  if (!SCHEMA_TYPES.has(type)) throw resultError(`${label}.type is unsupported: ${type}.`);
  const allowed = new Set([...SCHEMA_COMMON_KEYS, ...(SCHEMA_TYPE_KEYS[type] || [])]);
  rejectUnknownKeys(schema, allowed, label, 'result');
  const result: Record<string, unknown> = { type };
  if (schema.title !== undefined) result.title = requiredText(schema.title, MAX_SCHEMA_TITLE_LENGTH, `${label}.title`, 'result');
  if (schema.description !== undefined) result.description = requiredText(schema.description, MAX_SCHEMA_TEXT_LENGTH, `${label}.description`, 'result');
  if (schema.enum !== undefined) result.enum = normalizeEnum(schema.enum, type, `${label}.enum`);

  if (type === 'object') {
    const properties = schema.properties === undefined ? {} : schema.properties;
    const propertyObject = requirePlainObject(properties, `${label}.properties must be an object.`, 'result');
    const keys = Object.keys(propertyObject).sort();
    if (keys.length > MAX_RESULT_SCHEMA_PROPERTIES) throw resultError(`${label}.properties has too many entries.`);
    const normalizedProperties: Record<string, BoundedJsonSchema> = {};
    for (const key of keys) {
      validatePropertyName(key, `${label}.properties`, 'result');
      normalizedProperties[key] = normalizeSchema(propertyObject[key], `${label}.properties.${key}`, depth + 1, budget);
    }
    if (keys.length) result.properties = normalizedProperties;
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.length > keys.length) {
        throw resultError(`${label}.required must be an array of declared property names.`);
      }
      assertDenseArray(schema.required, `${label}.required`, 'result');
      const seen = new Set<string>();
      const required = schema.required.map((key, index) => {
        validatePropertyName(key, `${label}.required[${index}]`, 'result');
        if (!Object.hasOwn(normalizedProperties, key) || seen.has(key)) throw resultError(`${label}.required contains an unknown or duplicate property.`);
        seen.add(key);
        return key;
      });
      if (required.length) result.required = required;
    }
    if (schema.additionalProperties !== undefined) {
      if (typeof schema.additionalProperties !== 'boolean') throw resultError(`${label}.additionalProperties must be boolean.`);
      result.additionalProperties = schema.additionalProperties;
    }
  }
  if (type === 'array') {
    if (schema.items === undefined) throw resultError(`${label}.items is required for arrays.`);
    result.items = normalizeSchema(schema.items, `${label}.items`, depth + 1, budget);
    const minItems = optionalNonNegativeInteger(schema.minItems, `${label}.minItems`, MAX_RESULT_ARRAY_ITEMS, 'result');
    const maxItems = optionalNonNegativeInteger(schema.maxItems, `${label}.maxItems`, MAX_RESULT_ARRAY_ITEMS, 'result');
    if (minItems !== null) result.minItems = minItems;
    if (maxItems !== null) result.maxItems = maxItems;
    if (minItems !== null && maxItems !== null && minItems > maxItems) throw resultError(`${label}.minItems cannot exceed maxItems.`);
  }
  if (type === 'string') {
    const minLength = optionalNonNegativeInteger(schema.minLength, `${label}.minLength`, 1_000_000, 'result');
    const maxLength = optionalNonNegativeInteger(schema.maxLength, `${label}.maxLength`, 1_000_000, 'result');
    if (minLength !== null) result.minLength = minLength;
    if (maxLength !== null) result.maxLength = maxLength;
    if (minLength !== null && maxLength !== null && minLength > maxLength) throw resultError(`${label}.minLength cannot exceed maxLength.`);
  }
  if (type === 'number' || type === 'integer') {
    const minimum = optionalFiniteNumber(schema.minimum, `${label}.minimum`, 'result');
    const maximum = optionalFiniteNumber(schema.maximum, `${label}.maximum`, 'result');
    if (minimum !== null) result.minimum = minimum;
    if (maximum !== null) result.maximum = maximum;
    if (minimum !== null && maximum !== null && minimum > maximum) throw resultError(`${label}.minimum cannot exceed maximum.`);
  }
  return result as unknown as BoundedJsonSchema;
}

function normalizeEnum(value: unknown, type: string, label: string): JsonPrimitive[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RESULT_SCHEMA_ENUM_ITEMS) throw resultError(`${label} must be a non-empty bounded array.`);
  assertDenseArray(value, label, 'result');
  const seen = new Set<string>();
  const result: JsonPrimitive[] = [];
  for (const item of value) {
    const valid = type === 'null' ? item === null
      : type === 'integer' ? Number.isSafeInteger(item)
        : type === 'number' ? typeof item === 'number' && Number.isFinite(item)
          : type === 'string' || type === 'boolean' ? typeof item === type
            : false;
    if (!valid) throw resultError(`${label} contains a value incompatible with ${type}.`);
    const key = JSON.stringify(item);
    if (seen.has(key)) throw resultError(`${label} must not contain duplicates.`);
    seen.add(key);
    result.push(item as JsonPrimitive);
  }
  return result;
}

function validateValueAgainstSchema(schema: BoundedJsonSchema, value: unknown, path: string): void {
  const typeOK = schema.type === 'null' ? value === null
    : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'object' ? isPlainObject(value)
        : schema.type === 'integer' ? Number.isSafeInteger(value)
          : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === schema.type;
  if (!typeOK) throw resultError(`${path} must be ${schema.type}.`, { path });
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) throw resultError(`${path} is not an allowed enum value.`, { path });
  if (schema.type === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required || []) if (!Object.hasOwn(object, key)) throw resultError(`${path}.${key} is required.`, { path: `${path}.${key}` });
    for (const [key, child] of Object.entries(object)) {
      const childSchema = schema.properties?.[key];
      if (childSchema !== undefined) validateValueAgainstSchema(childSchema, child, `${path}.${key}`);
      else if (schema.additionalProperties === false) throw resultError(`${path}.${key} is not allowed.`, { path: `${path}.${key}` });
    }
  }
  if (schema.type === 'array') {
    const array = value as unknown[];
    if (schema.minItems !== undefined && array.length < schema.minItems) throw resultError(`${path} has fewer than ${schema.minItems} items.`, { path });
    if (schema.maxItems !== undefined && array.length > schema.maxItems) throw resultError(`${path} has more than ${schema.maxItems} items.`, { path });
    array.forEach((item, index) => validateValueAgainstSchema(schema.items, item, `${path}[${index}]`));
  }
  if (schema.type === 'string') {
    const length = Array.from(value as string).length;
    if (schema.minLength !== undefined && length < schema.minLength) throw resultError(`${path} is shorter than ${schema.minLength} characters.`, { path });
    if (schema.maxLength !== undefined && length > schema.maxLength) throw resultError(`${path} exceeds ${schema.maxLength} characters.`, { path });
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const number = value as number;
    if (schema.minimum !== undefined && number < schema.minimum) throw resultError(`${path} is below the minimum.`, { path });
    if (schema.maximum !== undefined && number > schema.maximum) throw resultError(`${path} exceeds the maximum.`, { path });
  }
}

interface JsonBounds {
  label: string;
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxArrayItems: number;
  maxStringLength: number;
  maxObjectKeys: number;
  errorKind: 'observation' | 'result' | 'task';
}
function assertBoundedJson(value: unknown, bounds: JsonBounds): asserts value is JsonValue {
  const budget = { nodes: bounds.maxNodes };
  inspectJsonValue(value, bounds.label, 0, budget, bounds, new Set<object>());
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw contractError(bounds.errorKind, `${bounds.label} must contain serializable JSON.`);
  }
  if (typeof serialized !== 'string' || utf8ByteLength(serialized) > bounds.maxBytes) {
    throw contractError(bounds.errorKind, `${bounds.label} exceeds ${bounds.maxBytes} bytes.`);
  }
}
function inspectJsonValue(value: unknown, label: string, depth: number, budget: { nodes: number }, bounds: JsonBounds, ancestors: Set<object>): void {
  if (depth > bounds.maxDepth || budget.nodes <= 0) throw contractError(bounds.errorKind, `${label} exceeds the supported JSON complexity.`);
  budget.nodes -= 1;
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw contractError(bounds.errorKind, `${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === 'string') {
    if (Array.from(value).length > bounds.maxStringLength) throw contractError(bounds.errorKind, `${label} contains an oversized string.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > bounds.maxArrayItems) throw contractError(bounds.errorKind, `${label} contains more than ${bounds.maxArrayItems} array items.`);
    assertDenseArray(value, label, bounds.errorKind);
    if (ancestors.has(value)) throw contractError(bounds.errorKind, `${label} contains a cyclic value.`);
    ancestors.add(value);
    try {
      value.forEach((item, index) => inspectJsonValue(item, `${label}[${index}]`, depth + 1, budget, bounds, ancestors));
    } finally {
      ancestors.delete(value);
    }
    return;
  }
  if (!isPlainObject(value)) throw contractError(bounds.errorKind, `${label} must contain JSON values only.`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw contractError(bounds.errorKind, `${label} contains unsupported symbol keys.`);
  if (ancestors.has(value)) throw contractError(bounds.errorKind, `${label} contains a cyclic value.`);
  ancestors.add(value);
  const entries = Object.entries(value);
  try {
    if (entries.length > bounds.maxObjectKeys) throw contractError(bounds.errorKind, `${label} contains too many object keys.`);
    for (const [key, child] of entries) {
      validatePropertyName(key, label, bounds.errorKind);
      inspectJsonValue(child, `${label}.${key}`, depth + 1, budget, bounds, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function boundedCloneOrNull(value: unknown, bounds: JsonBounds): JsonValue | null {
  if (value === null) return null;
  try {
    assertBoundedJson(value, bounds);
    return cloneJson(value as JsonValue);
  } catch {
    return null;
  }
}
function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === 'object') {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child);
    return result;
  }
  return value;
}
function genericBounds(label: string): JsonBounds {
  return {
    label,
    maxBytes: MAX_RESULT_PAYLOAD_BYTES,
    maxDepth: MAX_RESULT_JSON_DEPTH,
    maxNodes: MAX_RESULT_JSON_NODES,
    maxArrayItems: 24,
    maxStringLength: MAX_RESULT_STRING_LENGTH,
    maxObjectKeys: 256,
    errorKind: 'observation',
  };
}

function extractGenericPageState(page: Record<string, unknown> | null): ObservationGenericState | null {
  if (!page) return null;
  const generic: ObservationGenericState = {};
  if (Object.hasOwn(page, 'selected_text') && typeof page.selected_text === 'string' && page.selected_text.trim()) generic.selected_text = page.selected_text.trim();
  if (Object.hasOwn(page, 'last_interaction')) {
    const value = boundedCloneOrNull(page.last_interaction, genericBounds('last_interaction'));
    if (value !== null) generic.last_interaction = value;
  }
  if (Object.hasOwn(page, 'controls') && Array.isArray(page.controls) && page.controls.length <= 24) {
    const controls: JsonValue[] = [];
    for (const item of page.controls) {
      const value = boundedCloneOrNull(item, genericBounds('controls'));
      if (value !== null) controls.push(value);
    }
    if (controls.length) generic.controls = controls;
  }
  if (Object.hasOwn(page, 'dirty') && typeof page.dirty === 'boolean') generic.dirty = page.dirty;
  if (Object.hasOwn(page, 'artifact_version') && isPositiveSafeInteger(page.artifact_version)) generic.artifact_version = page.artifact_version;
  return Object.keys(generic).length ? generic : null;
}
function semanticView(value: JsonValue | null): string | null {
  if (!isPlainObject(value)) return null;
  return optionalText(value.view, MAX_LIST_ITEM_LENGTH);
}
function hasSemanticContent(value: JsonValue | null): value is JsonValue {
  if (value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'boolean' || typeof value === 'number') return true;
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}
function normalizeLocation(value: unknown): ObservationPage['location'] {
  if (!isPlainObject(value)) return null;
  const pathname = optionalText(value.pathname, MAX_PATHNAME_LENGTH);
  const hash = optionalText(value.hash, MAX_HASH_LENGTH);
  return {
    ...(pathname !== null ? { pathname } : {}),
    ...(hash !== null ? { hash } : {}),
  };
}
function normalizeManifestStatus(value: unknown): ArtifactManifestStatus {
  return isArtifactManifestStatus(value) ? value : 'missing';
}
function isArtifactManifestStatus(value: unknown): value is ArtifactManifestStatus {
  return typeof value === 'string' && MANIFEST_STATUSES.has(value);
}

function copyOptionalText<T extends Record<string, unknown>>(source: Record<string, unknown>, target: T, key: string, maxLength: number, pattern: RegExp | undefined, label: string, kind: 'observation' | 'result' | 'task'): void {
  const value = source[key];
  if (value === undefined || value === '') return;
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > maxLength || /[\0\r\n]/.test(value)) throw contractError(kind, `${label} is invalid.`);
  if (pattern && !pattern.test(value)) throw contractError(kind, `${label} is invalid.`);
  (target as Record<string, unknown>)[key] = value;
}
function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = optionalText(value, MAX_OBSERVED_AT_LENGTH);
    if (text !== null) return text;
  }
  return null;
}
function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (text.length > maxLength || /[\0\r\n]/.test(text)) return null;
  return text;
}
function nullableText(value: unknown, maxLength: number, label: string, kind: 'observation' | 'result' | 'task'): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, maxLength, label, kind);
}
function requiredText(value: unknown, maxLength: number, label: string, kind: 'observation' | 'result' | 'task'): string {
  if (typeof value !== 'string' || value !== value.trim()) throw contractError(kind, `${label} must be a trimmed string.`);
  const text = value.trim();
  if (!text || Array.from(text).length > maxLength || /[\0\r\n]/.test(text)) throw contractError(kind, `${label} is empty or exceeds ${maxLength} characters.`);
  return text;
}
function optionalTextList(value: unknown, maximumItems: number, label: string, kind: 'observation' | 'result' | 'task'): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) throw contractError(kind, `${label} must be an array with at most ${maximumItems} items.`);
  assertDenseArray(value, label, kind);
  const seen = new Set<string>();
  return value.map((item) => {
    const text = requiredText(item, MAX_LIST_ITEM_LENGTH, `${label} item`, kind);
    if (seen.has(text)) throw contractError(kind, `${label} must not contain duplicates.`);
    seen.add(text);
    return text;
  });
}
function optionalEnumList(value: unknown, maximumItems: number, allowed: Set<string>, label: string, kind: 'observation' | 'result' | 'task'): string[] {
  const result = optionalTextList(value, maximumItems, label, kind);
  for (const item of result) if (!allowed.has(item)) throw contractError(kind, `${label} contains unsupported value: ${item}.`);
  return result;
}
function requiredVersionedId(value: unknown, label: string, kind: 'observation' | 'result' | 'task'): string {
  const text = requiredText(value, MAX_SINK_ID_LENGTH, label, kind);
  if (!SINK_ID_PATTERN.test(text)) throw contractError(kind, `${label} is invalid.`);
  return text;
}
function assertDenseArray(value: unknown[], label: string, kind: 'observation' | 'result' | 'task'): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw contractError(kind, `${label} must not contain sparse items.`);
  }
}
function optionalNonNegativeInteger(value: unknown, label: string, maximum: number, kind: 'observation' | 'result' | 'task'): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw contractError(kind, `${label} must be a non-negative integer no greater than ${maximum}.`);
  return value as number;
}
function optionalRevision(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 128 || /[\0\r\n]/.test(value)) {
    throw resultError(`${label} is invalid.`);
  }
  return value;
}
function optionalFiniteNumber(value: unknown, label: string, kind: 'observation' | 'result' | 'task'): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw contractError(kind, `${label} must be a finite number.`);
  return value;
}
function validatePropertyName(value: unknown, label: string, kind: 'observation' | 'result' | 'task'): void {
  if (typeof value !== 'string' || !value || value.length > MAX_SCHEMA_PROPERTY_NAME_LENGTH || UNSAFE_KEYS.has(value) || /[\0\r\n]/.test(value)) throw contractError(kind, `${label} contains an invalid property name.`);
}
function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string, kind: 'observation' | 'result' | 'task'): void {
  if (Object.getOwnPropertySymbols(value).length > 0) throw contractError(kind, `${label} contains unsupported symbol keys.`);
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw contractError(kind, `${label} contains an unsafe key.`);
    if (!allowed.has(key)) throw contractError(kind, `${label} contains unsupported field: ${key}.`);
  }
}
function requireOwnKeys(value: Record<string, unknown>, required: Set<string>, label: string, kind: 'observation' | 'result' | 'task'): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw contractError(kind, `${label} is missing required field: ${key}.`);
  }
}
function requirePlainObject(value: unknown, message: string, kind: 'observation' | 'result' | 'task'): Record<string, unknown> {
  if (!isPlainObject(value)) throw contractError(kind, message);
  return value;
}
function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw observationError(`Artifact observation ${label} must be boolean.`);
  return value;
}
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isSafeHttpURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    return value === value.trim()
      && value.length <= MAX_LOCATION_LENGTH
      && !/[\0\r\n]/.test(value)
      && parsed.host !== ''
      && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) || 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function contractError(kind: 'observation' | 'result' | 'task', message: string, options: { path?: string } = {}): CloudArtifactContractError {
  if (kind === 'observation') return observationError(message, options);
  if (kind === 'task') return taskError(message, options);
  return resultError(message, options);
}
function observationError(message: string, options: { path?: string } = {}): ArtifactObservationContractError {
  return new ArtifactObservationContractError(message, { code: 'artifact_observation_contract_invalid', path: options.path });
}
function manifestError(message: string): ArtifactObservationContractError {
  return new ArtifactObservationContractError(message, { code: 'artifact_manifest_invalid' });
}
function resultError(message: string, options: { path?: string } = {}): ArtifactResultContractError {
  return new ArtifactResultContractError(message, { code: 'artifact_result_contract_invalid', path: options.path });
}
function taskError(message: string, options: { path?: string } = {}): ArtifactTaskContractError {
  return new ArtifactTaskContractError(message, { code: 'artifact_task_contract_invalid', path: options.path });
}
