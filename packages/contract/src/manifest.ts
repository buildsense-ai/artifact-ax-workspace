import { isArtifactId, isResultSinkId, isRuntimeName } from './ids.js';
import { isRecord } from './validate.js';

/**
 * The versioned application manifest (`artifact-manifest.json`) the platform
 * resolves for one displayed Artifact version. Version 4 is the first
 * contract that may declare an Artifact Runtime.
 *
 * Mirrors cats-company/server/artifact_task_manifest.go and
 * artifact_runtime_manifest.go: field names are the upstream JSON names and
 * every bound below is a bound the platform enforces.
 */

export const ARTIFACT_MANIFEST_FILENAME = 'artifact-manifest.json' as const;
export const ARTIFACT_MANIFEST_CONTRACT_V4 = 'catsco.artifact-manifest.v4' as const;
export const ARTIFACT_MANIFEST_CONTRACT = ARTIFACT_MANIFEST_CONTRACT_V4;

export const ARTIFACT_RUNTIME_VERSION_01 = '0.1' as const;
export const ARTIFACT_RUNTIME_VERSION_02 = '0.2' as const;
export const ARTIFACT_RUNTIME_VERSIONS = [ARTIFACT_RUNTIME_VERSION_01, ARTIFACT_RUNTIME_VERSION_02] as const;
export type ArtifactRuntimeVersion = (typeof ARTIFACT_RUNTIME_VERSIONS)[number];

export const MANIFEST_MAX_SURFACES = 32;
export const MANIFEST_MAX_STATE_NAMESPACES = 32;
export const MANIFEST_MAX_TASK_INTENTS = 16;
export const MANIFEST_MAX_RESULT_SINKS = 16;

/** Minimal JSON-Schema-ish shape used by task inputs and result payloads. */
export interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: readonly string[];
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  minItems?: number;
}

export interface Schema {
  type: 'object';
  properties: Record<string, SchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
  description?: string;
}

export interface RuntimeSurfaceDecl {
  id: string;
  title?: string;
}

export interface RuntimeStateDecl {
  namespace: string;
  /** The platform currently supports read-write namespaces only. */
  mode: 'read-write';
}

/**
 * Declared agent colleague — role metadata only (never a permission grant).
 * Pages attribute task/run activity and render the colleague chip from it;
 * access control always derives from the task/session, not this field.
 */
export interface AgentParticipant {
  uid?: string;
  name: string;
  kind?: 'agent';
}

export const MANIFEST_MAX_AGENT_PARTICIPANTS = 4;

export interface ArtifactRuntimeDecl {
  version: ArtifactRuntimeVersion;
  surfaces: RuntimeSurfaceDecl[];
  state: RuntimeStateDecl[];
  agent_participants?: AgentParticipant[];
}

/**
 * A task intent the page may submit. Exactly one completion channel is
 * declared: `result_sink` delivers a result to the page for human-mediated
 * application, while `completion: {mode: 'runtime_state'}` lets the Agent
 * complete by writing a Runtime State document (requires Runtime 0.2).
 */
export interface TaskIntentDecl {
  id: string;
  title: string;
  description: string;
  input_schema?: Schema;
  result_sink?: string;
  completion?: { mode: 'runtime_state' };
}

export interface ResultSinkDecl {
  id: string;
  description?: string;
  input_schema?: Schema;
}

export interface ArtifactManifestV4 {
  contract_version: typeof ARTIFACT_MANIFEST_CONTRACT_V4;
  purpose?: string;
  views: string[];
  entities: string[];
  entrypoints: string[];
  observation_capabilities: string[];
  result_sinks: ResultSinkDecl[];
  task_intents: TaskIntentDecl[];
  runtime?: ArtifactRuntimeDecl;
}

export interface ManifestCheck {
  ok: boolean;
  errors: string[];
  manifest?: ArtifactManifestV4;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value !== '' && value === value.trim()
    && value.length <= max && !/[\0\r\n]/.test(value) ? value : null;
}

