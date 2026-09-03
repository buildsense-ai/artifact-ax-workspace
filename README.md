# Artifact AX Workspace

Artifact AX Workspace is a standalone design project for an independent, agent-friendly (AX-friendly) application. The project starts with contracts and examples; it does not assume a shared runtime, a particular Agent SDK, or a dependency on `cats-company`.

This repository now contains a working **compatibility-first vertical slice** on top of the design docs: a shared contract, a deep in-memory domain service, a CatsCo-compatible Artifact node, an `artifactctl` CLI, and a teaching-report demo SPA.

## Thesis

An Artifact is a normal application that people can use directly. Its formal
XiaoBa deployment uses installed Skills and the platform-provided Artifact Host,
not this repository's standalone Bridge. The application remains useful when no
Agent is connected.

The local AX gateway diagram below remains valuable for development and
contract testing; it is not the production XiaoBa deployment path.

```text
Instruction
    ↓
Development/test semantic gateway (artifactctl / HTTP gateway)
    ↓
AX-friendly Artifact SPA
    ├─ human UI
    ├─ application state
    ├─ semantic commands
    └─ structured events
```

The Agent does not need to know the SPA framework, inspect pixels, embed a
generic Artifact runtime, or call a custom page-to-Agent service. AG-UI remains
an optional developer adapter; the production task/result path is the versioned
Cloud Artifact contract.

## What works today (the vertical slice)

Run the whole stack locally (Node ≥ 20, pnpm):

```bash
pnpm install
pnpm build          # packages + CLI + demo SPA
pnpm test           # full contract, domain, trigger, auth, adapter, CLI, bridge, and SPA helper suite
pnpm -r run typecheck && pnpm -r run lint
pnpm demo:serve     # artifact node: AX API + CatsCo index/management + SPA
```

The repository pins Node and pnpm in `.mise.toml`; run `mise install` before
the first `pnpm install` when using mise-managed toolchains.

Then, with the node on http://127.0.0.1:8787:

```bash
# Agent surface (JSON out)
pnpm exec tsx apps/artifactctl/src/cli.ts describe --artifact lesson-report --as agent_440 --url http://127.0.0.1:8787
pnpm exec tsx apps/artifactctl/src/cli.ts inspect  --artifact lesson-report --as agent_440 --url http://127.0.0.1:8787
pnpm exec tsx apps/artifactctl/src/cli.ts apply filter_rows --artifact lesson-report --as agent_440 \
  --revision 0 --version 1 --input '{"status":"all"}' --url http://127.0.0.1:8787
pnpm exec tsx apps/artifactctl/src/cli.ts watch --artifact lesson-report --as agent_440 --cursor 0 --timeout 5 --url http://127.0.0.1:8787

# Human approval loop: approve_rows returns pending_approval; resolve in the SPA
# (or via the API), then complete the publish with the approval id:
pnpm exec tsx apps/artifactctl/src/cli.ts publish --artifact lesson-report --as agent_440 --input '{"title":"v2"}' --url http://127.0.0.1:8787
pnpm exec tsx apps/artifactctl/src/cli.ts publish --artifact lesson-report --draft dft_... --approval apr_... --as human_reviewer --url http://127.0.0.1:8787
```

## Intelligent trigger MVP (selection as context, not a command)

The demo SPA adds a **Focus set / Context Bundle composer** on top of the same
semantic surface. A selection is context, not a command: the user picks stable
regions/items (`data-node-id`, `data-region-id` anchors), optionally gives
**one** natural-language intent, and an intent-aware arbiter decides the
behavior. It never applies a mutation silently.

- `packages/trigger` is a transport-neutral package: `ContextBundle`
  (bundle_id, session/topic binding, artifact revision, ordered selections,
  intent, assessment, delivery state, `context_ref`), a deterministic
  `IntentArbiter` (`{kind, confidence, risk, rationale, complete}` →
  `{collect | suggest | send | confirm}`), semantic grouping (same
  artifact/revision/region only; unrelated selections split), and an honest
  `MockOutbox` (idempotent by bundle_id; cats-company is never written).
