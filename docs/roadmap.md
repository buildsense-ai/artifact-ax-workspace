# Roadmap

Status of the compatibility-first vertical slices (2026-08-26), what is mock
vs CatsCo-compatible, and what is not yet implemented.

## Delivered in the first slice

Workspace layout (pnpm monorepo, `packages/*` + `apps/*`):

| Package | Purpose | Status |
| --- | --- | --- |
| `@artifact-ax/contract` | AX types + runtime validators + CatsCo cloud-artifacts wire types | implemented + tested |
| `@artifact-ax/domain` | Deep in-memory `ArtifactService` (describe/inspect/apply/watch/publish) | implemented + tested |
| `@artifact-ax/trigger` | Intelligent trigger MVP: `ContextBundle`, deterministic `IntentArbiter`, semantic grouping, honest mock outbox | implemented + tested |
| `@artifact-ax/lesson-report` | Example teaching-report spec and capability handlers | implemented + tested |
| `@artifact-ax/catsco-adapter` | Artifact node server (CatsCo index/management + AX HTTP gateway + sidecars) and HTTP client | implemented + tested |
| `artifactctl` | JSON CLI over the AX gateway (describe/inspect/apply/watch/publish) | implemented + e2e tested |
| `@artifact-ax/demo-spa` | Teaching-report SPA (stable region ids, approvable command, event log) | implemented + browser-verified |

## What is mock vs CatsCo-compatible

**CatsCo-compatible (verified against `cats-company/server/cloud_artifacts.go`
and its tests, read-only):**

- `cloud-artifacts.index.v1` publish index (id/title/kind/url/updated_at,
  `publish_version`, `agent_uid`; `kind ∈ {html, mini_app}`; id pattern; no
  duplicate ids; RFC3339 timestamps).
- `cloud-artifacts.management-list.v1` (`status`, `count`, `can_delete`,
  `can_restore`, `deleted_at`, agent-scoped `agent_uid` filtering).
- Management mutations: `DELETE <collection>/<id>` and
  `POST <collection>/<id>/restore` with `{"actor_uid": "..."}` bodies and
  `Authorization: Bearer <token>`; stable error codes
  (`artifact_not_found`, `artifact_already_deleted`, `artifact_not_deleted`,
  `artifact_operation_conflict`).
- Agent collection layout derived from the management base:
  `<base-without-/artifacts>/agents/<uid>/artifacts`.
- Public artifact URLs live under `/by-agent/<uid>/<id>/latest/` so
  `validateArtifactNodeURL` in cats-company accepts them.
- Per-artifact `artifact.ax.json` sidecar next to the published page
  (unknown fields are never appended to the CatsCo index itself).

**Mock (this slice only, flagged in code/docs):**

- Auth: the AX API trusts the `X-AX-Actor` header / `actor_id` query; the
  management token is a fixed demo string with a ≥32-char contract. No JWT,
  no Service Token, no OAuth.
- Transport: the node is a localhost HTTP server; the SPA falls back to an
  in-process domain service when the node is unreachable (`?mock=1` forces
  it).
- Public base URL is a config option (`AX_PUBLIC_BASE_URL`); no DNS/cloud
  credentials are involved anywhere.

## Intelligent trigger MVP (second slice)

Added on top of the vertical slice, still fully local:

| Surface | Status |
| --- | --- |
| `ContextBundle` contract (`trigger.context-bundle.v1`): bundle_id, session/topic binding, artifact revision, ordered selections, intent, assessment, delivery state, `context_ref` | implemented + tested |
| Deterministic first-pass intent classifier (Chinese + English, inspect/explain/review/compare vs change/edit/update vs delete/publish, confidence/risk/rationale) | implemented + tested (replaceable `IntentClassifier` seam for a future LLM) |
| `IntentArbiter` assessment → decision (`collect | suggest | send | confirm`), read-only auto-send or suggest per explicit `ArbiterPolicy` | implemented + tested |
| Semantic grouping: only same artifact/revision/region merge; unrelated selections split; read-only regions hold mutation intents as collected | implemented + tested |
| Delivery: one compact CatsCo-style message per bundle via an honest `MockOutbox` (idempotent by bundle_id, local only) | implemented + tested |
| Run-active queue: bundles queue for the next turn instead of pretending to inject mid-turn | implemented (unit-tested; SPA passes `defer` when a stream turn is active) |
| Non-modal Focus Set composer: remove/reorder/per-item note, one natural-language intent, live assessment line, `role=status`, keyboard + focus-visible | implemented + browser-verified |
| Real CatsCo send | **not implemented**: the outbox is a local mock labeled honestly; cats-company remains untouched. CatsCo's existing `/api/messages/send` would create a chat-visible message; this workspace now has a standalone AG-UI-compatible projection, but no CatsCo session injection. |
| LLM-based intent classifier | **not implemented / replaceable seam only**: deterministic first pass avoids one LLM call per click |
| Persistent session/topic binding | **mock**: session is a fixed string (`topic_lesson_report`) or a provider passed at construction |

