# Artifact AX Workspace

Artifact AX Workspace is a standalone design project for an independent, agent-friendly (AX-friendly) application. The project starts with contracts and examples; it does not assume a shared runtime, a particular Agent SDK, or a dependency on `cats-company`.

This repository now contains a working **compatibility-first vertical slice** on top of the design docs: a shared contract, a deep in-memory domain service, a CatsCo-compatible Artifact node, an `artifactctl` CLI, and a teaching-report demo SPA.

## Thesis

An Artifact is a normal application that people can use directly. It exposes a semantic surface that Agents can discover and operate through an external capability gateway such as one CLI. The application remains useful when no Agent is connected.

```text
Instruction
    ↓
One external capability gateway (artifactctl / HTTP gateway)
    ↓
AX-friendly Artifact SPA
    ├─ human UI
    ├─ application state
    ├─ semantic commands
    └─ structured events
```

The Agent does not need to know the SPA framework, inspect pixels, or embed a generic Artifact runtime. AG-UI can act as an adapter at the boundary when a host needs its event vocabulary; the Artifact domain model stays independent.

## What works today (the vertical slice)

Run the whole stack locally (Node ≥ 20, pnpm):

```bash
pnpm install
pnpm build          # packages + CLI + demo SPA
pnpm test           # 202 tests: contract, domain, trigger (incl. bridge + durable store + AG-UI), auth, adapter, CLI e2e, bridge e2e
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

The current outbox is intentionally local. CatsCo's existing message endpoint
would make a bundle visible in chat; keeping it hidden and structured is now
handled by an optional AG-UI-compatible projection at the standalone bridge
boundary. The Artifact itself still does not depend on AG-UI or an Agent
runtime.

## External Agent Bridge (third slice)

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

## Optional CatsCo session boundary

The bridge can also expose a server-side transitional identity adapter. It
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
  trigger/         # intelligent trigger MVP: ContextBundle + IntentArbiter + mock outbox
                   #   + external Agent Bridge protocol/client + AG-UI projection
  auth/            # CatsCo introspection seam, opaque sessions, browser client
  lesson-report/   # example structured artifact spec + capability handlers
  catsco-adapter/  # Artifact node server + browser-safe HTTP gateway client
apps/
  artifactctl/     # JSON CLI over the AX gateway (thick gateway, thin client)
  artifact-bridge/ # external Agent Bridge server (loopback HTTP inbox; in-memory or durable JSON-file store)
  demo-spa/        # teaching-report SPA (Vite, vanilla TS)
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
  injected into artifacts at runtime.
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
code building, rollback, CRDT/canvas, full Agent/MCP runtime, draft merge). Bridge
receipts can now persist via the opt-in `JsonFileBridgeStore`; the domain /
trigger in-memory stores remain in-memory.

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
