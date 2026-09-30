# Collaboration architecture

How a collaborative artifact works in this scaffold, and — the design
constraint that shaped everything — how the Agent knows what happened.

## The substrate the platform gives us

Artifact Runtime 0.2 (`catsco.artifact-manifest.v4` → `runtime`) provides:

- **State documents**: `state.get|list|put|patch` over namespaced JSON
  documents, shared per `(agent, artifact)`, ≤300KB, CAS revisions
  (`base_revision` → `revision_conflict` with `current_revision`).
- **Events**: `events.subscribe` delivers a commit-ordered stream
  (`state.updated` plus task/run/result events) to every connected viewer.
  The host polls `events.list` roughly every 1.5s — that is the latency floor
  for remote visibility.
- **Attribution**: every write is server-stamped `updated_by`.
- **Identity**: launch code / identity cookie → verified `uid`/`username`
  (see `03-page-contract.md`).

Important: state is scoped to the artifact, **not to a topic or a user**.
Rooms are an application-level convention: the demo isolates collaboration
groups by room-prefixed keys (`collab:<room>`).

## The five namespaces

The template manifest declares five `read-write` namespaces:

| Namespace | Key shape | Contents | Readers |
| --- | --- | --- | --- |
| `shared` | `collab:<room>` | Yjs update blob (base64) — opaque convergence substrate | human viewers |
| `presence` | `presence:<uid>` | heartbeat: identity, focus, TTL | everyone + Agent |
| `semantic` | `snapshot` | leader-elected projection of the merged board | Agent (direct read) |
| `journal` | `journal:<uid>` | per-actor bounded semantic event log (≤50 entries) | Agent (authoritative history) |
| `result` | `result:<task>` | agent result documents (runtime_state completion) | viewers (staging) |
| `agent` | `note:<w>`, `fb:<f>`, `patch:<id>` | proactive agent docs — leader materializes into pad text / feedback entities / staged canvas patches | leader → shared doc |

State keys may only contain `A-Za-z0-9._:-` — `:` is the separator, never `/`.

## Human convergence: Yjs over runtime state

`packages/collab` (`CollabDoc`) syncs one `Y.Doc` through one state key:

```
local edit → Yjs transaction → debounce → stateGet → applyUpdate(remote) →
  encodeStateAsUpdate → base64 → CAS state.put
CAS conflict → re-read, merge, retry (≤4)   // CRDT merge, never lost data
remote write → state.updated event → stateGet → applyUpdate (dedup safe)
applyUpdate gained ops → repersist        // merged state is written back,
                                          // so convergence never depends
                                          // on who edits next
```

All domain state (rows, work items, findings, feedback, proposals) lives in
plain-JSON values inside the one Yjs document. Convergence is automatic and
attribution of merges is intentionally fuzzy — which is exactly why the
channels below exist.

## Live text: the actual Yjs surface

Discrete entity records exercise CRDT only at value level. The demo also
ships a real character-level merge surface: each work item carries a
`notes:<id>` shared `Y.Text`, bound to a `<textarea>` by
`bindTextarea` (`packages/collab/text-binding.ts`):

- Local input is spliced into the Y.Text as minimal diff edits; remote
  merges are applied back with caret preservation.
- Notes-only transactions do **not** trigger a board re-render — the live
  binding owns the textarea; structural changes re-render with focus
  + selection restore.
- Focus publishes `presence.focus = notes:<id>` immediately (typing
  indicators); blur journals one `notes.update` entry when the text
  changed — keystrokes are synced, semantics are journaled.

## Agent legibility: three honest channels

**Yjs is the transport, not the record.** Anything an Agent reasons about
exists as plain JSON:

1. **Journal** — every domain mutation appends one compact entry to the
   writer's own `journal:<uid>` (serialized per-client queue, CAS on own
   key). Server-stamped `updated_by` makes entries non-forgeable
   cross-actor. Bounded to 50 entries; this is the authoritative
   "who did what" feed.

