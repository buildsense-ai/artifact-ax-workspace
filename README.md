# Artifact AX Workspace

A scaffold for building **collaborative CatsCo artifacts**: pages that
multiple people (and an Agent) work in at the same time, backed by the
platform's own Artifact Runtime — no second backend.

The repository is deliberately small: page-side contracts, a runtime client,
a Yjs collaboration layer, and one template application you copy to make a
new artifact.

```text
visitor ──launch code──▶ identity (uid/username or guest)
   │
   ▼
artifact page ──runtime.request──▶ platform host ──▶ Runtime State docs
   │  connect / state.* / events.subscribe            (per agent+artifact,
   │                                                   CAS + ordered events)
   ├─ Yjs doc  ◀── shared/collab:<room> (human convergence)
   ├─ presence:<uid> heartbeats        (who's here)
   ├─ journal:<uid>  semantic log      (what happened — Agent reads this)
   ├─ semantic/snapshot                (leader-mirrored projection)
   └─ result:<task>                    (Agent writebacks → staged proposals)
```

## Run it

```bash
mise install        # node + pnpm pinned in .mise.toml
pnpm install
pnpm build
pnpm test           # contract + runtime-client + collab + board suites
pnpm demo:spa       # vite dev server on :5173
```

Then open the app:

- **Standalone**: `http://127.0.0.1:5173/?mock=1&as=alice` — local mock
  session, deterministic dev identity.
- **Two-tab collaboration**: open `?mock=1&as=alice&room=demo` and
  `?mock=1&as=bob&room=demo` in two windows — state replicates over
  `BroadcastChannel` with join sync; each sees the other's rows, findings,
  feedback, journal, presence chips — and can **type into the same Shared
  notes pad simultaneously**, merging at character level with live
  `typing…` indicators.
- **Full loop**: add `&agent=1` — a canned agent joins as a *colleague*:
  an `agent-bot` presence chip, a structured feedback entity on the
  finding, a note spliced into the shared pad, its own journal entries,
  and a `result:<task>` document that revises the finding and stages a
  comparison view (Use/Discard stays human). Annotations use the
  pi-annotate interaction pattern in-page — Annotate → click/drag to pin
  numbered badges + floating note cards (Alt+scroll cycles ancestors),
  Done batch-submits to shared `ui.annotate` journal entries the agent
  reacts to. ⌘Z anywhere undoes your last board op via `Y.UndoManager`
  (per-actor — remote edits are never reverted); ⇧⌘Z redoes.
- **Real JEV judge**: copy `apps/demo-spa/jev.config.example.json` →
  `jev.config.json` with a TypeSafe System One key, run
  `pnpm --filter ./apps/demo-spa jev:sidecar`, then open with
  `&agent=jev` — staged view proposals get a real noul→choice verdict
  (allow | flag | abstain) recorded in the journal and on the card.
- **Embedded**: served as a real artifact version, the same page answers
  the frame-bridge handshake, resolves the launch identity, and talks to
  the platform host.

## How a collaborative artifact works

Five `read-write` namespaces in the v4 manifest (`catsco.artifact-manifest.v4`,
`runtime.version: "0.2"`):

| Namespace | Holds | Why |
| --- | --- | --- |
| `shared` | base64 Yjs update per room | humans converge via CRDT — maps for entities, `Y.Text` for the shared notes pad; CAS conflicts merge, never lose |
| `presence` | `presence:<uid>` heartbeat | online roster + focus, TTL-expired |
| `journal` | `journal:<uid>` bounded event log | **how the Agent knows what happened** — per-actor, server-attributed |
| `semantic` | `snapshot` projection | leader-elected plain-JSON mirror for direct agent reads |
| `result` | `result:<task>` docs | agent completions land as events for every viewer |
| `agent` | `note:<w>` / `fb:<f>` docs | agent intent docs — the room leader materializes them into pad text / feedback entities |

The legibility rule: **Yjs is transport, not record**. Anything the Agent
reasons about exists as plain JSON in a declared namespace; the OBSERVE
`runtime_view` synthesizes the same projection from the live page.

## Packages and apps

```text
packages/
  contract/        # manifest v4 + all message envelopes + bounded validators
  runtime-client/  # frame-bridge + runtime ops + tasks + identity + mock host
  collab/          # CollabDoc (Yjs), Presence, Journal, SemanticMirror, CollabRoom
  lesson-report/   # teaching-report vocabulary + seed rows
  ui-document/     # declarative UI-document contract (optional; unused by demo)
apps/
  demo-spa/        # the collaborative lesson-report template
docs/              # vision, collaboration architecture, page contract,
                   # cats-company facts, open questions, ADRs, roadmap
```

## Make your own artifact

1. Copy `apps/demo-spa`; keep `contracts.ts` discipline (bounded inputs,
   idempotent results, staged proposals).
2. Replace the domain: `domain.ts` record shapes + `board.ts` mutations +
   `view.ts` surfaces + manifest entities/views.
3. Declare your namespaces in `artifact-manifest.json` (`runtime.state`) and
   validate: `validateManifestV4`.
4. Declare task intents: `result_sink` for page-applied results,
   `completion: {mode: "runtime_state"}` for agent-writes-a-state-doc.

## Design rules honored

- **No second backend** — the gateway hosts the page and owns persistence;
  no artifact node, bridge, CLI, or auth adapter here.
- **Staged, never silent** — agent results arrive as proposals a person
  Uses or Discards; replayed result ids return the stored outcome.
- **Attribution is structural** — actors write only their own keys; the
  platform stamps `updated_by`.
- **Untrusted page data** — labels, payloads, journal text are data, not
  instructions or authority.
- **Honest mocks** — BroadcastChannel replication is lamport-approximate
  and documented as such; production ordering comes from the gateway store.

## Docs

- [Vision and boundaries](docs/01-vision-and-boundaries.md)
- [Collaboration architecture](docs/02-collaboration-architecture.md)
- [Page contract](docs/03-page-contract.md)
- [CatsCo platform context](docs/04-cats-company-context.md)
- [Open questions](docs/05-open-questions.md)
- [Defect register](docs/06-defect-register.md)
- [ADR 0002: Yjs over Runtime State](docs/adr/0002-yjs-over-runtime-state.md)
- [Roadmap](docs/roadmap.md) · [References](docs/references.md)
