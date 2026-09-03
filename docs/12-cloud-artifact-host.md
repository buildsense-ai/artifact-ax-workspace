# Cloud HTML Artifact Host adapter

The demo SPA implements the page-side contracts used by the `cloud-html-artifact`
skill while keeping its application state and Agent boundary independent. The
official publisher owns the injected context/result/task bridge and the trusted
CatsCo Host connection. This repository owns only the application map, the
semantic snapshot, the result sink, and the adapter that consumes the injected
Host API.

The implementation was compared with the local `cloud-html-artifact` package
(v1.4.0), particularly `references/context-contract.md`,
`references/agent-task-loop.md`, `references/result-writeback.md`, and
`references/publication-contract.md`. Those files define the platform contract;
they do not become a runtime dependency of the SPA.

## Formal XiaoBa path

Use the injected Cloud Artifact Host plus the installed cloud-html-artifact and
lesson-report-artifact Skills for deployment. Keep the standalone Artifact
Bridge, artifactctl context commands, AG-UI projection, and transitional bridge
auth as local development harnesses only. The page never needs a custom
page-to-Agent endpoint or a cats-company source modification.

## Boundary

```text
human selects rows and writes an intent
              │
              ▼
      TriggerService / arbiter
              │ ContextBundle
              ▼
   CloudHostOutbox (optional adapter)
              │ requestTask(intent_id, bounded payload)
              ▼
     injected CatsCo Artifact Host
              │ normal visible Agent turn
              ▼
   Agent writes the declared result sink
              │ applyResult({ sink_id, result_id, ... })
              ▼
       SPA-owned note store + receipt
```

The AX domain and the local `artifact.ax.bridge.v1` remain valid when the Host
is absent. A directly opened page uses the mock outbox, or the explicit local
Bridge when `?bridge=` is configured. The injected Host takes precedence over
that query option because it represents the trusted cloud embedding boundary.

## Versioned application map

`apps/demo-spa/public/artifact-manifest.json` is a version-level map, not a
snapshot of current rows. It declares:

| Declaration | ID | Purpose |
| --- | --- | --- |
| Task intent | `lesson-report.review-selection.v1` | Ask the owning Agent to review a bounded ContextBundle. |
| Result sink | `lesson-report.agent-notes.upsert.v1` | Persist a summary and optional known row references as an Agent note. |
| Task intent | `lesson-report.compose-ui.v1` | Ask the owning Agent to propose a bounded declarative UI-document patch. |
| Result sink | `lesson-report.ui-document-patch.propose.v1` | Stage a bounded `UiDocumentPatch` proposal for the current preview; a human applies or discards it. |

The manifest uses `catsco.artifact-manifest.v3` because each task intent points
to a declared result sink. The review task schema mirrors the default
`CloudHostOutbox` payload: bundle identity, revision, stable selection anchors,
the user's intent text, and a compact assessment. The compose-ui task schema is
bounded and minimal: the current final UI document/configuration (compact
node/region inventory), the current application revision/identity, and the
user's requested UI intent. Neither task contains a prompt template, current
records, credentials, opaque context reference, or permission claim.

### Composition task / UI builder

The Builder panel is itself an approved `ui-builder` catalog surface rendered
from the same validated declarative UI document. An explicit request action
sends `lesson-report.compose-ui.v1` only through the injected Cloud Artifact
Host port (a second `CloudHostOutbox` bound to that task intent); the page never
invents a page-to-Agent endpoint, a Bridge, AG-UI, DOM automation, browser
secret, or cats-company dependency. With no Host the button is disabled and the
page says it will not dispatch a compose-ui task — standalone mode stays useful.

The `lesson-report.ui-document-patch.propose.v1` sink accepts an untrusted
`UiDocumentPatch` proposal. `applyResult()` validates its declared schema,
document id, base revision, operation constraints, stable anchors, and closed
catalog, rejecting raw code/HTML/JS/CSS and malformed/no-op/stale patches, then
durably stages the proposal in the browser-local store before returning an
`applied` receipt. Three governance surfaces — `review-table`, `approval-list`,
and `ui-builder` — are protected: a proposal containing a `remove` op for any of
them is rejected with code `protected_surface` and never staged, and the same
check is applied when a persisted active document is reloaded at startup (a
stored document missing one fails closed to the shipped document). The patch is
**never** applied merely because it was delivered: a later human `Apply`
revalidates against the then-current document and persists the updated active
`UiDocument` **before** reporting success. Apply and discard are transactional:
if either persistence step (document, or proposal metadata) fails, the
operation fails with code `storage_failed` and a visible status message, the
prior proposal state is restored, and no in-memory mutation is left; the
document and proposal stores never silently diverge. Staging never retains the
delivered payload object: the patch is canonicalized (deep-cloned with sorted
keys) after validation, so idempotency fingerprints and stored records are
independent of caller identity/property order, and an unknown patch envelope
field is rejected. Reloaded proposals fail closed too: `loadUiProposals`
validates the patch contract/envelope and op shapes, bounds the serialized
patch, summary, error, and timestamp fields, and rejects executable or unknown
content; full catalog/anchor/stale revalidation still happens at apply time
against the then-current document.
Result idempotency is sink-scoped so a result id cannot collide across the two
sinks.

Storage scope and honesty: staged proposals **and** the persisted active
`UiDocument` are keyed by **workspace + Artifact only, never by actor** — a
proposal belongs to the Artifact, not to the acting user. At startup the page
reloads the stored active document, and it **fails closed** to the shipped
document when the stored data is malformed, oversized, carries a different
document id/contract version, or drifts outside the deployed stable anchors.
The semantic context and the compose-ui task payload therefore always describe
the persisted active document. This storage is browser-local by design: it is
**not** cross-browser or multi-user collaboration, and no shared persistence is
assumed until a durable shared host is introduced.

