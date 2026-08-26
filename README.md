# Artifact AX Workspace

Artifact AX Workspace is a standalone design project for an independent, agent-friendly application. The project starts with contracts and examples; it does not assume a shared runtime, a particular Agent SDK, or a dependency on `cats-company`.

## Thesis

An Artifact is a normal application that people can use directly. It exposes a semantic surface that Agents can discover and operate through an external capability gateway such as one CLI. The application remains useful when no Agent is connected.

```text
Instruction
    ↓
One external capability gateway
    ↓
AX-friendly Artifact SPA
    ├─ human UI
    ├─ application state
    ├─ semantic commands
    └─ structured events
```

The Agent does not need to know the SPA framework, inspect pixels, or embed a generic Artifact runtime. AG-UI can act as an adapter at the boundary when a host needs its event vocabulary; the Artifact domain model stays independent.

## Collaboration model

The application supports several kinds of actors:

- Builder Agents or people create drafts and propose changes.
- Reviewers approve, reject, or publish versions.
- Operator Agents and people use the published application.
- Observers follow state changes, provenance, and pending approvals.

Build changes and live interaction changes use separate permissions and version boundaries. A draft never silently replaces a version that another person is using.

## Current status

This repository captures the product and protocol discussion as of 2026-08-26. It contains no production runtime or integration code yet. The next implementation decision is intentionally left open until the Artifact contract, build lifecycle, and permission model are reviewed.

## Documents

- [Vision and boundaries](docs/01-vision-and-boundaries.md)
- [Domain model](docs/02-domain-model.md)
- [Human and Agent collaboration](docs/03-agent-human-collaboration.md)
- [AX contract and CLI surface](docs/04-ax-contract.md)
- [Authentication and permissions](docs/05-auth-and-permissions.md)
- [CatsCo integration context](docs/06-cats-company-context.md)
- [Build and publish lifecycle](docs/07-build-publish-lifecycle.md)
- [Open questions](docs/08-open-questions.md)
- [Proposed CatsCo OAuth contract](docs/09-cats-company-oauth-contract.md)
- [ADR 0001: standalone AX-friendly app](docs/adr/0001-standalone-ax-friendly-app.md)
- [References](docs/references.md)

## Relationship to CatsCo

The reference repository is located at `../cats-company`. The current integration notes are based on its local code and documentation, not on an assumed OAuth implementation. CatsCo currently provides user JWTs, Bot API Keys, account-center introspection, Agent/Topic relationships, and Cloud Artifact proxying. A future standalone application can use CatsCo as an OIDC/OAuth authority after that interface is explicitly defined.

See [CatsCo integration context](docs/06-cats-company-context.md) for the observed endpoints, existing constraints, and the proposed adapter boundary.
