import { describe, expect, it } from 'vitest';
import {
  validateCloudArtifactIndex,
  validateCloudArtifactManagementList,
  validateCloudArtifactOperation,
  validateCloudArtifactNodeURL,
} from './catsco.js';
import { isCloudArtifactId } from './ids.js';

/** Fixtures mirrored from cats-company/server/cloud_artifacts_test.go. */

const VALID_INDEX = {
  contract_version: 'cloud-artifacts.index.v1',
  updated_at: '2026-07-22T06:00:00.000Z',
  artifacts: [
    {
      id: 'lesson-game',
      title: '课堂小游戏',
      kind: 'html',
      url: 'https://example.test/lesson-game/latest/',
      updated_at: '2026-07-22T06:00:00.000Z',
    },
  ],
};

const VALID_MANAGED_ACTIVE = {
  contract_version: 'cloud-artifacts.management-list.v1',
  status: 'active',
  count: 1,
  artifacts: [
    {
      id: 'lesson-game',
      title: '课堂小游戏',
      kind: 'html',
      url: 'https://example.test/lesson-game/latest/',
      status: 'active',
      created_at: '2026-07-22T05:00:00.000Z',
      updated_at: '2026-07-22T06:00:00.000Z',
      publish_version: 2,
      agent_name: '豆包',
      source_title: '课堂任务',
      can_delete: true,
      can_restore: false,
    },
  ],
};

const VALID_MANAGED_DELETED = {
  contract_version: 'cloud-artifacts.management-list.v1',
  status: 'deleted',
  count: 1,
  artifacts: [
    {
      id: 'lesson-game',
      title: '课堂小游戏',
      kind: 'html',
      url: 'https://example.test/lesson-game/latest/',
      status: 'deleted',
      created_at: '2026-07-22T05:00:00.000Z',
      updated_at: '2026-07-22T07:00:00.000Z',
      deleted_at: '2026-07-22T07:00:00.000Z',
      can_delete: false,
      can_restore: true,
    },
  ],
};

describe('cloud artifact id pattern', () => {
  it('mirrors the Go artifactIDPattern', () => {
    expect(isCloudArtifactId('lesson-game')).toBe(true);
    expect(isCloudArtifactId('a')).toBe(true);
    expect(isCloudArtifactId('a.b_c-d')).toBe(true);
    expect(isCloudArtifactId('-lead')).toBe(false);
    expect(isCloudArtifactId('trail-')).toBe(false);
    expect(isCloudArtifactId('UPPER')).toBe(false);
    expect(isCloudArtifactId('with space')).toBe(false);
  });
});

describe('validateCloudArtifactIndex', () => {
  it('accepts the CatsCo fixture index', () => {
    expect(validateCloudArtifactIndex(VALID_INDEX)).toEqual([]);
  });

  it('rejects a wrong contract version', () => {
    expect(validateCloudArtifactIndex({ ...VALID_INDEX, contract_version: 'wrong' })).not.toEqual([]);
  });

  it('rejects invalid kind', () => {
    const bad = { ...VALID_INDEX, artifacts: [{ ...VALID_INDEX.artifacts[0], kind: 'webgl' }] };
    expect(validateCloudArtifactIndex(bad)).toEqual([expect.stringContaining('kind')]);
  });

  it('rejects invalid id', () => {
    const bad = { ...VALID_INDEX, artifacts: [{ ...VALID_INDEX.artifacts[0], id: 'bad id' }] };
    expect(validateCloudArtifactIndex(bad)).toEqual([expect.stringContaining('id')]);
  });

  it('rejects non-http(s) URLs and missing hosts', () => {
    const bad = { ...VALID_INDEX, artifacts: [{ ...VALID_INDEX.artifacts[0], url: 'ftp://example.test/x/' }] };
    expect(validateCloudArtifactIndex(bad)).toEqual([expect.stringContaining('url')]);
    const noHost = { ...VALID_INDEX, artifacts: [{ ...VALID_INDEX.artifacts[0], url: '/relative/path' }] };
    expect(validateCloudArtifactIndex(noHost)).toEqual([expect.stringContaining('url')]);
  });

  it('rejects missing or invalid updated_at', () => {
    const bad = { ...VALID_INDEX, artifacts: [{ ...VALID_INDEX.artifacts[0], updated_at: 'not-a-time' }] };
    expect(validateCloudArtifactIndex(bad)).toEqual([expect.stringContaining('updated_at')]);
  });

  it('rejects duplicate artifact ids (Go: seen set)', () => {
    const bad = {
      contract_version: 'cloud-artifacts.index.v1',
      artifacts: [VALID_INDEX.artifacts[0], { ...VALID_INDEX.artifacts[0] }],
    };
    expect(validateCloudArtifactIndex(bad)).toEqual([expect.stringContaining('duplicate')]);
  });
});

