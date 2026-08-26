# ADR 0001: Keep the AX-friendly Artifact app standalone

**Status:** Proposed

**Date:** 2026-08-26

## Context

The desired Artifact experience supports Builder Agents, human Builders, Operator Agents, and direct human interaction. The application should remain useful without an Agent and should avoid coupling its domain model to `cats-company`, a specific Agent SDK, or a generic browser runtime.

CatsCo already provides identity-related APIs, Bot identities, Topics, and Artifact publication routes. Its current general authentication surface is JWT and Bot API Key based; a general OIDC/OAuth contract is not yet documented.

## Decision

Create a separate Artifact AX Workspace project. Model the Artifact as a normal SPA with a semantic manifest, bounded state projection, typed commands, structured events, Drafts, Published versions, and explicit approvals.

Expose one external capability gateway, such as a CLI, for Agent access. Put AG-UI, MCP, CatsCo, and other integrations in adapters outside the Artifact domain model.

Use CatsCo as a future identity authority through a standard OIDC/OAuth contract. Until that contract exists, use a server-side transitional adapter that validates CatsCo JWTs through the account-center introspection API. Keep workspace ACLs and Artifact permissions in the standalone service.

## Consequences

### Benefits

- The SPA remains usable by people and portable across Agent hosts.
- The Agent surface stays semantic and compact.
- CatsCo can integrate later without owning Artifact state or build execution.
- Builders can work in Drafts while existing sessions remain stable.
- Human approvals, provenance, and rollback become first-class behavior.

### Costs

- The standalone service needs its own workspace, Artifact, version, and audit storage.
- The project must maintain an identity adapter until CatsCo exposes native OIDC/OAuth.
- Multi-actor conflicts require revision and branch handling.
- Arbitrary code building requires a sandbox and a separate security review.

## Alternatives considered

### Embed a generic Artifact runtime in every SPA

This approach gives a common client bridge but couples every published Artifact to a runtime version and Agent protocol. It is not required for the AX-friendly application model and remains an optional future optimization.

### Make `cats-company` the Artifact domain service

This approach reduces an initial deployment boundary but couples Artifact state, build lifecycle, and permissions to chat and Bot concepts. The new project keeps CatsCo integration behind an adapter instead.

### Let Agents control the browser directly

Browser automation can cover unstructured pages, but it makes state discovery and action execution fragile. The AX contract exposes semantic capabilities and keeps browser automation as an optional fallback.
