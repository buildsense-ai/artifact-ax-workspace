# Domain model

The model separates an Artifact’s definition from its live use and gives every change an actor, a version, and a causal link.

## Core entities

| Entity | Meaning | Main invariant |
| --- | --- | --- |
| Workspace | A permission and collaboration boundary | Every Artifact and actor belongs to a workspace. |
| Artifact | The named application surface | Its identity remains stable across published versions. |
| Region | A semantic area of an Artifact | Its identifier is stable within the Artifact contract. |
| Draft | A mutable build candidate | A draft never becomes active without a version transition. |
| Published version | An immutable runnable definition | A use session pins to one version. |
| Use session | A live interaction context | It records the Artifact version and state revision. |
| Actor | A human, Agent, service, or system process | Every command and event identifies its actor. |
| Capability | A semantic operation the application exposes | The application validates it against policy and revision. |
| Command | A request to perform a domain action | It is schema-validated and idempotent when retried. |
| Event | A recorded result or state transition | It carries provenance and a causal relationship. |
| Approval | A human or policy decision required by an action | It is explicit, scoped, and resumable. |

## State ownership

The application should distinguish three state classes.

| State class | Owner | Examples | Agent visibility |
| --- | --- | --- | --- |
| Local UI state | SPA | Active tab, hover, open panel | Usually not shared. |
| Collaborative state | Artifact service and SPA | Filters, drafts, selections, approval status | Exposed through a bounded projection. |
| Durable business state | Domain service | Published records, permissions, final submissions | Exposed through authorized commands and projections. |

An Agent proposes a semantic transition. The application and its policy layer decide whether to apply it. This arrangement preserves a single business authority while allowing human and Agent participation.

## Build and use objects

Build commands target a Draft or branch. Use commands target a Published version and include an expected state revision. The service rejects a stale command with a structured conflict response instead of silently overwriting a newer change.

```text
Workspace
└── Artifact
    ├── Drafts / branches
    ├── Published versions
    │   └── Use sessions
    └── Event and audit history
```

## Actor roles

Roles describe intent, while scopes and Artifact ACLs enforce authority.

- **Builder** creates or edits a Draft.
- **Reviewer** validates a Draft and approves a publish transition.
- **Operator** invokes capabilities against a Published version.
- **Observer** reads projections and activity without changing state.
- **Owner** manages workspace membership, policies, and recovery.

One identity can hold several roles in different workspaces. An Agent identity never receives authority merely because its name contains “builder” or “admin”.

## Command envelope

Every command should carry enough information to make retries safe and conflicts explainable.

```json
{
  "command_id": "cmd_01J...",
  "workspace_id": "ws_demo",
  "artifact_id": "lesson-report",
  "version": 3,
  "base_revision": 17,
  "actor": {"id": "agent_440", "type": "agent"},
  "name": "approve_rows",
  "args": {"row_ids": ["r-12", "r-19"]},
  "idempotency_key": "approve-17-r12-r19"
}
```

The command result includes `accepted`, `new_revision`, a structured outcome, and any approval requirement. The result never asks a caller to infer success from a changed pixel or a free-form sentence.

## Event envelope

Events carry state changes, task progress, and provenance.

```json
{
  "event_id": "evt_01J...",
  "workspace_id": "ws_demo",
  "artifact_id": "lesson-report",
  "version": 3,
  "revision": 18,
  "actor": {"id": "human_27", "type": "human"},
  "caused_by": "cmd_01J...",
  "type": "approval.resolved",
  "data": {"decision": "approved"}
}
```

The application may map this envelope to AG-UI events at an adapter boundary. The core event remains meaningful to a human client, a script, or another Agent.

## Concurrency choice

Use optimistic revisions and Draft branches first. Add a CRDT only when the product demonstrates a real need for simultaneous character-level editing; a CRDT does not solve permission, publish, or domain-command conflicts by itself.