- Language-agnostic first pass: Chinese and English action words for
  inspect/explain/review/compare (low risk), change/edit/update (medium),
  delete/publish (high). No intent text ⇒ collect only. A complete low-risk
  read intent auto-sends or suggests per an explicit user policy
  (`readSendThreshold` / `suggestThreshold`); write/destructive intents
  always stage a proposal that requires confirmation. Word-boundary and
  negation guards keep ordinary words/sentences from becoming accidental
  triggers.
- The transport is replaceable: `Outbox` and `IntentClassifier` are seams; an
  LLM classifier could later be plugged in without touching the DOM handlers.
- While a run is active (a stream turn is being folded in), a focus commit is
  queued for the next turn instead of pretending to inject mid-turn.
- The SPA renders **one compact CatsCo-style message per bundle**, with the
  decision badge, risk/confidence, rationale, and a `context_ref` to the full
  mock payload.

The standalone outbox is intentionally local. The deployed path does not send a
ContextBundle to a custom chat endpoint: an explicit page action uses the
platform Host to create one normal visible task turn. The optional AG-UI
projection and standalone Bridge remain developer harnesses only. The Artifact
itself still does not depend on AG-UI or an Agent runtime.

## Developer-only Artifact Bridge harness

Keep this implemented slice for isolated transport, CLI, durability, and AG-UI
experiments. Do not deploy it with XiaoBa and do not treat it as a prerequisite
for the Cloud Artifact task path described below.

The smallest usable external **Agent Bridge / Inbox**: the SPA can deliver a
`ContextBundle` to an external Agent through a standalone loopback HTTP bridge
and an external CLI — without modifying cats-company and without requiring a
generic Artifact runtime.

- `packages/trigger` now defines a **versioned, transport-neutral bridge
  protocol** (`artifact.ax.bridge.v1`) plus a replaceable `BridgeStore` seam
  (default `InMemoryBridgeStore`). Receipts move through explicit states:
  `accepted → queued → needs_confirm → acknowledged → completed`, plus
  `rejected` and `expired`. Submission is **exact-once / idempotent** by
  bundle id or idempotency key, and **stale revisions** (older than the
  accepted high-water for the same artifact) are rejected rather than
  delivered out of order.
- `apps/artifact-bridge` is an **independent bridge app**: a loopback HTTP API
  (submit, status, ack, resume, complete, reject, watch/SSE) with safe
  defaults — binds `127.0.0.1`, local-origin CORS, optional explicit pairing token
  (`Authorization: Bearer`), in-memory state via the replaceable seam by
  default, with an opt-in durable JSON-file store (`--store-file` /
  `AX_BRIDGE_STORE_FILE`). It speaks **only** the artifact bridge protocol; it
  is never a CatsCo chat send.
- `artifactctl` gained a **`context` (inbox) command group**: `context send`,
  `context status`, `context fetch`, `context watch`, `context ag-ui`, `context ack`,
  `context resume`, `context complete`, `context reject` — stable JSON / NDJSON
  output, machine friendly. `context fetch` is the explicitly authorized
  full-payload read; status/watch stay compact receipt surfaces.
- The SPA uses a **`BridgeOutbox`** when a bridge is configured
  (`?bridge=<url>`), otherwise it keeps the honest **`MockOutbox`** fallback.
  The browser never spawns a process; it POSTs over HTTP. This is opt-in, so
  the SPA and Agent stay decoupled and the app remains usable without any
  Agent.
- `apps/artifact-bridge` also exposes `GET /v1/ag-ui/watch`, an
  AG-UI-compatible SSE projection. It emits `RUN_STARTED`, namespaced
  `CUSTOM` receipt/context events, and terminal `RUN_FINISHED` events.
  `artifactctl context ag-ui` prints the same events as NDJSON. It emits no
  chat text and includes the full bundle only when `include_context=1` is
  explicitly requested.

## Cloud HTML Artifact integration (fourth slice)

