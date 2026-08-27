# Authentication and permissions

Authentication identifies a human or Agent. Authorization decides what that actor can do in a workspace, on an Artifact, against a version, and within a particular Region. The two concerns must remain separate.

## Target identity boundary

The standalone application should treat CatsCo as a possible OIDC/OAuth authority, not as a database dependency. The application owns its workspace membership, Artifact ACLs, capability policy, and audit records.

The target flow is:

```text
Human browser ── OAuth Authorization Code + PKCE ──> CatsCo identity
     │
     └── short-lived token or secure session ──> Artifact service

Agent CLI ── delegated/device authorization or service grant ──> CatsCo identity
     │
     └── scoped token ──> Artifact service
```

This flow requires CatsCo to expose a stable issuer, authorization endpoints, token endpoints, audience rules, and claims. The current local repository documents JWT login and Feishu channel OAuth, but it does not yet document a general OIDC provider; see [CatsCo context](06-cats-company-context.md).

The workspace now includes an optional transitional adapter for the contract
that CatsCo does document today: server-side `POST /api/account/introspect`
with a Service Token, followed by a short-lived opaque Artifact session. See
[the adapter guide](11-transitional-auth-adapter.md). This adapter keeps the
future OIDC exchange behind the same identity/session seam and does not modify
cats-company.

## Recommended scopes

Scopes should be narrow and composable:

| Scope | Meaning |
| --- | --- |
| `artifact:read` | Read a permitted Artifact projection and published surface. |
| `artifact:edit` | Create or modify a Draft. |
| `artifact:execute` | Invoke permitted use-plane capabilities. |
| `artifact:approve` | Resolve approvals assigned to the actor. |
| `artifact:publish` | Promote a validated Draft to a published version. |
| `artifact:share` | Change workspace membership or share policy. |
| `artifact:admin` | Recover, delete, or change workspace policy. |

The service evaluates scopes together with workspace membership, Artifact ACL, actor type, capability policy, and version state. A token with `artifact:edit` does not automatically receive `artifact:publish`.

## Human and Agent identities

An Agent can act as a first-class actor while preserving human accountability. A delegated grant should record the human owner, the Agent identity, the requested scopes, the Artifact boundary, and an expiry.

The application should never infer broad authority from a Bot UID or display name. The policy record must explicitly map a CatsCo identity to a workspace role and capability set.

## Build permissions

Build permissions need stronger controls than normal interaction permissions.

- A Builder can create a Draft and request a preview.
- A validator checks dependency, resource, accessibility, and capability constraints.
- A Reviewer or policy rule approves publication.
- The service publishes an immutable version and records the source revision.
- An owner can revoke a Builder grant and roll back a published version.

If an Agent writes arbitrary JavaScript or HTML, the build service must isolate execution, restrict network egress, apply a content-security policy, and prevent build credentials from reaching the generated page. Schema and component configuration are safer starting points than unrestricted code generation.

## Token handling

The browser must not receive CatsCo Service Tokens, artifact-node management tokens, DNS credentials, or other host secrets. The browser receives only a user-scoped session or short-lived access token for the Artifact service.

In the transitional adapter, the CatsCo user JWT is accepted only at the
server-side exchange boundary and is not stored in the session record. The
browser receives an HttpOnly `artifact_ax_session` cookie and can query a
public principal view; the CatsCo Service Token remains server-only. Bridge
reads made with that session are actor-bound and require `artifact:read` by
default; bridge submission and receipt lifecycle writes require
`artifact:execute` by default. Pairing-token requests remain an explicit
loopback operator path. By default the adapter uses CatsCo's documented
`GET /api/account/users/{uid}` service route to recheck account `state` on a
bounded interval; a host can replace it with a stronger principal-revalidation
hook. That lookup detects disabled/deleted accounts but is not a JWT revocation
oracle, so session expiry still bounds token-lifecycle risk.

The CLI uses its own delegated credential and never reuses a browser token from local storage. Tokens should have a resource-specific audience, a short lifetime, revocation support, and an audit trail.

## Approvals and sensitive actions

The application should mark publication, sharing, deletion, external network access, and irreversible business commands as approval-required capabilities. An approval binds to the Artifact, version, command, actor, and expiry; resolving it produces a structured event that the waiting task can resume.

## Audit requirements

The audit record should answer five questions:

1. Who acted, and was the actor a person, Agent, service, or system?
2. Which workspace, Artifact, version, and Region were involved?
3. Which command and input schema were used?
4. Which revision and parent event did the command use?
5. What policy decision, result, and approval followed?

The audit trail supports human review, Agent recovery, incident response, and rollback. It should not copy sensitive tokens or raw credentials into event payloads.