2. **Semantic snapshot** — `semantic/snapshot` is written by a single leader
   (smallest live uid in the presence set; TTL expiry rotates leadership).
   It is a derived, eventually-consistent convenience view — clearly marked
   as such. The authoritative semantic answer is OBSERVE.

3. **OBSERVE `runtime_view`** — when the Agent requests page context, the
   page synthesizes the projection from its fully-merged local document:
   online actors, board revision, work items/findings/proposals, and the
   last ~20 journal entries. No election needed; the live page is the best
   mirror.

## The Agent is a colleague — honestly

An agent cannot produce Yjs operations: it only reads and writes JSON state
documents. So the honest model is **agent writes intent docs; a live page
materializes them into the shared document**. Every agent artifact is a
plain bounded JSON doc in `agent:` — no agent ever touches the Yjs blob:

- `agent/fb:<finding>` → leader applies as a real `FindingFeedback` entity
  (actor = the doc's `updated_by`) — structured, attributable, queryable.
- `agent/note:<work-item>` → leader splices `[agent] …` into the shared
  notes `Y.Text` — human-visible prose, the colleague-typing flourish.

Both are idempotent by (key, revision) via the `agentnotes` map; only the
leader applies so concurrent tabs can't double-insert. Leadership rotates
on TTL expiry and a leader sweep re-applies missed docs on takeover.

**Activity status is derived, not faked.** The platform already pushes
`task.status`/`run` events to every viewer — the page renders the agent
chip from that native stream, labeled by the declared
participant name when the runtime provides one. A `presence:<bot-uid>` beacon
(`kind: 'agent'`, `focus` = current activity) is an *optional* liveness
override for proactive (non-task) work; a burst process should not be
required to heartbeat. Agents never lead — neither `kind` entries nor
runtime-declared uids are eligible.

**Humans annotate the canvas the agent reads.** The `Annotate` toggle
opens a pi-annotate-style overlay (`annotate-ui.ts` — the in-page pattern
distilled from the upstream browser extension, MIT): numbered badges pin
to anchors, floating note cards carry the comment input, SVG connectors
link card↔badge, Alt/⌥+scroll cycles hovered ancestors, ESC discards,
Done batch-submits. Picking stays semantics-first (Codex-style):
`data-node-id` — ui-document nodes, table rows, work items — then
`data-region-id`, else a unique-verified generated selector; dragging
selects a region rect re-anchored to the smallest containing node (the
marker stores rect-vs-node deltas and reprojects onto the node's CURRENT
bounds). The `UiAnnotation` carries a
self-describing bundle: `kind`, semantic anchor, `selector`, `rect`,
`excerpt`, plus a bounded `context` summary (tag · role · name · size) —
enough for the agent to locate the intent without a live DOM.
`board.annotate` stores a shared `UiAnnotation` entity
(persistent, rendered as purple outlines on the anchored element) plus a
`ui.annotate` journal entry — which is exactly how the colleague sees it:
the agent's reactive wake reads the journal tail and acknowledges via
`agent.annotate-ack`.

**Annotations on canvas nodes close the loop.** The board carries a live
shared `UiDocument` (`canvasdocs` map, `canvas` entity) rendered by the
same read-only renderer as proposal previews — the agent-patchable
surface. When an annotation anchors to a canvas `nodeId`, the colleague
answers with more than an ack: it writes an `agent/patch:<id>` doc
(`lesson-report.canvas-patch.v1`) carrying a full `UiDocumentPatch`
target-tagged to the canvas revision. The leader page validates it
(`validatePatch` against the *current* canvas — invalid patches get an
`agent.patch-rejected` journal entry, never staged), materializes a
staged `CanvasPatchProposal`, and a human `Use` applies it atomically
(`applyPatch` bumps the revision; a stale `base_revision` fails closed).
Annotation → staged patch → Use → the annotated surface itself changes:
the artifact-as-canvas loop, under the same human-authorization rule as
everything else the agent proposes.

Two wake-path details matter. **Event coalescing is per namespace**: a
burst writes the journal entry and the `shared` Yjs blob back-to-back —
keeping only the last event in the window would swallow the `journal`
wake, so `AgentLoop` queues the latest event *per namespace*. And **the
mirror lags ~800ms**: the journal wake can fire before
`semantic/snapshot` contains the canvas, so the decider re-reads the
snapshot with a bounded retry before deciding the node is patchable —
ack-only is the graceful degradation, never a silent skip.

**Environment split on submit.** The annotation entity + journal entry
always land in room state; the *delivery* differs by host:

- **Embedded in cats-company** — the page submits
  `lesson-report.annotate-ask.v1` (runtime_state completion). The task
  host posts the task's visible message into the topic with
  `metadata.artifact_task_ref` — the annotation shows in the chat as an
  artifact reference, and the platform agent answers through the room.
- **Standalone / mock** — no chat exists, so the `ui.annotate` journal
  event itself is the ask: the colleague's reactive wake answers it
  (`agent.annotate-ack`). Composer button reads "Send to chat" vs "Ask"
  accordingly.

**The agent's own audit trail** is `journal:<bot-uid>` — same per-actor
log the humans use, server-attributed.

**The declaration is self-attested, not configured.** Agents announce
themselves with `agent:card`
(`{contract_version: 'lesson-report.agent-card.v1', name, kind: 'agent',
role?}`) on their first loop — every viewer discovers colleagues live,
and `updated_by` (server-stamped) is the proof: a human cannot forge a
card because they cannot write `agent:` docs under a bot identity.
Cards feed the chip label and the leader-exclusion uid set. The
manifest `agent_participants` field stays as optional forward-compat
(`validateManifestV4` accepts it, the platform parser does not yet), but
self-declaration is the mechanism — live, attributive, and platform-free.

**The agent's read path** (documented so intent docs are answerable):
`state.list` → `journal:*` for what happened, `semantic/snapshot` and
`presence:*` for who's here and what the board holds, `agent:*` /
`result:*` for its own artifacts. OBSERVE `runtime_view` carries bounded
row content and feedback excerpts — the agent can actually see what it is
being asked to review.

## The agent loop — perceive → decide → act

`?agent=1` runs a real `AgentLoop` (`packages/collab/src/agent-loop.ts`),
not a script. Wake sources: task submission (platform path) **and** room
`state.updated` events — a `finding.create` journal entry from a human
wakes the colleague without any task, and it leaves proactive feedback
unless it already has (checked via `agent/fb:` doc). Each wake assembles
an `AgentContext` — semantic projection + merged journal tail + bounded
doc reads — and the **decider** (a pure function of ctx, the only part a
real agent replaces) returns typed actions the loop executes: `presence`,
`state-put`, `result` (write-once), `journal`, `pause`, `wait`. The
decider never sees the page's board object — same information budget as
a platform agent.

Mock-side reactive wake: `createMockSession({agentEvents})` forwards the
store event stream to the agent session (real-platform bot event
subscription is an open question in docs/05 — the loop degrades to
task-only wakes without it).

## The task/result loop

1. Human selects a finding → page submits `lesson-report.collab-review.v1`
   (`task.request`) with a bounded input: work item + finding (id, revision,
   summary, row ids, feedback) + input-preparation disclosure + room.
2. Agent resolves the task ref → reads journal/semantic state docs → writes
   a `result:<task>` document (runtime_state completion). Its write emits an
   event to **every viewer**.
3. Every page validates the result doc → `board.applyAgentResult`:
   idempotent by result key (replays return the stored outcome; a different
   payload under the same id is `duplicate_result_conflict`), revises the
   finding, stages the comparison view.
4. A person explicitly **Uses** or **Discards** the view — producing journal
   entries the Agent reads next time. Closed loop, no hidden channels.

**The agent can author views, not just row selections.** `comparison_view`
may carry an optional `document` — a bounded json-render `UiDocument`
(`artifact-ax.ui-document.v1`) validated against the fixed catalog in
`packages/ui-document` before it may stage (an invalid document rejects
the whole result doc). The page renders it **read-only** inside the
proposal card (`apps/demo-spa/src/ui-render.ts`): data bindings resolve
against a snapshot view model (proposal rows, status counts, feedback
lines); events never wire. `Use` still applies only the row-selection
recipe — the document is a proposal *preview*, not a live surface.

**JEV judges the staged view — as evidence, never authorization.** The
leader submits `lesson-report.judge-view.v1` (input: proposal id, base
revision, row ids, the staged document). The judge writes
`result:<task>` = `lesson-report.view-judgment.v1`
`{proposal_id, verdict: allow|flag|abstain, confidence?, rationale}`;
every viewer attaches it to the proposal card (`applyViewJudgment`,
idempotent by result id, re-judgment supersedes). The verdict changes
nothing by itself — a person still Uses or Discards.

The judge is just another agent handling a declared intent. A real judge
calls **TypeSafe System One** (`POST {base}/v1/systemone`, Bearer key,
`{model, state, questions}`): `packages/jev` is the TS port of the
CatsLog `internal/jev` contract — the `noul` signal gate (below the 0.60
floor = a valid abstention, empty status), the closed `choice` verdict
with confidence in (0,1], strict envelope validation, bounded evidence
only, no authorization or persistence authority. The API key lives
agent-side; an artifact page must never hold it.

**Dev wiring**: `?agent=jev` runs the same `AgentLoop` but the decider's
hooks delegate to a local sidecar (`apps/demo-spa/scripts/
jev-sidecar.mjs`, `pnpm --filter ./apps/demo-spa jev:sidecar`). Vite
proxies `/jev/*` → `127.0.0.1:8787`; the sidecar reads
`jev.config.json` (gitignored; `jev.config.example.json` documents
`apiKey`/`baseUrl`/`model`/`port`). Two Jev-backed hooks:

- `POST /judge` — `judgeViewDocument`: staged document + proposal context
  + the real `CATALOG` descriptor → noul→choice verdict. Transport
  failure yields a typed `abstain`, never a guessed verdict.
- `POST /compose` — candidate-based spec composition (the json-render
  `experimental_composeSpec` discipline on our released client): the app
  supplies atomic element candidates; one batched `ask` evaluates a
  `noul` signal gate plus per-candidate include/omit `choice` questions;
  selected nodes keep catalog order. The composer only selects — it can
  never invent props or content the app did not offer.

On the platform the bot runner holds the same `JevClient`; the page
changes nothing. `?agent=1` keeps canned verdict + full-candidate
documents for keyless dev.

The second declared intent (`review-selection` → `agent-notes.upsert` result
sink) demonstrates the other completion channel: the platform delivers the
result to the page, the page applies it (note list) and returns an
application receipt.

**Undo is per-actor CRDT undo.** Every board mutation runs through
`tx()` (`doc.transact(fn, 'local')`); a `Y.UndoManager` scoped to all
entity maps tracks `trackedOrigins: {'local'}` only — remote
`applyUpdate` transactions ('remote') are structurally excluded, so
⌘Z/⇧⌘Z reverts *my* ops while colleagues' edits survive. Seeding is
cleared from history (`clearUndoHistory`), and every undo/redo writes a
`ui.undo`/`ui.redo` journal entry so the agent sees the retraction, not
just a missing entity. The annotate overlay keeps its own lighter
⌘Z for pending cards; notes-pad typing stays native (Y.Text ops are
out of undo scope by design).

## What is deliberately approximate

- Cross-actor journal ordering (per-actor `seq` is exact; merged order is
  timestamp-approximate — sufficient for "what happened").
- Mock-mode ordering (BroadcastChannel lamport LWW + join `hello`/`dump`
  snapshot; every winning remote merge emits a local `state.updated`, and
  doc merges repersist — documented as a dev approximation of the
  platform's transaction-serialized CAS + commit-ordered events).
- Leader-mirror freshness (debounced, event-driven, best-effort).
- Presence precision (5s heartbeat, 15s TTL; typing focus beats early).
