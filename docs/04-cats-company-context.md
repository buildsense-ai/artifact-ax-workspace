# CatsCo platform context

Facts observed in `../cats-company` that this scaffold builds against.
Recorded as facts-with-sources, not assumptions. Re-verify before relying on
an edge.

## Artifact Runtime 0.2 — the collaboration substrate

`server/artifact_runtime.go`, `server/artifact_runtime_manifest.go`,
`server/store/artifact_runtime.go`, `webapp/src/artifact-runtime-host.js`.

- Page ops reach the host as `catsco.artifact.runtime.request.v1` postMessage
  envelopes; responses are `catsco.artifact.runtime.response.v1`, pushes are
  `catsco.artifact.runtime.event.v1` (event v2 shape carries `data`,
  `task_id`, `run_id`, `result_id`).
- Operations: `connect`, `state.get`, `state.list`, `state.put`,
  `state.patch`, `run.get`, `run.list`, `events.subscribe`,
  `events.unsubscribe`; bot-side adds `run.complete` and observe/apply
  (resolved via `context_ref` or `task_ref`).
- State docs: keyed by `(agentUID, artifactID, namespace, key)` — **shared
  across every viewer and every topic of the artifact**, not per room or
  user. Value ≤300KB JSON (node-bounded), CAS `base_revision`, write emits a
  `state.updated` event in the same transaction.
- Key pattern `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` — **no `/` separator**;
  namespaces match `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$` ≤64.
- The host polls `events.list` at ~1.5s inside the session; viewer access
  requires a verified preview session.
- Manifest: `catsco.artifact-manifest.v4`, `runtime.version` `0.1|0.2`,
  `surfaces[1-32]`, `state[1-32]` namespaces (`read-write` only).
- Runtime 0.2 adds persistent runs (`run_<43>`) and `runtime_state` task
  completion (`completion: {"mode":"runtime_state"}` XOR `result_sink`).
- The runtime-manifest parser is **strict**: any unrecognized root or
  `runtime.*` field rejects the whole manifest
  (`parseArtifactRuntimeManifest` allowlists). App-level conventions like
  `agent_participants` must not ship in a deployed manifest until the
  platform parser accepts them.

## Identity

`server/artifact_identity.go`, `server/artifact_launch.go`,
`webapp/public/artifact-auth.html`, `webapp/src/artifact-context.js`.

- `catsco_artifact_id`: domain cookie (`.catsco.cc`/`.catsco.cn`), HttpOnly,
  signed `v1:uid:exp:username`, default 24h TTL; the **gateway** exchanges it
  via `GET` with the shared gateway token → `{authenticated, uid, username,
  expires_at}`. Opt-in env config; the page never reads it.
- Launch: `POST /api/artifacts/launch` → `POST {gateway}/_gateway/codes`
  → `{app_id, code, expires_at, launch_url}`; the artifact app redeems the
  one-time code for its identity. `identity=guest` fallback on the gateway.
- Preview/task access is bound to authenticated users + preview sessions;
  state writes stamp `updated_by` (username) and `updated_by_uid`.

## Frame bridge (opaque managed frames)

`docs/artifact-frame-bridge.md`, `webapp/src/artifact-context.js`.

- Same-origin artifact URLs render in a `null`-origin sandbox: only the
  handshake crosses the WindowProxy (`*`), context/result payloads ride the
  transferred `MessagePort`; cross-origin frames use exact-origin
  postMessage and do not use the bridge.
- Nonce in `catsco_bridge_nonce` fragment param; the runtime must strip only
  that param via `history.replaceState`; READY echoes nonce + contract +
  bridge id. A second `load` event invalidates the binding.
- A runtime that cannot do the handshake is "legacy": page context returns
  an empty snapshot, result delivery fails with
  `opaque_frame_bridge_required`.

## Tasks, context, results

`server/artifact_task.go`, `server/artifact_task_manifest.go`,
`server/artifact_context.go`, `server/artifact_result_writeback.go`,
`webapp/src/artifact-task-host.js`.

- Page → `catsco.artifact.task.request.v1` after `bridge.ready` → host
  connect; accepted → `catsco.artifact-task-ref.v1`, statuses via
  `catsco.artifact.task.status.v1` (`submitted|running|completed|failed`,
  optional `result_id`, `run_id`, `delivery_status`).
- OBSERVE: host requests page context; `catsco.artifact-page-context.v1`
  ≤16KB, `semantic_context` bounded ≤8KB (depth/array/object limits).
- Result delivery: `catsco.artifact-result.v1` (≤64KB payload) → page must
  return `catsco.artifact-result-receipt.v1` (≤8KB); only `applied`
  completes the loop. Persistent tasks may instead complete via
  `runtime_state` (bot writes state docs; `PutArtifactRuntimeStateForRun`).

## Assumptions (not facts)

- The gateway's code-exchange endpoint shape (`/_exchange/identity`) is
  modeled in `runtime-client/identity.ts` from the launch flow; the gateway
  source is outside this repo — re-check before production.
- Result document key convention `result:<task>` is a scaffold convention;
  the Agent contract only requires the `result` namespace be declared.
