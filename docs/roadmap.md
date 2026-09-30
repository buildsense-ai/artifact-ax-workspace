# Roadmap

Status of the collaboration-first scaffold (2026-09-27). The earlier
cats-company-node scaffolding (artifact node, AX gateway, artifactctl,
bridge, transitional auth, skill packaging) was removed — superseded by the
platform's own gateway hosting, runtime state, and launch identity.

## Delivered

| Piece | Purpose | Status |
| --- | --- | --- |
| `@artifact-ax/contract` | manifest v4 + frame-bridge/runtime/context/result/task envelopes + bounded validators | implemented + tested |
| `@artifact-ax/runtime-client` | page-side session: handshake, runtime ops, task submit, context/result serving, launch identity, BroadcastChannel mock | implemented + tested |
| `@artifact-ax/collab` | `CollabDoc` (Yjs over runtime state), `Presence`, `Journal`, `SemanticMirror`, `CollabRoom` | implemented + tested |
| `@artifact-ax/lesson-report` | teaching-report vocabulary + seed rows | implemented |
| `@artifact-ax/ui-document` | declarative UI document contract + catalog + patches — staged proposals render agent-authored documents read-only | implemented + tested + used by the demo |
| `@artifact-ax/jev` | TypeSafe System One client, agent-side only: `/v1/systemone` wire shape, noul signal gate → typed choice verdict, abstention at the 0.60 floor, strict envelope validation | implemented + tested; dev runner wired (`?agent=jev` → `jev:sidecar`); platform bot-runner wiring open |
| `apps/demo-spa` | collaborative lesson report: identity bar, presence (incl. agent colleagues), Yjs board, live shared-notes pad (Y.Text), journal feed, staged agent results + agent-authored view previews, JEV verdict badges, task submit, OBSERVE serving | implemented + tested |

## Mock vs platform-verified

- `createMockSession` mirrors the runtime op contract and replicates state
  over `BroadcastChannel` with `hello`/`dump` join-sync; ordering is
  lamport LWW, **not** the platform's transaction-serialized CAS.
  Dev-surface only.
- The launch-code exchange endpoint (`/_exchange/identity`) is modeled from
  the launch flow, not verified against the gateway source.
- The `result:<task>` key convention and the five-namespace layout are
  scaffold conventions within a declared-contract boundary.

## Deliberately not implemented

- Checkpoint/compaction rotation when a Yjs update blob approaches 300KB.
- Push-channel presence or sub-second collaboration (platform polls
  ~1.5s) — live text works but remote keystrokes lag the poll.
- Room-level access control (state is artifact-global; room keys are
  conventions, not capabilities).
- Agent-side Skill packaging (out of scope; task/result contracts are
  declared in the manifest).
- Agent-authored `UiDocument` proposals render **read-only** in staged
  cards; `Use` applies only the row recipe — interactive documents and
  agent→page UI *patch* proposals remain open.

## Likely next steps

Order follows `docs/06-defect-register.md` (the concrete defect list):

1. **P0-1** Deploy the demo as a real artifact version — frame bridge,
   identity exchange, runtime connect/state/events, task submit, result
   loop end-to-end on the gateway.
2. **P0-2** Verify bot write scope on `agent:`/`presence:`/`journal:`/
   `result:` namespaces (can veto the colleague model — test first).
3. **P0-3** Doc checkpoint rotation (`collab:<room>:gen-<n>`) + retention.
4. **P0-4** One real JEV call against `api.typesafe.ai`.
5. Then: remote cursor/selection awareness; `?agent=jev` judge/proposer
   split across real runners; interactive UiDocument and patch proposals.
