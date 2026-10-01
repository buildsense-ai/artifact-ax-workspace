# Defect register (残缺点)

Known gaps ordered by whether they can actually hurt. Each entry: what,
why it matters, how to verify/fix. Status date: 2026-09-30.

## P0 — real blockers (must clear before real deploy)

| # | Defect | Why it matters | Verify / fix |
|---|--------|----------------|--------------|
| P0-1 | **No real deployment has ever run** | Everything is "correct by design" on the wire the mock approximates; frame-bridge handshake, identity exchange, real CAS, task dispatch, event ordering are unverified | Deploy `apps/demo-spa` as an artifact version; run the checklist in `docs/02` + `05` end-to-end on the gateway |
| P0-2 | **Bot write scope unverified** | The entire agent-colleague model assumes bots can write `agent:*`, `presence:*`, `journal:*` (and `result:*` outside a run). If `resolveAgentAccess`/`PutArtifactRuntimeStateForRun` scopes writes to an active run, reactive colleagues can't exist | Read `cats-company/server/artifact_runtime.go` access paths; test a bot PUT on each namespace during and outside a run |
| P0-3 | **`collab:` doc has no checkpoint rotation** | 300KB value cap is a hard ceiling; annotations/proposals/journal grow forever. Long-lived rooms will hit it and writes start failing | Implement `collab:<room>:gen-<n>` generations (designed; `docs/02` + roadmap) + GC/retention for stale entities |
| P0-4 | **JEV never called the real API** | Stub-verified only. If the real `v1/systemone` envelope differs, every verdict silently becomes `abstain` — graceful but dead | One real-key call via `jev.config.json` + sidecar; assert `verdict` ∈ {allow,flag} on a known-good document |

## P1 — structural (works, but semantics are approximations)

| # | Defect | Why it matters | Verify / fix |
|---|--------|----------------|--------------|
| P1-1 | **Same agent proposes and judges** | In dev one loop plays both roles; the verdict is theater unless a different model/runner judges | Real deploy: judge intent handled by a different bot/model (JEV is already a separate model — assign it there) |
| P1-2 | **Compose is a hand-rolled equivalent** | `experimental_composeSpec` is unreleased; our `/compose` is noul→choice per candidate — no layout/move/replace second pass | When `@json-render/core` publishes it, swap sidecar internals; boundary (`/compose` in/out) unchanged |
| P1-3 | **Semantic mirror races reactive wakes** | Mirror debounces ~800ms; the annotate→patch path retries 4×300ms to paper over it — a race, not a guarantee | Re-read snapshot with bounded retry (done); better: include projection in the task input when the platform carries it |
| P1-4 | **Cross-actor journal order is timestamp-approximate** | "What happened" is legible; causal ordering is not provable | Correlate entries with commit-ordered `event_id` stream when strict order is needed (recorded in `05`) |
| P1-5 | **Transient dual-leader on joins** | `isLeader()` can be true on two sides during presence churn → duplicate judge submissions / materializations | All leader actions are idempotent-by-key today; add leader epoch/fencing if duplication becomes visible |

## P1 — deployment reality

| # | Defect | Why it matters | Verify / fix |
|---|--------|----------------|--------------|
| P1-1 | **Standalone direct-URL deploy was silently running the mock session** | `embedded = window.parent !== window` → direct URL → BroadcastChannel mock: all "shared" state stayed inside one browser context. Every e2e pass (presence, notes, annotate→patch) was two playwright pages in ONE context talking over BroadcastChannel — nothing ever reached the gateway. A user's annotations were invisible to everyone else | Fixed: `openHttpSession` standalone transport (`api/runtime/*`, backend forwards to gateway); falls back to mock only when no bridge answers. Deploy check: `curl <app>/api/runtime/connect` must return JSON, not 404 |
| P1-2 | **Verification ≠ verification** — e2e on a standalone URL only ever exercises the mock | Any "room verification" that doesn't cross process/browser boundaries proves nothing about the runtime | Real verification must run from two separate browsers/machines, or via `api/runtime/state.list` inspection server-side |

## P1.5 — porting hazards (learned from the online-todo deploy)

| # | Defect | Why it matters | Verify / fix |
|---|--------|----------------|--------------|
| P1.5-1 | **Schema identifiers are not display labels** | Found in production: renaming `kind: 'review-table'` → `'todo-table'` in the agent's document made `checkDocument` reject it — the whole result doc silently dropped, looking exactly like "result never written". Catalog kinds, contract_version strings, namespace names, and entity key prefixes are **cross-boundary identifiers** — they must stay stable across domain renames; only display labels, DOM anchors, and self-consistent internal keys may follow the domain | Keep `checkDocument` failures loud-ish: `normalize*` already rejects the whole result — document the rename boundary in the porting guide; consider logging `RDIAG`-style normalize failures in dev |
| P1.5-2 | **Silent normalize drops** | `handleResultEvent` `if (!payload) return;` discards malformed result docs invisibly — indistinguishable from "agent never wrote" | Dev-mode `console.warn` on normalize rejection (cheap; a real artifact needs a rejection receipt path anyway) |

## P2 — UX & maintenance edges

| # | Defect | Why it matters | Verify / fix |
|---|--------|----------------|--------------|
| P2-1 | **Undo scope excludes notes pads** | Y.Text pads are lazily-created root types, outside the UndoManager scope — typing there can't ⌘Z | Acceptable (native semantics) or hoist pads under a scoped map (breaking doc layout change) |
| P2-2 | **Overlay cards collide + region ghost is a dead rect** | Adjacent anchors overlap cards; the locate-flash ghost draws the stored rect, not reprojected | Card stacking/collision pass; reuse `deltas` reprojection for the ghost |
| P2-3 | **`agent:card` never expires** | A dead agent's card persists forever — weaker than presence TTL semantics | TTL the card (republish on wake; viewers treat stale `at` as gone) |
| P2-4 | **`flag` verdict has no downstream** | A flagged proposal just shows a red badge — no re-proposal or escalation loop | Optional: flag → notify proposer / auto-discard-with-reason |
| P2-5 | **Annotation text is single-writer** | Two humans can't co-edit one note | Convert `UiAnnotation.text` to a Y.Text ref inside the doc if co-editing becomes real |
| P2-6 | **Event replay causes notice noise** | Connect replays historical `result:` events → idempotent apply but repeated toasts | Track last-seen result key in session state; suppress notices for replays |
| P2-7 | **Overlay ⌘Z is one-shot** | Last-card undo exists; no redo and no per-card edit after submit (retract only) | Keep as is (retract covers it) or extend undo history |

## Standing approximations (accepted, not defects)

- Mock sync = BroadcastChannel lamport LWW + hello/dump join-sync — dev
  approximation of platform transaction-serialized CAS + commit-ordered
  events.
- Journal merge order = timestamp-approximate (per-actor seq exact).
- Presence = 5s heartbeat / 15s TTL; typing focus beats early.
- Launch-code exchange modeled from launch flow, not verified against
  gateway source.
- `?agent=1` canned colleague vs `?agent=jev` real JEV — the demo runs
  without keys by design.

## Next-action order

1. P0-1 deploy run (checklist in `docs/02` task/result section + `05`)
2. P0-2 bot write-scope test — can veto the colleague design, test first
3. P0-3 checkpoint rotation design doc → implement
4. P0-4 one real JEV call
5. P1/P2 by pain