The demo SPA now speaks the page-side contracts from the local
`cloud-html-artifact` skill package (v1.4.0) without copying its publisher or
injected bridge. The integration keeps the application independent: the
official CatsCo publisher supplies the bridge and Host connection when a page
is opened in CatsCo, while a directly opened page remains a normal standalone
SPA.

- `packages/contract` validates the versioned application map
  (`catsco.artifact-manifest.v1/v2/v3`), bounded result schemas, trust-separated
  Observation Packets, task statuses, and application receipts. These are
  transport-neutral types; they do not call a Host or an Agent.
- `apps/demo-spa/public/artifact-manifest.json` declares two real v3 tasks,
  each linked to a declared result sink: `lesson-report.review-selection.v1` →
  `lesson-report.agent-notes.upsert.v1` (review a bounded ContextBundle) and
  `lesson-report.compose-ui.v1` →
  `lesson-report.ui-document-patch.propose.v1` (propose a bounded declarative
  UI-document patch). The review task input is a bounded projection of the
  existing ContextBundle. The compose-ui task input is the current final UI
  document/configuration, the current application revision/identity, and the
  user's requested UI intent — never event history, task refs, writeback refs,
  or credentials.
- The page exposes `window.catscoArtifact.getContext()` as a synchronous,
  read-only **final-state-first** semantic snapshot: the latest final
  projection/result summary plus stable refs only (`semantic_mode: 'final-state'`,
  `state_revision`, `summary`, `filter`, `visible_rows`, `agent_notes`, stable
  selection/node refs). It never contains credentials, prompts, opaque refs, or
  authority claims. Intermediate event/state history is **never injected** into
  the default page context and is **never required**; it is
  retained only for a bounded optional query
  (`getContext({ include_events: true, max_events: N })`) and is capped by the
  page. The bridge treats this object as untrusted observation data.
- The page exposes `window.catscoArtifact.applyResult()`. It validates the
  declared sink and payload again, checks the expected report revision,
  deduplicates by `result_id`, persists notes in the app's localStorage store,
  and returns `applied` only after persistence succeeds. The local key is
  scoped by workspace, Artifact, and actor; reloading the page retains the
  note and its application receipt identity without sharing it across scopes.
- When an injected `window.catscoArtifactHost` is present, the SPA uses
  `CloudHostOutbox`. Only an explicit low-risk `send` with `delivery=sent`
  creates a Host task. Collected, suggested, confirmation-gated, deferred, or
  activation-rejected bundles remain staged locally; the adapter never falls
  back to the local Bridge and never retries a timed-out task automatically.
  Host `submitted`, `running`, `completed`, and `failed` statuses appear as
  task receipts. An official contract-marked `completed` status is considered
  successful because CatsCo emits it only after the exact page returns an
  application-level `applied` receipt; structural test Hosts must provide that
  application status explicitly. A staged deferred send keeps
  its bundle ID and offers an explicit “Send now” retry; timeouts never retry
  automatically.
- If no Host is injected, the existing `?bridge=` local bridge remains
  available; without either option the SPA uses the local mock outbox. A Host
  takes precedence over `?bridge=` because it is the trusted cloud path. The
  Host task creates a normal visible CatsCo turn; it is not a silent chat
  injection or a hidden model call.

The page contract deliberately uses a small `agent notes` writeback example
instead of pretending that the existing approval-gated row mutation is an
application-level `applied` result. Approving rows still follows the AX
command and human approval flow. A production application can replace the
localStorage sink with its own durable store while keeping the same manifest
and receipt boundary.

## JSON-rendered agentic UI (fifth slice)

The demo SPA's business surfaces are now driven by a **versioned declarative UI
document**, not a one-off static DOM template. A new standalone package,
`@artifact-ax/ui-document`, owns the contract; the SPA owns a small, fixed
catalog renderer that walks it.

### Package: `@artifact-ax/ui-document`

A typed, framework-free contract that enforces catalog/prop/binding/event
allowlists before any renderer touches a document:

- `UiDocument` (`artifact-ax.ui-document.v1`): a list of composable `UiNode`s,
  each referencing a fixed catalog kind, with optional `props`, data
  `bindings`, and semantic `events`.
