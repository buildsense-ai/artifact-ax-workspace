# AX contract and CLI surface

The AX contract gives an external actor enough information to understand and operate the application without learning its implementation. The contract is domain-oriented and transport-neutral.

## Contract layers

The contract has four layers:

1. **Manifest** describes the Artifact, Regions, versions, capabilities, and policy hints.
2. **Projection** exposes a bounded, current view of application state.
3. **Command** requests a semantic state transition.
4. **Event** reports progress, outcomes, approvals, and state revisions.

The application may deliver these layers over HTTP, WebSocket, or Server-Sent Events. A CLI, an AG-UI adapter, and a human SPA can all consume the same contract.

## Manifest example

The manifest describes what an actor may discover. It does not grant permission; the server filters capabilities again for the authenticated actor.

```json
{
  "contract_version": "artifact.ax.v1",
  "workspace_id": "ws_demo",
  "artifact_id": "lesson-report",
  "title": "Lesson report",
  "published_version": 3,
  "regions": [
    {
      "id": "review-table",
      "title": "Review table",
      "summary": "Rows awaiting teacher review",
      "order": 1
    }
  ],
  "capabilities": [
    {
      "name": "filter_rows",
      "description": "Filter the review table",
      "input_schema": {"type": "object", "properties": {"status": {"type": "string"}}}
    },
    {
      "name": "approve_rows",
      "description": "Approve selected rows after confirmation",
      "requires": ["artifact:execute", "approval:user"]
    }
  ]
}
```

The HTML surface can expose stable identifiers for human and machine navigation:

```html
<main data-artifact-id="lesson-report">
  <section data-region-id="review-table" data-region-title="Review table">
    <!-- Normal application UI. -->
  </section>
</main>
```

These attributes identify an application area; they are not authorization credentials. The server still validates every command.

## State projection

An inspection response should include only the state required for the actor’s task. It should contain a `version`, `revision`, bounded data, pending approvals, and a cursor for recent events.

The service should cap bytes, depth, array length, and event count. A large document can expose a summary and a separately authorized resource reference instead of placing the whole document in an Agent context window.

## Command semantics

Commands are semantic and typed. A command has a stable name, an input schema, an expected revision, and an idempotency key.

The application returns one of the following structured outcomes:

- `accepted`: the command applied and produced a new revision;
- `pending_approval`: a named actor must resolve an approval;
- `conflict`: the base revision is stale and a fresh projection is required;
- `rejected`: policy, schema, or business validation failed;
- `failed`: execution failed after validation and includes a retry hint.

## Event semantics

Events are ordered within an Artifact stream and include `event_id`, `revision`, `actor`, `caused_by`, and a typed payload. A consumer can resume from a cursor and detect a gap.

The application can map events to AG-UI as follows:

| AX event | Optional AG-UI mapping |
| --- | --- |
| Task started/finished/failed | `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` |
| State snapshot or patch | `STATE_SNAPSHOT`, `STATE_DELTA` |
| Capability execution | `TOOL_CALL_*` and tool result |
| Human approval | interrupt/resume flow |
| Domain-specific activity | `ACTIVITY_*` or a namespaced custom event |

The mapping belongs in a gateway. The SPA and its domain service continue to speak the AX contract.

## One external CLI

The project can expose one CLI binary, for example `artifactctl`, with a generic command surface:

```text
artifactctl describe <artifact>
artifactctl inspect <artifact> [--region <id>]
artifactctl apply <artifact> <capability> --input <json>
artifactctl watch <artifact> [--cursor <cursor>]
artifactctl publish <draft> --approval <token>
```

The exact name is not a product decision. The important property is that the CLI is a capability gateway, not an unrestricted shell wrapper. It returns JSON by default so an Agent can reason over stable fields and structured errors.

## No Artifact runtime requirement

The SPA can implement its own normal state store, event subscription, and UI transitions. The project does not require a shared JavaScript runtime to be injected into every Artifact.

A reusable validator, manifest schema, or test fixture may help builders during development. Those tools are build-time aids and do not make the published application Agent-dependent.

## Compatibility

Every manifest, command, and event includes a contract version. A server should accept one current version and a documented compatibility window, reject unknown major versions, and preserve published versions so an active use session does not change behavior unexpectedly.