function stringList(value: unknown, name: string, max: number, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    errors.push(`${name} must be an array of at most ${max} strings`);
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const entry = text(item, 128);
    if (entry === null) {
      errors.push(`${name} entries must be bounded strings`);
      return out;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Validate a parsed manifest body against the v4 contract. Structural
 * validation only: the page does not decide whether the platform accepts the
 * manifest, it just refuses to ship a malformed one.
 */
export function validateManifestV4(value: unknown): ManifestCheck {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }
  if (value.contract_version !== ARTIFACT_MANIFEST_CONTRACT_V4) {
    errors.push(`contract_version must be ${ARTIFACT_MANIFEST_CONTRACT_V4}`);
  }
  const purpose = value.purpose === undefined ? undefined : text(value.purpose, 500);
  if (value.purpose !== undefined && purpose === undefined) {
    errors.push('purpose must be a bounded string');
  }
  const views = stringList(value.views, 'views', 32, errors);
  const entities = stringList(value.entities, 'entities', 64, errors);
  const entrypoints = stringList(value.entrypoints, 'entrypoints', 16, errors);
  const observationCapabilities = stringList(value.observation_capabilities, 'observation_capabilities', 16, errors);

  const sinkIds = new Set<string>();
  const resultSinks: ResultSinkDecl[] = [];
  if (value.result_sinks !== undefined) {
    if (!Array.isArray(value.result_sinks) || value.result_sinks.length > MANIFEST_MAX_RESULT_SINKS) {
      errors.push(`result_sinks must be an array of at most ${MANIFEST_MAX_RESULT_SINKS} items`);
    } else {
      for (const [index, raw] of value.result_sinks.entries()) {
        if (!isRecord(raw)) {
          errors.push(`result_sinks[${index}] must be an object`);
          continue;
        }
        const id = text(raw.id, 128);
        if (id === null || !isResultSinkId(id) || sinkIds.has(id)) {
          errors.push(`result_sinks[${index}].id is invalid or duplicated`);
          continue;
        }
        sinkIds.add(id);
        const description = raw.description === undefined ? undefined : text(raw.description, 500);
        resultSinks.push({ id, ...(description ? { description } : {}), ...(isRecord(raw.input_schema) ? { input_schema: raw.input_schema as unknown as Schema } : {}) });
      }
    }
  }

  const taskIntents: TaskIntentDecl[] = [];
  const intentIds = new Set<string>();
  if (value.task_intents !== undefined) {
    if (!Array.isArray(value.task_intents) || value.task_intents.length > MANIFEST_MAX_TASK_INTENTS) {
      errors.push(`task_intents must be an array of at most ${MANIFEST_MAX_TASK_INTENTS} items`);
    } else {
      for (const [index, raw] of value.task_intents.entries()) {
        if (!isRecord(raw)) {
          errors.push(`task_intents[${index}] must be an object`);
          continue;
        }
        const id = text(raw.id, 128);
        const title = text(raw.title, 256);
        const description = text(raw.description, 500);
        if (id === null || !isResultSinkId(id) || intentIds.has(id) || title === null || description === null) {
          errors.push(`task_intents[${index}] is invalid`);
          continue;
        }
        const resultSinkRaw = raw.result_sink === undefined ? undefined : text(raw.result_sink, 128);
        if (raw.result_sink !== undefined && resultSinkRaw === null) {
          errors.push(`task_intents[${index}].result_sink is invalid`);
          continue;
        }
        const resultSink = resultSinkRaw ?? undefined;
        const hasCompletion = isRecord(raw.completion);
        if ((resultSink === undefined) === !hasCompletion) {
          errors.push(`task_intents[${index}] must declare exactly one of result_sink or completion`);
          continue;
        }
        if (resultSink !== undefined && !sinkIds.has(resultSink)) {
          errors.push(`task_intents[${index}].result_sink is not a declared sink`);
          continue;
        }
        let completion: TaskIntentDecl['completion'];
        if (hasCompletion) {
          const mode = (raw.completion as Record<string, unknown>).mode;
          if (mode !== 'runtime_state' || Object.keys(raw.completion as object).length !== 1) {
            errors.push(`task_intents[${index}].completion must be {"mode":"runtime_state"}`);
            continue;
          }
          completion = { mode: 'runtime_state' };
        }
        intentIds.add(id);
        taskIntents.push({
          id, title, description,
          ...(isRecord(raw.input_schema) ? { input_schema: raw.input_schema as unknown as Schema } : {}),
          ...(resultSink !== undefined ? { result_sink: resultSink } : {}),
          ...(completion ? { completion } : {}),
        });
      }
    }
  }

  let runtime: ArtifactRuntimeDecl | undefined;
  if (value.runtime !== undefined) {
    if (!isRecord(value.runtime)) {
      errors.push('runtime must be an object');
    } else {
      const version = text(value.runtime.version, 16) as ArtifactRuntimeVersion | null;
      if (version === null || !ARTIFACT_RUNTIME_VERSIONS.includes(version)) {
        errors.push('runtime.version must be "0.1" or "0.2"');
      }
      const surfaces: RuntimeSurfaceDecl[] = [];
      if (!Array.isArray(value.runtime.surfaces) || value.runtime.surfaces.length === 0
        || value.runtime.surfaces.length > MANIFEST_MAX_SURFACES) {
        errors.push(`runtime.surfaces must contain 1-${MANIFEST_MAX_SURFACES} items`);
      } else {
        const seen = new Set<string>();
        for (const [index, raw] of value.runtime.surfaces.entries()) {
          if (!isRecord(raw) || !isRuntimeName(raw.id) || seen.has(raw.id as string)) {
            errors.push(`runtime.surfaces[${index}].id is invalid or duplicated`);
            continue;
          }
          seen.add(raw.id as string);
          const title2 = raw.title === undefined ? undefined : text(raw.title, 128);
          surfaces.push({ id: raw.id as string, ...(title2 ? { title: title2 } : {}) });
        }
      }
      const states: RuntimeStateDecl[] = [];
      if (!Array.isArray(value.runtime.state) || value.runtime.state.length === 0
        || value.runtime.state.length > MANIFEST_MAX_STATE_NAMESPACES) {
        errors.push(`runtime.state must contain 1-${MANIFEST_MAX_STATE_NAMESPACES} items`);
      } else {
        const seen = new Set<string>();
        for (const [index, raw] of value.runtime.state.entries()) {
          if (!isRecord(raw) || !isRuntimeName(raw.namespace) || seen.has(raw.namespace as string)
            || raw.mode !== 'read-write') {
            errors.push(`runtime.state[${index}] is invalid or duplicated`);
            continue;
          }
          seen.add(raw.namespace as string);
          states.push({ namespace: raw.namespace as string, mode: 'read-write' });
        }
      }
      let agentParticipants: AgentParticipant[] | undefined;
      if (value.runtime.agent_participants !== undefined) {
        if (!Array.isArray(value.runtime.agent_participants)
          || value.runtime.agent_participants.length === 0
          || value.runtime.agent_participants.length > MANIFEST_MAX_AGENT_PARTICIPANTS) {
          errors.push(`runtime.agent_participants must contain 1-${MANIFEST_MAX_AGENT_PARTICIPANTS} items`);
        } else {
          const seen = new Set<string>();
          agentParticipants = [];
          for (const [index, raw] of value.runtime.agent_participants.entries()) {
            const name = isRecord(raw) ? text(raw.name, 64) : null;
            const uid = isRecord(raw) && raw.uid !== undefined ? text(raw.uid, 64) : undefined;
            const kind = isRecord(raw) && raw.kind !== undefined ? text(raw.kind, 32) : undefined;
            if (name === null || (kind !== undefined && kind !== 'agent')
              || (raw as Record<string, unknown>).uid !== undefined && uid === undefined) {
              errors.push(`runtime.agent_participants[${index}] is invalid`);
              continue;
            }
            const dedupe = `${uid ?? ''}|${name}`;
            if (seen.has(dedupe)) {
              errors.push(`runtime.agent_participants[${index}] is duplicated`);
              continue;
            }
            seen.add(dedupe);
            agentParticipants.push({ name, ...(uid ? { uid } : {}), kind: 'agent' });
          }
        }
      }
      if (version && surfaces.length > 0 && states.length > 0) {
        runtime = {
          version,
          surfaces,
          state: states,
          ...(agentParticipants && agentParticipants.length > 0 ? { agent_participants: agentParticipants } : {}),
        };
      }
    }
  }
  if (taskIntents.some((intent) => intent.completion) && runtime?.version !== ARTIFACT_RUNTIME_VERSION_02) {
    errors.push('runtime_state task completion requires runtime.version "0.2"');
  }

  const manifest: ArtifactManifestV4 = {
    contract_version: ARTIFACT_MANIFEST_CONTRACT_V4,
    ...(purpose ? { purpose } : {}),
    views, entities, entrypoints,
    observation_capabilities: observationCapabilities,
    result_sinks: resultSinks,
    task_intents: taskIntents,
    ...(runtime ? { runtime } : {}),
  };
  return { ok: errors.length === 0, errors, manifest: errors.length === 0 ? manifest : undefined };
}

/** Convenience: namespaces the manifest allows for a write. */
export function manifestAllowsNamespace(manifest: ArtifactManifestV4, namespace: string, write: boolean): boolean {
  if (!manifest.runtime) return false;
  for (const declaration of manifest.runtime.state) {
    if (declaration.namespace === namespace) {
      return !write || declaration.mode === 'read-write';
    }
  }
  return false;
}

export { isArtifactId };