- **Approved component catalog** (`CATALOG`): the closed set of surfaces that
  may appear in a document (`review-table`, `summary-list`, `approval-list`,
  `focus-composer`, `agent-notes`, `event-log`, `context-outbox`). Each entry
  hard-declares its allowed props, binding names, and semantic actions.
- **Data bindings**: a named binding maps to a safe dot-path into a
  projection-derived view model. Paths are validated (identifier segments only;
  `__proto__`/`constructor`/`prototype` rejected) and resolved by
  `resolvePath`/`resolveNodeBindings`.
- **Semantic event bindings**: a node's `events` maps a DOM event to an
  allowlisted action (e.g. `rowToggle → toggleRow`,
  `approve → approveRows`). Unknown events and non-allowlisted actions are
  rejected at validation time.
- **Patches** (`artifact-ax.ui-document-patch.v1`): `applyPatch` validates every
  op (insert/update/remove) against the catalog and a base document revision,
  then returns a new document; the original is never mutated.
- **Security boundary**: props are primitives only; keys like `on*`,
  `innerHTML`, `style`, `href`, `src`, `dangerouslySetInnerHTML` are rejected,
  and string props containing script/iframe/event-handler markup are rejected.
  No value is ever treated as executable presentation.

The package is dependency-free for its contract layer (it imports only
`@artifact-ax/contract` for the schema-property shape) and ships focused unit
tests for validation and patch behavior.

### Renderer decision

The preferred route was **React + Vercel json-render with a shadcn/Base UI
catalog**. That combination would have required converting the incumbent
framework-free SPA to React and re-implementing its DOM-coupled transport,
bridge, and Cloud Host wiring, which risked the standalone/no-runtime boundary
and the mock/cloud-host backwards compatibility this workspace guarantees.

Instead the SPA uses an **equally constrained catalog renderer**: a single
`catalog-renderer.ts` that walks a validated `UiDocument` and renders each
approved surface from the catalog, resolving bindings against the view model
and wiring semantic events through one dispatch seam into the existing
`AxGateway`. This is a genuine data-driven JSON renderer (not a hardcoded DOM
template) — the document is the source of screen structure, and the renderer is
closed to the fixed catalog. The reason for not using Vercel json-render is
documented here rather than faking the requirement with a static template.

### SPA integration

`apps/demo-spa/src/ui/` contains:

- `lesson-report.document.ts` — the declarative `UiDocument` for the report.
- `catalog-renderer.ts` — the constrained catalog renderer (DOM built with
  `textContent`, never innerHTML with untrusted text).
- `view-model.ts` — the projection-derived `UIDocumentView`.
- `ui-draft.ts` — the draft-only patch boundary.

`DemoApp` builds the view model from the projection and semantic state, then
calls the renderer. All mutation still goes through semantic commands on the
gateway; the production Cloud Host/task/result sink (`getContext`/`applyResult`)
is unchanged. Stable `data-region-id`/`data-node-id` anchors and the
`#app` `data-artifact-id`/`data-workspace-id` attributes are preserved.

### V1 limits (honest)

- **Fixed catalog, one document model.** Only the eight listed catalog
  surfaces exist (`review-table`, `summary-list`, `approval-list`,
  `focus-composer`, `agent-notes`, `event-log`, `context-outbox`, `ui-builder`);
  adding one means extending the package catalog, the renderer, and tests.
- **Draft-only patch (developer seam) + formal compose-ui path.** A builder can
  submit a validated `?ui_patch=` patch that re-renders the same surfaces. It is
  local-only and never writes into the production manifest, the XiaoBa
  task/result contract, or any cats-company surface. The patch boundary also
  keeps the stable anchors authoritative: the resulting node/region ids must
  stay within the deployed lesson-report set. The production manifest now also
  declares a formal compose-ui task (`lesson-report.compose-ui.v1`) and a UI
  patch result sink (`lesson-report.ui-document-patch.propose.v1`). The Agent's
  proposed `UiDocumentPatch` is validated and **staged only** by the page; a
  human applies or discards it (the draft is never applied merely because it was
  delivered). The page `getContext`/OBSERVE context semantics are documented in
  `docs/13` and the lesson-report Skill reference.
