# Vision and boundaries

Artifact AX Workspace is an independent application surface that humans and Agents can use together. The application owns its domain state and interaction model; an Agent participates through declared capabilities and semantic commands.

## Product definition

The product is an **AX-friendly App**, not an Agent runtime. It presents an ordinary SPA to people and a stable, machine-readable contract to Agents.

The phrase “AX-friendly” means that an Agent can discover what the application represents, understand a bounded projection of its state, request a semantic action, and receive a structured outcome. The Agent does not need to scrape coordinates, infer state from arbitrary text, or know the implementation framework.

The application is **agent-usable but not agent-aware**. It does not require a model, an Agent thread, or an AG-UI SDK to render and operate its normal user experience.

## What the application owns

The application owns the following concerns:

- Domain state and state transitions.
- Human-facing navigation, forms, tables, charts, and approvals.
- Stable Artifact and Region identifiers.
- A capability manifest that describes semantic commands.
- Structured command results, errors, revisions, and events.
- Draft, preview, published-version, and rollback boundaries.
- Actor provenance and audit records for application changes.

The application may use a normal HTTP, WebSocket, or Server-Sent Events client as part of its own business behavior. That client code is application logic; it is not a general-purpose Agent runtime.

## What stays outside

The following concerns stay outside the Artifact core:

- Model selection, prompting, planning, and Agent orchestration.
- Agent-specific tool schemas and SDKs.
- CatsCo conversations, Bot execution, and device routing.
- Identity-provider internals and service secrets.
- Long-lived business databases that do not belong to the Artifact domain.

An external gateway can translate between the application contract and AG-UI, MCP, a custom Agent, or a human-operated script. This keeps the Artifact portable across hosts and Agents.

## The two planes

The application has two related but separate planes.

### Build plane

The build plane changes the Artifact definition: source, schema, components, workflows, or configuration. Builders work against drafts or branches, and validators produce a preview before a version becomes publishable.

### Use plane

The use plane runs a published Artifact. People and Operator Agents filter data, fill forms, approve actions, and submit domain commands. Use-plane changes are recorded as events against a specific published version and state revision.

Separating these planes prevents a Builder Agent from changing the application underneath an active user session.

## AG-UI's position

AG-UI is an optional interoperability adapter. Its lifecycle, state, tool, and interrupt events can carry the application’s projections and command outcomes, but the Artifact does not make AG-UI event names its domain model. See the [AG-UI architecture](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/architecture.mdx) and [events](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx) documentation.

## First-principles assessment

Every collaboration scenario needs four capabilities: display, identify, understand, and change. A normal SPA already handles display; the independent project should first make identity, bounded context, and controlled change explicit.

The highest-confidence design choices are semantic commands, versioned state, actor provenance, and a single capability gateway. Arbitrary code generation in a live session, a universal canvas, and conflict-free editing of every possible source file have lower confidence and should remain optional extensions.

## Smallest meaningful scenario

One teaching-report Artifact provides a table and an approval area. A Builder Agent creates a draft, a human reviews and publishes it, and an Operator Agent or another person filters rows, requests approval, and continues after the approval is resolved. The scenario exercises the full collaboration boundary without requiring an infinite canvas or a framework-specific runtime.
