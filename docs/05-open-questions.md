# Open questions

Things deliberately undecided or known-approximate. Ordered by impact.
The concrete gap/defect inventory lives in `06-defect-register.md` —
these are the underlying *questions*; that file is the action list.

## Sync granularity

- **1.5s event poll** is the platform floor for remote visibility. If a
  product needs faster collaboration (cursor presence, near-live co-editing)
  the options are: lobby the platform for a push channel, or a companion
  WebSocket service authenticated by the same launch identity. Neither is in
  the scaffold.
- **Update doc size** — `encodeStateAsUpdate` keeps the blob compact, but a
  very long-lived room still approaches the 300KB cap. Compaction strategy
  (checkpoint + new doc key generation) is designed but not implemented.

## Agent legibility

- **Cross-actor total order** doesn't exist in journals (per-actor `seq` +
  timestamp merge). If an Agent ever needs a strict ordering proof, the
  platform's commit-serialized `event_id` stream is the tiebreaker — the
  scaffold does not currently correlate journal entries to event ids.
- **semantic/snapshot vs OBSERVE** — the mirror exists for direct `state.get`
  reads; OBSERVE is authoritative. Whether agents actually read raw state
  docs in production should drive how much effort the mirror deserves.

## Scope

- **Room model** — state is artifact-global. `collab:<room>` keys partition
  rooms by convention. If one artifact must isolate rooms (privacy between
  topics), room keys need to be unguessable or access-scoped — currently
  they are not.
- **Private state** — the private view recipe stays in localStorage. If a
  product wants per-user private state *in* the runtime, key it
  `private:<uid>:<name>` — but remember every viewer can read every key;
  privacy would need platform ACLs that don't exist today.

## Identity edges

- Guest identity is a self-asserted `guest` — fine for a demo, wrong for
  anything where attribution matters. Products should decide whether guests
  can write at all.
- The launch-code exchange endpoint is modeled, not verified against the
  gateway implementation (see `04-cats-company-context.md` assumptions).

## Agent-side writes

- **Bot write scope**: can a bot write runtime state outside an active run
  (`presence:*`, `journal:*`, `agent:*`, `result:*`)? The platform resolves
  state access per `(agent, artifact)` but writes may be bound to a run or
  viewer session — verify `resolveStateAccess`/`PutArtifactRuntimeStateForRun`
  scoping in `cats-company/server/artifact_runtime.go` before production.
- **Presence for bots** is deliberately optional (TTL beacon for proactive
  work only); primary status derives from the native `task.status`/`run`
  stream. If platform bots can write presence, a longer-lived agent could
  heartbeat normally.
- **`runtime.agent_participants`** is solved app-side for now: agents
  self-declare via `agent:card` (server-attested `updated_by`), which is
  live and unforgeable — arguably better than a static manifest field.
  The manifest field remains a forward-compat proposal for cats-company.
- **Agent-read ordering**: `journal:*` + `semantic/snapshot` may be a beat
  behind live pages; OBSERVE `runtime_view` is authoritative. If agents
  need strict ordering, correlate journal entries with the commit-ordered
  event stream (`event_id`).