- **Final-state-first Agent context (page `getContext`).** The default
  `getContext()` is the latest final projection/result summary plus stable refs
  only. It is **not** the Cloud task payload: the task payload emitted by
  `CloudHostOutbox` is a bounded ContextBundle projection (selections, intent,
  assessment), which never carries a final-state summary — the platform Skill
  reads the final state from the page OBSERVE/context surface. Intermediate
  event/state history is retained for a bounded optional query
  (`getContext({ include_events: true })`), never automatically injected and
  never required. This is stated in `docs/13`, the lesson-report Skill reference,
  and the SPA `buildSemanticContext`.
- **No generic runtime or agent-controlled code execution.** The document cannot
  emit raw HTML/JS/CSS, access browser secrets, or bypass command/permission
  policy.

## XiaoBa Skills: formal deployment path

Deploy exactly two composable Skills to the target XiaoBa Agent:

| Layer | Skill | Responsibility |
| --- | --- | --- |
| Platform | cloud-html-artifact, existing version 1.4.0 package | Read the one-shot task/current-page context, preserve trusted routing, and write a declared result sink. |
| Application | lesson-report-artifact | Review the selected teaching-report context and produce only the bounded Agent-note result, and propose a bounded UI-document patch for the compose-ui task. |

The application Skill supports exactly two task-to-sink mappings, both requested
only after an explicit user send and both complete only when the exact result
sink returns the application's applied receipt:

- `lesson-report.review-selection.v1` →
  `lesson-report.agent-notes.upsert.v1` (review note).
- `lesson-report.compose-ui.v1` →
  `lesson-report.ui-document-patch.propose.v1` (UI patch proposal). A UI patch
  is **staged only** until a human applies or discards it in the page; it is
  never applied merely because it was delivered.

There is no Artifact Bridge, artifactctl context, custom HTTP endpoint, local
pairing token, or cats-company source change in this deployment path.

Read [XiaoBa Skill deployment boundary](docs/13-xiaoba-skill-deployment.md) for
the canonical Skill source/package, observed SkillHub facts, external
preconditions, and acceptance test.

## Developer-only transitional bridge auth

The developer harness can also expose a server-side transitional identity adapter. It
calls CatsCo's documented account-center introspection endpoint with a
server-only Service Token, then gives the browser a short-lived HttpOnly
`artifact_ax_session` cookie. The user JWT is never persisted, and the Service
Token never enters the SPA. Enable it only when both values are configured:

```bash
pnpm exec tsx apps/artifact-bridge/src/serve.ts \
  --catsco-account-url https://app.catsco.cc \
  --catsco-service-token "$CATSCO_ACCOUNT_SERVICE_TOKEN" \
  --auth-scopes artifact:read,artifact:execute \
  --token 'local-pairing-token-0123456789'
```

The auth routes are `POST /v1/auth/exchange`, `GET /v1/auth/session`, and
`POST /v1/auth/logout`. A host can use the browser-safe
`ArtifactAuthClient` from `@artifact-ax/auth`; the demo transport opts into
cookie credentials with `?bridge_session=1`. Session bridge reads require
`artifact:read` and bridge writes/lifecycle actions require
`artifact:execute` by default; all bundles remain bound to the authenticated
`actor_id`. By default it also rechecks the CatsCo account's current state at
a bounded interval; that detects a disabled/deleted account but does not
prove JWT revocation. This is a transitional introspection adapter, not native
OAuth/OIDC; see [docs/11-transitional-auth-adapter.md](docs/11-transitional-auth-adapter.md).

Run it locally:

