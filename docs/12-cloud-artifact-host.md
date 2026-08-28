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

The manifest uses `catsco.artifact-manifest.v3` because the task intent points
to a declared result sink. The task schema mirrors the default
`CloudHostOutbox` payload: bundle identity, revision, stable selection anchors,
the user's intent text, and a compact assessment. It contains no prompt
template, current records, credentials, opaque context reference, or permission
claim.

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
Focus Set anchors and notes, a bounded visible-row sample, and previously
applied Agent-note summaries. The implementation caps collections and strings
and keeps headroom below the bridge's 8 KiB semantic limit. The snapshot is
page-authored observation data; it cannot establish Artifact identity,
authorization, or Agent instructions. Focus Set clicks are context, not dirty
application data, so the page reports `dirty: false`.

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