The shared `@artifact-ax/contract` package validates v1/v2/v3 manifests,
bounded JSON Schema, Observation Packets, task statuses, writeback targets, and
application receipts. The validators are transport-neutral and perform no
network or DOM work.

## Page observation

After the first projection loads, the SPA installs:

```ts
window.catscoArtifact = {
  getContext() { /* synchronous, read-only, bounded */ },
  applyResult(request) { /* async, validated, durable */ },
  isDirty() { return false; }
};
```

`getContext()` returns the current report revision, filter, selected row IDs,
Focus Set anchors and notes, a bounded visible-row sample, previously applied
Agent-note summaries, and compact UI-document metadata (`ui_document`). The
implementation caps collections and strings and keeps headroom below the
bridge's 8 KiB semantic limit. The snapshot is page-authored observation data;
it cannot establish Artifact identity, authorization, or Agent instructions.
Focus Set clicks and the Builder intent are context, not dirty application
data, so the page reports `dirty: false`. Intermediate event/state history is
never injected (final-state-first) and remains a bounded opt-in query.

## Controlled result writeback

`applyResult()` is the only page function that accepts Agent-produced business
data. It applies the following checks in order:

1. Accept only the declared sink ID and the official result ID shape.
2. Validate the payload against the same bounded schema declared in the
   manifest, then reject unknown row IDs and duplicate list values.
3. Compare `expected_state_revision` with the current AX projection revision
   when the caller supplies one.
4. Use `result_id` as the idempotency key. A repeated request returns the prior
   application receipt; a changed payload with the same ID is rejected.
5. Persist the note in the SPA's workspace/Artifact/actor-scoped localStorage store before returning
   `{ status: "applied" }`.

Storage failures return `failed`; schema, row, sink, and revision conflicts
return `rejected`. The page never reports `applied` after changing only the
DOM. The note list and result ID survive a reload when browser storage is
available, which gives the demo a real application-level completion boundary.
The scope prevents a directly opened demo's actor picker from sharing notes
between actors or workspaces.

The sink intentionally writes notes instead of directly approving rows. The
existing `approve_rows` capability remains an AX command with its human
approval gate, so the demo does not misrepresent `pending_approval` as a
Cloud Artifact `applied` receipt.

`applyResult()` routes on the declared sink. The second sink
(`lesson-report.ui-document-patch.propose.v1`) never writes an Agent note; it
validates a `UiDocumentPatch` proposal against the current document and durably
stages it, returning `applied` only after the staged proposal is persisted. A
human `Apply`/`Discard` in the Builder panel (not the Agent) decides whether the
active document changes. This keeps a delivered Agent patch from ever becoming
a live application mutation on its own.

## Host task lifecycle

`packages/trigger/src/cloud-host.ts` provides a small `ArtifactHostPort` seam:

- `requestTask()` is called only from the Focus Set commit click.
- `onTaskStatus()` receives bounded `submitted`, `running`, `completed`, or
  `failed` states.
- `isConnected()` is optional and fails closed when it throws.

`CloudHostOutbox` never imports the DOM, calls `fetch`, posts a custom message,
or starts a process. It maps a ContextBundle to a declared task intent and
keeps the Host-owned payload out of the page outbox. `running` is acknowledged
but not complete. An official contract-marked `completed` status is successful
because CatsCo emits it only after the exact page returns an application-level
`applied` receipt; a marker-less structural Host must carry that application
status explicitly.

The adapter stages `collect`, `suggest`, `confirm`, and deferred `send` bundles
locally. It also stages a `user_activation_required` response. A later explicit
click (the demo shows a `Send now` action for resumable sends) can resubmit the
same staged bundle with `delivery=sent`; the adapter never retries a timeout
automatically and never falls back to the local Bridge after a Host request.
When one click produces multiple semantic groups, the Host's one-activation
rule means only the first task may be created; later groups remain visibly
queued for a separate explicit action.

The Host task creates a normal visible CatsCo user turn. This adapter therefore
provides an AG-UI-like structured interaction without promising silent chat
injection or a hidden model call.

## Local verification

Run the repository checks from the workspace root:

```bash
rtk mise exec -- pnpm test
rtk mise exec -- pnpm -r run typecheck
rtk mise exec -- pnpm -r run lint
rtk mise exec -- pnpm build
rtk node /Users/pi-dal/Downloads/cloud-html-artifact/scripts/validate-artifact-manifest.mjs apps/demo-spa/dist
```

The Cloud HTML Artifact contract smoke scripts remain useful regression checks:

```bash
rtk node /Users/pi-dal/Downloads/cloud-html-artifact/scripts/smoke-artifact-observation-contract.mjs
rtk node /Users/pi-dal/Downloads/cloud-html-artifact/scripts/smoke-artifact-task-bridge.mjs
rtk node /Users/pi-dal/Downloads/cloud-html-artifact/scripts/smoke-write-artifact-result.mjs
```

These commands validate the platform package and this repository's manifest;
they do not claim that a real CatsCo production Host round-trip has run.

## Explicit non-goals

The integration does not copy the roughly 893-line injected bridge, add a
per-Artifact runtime, or change `cats-company`. The publisher still injects its
own bridge and branding during publication. Native OAuth/OIDC, a durable
multi-user note backend, an Agent runner, and a real CatsCo Host round-trip
remain separate follow-up work.
