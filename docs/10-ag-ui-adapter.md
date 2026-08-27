# AG-UI adapter boundary

Status: implemented as a small, optional projection layer (2026-08-26).

The Artifact app remains a normal SPA. Its domain contract is
`artifact.ax.v1`, and the external inbox remains `artifact.ax.bridge.v1`.
AG-UI is added only at the bridge boundary, where a host that already speaks
AG-UI can observe structured interaction events.

```text
SPA Focus Set
    │ ContextBundle
    ▼
artifact.ax.bridge.v1  ── receipts ──▶  AG-UI-compatible SSE projection
    │                                      │
    └── artifactctl context ...            └── host UI / AG-UI client
```

## Why this shape

The smallest useful AG-UI effect here is event interoperability, not a second
Agent runtime. A bridge receipt already has the state and provenance needed to
render a non-chat interaction (queued, approval required, acknowledged, or
completed). Projecting that receipt at the edge keeps the Artifact and Agent
decoupled and avoids making every Artifact depend on an AG-UI SDK.

The adapter intentionally emits no `TEXT_MESSAGE_*` events. A selected region
is context, not a message to display in a conversation. A host may render the
namespaced custom event as an approval card, activity, notification, or any
other UI affordance.

## Endpoint

`apps/artifact-bridge` exposes:

```text
GET /v1/ag-ui/watch
```

`GET /v1/health` advertises the projection path, the three event families, and
the two namespaced custom-event names, so a host can discover the optional
surface instead of assuming AG-UI is present.

It uses the same loopback bind and bridge authorization boundary as the other
routes: a configured pairing token **or** an actor-scoped Artifact session.
The session path requires the read scope and filters every receipt by the
session actor. It returns one AG-UI-compatible JSON event in each Server-Sent
Events `data:` frame. Query parameters are:

| Parameter | Meaning |
| --- | --- |
| `state=<receipt-state>` | Optional receipt-state filter. |
| `bundle_id=<id>` | Optional one-bundle filter. |
| `include_context=1` | Explicitly include the full authorized ContextBundle once per bundle. Defaults off. |

The endpoint is a projection subscription, not an Agent execution endpoint. It
does not accept a prompt, call a model, or inject a message into CatsCo.

## Event mapping

Each bundle is represented as one AG-UI run for the lifetime of a connection:

| Bridge observation | AG-UI event |
| --- | --- |
| First receipt for a bundle | `RUN_STARTED` (`threadId = session_id`, `runId = bundle_id`) |
| Any receipt state | `CUSTOM` named `artifact.ax.bridge.receipt.v1` (including compact stable selection anchors) |
| `include_context=1` | `CUSTOM` named `artifact.ax.bridge.context.v1` (once) |
| `completed`, `rejected`, or `expired` | `RUN_FINISHED` with `result.bridge_state` |

`needs_confirm` and `queued` stay open. They are ordinary structured states,
not transport errors, so a policy rejection is represented by
`RUN_FINISHED({bridge_state: "rejected"})`, not by a fabricated model error.

The receipt custom value is compact and carries a stable reference rather than
duplicating the full payload by default:

```json
{
  "type": "CUSTOM",
  "timestamp": 1787702400000,
  "name": "artifact.ax.bridge.receipt.v1",
  "metadata": {
    "source": "artifact.ax.bridge.v1",
    "bundleId": "bdl-demo-1",
    "receiptId": "rct-1",
    "state": "needs_confirm"
  },
  "value": {
    "protocol_version": "artifact.ax.bridge.v1",
    "receipt": { "bundle_id": "bdl-demo-1", "state": "needs_confirm" },
    "bundle_ref": {
      "bundle_id": "bdl-demo-1",
      "session_id": "topic_lesson_report",
      "artifact_id": "lesson-report",
      "revision": 3
    },
    "selection_refs": [
      { "region_id": "review-table", "node_id": "row-17", "label": "Row 17" }
    ]
  }
}
```

`selection_refs` is deliberately limited to stable anchors, short labels, and
an optional per-selection note; the full payload remains behind the explicit
context option. This lets a host highlight several annotated locations
immediately while preserving the compact-by-default boundary.

`packages/trigger/src/ag-ui.ts` contains the pure projector and runtime guard;
`BridgeClient.watchAgUi()` and `artifactctl context ag-ui` are thin consumers.
The projector is per connection, so reconnects replay a self-contained
lifecycle without adding AG-UI state to the durable bridge store. Receipt
fingerprints make idempotent retries quiet.

## Local use

Start the bridge as usual, then consume raw AG-UI events:

```bash
pnpm exec tsx apps/artifact-bridge/src/serve.ts \
  --port 8788 --token 'some-long-local-pairing-token-0123456789'

pnpm exec tsx apps/artifactctl/src/cli.ts context ag-ui \
  --bundle-id bdl-demo-1 --include-context --timeout 5 \
  --bridge-url http://127.0.0.1:8788 \
  --token 'some-long-local-pairing-token-0123456789'
```

The CLI prints one event per line (NDJSON), so an Agent can consume it with no
AG-UI runtime and no browser credential. A browser host can use the same
`BridgeClient.watchAgUi()` method or connect directly to the SSE endpoint.

## Boundary and security notes

- Full context is never sent on the compact stream unless `include_context=1`
  is explicit and the caller is authorized by a pairing token or an
  actor-scoped Artifact session.
- The adapter is loopback-only. It accepts either the explicit local pairing
  token or the transitional Artifact session described in
  [docs/11-transitional-auth-adapter.md](11-transitional-auth-adapter.md);
  native JWT/OAuth/PKCE remains a later edge adapter.
- The bridge is not `cats-company` and does not call `/api/messages/send`.
  Nothing here creates a chat-visible message or changes the CatsCo codebase.
- This is a compatibility projection of three AG-UI event families, not a
  complete implementation of every AG-UI event or a replacement for an Agent
  server. An Agent runner can be connected later without changing the AX or
  bridge contracts.

References: [AG-UI architecture](https://docs.ag-ui.com/concepts/architecture),
[AG-UI events](https://docs.ag-ui.com/concepts/events), and the
[TypeScript event definitions](https://github.com/ag-ui-protocol/ag-ui/blob/main/sdks/typescript/packages/core/src/events.ts).
