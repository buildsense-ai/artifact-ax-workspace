# References

## Platform sources of truth (read-only)

Everything in `docs/03-page-contract.md` is mirrored from these files;
re-check them when the platform changes:

- `../cats-company/server/artifact_runtime.go` — runtime ops, viewer/agent
  access resolution, state/event/run responses
- `../cats-company/server/artifact_runtime_manifest.go` — manifest v4 +
  runtime block parsing and bounds
- `../cats-company/server/store/artifact_runtime.go` — state doc, event,
  CAS conflict, store interface
- `../cats-company/server/store/artifact_runtime_run.go` — persistent runs
- `../cats-company/server/artifact_task_manifest.go` — task intents,
  result sinks, `runtime_state` completion
- `../cats-company/server/artifact_task.go` — task lifecycle + status
- `../cats-company/server/artifact_context.go` — OBSERVE page context
- `../cats-company/server/artifact_result_writeback.go` — result delivery
  and receipts
- `../cats-company/server/artifact_identity.go` — `catsco_artifact_id`
  domain cookie + gateway identity lookup
- `../cats-company/server/artifact_launch.go` — one-time launch codes
- `../cats-company/docs/artifact-frame-bridge.md` — opaque frame bridge
- `../cats-company/webapp/src/artifact-context.js` — message types,
  page-context/result/task normalizers, message policy
- `../cats-company/webapp/src/artifact-task-host.js` — task host, statuses
- `../cats-company/webapp/src/artifact-runtime-host.js` — runtime request
  normalization, event polling
- `../cats-company/webapp/public/artifact-auth.html` — identity handshake
  page (`identity=guest` fallback)

## Yjs

- [Yjs](https://github.com/yjs/yjs) — CRDT document used for `shared`
  doc convergence (`Y.Doc`, `encodeStateAsUpdate`, `applyUpdate`).

## Prior architecture (removed)

The cats-company-node scaffolding this workspace replaced is in git history
(`git log` before 2026-09-27): artifact node, AX gateway + `artifactctl`,
standalone bridge + AG-UI, transitional auth adapter, XiaoBa skill
packaging. Kept for archaeology, not for reuse.
