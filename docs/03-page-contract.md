# Page contract

Everything the artifact page sends or receives, with the exact contract
strings the platform hosts validate against. Sources of truth are listed in
`references.md`.

## Channels

| Frame type | Channel |
| --- | --- |
| Cross-origin managed frame (`artifact.catsco.cc` inside `app.catsco.cc`) | `postMessage` with exact origins |
| Same-origin managed frame (opaque `null` origin) | `catsco.artifact-frame-bridge.v1` handshake → transferred `MessagePort` carries context/result envelopes |

The client (`packages/runtime-client`) listens on both channels and replies
on the one a request arrived on.

## Handshake (opaque frames)

1. Host puts `catsco_bridge_nonce=<nonce>` in the iframe URL fragment.
2. Page reads the nonce on first load and **strips it**
   (`history.replaceState`) before exposing the fragment.
3. Host sends `catsco.artifact.frame-bridge.request.v1` with one transferred
   `MessagePort`.
4. Page replies on the port with `catsco.artifact.frame-bridge.ready.v1`
   (`contract_version`, exact `nonce`, `bridge_id`). Nonce and port are
   one-document capabilities — discarded on navigation.

## Page → host (postMessage)

- `catsco.artifact.bridge.ready.v1` — announces the app is up; host replies
  `catsco.artifact.host.connect.v1`. Tasks require the connect.
- `catsco.artifact.runtime.request.v1` `{type, request_id, operation, payload}`
  → `catsco.artifact.runtime.response.v1` `{type, request_id, response}`.

  | operation | payload | response (inside `response`) |
  | --- | --- | --- |
  | `connect` | — | `artifact`, `runtime` (manifest), `event_cursor`, `runs` |
  | `state.get` | `namespace`, `key` | `state` (`catsco.artifact-runtime-state.v1`) |
  | `state.list` | — | `state_refs[]`, `truncated` |
  | `state.put` | `namespace`, `key`, `base_revision`, `value` | `state`, `event` |
  | `state.patch` | `namespace`, `key`, `base_revision>0`, `patch[≤64]` | `state`, `event` |
  | `events.subscribe` | `after_event_id?` | `event_cursor`; then `catsco.artifact.runtime.event.v1` pushes |
  | `events.unsubscribe` | — | `ok` |
  | `run.get` / `run.list` | `run_id` / — | `run` / `runs` (Runtime 0.2 only) |

  Errors come back `{ok:false, error:{code,message,current_revision?}}`;
  `revision_conflict` carries the current revision for CAS retry.

- `catsco.artifact.task.request.v1` `{type, request_id, intent_id, payload≤64KB}`
  → `catsco.artifact.task.accepted.v1` (`catsco.artifact-task-ref.v1`:
  `task_id`, `task_ref`, `visible_message`, optional `run_id`,
  `completion_mode`) or `catsco.artifact.task.rejected.v1`; then
  `catsco.artifact.task.status.v1` pushes (`submitted|running|completed|failed`,
  `result_id`, `delivery_status`…).

## Host → page

- `catsco.artifact.context.request.v1` (OBSERVE) → page replies
  `catsco.artifact.context.response.v1` with a bounded
  `catsco.artifact-page-context.v1` (≤16KB; `semantic_context` ≤8KB). The
  template puts `semantic_mode: 'final-state'` and the `runtime_view`
  projection inside `semantic_context`.
- `catsco.artifact.result.request.v1` (`catsco.artifact-result.v1`:
  `sink_id`, `result_id`, `payload`, optional `expected_state_revision`) →
  page replies `catsco.artifact.result.response.v1` with a
  `catsco.artifact-result-receipt.v1` (`status: applied|rejected|failed`) —
  `applied` only after the application's own persistence succeeded.

## Identity

- Launch: `artifact-auth.html` (platform origin) → `POST /api/artifacts/launch`
  → one-time code embedded in `launch_url`. The app exchanges the code at the
  gateway (`{uid, username}`) — `packages/runtime-client/identity.ts`.
