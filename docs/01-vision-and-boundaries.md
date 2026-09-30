# Vision and boundaries

**Artifact AX Workspace is a scaffold for building collaborative artifacts on
the CatsCo Artifact platform** — not a runtime, not a gateway, not a second
backend. One template application (`apps/demo-spa`) plus three small packages
show the whole path: identity → runtime state → shared document → agent
task → agent result.

## Thesis

An artifact is a normal web page served by the platform gateway. The platform
already provides everything a collaboration-capable page needs:

- **Identity**: a launch handshake turns the visitor's platform session into
  a verified `uid`/`username` (or an explicit guest). The page never holds
  credentials.
- **Shared state**: Artifact Runtime 0.2 persists namespaced JSON documents
  per `(agent, artifact)` with CAS revisions and an ordered event stream.
- **Agent legibility**: OBSERVE page context, task intents, result sinks, and
  `runtime_state` completion.

So the scaffold's job is only to show how to compose those pieces well —
in particular, how to put a Yjs document on runtime state **without making
the Agent blind** (see `02-collaboration-architecture.md`).

## What this repository is for

- **A starting point** for a new collaborative artifact: copy `apps/demo-spa`,
  keep the contract discipline, swap the domain.
- **A reference implementation** of the page side of the platform contracts
  (`packages/contract`, `packages/runtime-client`).
- **The collaboration pattern** (`packages/collab`): Yjs doc sync + presence
  + per-actor journals + semantic mirror.

## Boundaries (what this is not)

- **Not a second platform.** No artifact node, no publish lifecycle, no
  approvals service, no CLI, no standalone bridge, no auth adapter. The
  gateway hosts artifacts and owns persistence.
- **Not a generic runtime.** The page is an ordinary application; nothing is
  injected. There is no agent-controlled code execution anywhere.
- **Not the Agent side.** Task intents and result documents are declared and
  wired, but the Skill/Agent implementation that answers them lives in the
  platform deployment, not here.
- **Not real-time text collaboration.** Runtime events are polled (~1.5s).
  The scaffold targets shared workboards — findings, feedback, proposals —
  not Google-Docs-style typing.

## Hard rules

1. Runtime State documents are the only shared storage. localStorage is for
   explicitly private things (the private view recipe) and is never shared.
2. Everything an Agent may need to reason about exists as plain JSON in a
   declared namespace. Yjs update blobs are the human convergence substrate
   and are never agent-facing.
3. Attribution is structural: each actor writes only its own `journal:` and
   `presence:` keys; the platform stamps `updated_by`.
4. Task inputs carry bounded entity projections (ids, revisions, bounded
   text) — never event history, credentials, raw refs, or envelopes.
5. Agent results are **staged**, never silently applied: a person explicitly
   Uses or Discards a proposal. Idempotent by result id, always.
6. Page content, labels, and payloads are untrusted data — not instructions,
   authority, or permission proof.
