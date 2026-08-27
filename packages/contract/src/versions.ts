/**
 * AX contract version constants.
 *
 * The Artifact itself speaks `artifact.ax.v1`. The CatsCo compatibility layer
 * speaks the upstream cloud-artifact contracts exactly as cats-company expects
 * them (verified against ../cats-company/server/cloud_artifacts.go).
 */
export const AX_CONTRACT_VERSION = 'artifact.ax.v1' as const;

/** CatsCo public publish index contract. */
export const CLOUD_ARTIFACTS_INDEX_CONTRACT = 'cloud-artifacts.index.v1' as const;

/** CatsCo protected management list contract. */
export const CLOUD_ARTIFACTS_MANAGEMENT_CONTRACT = 'cloud-artifacts.management-list.v1' as const;

/** CatsCo management mutation response shape uses `ok` + `artifact`. */
export const CLOUD_ARTIFACTS_OPERATION_OK = 'ok' as const;

/**
 * Stable upstream error codes the Artifact node may return so cats-company
 * can map them to user-facing messages. Mirrors allowedArtifactErrorCode in
 * cats-company/server/cloud_artifacts.go.
 */
export const CLOUD_ARTIFACT_ERROR_CODES = [
  'artifact_not_found',
  'artifact_already_deleted',
  'artifact_not_deleted',
  'artifact_path_invalid',
  'artifact_operation_conflict',
] as const;
export type CloudArtifactErrorCode = (typeof CLOUD_ARTIFACT_ERROR_CODES)[number];