describe('validateCloudArtifactManagementList', () => {
  it('accepts the active managed fixture for status=active', () => {
    expect(validateCloudArtifactManagementList(VALID_MANAGED_ACTIVE, 'active')).toEqual([]);
  });

  it('accepts the deleted managed fixture for status=deleted', () => {
    expect(validateCloudArtifactManagementList(VALID_MANAGED_DELETED, 'deleted')).toEqual([]);
  });

  it('rejects status mismatch against the expected status', () => {
    const errors = validateCloudArtifactManagementList(VALID_MANAGED_ACTIVE, 'deleted');
    expect(errors.join('\n')).toContain('status mismatch');
  });

  it('rejects an active artifact without can_delete (Go: active must be deletable)', () => {
    const bad = {
      ...VALID_MANAGED_ACTIVE,
      artifacts: [{ ...VALID_MANAGED_ACTIVE.artifacts[0], can_delete: false }],
    };
    expect(validateCloudArtifactManagementList(bad, 'active')).toEqual([
      expect.stringContaining('can_delete'),
    ]);
  });

  it('rejects a deleted artifact without can_restore or deleted_at', () => {
    const badNoRestore = {
      ...VALID_MANAGED_DELETED,
      artifacts: [{ ...VALID_MANAGED_DELETED.artifacts[0], can_restore: false }],
    };
    expect(validateCloudArtifactManagementList(badNoRestore, 'deleted')).toEqual([
      expect.stringContaining('can_restore'),
    ]);
    const badNoDeletedAt = {
      ...VALID_MANAGED_DELETED,
      artifacts: [{ ...VALID_MANAGED_DELETED.artifacts[0], deleted_at: undefined }],
    };
    expect(validateCloudArtifactManagementList(badNoDeletedAt, 'deleted')).toEqual([
      expect.stringContaining('deleted_at'),
    ]);
  });

  it('rejects wrong contract version', () => {
    expect(validateCloudArtifactManagementList({ ...VALID_MANAGED_ACTIVE, contract_version: 'nope' }, 'active')).not.toEqual([]);
  });
});

describe('validateCloudArtifactOperation', () => {
  it('accepts an ok operation with a managed artifact', () => {
    const op = { ok: true, artifact: VALID_MANAGED_ACTIVE.artifacts[0] };
    expect(validateCloudArtifactOperation(op)).toEqual([]);
  });

  it('rejects ok=false and invalid artifacts', () => {
    expect(validateCloudArtifactOperation({ ok: false, artifact: VALID_MANAGED_ACTIVE.artifacts[0] })).not.toEqual([]);
    expect(validateCloudArtifactOperation({ ok: true, artifact: { ...VALID_MANAGED_ACTIVE.artifacts[0], kind: 'x' } })).not.toEqual([]);
  });
});

describe('validateCloudArtifactNodeURL', () => {
  const base = 'https://nodes.example.test';

  it('allows artifact URLs under the node base', () => {
    expect(validateCloudArtifactNodeURL(`${base}/by-agent/440/lesson-game/latest/`, base)).toBeNull();
  });

  it('allows the agent-scoped path when the agent matches', () => {
    expect(validateCloudArtifactNodeURL(`${base}/by-agent/440/lesson-game/latest/`, base, 440)).toBeNull();
  });

  it('rejects a different agent scope', () => {
    expect(validateCloudArtifactNodeURL(`${base}/by-agent/512/lesson-game/latest/`, base, 440)).not.toBeNull();
  });

  it('rejects a different host and query strings', () => {
    expect(validateCloudArtifactNodeURL('https://evil.test/by-agent/440/x/', base, 440)).not.toBeNull();
    expect(validateCloudArtifactNodeURL(`${base}/by-agent/440/x/?debug=1`, base, 440)).not.toBeNull();
  });

  it('rejects URLs outside a pathful node base', () => {
    const pathBase = 'https://nodes.example.test/artifacts';
    expect(validateCloudArtifactNodeURL('https://nodes.example.test/by-agent/440/x/', pathBase, 440)).not.toBeNull();
    expect(validateCloudArtifactNodeURL('https://nodes.example.test/artifacts/by-agent/440/x/', pathBase, 440)).toBeNull();
  });
});