```bash
# terminal 1 — the bridge (loopback, optional pairing token; add --store-file ./bridge-store.json for durable receipts)
pnpm exec tsx apps/artifact-bridge/src/serve.ts --port 8788 --token 'some-long-local-pairing-token-0123456789'

# terminal 2 — run the demo SPA with the bridge wired in
pnpm demo:spa -- --open "http://127.0.0.1:5173/?bridge=http://127.0.0.1:8788&bridge_token=some-long-local-pairing-token-0123456789"

# terminal 3 — the external Agent pulls receipts through the CLI
B=$(cat <<'JSON'
{"contract_version":"trigger.context-bundle.v1","bundle_id":"bdl-demo-1","session_id":"topic_lesson_report","actor_id":"human_teacher","artifact_id":"lesson-report","revision":0,"selections":[{"selection_id":"sel-1","artifact_id":"lesson-report","revision":0,"region_id":"review-table","node_id":"r-1","label":"Row r-1"}],"intent":{"text":"review"},"assessment":{"intent_kind":"review","confidence":0.9,"risk":"low","rationale":["read intent"],"complete":true},"decision":"send","delivery":"sent","created_at":"2026-08-26T00:00:00Z"}
JSON
)
pnpm exec tsx apps/artifactctl/src/cli.ts context send --bridge-url http://127.0.0.1:8788 --token 'some-long-local-pairing-token-0123456789' --bundle "$B"
pnpm exec tsx apps/artifactctl/src/cli.ts context watch --bridge-url http://127.0.0.1:8788 --token 'some-long-local-pairing-token-0123456789' --timeout 5
pnpm exec tsx apps/artifactctl/src/cli.ts context fetch --bridge-url http://127.0.0.1:8788 --token 'some-long-local-pairing-token-0123456789' --bundle-id bdl-demo-1
pnpm exec tsx apps/artifactctl/src/cli.ts context ag-ui --bridge-url http://127.0.0.1:8788 --token 'some-long-local-pairing-token-0123456789' --bundle-id bdl-demo-1 --timeout 5
```

**Honest boundary**: the bridge defaults to in-memory receipts; an opt-in
`JsonFileBridgeStore` (`--store-file <path>` or `AX_BRIDGE_STORE_FILE`)
persists receipts and full bundles to one atomic JSON file and recovers them
across restarts — corrupt files fail loudly at startup rather than being
silently wiped. Auth defaults to loopback + an explicit pairing token; the
optional CatsCo session adapter is transitional and not production auth. The
SPA is not configured to use the bridge by default. A
bridge endpoint must never be mistaken for a CatsCo chat send. In bridge mode
the SPA renders receipt states from the watch stream; an Agent reads the full
bundle only through the authorized `context fetch` path rather than the
compact receipt stream. A host that speaks AG-UI can instead consume the
optional raw event projection described in
[docs/10-ag-ui-adapter.md](docs/10-ag-ui-adapter.md).

Screenshot of the Focus Set surface (empty state):

```text
docs/screenshot-focus-mvp.png
```

Open the artifact page in a browser: `http://127.0.0.1:8787/by-agent/440/lesson-report/latest/` (or `http://127.0.0.1:5173/?mock=1` for the standalone SPA)
(choose an actor, filter rows, approve rows → approval card → human approves →
rows update live). Without the node, the SPA falls back to an in-process mock
transport, so a static demo never bricks.

CatsCo compatibility surface served by the node:

- `GET /artifacts-index.json` → `cloud-artifacts.index.v1`
- `GET /internal/artifacts?status=active|deleted` → `cloud-artifacts.management-list.v1` (Bearer token)
- `GET /internal/agents/<uid>/artifacts?status=...`, `DELETE .../<id>`, `POST .../<id>/restore`
- `GET /by-agent/<uid>/<id>/latest/artifact.ax.json` → sidecar manifest

## Repository layout

