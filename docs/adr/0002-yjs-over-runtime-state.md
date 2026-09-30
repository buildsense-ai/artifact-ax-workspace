# ADR 0002: Sync Yjs through Runtime State instead of a dedicated collab server

**Status:** Accepted

**Date:** 2026-09-27

## Context

Supersedes the transport assumptions of
[ADR 0001](0001-standalone-ax-friendly-app.md): the CatsCo platform now hosts
artifacts behind a gateway, provides verified visitor identity (launch code +
domain identity cookie), and exposes Artifact Runtime 0.2 — durable,
CAS-versioned, event-broadcast namespaced state shared by all viewers of an
artifact.

The scaffold needs real collaboration. The usual answer is `y-websocket` or a
hosted provider — which would mean a second backend, a second auth story,
and ops surface this project explicitly does not want.

## Decision

Introduce **Yjs core only**, synced through the platform's own Runtime State:

- One `shared` state document carries the base64 Yjs update; writers merge
  remote updates and CAS-put; readers apply updates on `state.updated`
  events.
- Agent legibility is a first-class part of the design, not an afterthought:
  per-actor `journal:<uid>` documents carry the semantic event log
  (`updated_by` makes attribution structural), presence lives in
  `presence:<uid>` heartbeats, and a leader-elected `semantic/snapshot` plus
  OBSERVE `runtime_view` expose plain-JSON state to the Agent.
- No y-websocket, no provider server, no separate persistence, no second
  identity system.

## Consequences

### Benefits

- Zero new infrastructure: the gateway is the sync + persistence layer.
- CAS conflicts resolve by CRDT merge — concurrent writes converge instead
  of last-writer-losing.
- Identity, attribution, and room sharing reuse the platform contract.
- Local dev keeps working: `?mock=1` swaps in a BroadcastChannel-backed
  mock session and two browser tabs genuinely collaborate.

### Costs

- Remote visibility latency is the host's ~1.5s `events.list` poll — fine
  for workboard-style collaboration, wrong for co-typing.
- 300KB state cap bounds doc growth; long-lived rooms need a checkpoint
  rotation that is not yet implemented.
- Agent-facing semantics must be maintained twice (Yjs doc + journal/
  mirror). Mitigated by making projections derived, bounded, and clearly
  marked eventually-consistent.

## Alternatives considered

### Dedicated y-websocket service

Lower latency and real ephemeral awareness, but a second deployable, a
second auth integration (still solvable via the launch identity), and one
more place where the artifact's truth could drift from platform state.

### Plain CAS state documents without Yjs

Per-entity JSON keys are natively agent-readable, but concurrent edits to
the same finding/feedback become LWW or hand-rolled field merges —
reinventing a worse CRDT. Kept as the model for `journal:`/`presence:`/
`result:` keys, where single-writer-per-key makes CAS sufficient.

### Full-CRDT domain with leader-mirror only

Works, but journal entries would be produced only by the leader — losing
the per-actor, server-attributed event log that makes "who did what"
auditable. The design keeps journals per-actor and the mirror merely
convenient.
