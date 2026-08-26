# Human and Agent collaboration

The application treats humans and Agents as different kinds of actors in one workspace. Each actor uses the same semantic application contract, while policy determines which capabilities the actor can invoke.

## Co-work loop

The collaboration loop keeps intention, execution, and review visible.

1. An actor discovers the Artifact’s current projection and available capabilities.
2. A Builder proposes a Draft change or an Operator proposes a use-plane command.
3. The application validates the command against the actor, Artifact, version, and revision.
4. The application applies the change, requests approval when required, and emits a structured event.
5. Other actors observe the event, inspect the new projection, and continue from the new revision.

The loop supports a person asking an Agent to continue work, an Agent asking a person to approve a consequential action, and two Agents taking turns on one Artifact.

## Builder collaboration

Builders work on Drafts rather than the active Published version. A Draft records its base version, parent change, builder identity, validation results, and preview URL.

When two Builders start from the same revision, the service should preserve both proposals. The owner can merge compatible changes or ask one Builder to rebase against the newer revision. A failed merge is a visible task outcome, not an implicit overwrite.

## Operator collaboration

Operators change runtime state through semantic commands. The service checks `base_revision`, applies an idempotency key, and returns a new revision or a conflict projection.

Local UI state remains private to a browser unless the user explicitly promotes it to collaborative state. This keeps harmless actions such as opening a panel from consuming Agent turns or creating noisy audit records.

## Human-facing affordances

The SPA should make collaboration legible without turning the page into a log viewer.

- Show who owns the current Draft and who last changed the active version.
- Show pending approvals beside the affected Region.
- Show whether an Agent is proposing, executing, waiting, or blocked.
- Offer compare, undo, rollback, and “continue from this Region” actions.
- Keep the current state usable when an Agent disconnects.

The application should expose the same information as a compact machine projection so an Agent does not need to parse the visual timeline.

## Agent-facing affordances

An Agent needs a small, stable surface:

- `describe` returns capabilities, schemas, Regions, policy hints, and the current version.
- `inspect` returns a bounded state projection and recent causal events.
- `apply` submits a command with an expected revision and idempotency key.
- `watch` waits for a task, approval, or revision change and supports a resumable cursor.

The external CLI can expose these verbs through one executable. App-specific capabilities come from the Artifact manifest rather than from a growing list of Agent-specific tools.

## Multiple Agent runs

One Artifact can host several Agent tasks at once. Every task receives its own `task_id` and run metadata, but all commands still target an explicit Artifact version and revision.

The application must not treat one global Agent thread as the Artifact’s state owner. A task can finish, be cancelled, or reconnect while the Artifact remains available to other actors.

## Presence and notifications

Presence is advisory. A lock or “Agent is editing” indicator helps people coordinate, but authorization and revision checks remain authoritative.

Notifications should be event-driven and scoped. A person receives an approval request or a conflict notice only when their role, workspace membership, and subscription permit it.

## Recovery

The service stores periodic snapshots and an append-only event cursor. A reconnecting actor asks for the latest snapshot plus events after its cursor; a missing or invalid cursor triggers a fresh snapshot.

The application treats duplicate commands and duplicate event delivery as normal network conditions. Idempotency keys, revision checks, and immutable published versions make recovery predictable.