```text
packages/
  contract/        # AX types + runtime validation + CatsCo wire contracts
  domain/          # in-memory ArtifactService (describe/inspect/apply/watch/publish)
  trigger/         # intelligent trigger MVP + local Bridge + AG-UI + Cloud Host adapter
  auth/            # CatsCo introspection seam, opaque sessions, browser client
  lesson-report/   # example structured artifact spec + capability handlers
  ui-document/     # versioned declarative UI document contract + catalog + patches
  catsco-adapter/  # Artifact node server + browser-safe HTTP gateway client
apps/
  artifactctl/     # JSON CLI over the AX gateway (thick gateway, thin client)
  artifact-bridge/ # developer-only Agent Bridge server (loopback HTTP inbox; in-memory or durable JSON-file store)
  demo-spa/        # teaching-report SPA + Cloud Artifact page/task/writeback surface, document-rendered via ui-document
skills/
  lesson-report-artifact/ # XiaoBa domain Skill source
skill-packages/    # validated portable Skill archive
docs/              # design docs (unchanged) + roadmap.md
```

## Design rules honored

- **Deep module**: `ArtifactService` owns Draft/Published versions, optimistic
  revisions, idempotency, approvals, audit events, and soft delete/restore
  behind the small transport-neutral `AxGateway` seam. The CLI and SPA never
  duplicate domain logic.
- **Two adapters, one seam**: `ArtifactService` (in-process) and
  `HttpAxGateway` (HTTP) implement the same `AxGateway` interface; the SPA
  uses whichever is reachable.
- **No generic runtime**: the SPA is an ordinary application; nothing is
  injected into artifacts at runtime. The business surfaces are rendered from a
  validated declarative document against a fixed, approved catalog — no
  agent-controlled code execution and no raw HTML/JS/CSS inputs.
- **CatsCo is an external adapter target**: the contract and domain don't
  import cats-company code; `packages/catsco-adapter` renders the upstream
  JSON and speaks the upstream route/URL/error contract (verified
  read-only against `cats-company/server/cloud_artifacts.go`).
- **No secrets in the browser**: no Service Token, Bot API Key, or cloud
  credential appears in the SPA, examples, tests, or git. The management
  token is a demo string; the opt-in transitional session adapter keeps the
  CatsCo Service Token server-side and is not native OAuth/OIDC.

## Status and honesty markers

See [docs/roadmap.md](docs/roadmap.md) for the mock vs CatsCo-compatible
breakdown and what is deliberately not implemented (native OAuth/OIDC,
code building, rollback, CRDT/canvas, full Agent/MCP runtime, draft merge,
and a real CatsCo Host round-trip). Bridge receipts can now persist via the
opt-in `JsonFileBridgeStore`; the domain/trigger stores and demo note sink are
local by default.

## Documents

- [Vision and boundaries](docs/01-vision-and-boundaries.md)
- [Domain model](docs/02-domain-model.md)
- [Human and Agent collaboration](docs/03-agent-human-collaboration.md)
- [AX contract and CLI surface](docs/04-ax-contract.md)
- [Authentication and permissions](docs/05-auth-and-permissions.md)
- [CatsCo integration context](docs/06-cats-company-context.md)
- [Build and publish lifecycle](docs/07-build-publish-lifecycle.md)
- [Open questions](docs/08-open-questions.md)
- [Proposed CatsCo OAuth contract](docs/09-cats-company-oauth-contract.md)
- [AG-UI adapter boundary](docs/10-ag-ui-adapter.md)
- [Transitional auth adapter](docs/11-transitional-auth-adapter.md)
- [Cloud HTML Artifact Host adapter](docs/12-cloud-artifact-host.md)
- [XiaoBa Skill deployment boundary](docs/13-xiaoba-skill-deployment.md)
- [ADR 0001: standalone AX-friendly app](docs/adr/0001-standalone-ax-friendly-app.md)
- [Roadmap](docs/roadmap.md)
- [References](docs/references.md)

## Relationship to CatsCo

The reference repository is located at `../cats-company` and is **not
modified** by this project. CatsCo currently provides user JWTs, Bot API
Keys, account-center introspection, Agent/Topic relationships, and Cloud
Artifact proxying. The Artifact node here is what a cats-company server
expects as its upstream: a validated index, a protected management list with
delete/restore, and public artifact URLs under `/by-agent/<uid>/`. See
[docs/06-cats-company-context.md](docs/06-cats-company-context.md) for the
observed endpoints and the proposed adapter boundary.