## Verified by the slice

1. Mock Agent (`artifactctl`/SPA as `agent_440`) discovers the manifest,
   inspects a bounded projection, and operates the lesson-report through one
   CLI.
2. A human (reviewer) approves a gated command while the Agent watches; the
   task resumes and the region data changes.
3. Optimistic revision conflicts and idempotent retries behave per contract.
4. Draft → validate → publish goes through a human publish approval.
5. CatsCo index/management JSON passes the same runtime validators the Go
   server applies (ported 1:1), including node URL constraints.
6. A focus commit with no intent collects only; a complete low-risk read
   intent auto-sends or suggests per policy; a delete/publish intent is
   staged as a confirmation and never silently applied.
7. Mixed selections across regions split into separate bundles instead of
   being silently merged; a mutation aimed at a read-only region is held as
   collected with an explicit rationale.
8. Delivery is idempotent: re-sending the same bundle_id yields a stored
   receipt, and a run-active commit queues rather than injects.

## Not implemented (deliberate, later stages)

- **Horizontal slices beyond the demo artifact**: one artifact profile
  (`lesson-report`) is seeded; multi-artifact/multi-workspace management UI
  and per-node storage are not built.
- **Persistence**: the domain and trigger `ArtifactService` stores are
  in-memory; no database/event store, restart resets drafts/versions. Bridge
  receipts are the one durable exception: the opt-in `JsonFileBridgeStore`
  (see the bridge section below) persists them to an atomic JSON file.
- **Native real auth** (docs/05, docs/09): OAuth/OIDC issuer discovery, PKCE
  SPA login, CLI device flow, refresh-token rotation, and durable sessions are
  not implemented. A transitional server-side CatsCo introspection adapter is
  now available (see docs/11); it is loopback-only, issues short-lived opaque
  sessions, keeps Service Tokens server-only, requires `artifact:read` for
  bridge reads and `artifact:execute` for bridge writes, and binds bridge
  requests to the authenticated actor. It rechecks the current CatsCo account
  state on a bounded interval; JWT revocation remains TTL-bounded. The webapp
  browser token (`oc_token`) pattern is intentionally not copied.
- **Code building** (docs/07): structured building only; no JS/HTML sandbox,
  no CSP/network policy work for arbitrary code.
- **Rollback / version migration**: publishing pins new sessions; explicit
  rollback and per-version migration commands are not implemented.
- **CRDT / infinite canvas / arbitrary state sync**: out of scope per
  docs/02 and docs/08.
- **Full Agent runtime / MCP adapter**: not implemented. An optional AG-UI
  projection now exists at the bridge boundary (see below); the Artifact still
  does not depend on an AG-UI SDK or runtime.
- **Draft branching / merge**: two builders from one base are preserved as
  separate drafts, but rebase/merge is not implemented.

## External Agent Bridge / Inbox (third slice)

A standalone, minimal bridge so the SPA can hand a `ContextBundle` to an
external Agent without modifying cats-company and without an Artifact runtime.

