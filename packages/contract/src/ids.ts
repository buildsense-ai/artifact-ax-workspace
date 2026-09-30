/**
 * Identifier patterns shared by the page-side Artifact contracts. The
 * patterns mirror cats-company/server artifact validators so a value the page
 * accepts is a value the platform would also accept.
 */

/** Cloud Artifact identifiers (mirrors cloud_artifacts.go). */
export const ARTIFACT_ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/;

/** Runtime namespace and surface names (mirrors artifactRuntimeNamePattern). */
export const RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const RUNTIME_NAME_MAX_LENGTH = 64;

/** Runtime state document keys (mirrors artifactRuntimeDocumentKeyPattern). */
export const RUNTIME_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Request ids for runtime/task request envelopes. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Task intent and result sink identifiers end in an explicit version. */
export const RESULT_SINK_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[1-9]\d*$/;

/** Platform-issued ref shapes. Pages never mint these; they only echo them. */
export const TASK_ID_PATTERN = /^atk_[A-Za-z0-9_-]{43}$/;
export const TASK_REF_PATTERN = /^atr_[A-Za-z0-9_-]{43}$/;
export const RESULT_ID_PATTERN = /^arr_[A-Za-z0-9_-]{43}$/;
export const RUNTIME_RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{43}$/;
export const ARTIFACT_REF_CONTRACT = 'catsco.artifact-ref.v1' as const;

export function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value);
}

export function isRuntimeName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= RUNTIME_NAME_MAX_LENGTH && RUNTIME_NAME_PATTERN.test(value);
}

export function isRuntimeKey(value: unknown): value is string {
  return typeof value === 'string' && RUNTIME_KEY_PATTERN.test(value);
}

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function isResultSinkId(value: unknown): value is string {
  return typeof value === 'string' && RESULT_SINK_ID_PATTERN.test(value);
}

let counter = 0;

/** Mint a request id for a page-initiated envelope. */
export function newRequestId(prefix = 'req'): string {
  counter += 1;
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ?? 'local';
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`;
}