- `identity=guest` is the explicit visitor fallback.
- The `catsco_artifact_id` domain cookie is **gateway-side only** (HttpOnly,
  exchanged by the gateway with the shared token); the page never sees it.
- Dev: `?as=<name>` mints a deterministic dev identity.
- Standalone deploys (direct URL, no launch code): the app's own backend
  exposes `GET api/whoami`, forwarding the domain cookie to the gateway's
  viewer lookup → `catsco.artifact-viewer.v1` `{authenticated, viewer}`.
  `resolveIdentity` tries it before falling back to guest.

## Standalone runtime bridge

A standalone page has no frame-bridge host — but it can still reach real
Runtime State through the app's backend, which holds the app-scoped gateway
credential. Same-origin endpoints (`HttpRuntimeSession` in runtime-client):

| Endpoint | Body | Returns |
|---|---|---|
| `POST api/runtime/connect` | — | `{artifact, runtime, event_cursor, runs?}` |
| `POST api/runtime/state.get` | `{namespace, key}` | `{state}` |
| `POST api/runtime/state.list` | — | `{state_refs, truncated}` |
| `POST api/runtime/state.put` | `{namespace, key, base_revision, value}` | `{state, event?}` |
| `POST api/runtime/state.patch` | `{namespace, key, base_revision, patch}` | `{state, event?}` |
| `GET api/runtime/events?after=<cursor>` | — | `{events, cursor}` — long-poll; pseudo-events `{type:'task.status', task:{...}}` / `{type:'task.rejected', rejected:{...}}` ride the same stream |
| `POST api/runtime/task.submit` | `{intent_id, payload}` | `{task}` or `4xx {code,message}` |
| `GET api/whoami` | — | `catsco.artifact-viewer.v1` |

Missing bridge → the page falls back to the BroadcastChannel mock
(`?mock=1` forces it). The in-page scripted colleague is mock-only: on a
real session, agent writes must be stamped by the bot's own uid, so the
server-side colleague runs against the backend bridge instead.

## Manifest v4

`artifact-manifest.json` (`catsco.artifact-manifest.v4`), fetched per
displayed version, no redirects allowed:

- `runtime.version: "0.2"` (or `"0.1"`), `runtime.surfaces[1-32]`,
  `runtime.state[1-32]` namespaces with `mode: "read-write"`.
- `task_intents[]`: each declares `id` (`*.vN`), `title`, `description`,
  optional `input_schema`, and **exactly one** of `result_sink` (declared
  sink id) or `completion: {"mode":"runtime_state"}` — the latter requires
  runtime `0.2` and means the Agent completes by writing a Runtime State
  document.
- `lesson-report.judge-view.v1` (JEV judge): input
  `{contract_version: 'lesson-report.judge-task.v1', room, proposal:
  {proposal_id, base_revision, row_ids, document}}`; completes
  `runtime_state` by writing `result:<task>` =
  `lesson-report.view-judgment.v1` `{proposal_id, verdict:
  allow|flag|abstain, confidence?, rationale}` — typed evidence on the
  staged proposal; the human Use/Discard is unchanged.
- **Proposed extension** `runtime.agent_participants[≤4]`
  `{uid?, name, kind:"agent"}`: declared agent colleagues — role metadata,
  not a permission grant. The platform parser is strict and rejects it
  today; `validateManifestV4` accepts it as forward-compat so the same
  manifest starts working the day the platform adopts it. Do not ship it
  in a deployed manifest until the platform accepts the field.
- `result_sinks[≤16]`, `observation_capabilities`, `views`, `entities`,
  `entrypoints`, `purpose`. No credentials, prompts, rows, or permission
  claims belong in the manifest.

`packages/contract` validates this shape (`validateManifestV4`) and every
envelope above (`normalize*` functions mirror the host's own bounds).