| Surface | Status |
| --- | --- |
| Versioned, transport-neutral bridge protocol `artifact.ax.bridge.v1`: bundle/session/artifact/revision/selection fields, idempotency, explicit receipt states `accepted / queued / needs_confirm / acknowledged / completed / rejected / expired` | implemented + tested |
| `BridgeStore` replaceable seam; default `InMemoryBridgeStore` (exact-once/idempotent submit, run-active queueing, confirm/resume, stale-revision rejection, TTL expiry, malformed-payload guards) | implemented + tested |
| `apps/artifact-bridge`: loopback HTTP API (submit, status, ack, resume, complete, reject, watch/SSE), loopback bind + local-origin CORS + explicit pairing token, in-memory state by default | implemented + tested |
| `JsonFileBridgeStore` (`apps/artifact-bridge`): durable opt-in store behind the same `BridgeStore` seam (atomic JSON file, single-writer serialized writes, restart recovery, corrupt files fail loudly); wired via `--store-file` / `AX_BRIDGE_STORE_FILE` | implemented + tested |
| `artifactctl context <send|status|fetch|watch|ag-ui|ack|resume|complete|reject>` with stable JSON/NDJSON output; `fetch` is the authorized full-payload read and `ag-ui` emits raw AG-UI-compatible events | implemented + e2e tested |
| `BridgeOutbox` in `packages/trigger`; SPA uses it when configured (`?bridge=`), retains honest `MockOutbox` fallback otherwise; browser never spawns a process | implemented + tested |
| NDJSON / stdio-friendly watch for an external CLI (`context watch` emits one JSON object per line) | implemented + e2e tested |
| AG-UI-compatible projection (`GET /v1/ag-ui/watch`): per-connection `RUN_STARTED`, namespaced `CUSTOM` receipt/context events, terminal `RUN_FINISHED`; raw SSE + `BridgeClient.watchAgUi()` + `artifactctl context ag-ui` | implemented + tested |
| Optional CatsCo transitional auth: account-center introspection, opaque HttpOnly session, explicit read/write scopes, actor-scoped bridge reads/writes, browser-safe `ArtifactAuthClient` | implemented + tested (see docs/11) |

Not claimed here:
- **Native auth** remains out of scope: no OAuth/OIDC issuer, PKCE login, CLI
  device flow, durable session store, or refresh-token rotation. The optional
  transitional adapter uses CatsCo account-center introspection with a
  server-only Service Token and issues an opaque session; it is loopback-only,
  separates `artifact:read` from `artifact:execute`, and is not production auth
  by itself. A provider-side revalidation hook is injectable; by default the
  adapter polls CatsCo's documented account lookup for current account state,
  while JWT revocation remains TTL-bounded.
- **Persistence** stays in memory by default via the replaceable `BridgeStore`
  seam; an opt-in `JsonFileBridgeStore` (`--store-file` /
  `AX_BRIDGE_STORE_FILE`) persists receipts and full bundles to one atomic
  JSON file and recovers them on restart. Still out of scope: the domain /
  trigger `ArtifactService` stores remain in-memory, and multi-process access
  to one store file is a single-writer model only.
- **Bridge-mode UI** renders receipt state (and updates it from the SSE watch);
  full ContextBundle payloads remain off the compact receipt path and are
  available only through the explicitly authorized `context fetch` route.
- **CatsCo chat injection**: the bridge speaks `artifact.ax.bridge.v1` only;
  it is deliberately never a CatsCo `/api/messages/send` and is not
  configured in the SPA by default.
- **AG-UI boundary**: the projection is an event adapter, not a model runner or
  a full implementation of every AG-UI event. It emits no text-message events
  and does not turn a ContextBundle into a chat-visible message. Full context
  is opt-in (`include_context=1`) and remains protected by the bridge token or
  an actor-scoped Artifact session.

See [10-ag-ui-adapter.md](10-ag-ui-adapter.md) for the event mapping and a
CLI/SSE example.

## Round-trip against a real cats-company server

Not yet run. The next phase should point `CATSCO_ARTIFACT_INDEX_URL` and
`CATSCO_ARTIFACT_MANAGEMENT_URL` at this node and run cats-company's own
`cloud_artifacts` test expectations against it (or cURL the routes published
above). This is the highest-value follow-up.

## Suggested next phases

- Phase 1: round-trip against cats-company (above); fix any drift.
- Phase 2: replace in-memory domain with a durable store behind the same
  `AxGateway` seam (two adapter rule now holds: in-memory + HTTP).
- Phase 3: **transitional auth adapter (implemented as an opt-in slice)** —
  server-side JWT introspection, opaque session cookie, explicit scopes, and
  actor-scoped bridge access. Remaining work is deployment hardening and a
  real durable session store.
- Phase 4: draft branching + merge MVP, rollback/migration commands.
- Phase 5: native OAuth/OIDC per docs/09; connect a real Agent runner or MCP
  adapter behind the existing AG-UI projection without changing the Artifact
  or bridge contracts.
