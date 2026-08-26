# CatsCo integration context

This document records the information observed in the local `cats-company` repository on 2026-08-26. It separates current facts from the integration shape proposed for Artifact AX Workspace.

The reference checkout is `../cats-company`. The inspected branch is `fix/browser-notification-test` at `14f3ab1`, with local user changes present. This document does not treat an unmerged Artifact worktree as the current public contract.

## Current product boundary

CatsCo describes two cooperating repositories:

- `cats-company` provides the Platform: WebApp, server APIs, identity, messages, conversations, Bot management, device routing, and Artifact discovery.
- `XiaoBa-CLI` provides the Runtime: Agent execution, model adapters, CLI, local tools, and connectors.

The relevant source is summarized in [`cats-company/README.md`](../../cats-company/README.md). The new project should remain a separate application and integrate through APIs or an adapter.

## Current authentication facts

| Existing mechanism | Current behavior | Relevance to the new project |
| --- | --- | --- |
| Human JWT | `/api/auth/login` returns a user JWT; `server/auth.go` documents a seven-day normal token and a persistent trusted-desktop token. | Useful as a transitional CatsCo adapter. Do not copy the signing secret or assume JWT equals Artifact permission. |
| Bot API Key | A Bot receives an `cc_...` key and connects through WebSocket or API routes. | Suitable for server-to-server Agent runtime access after a narrow capability grant. Do not expose it to a browser SPA. |
| Account-center Service Token | Internal services call `/api/account/introspect` and `/api/account/users/{uid}` with `Authorization: Service ...`. | Suitable for a backend adapter to verify a CatsCo user. The token must remain server-side. |
| Channel OAuth | The repository contains Feishu channel binding OAuth endpoints. | This proves an OAuth flow exists for that channel, not that CatsCo currently exposes general OIDC login. |

The local documentation does not define a general `/.well-known/openid-configuration`, authorization endpoint, token endpoint, or PKCE flow. The standalone project therefore treats native CatsCo OIDC as a required future contract, not an existing assumption.

The current WebApp stores its user token under `oc_token` in browser storage through `webapp/src/auth-session.js` and `webapp/src/api.js`. The standalone SPA should not copy that storage decision automatically; a PKCE-backed short-lived session or a backend-for-frontend cookie is a separate security decision.

The server also generates a random JWT signing secret at startup when `OC_JWT_SECRET` is absent, while production documentation requires a fixed secret. The new service must validate identity through a public issuer, introspection, or a controlled adapter; it must never depend on CatsCo’s private signing key.

Relevant sources:

- [`server/auth.go`](../../cats-company/server/auth.go)
- [`docs/API.md`](../../cats-company/docs/API.md)
- [`docs/ACCOUNT_CENTER_AUTH.md`](../../cats-company/docs/ACCOUNT_CENTER_AUTH.md)
- [`docs/SERVICE_TOKEN_GUIDE.md`](../../cats-company/docs/SERVICE_TOKEN_GUIDE.md)
- [`server/feishu_channel.go`](../../cats-company/server/feishu_channel.go)

## Current Agent and conversation model

CatsCo identifies Agents as Bot users with numeric UIDs. The WebApp exposes visible Agents through `GET /api/agents`, can open an Agent conversation through `POST /api/agents/open`, and uses P2P or group Topics for messages.

The WebSocket endpoint is `wss://app.catsco.cc/v0/channels`. Human clients authenticate with a JWT; Bot clients use an API Key, preferably in the `X-API-Key` header. The current wire model includes `type`, `msg_type`, and arbitrary `metadata` on message data, plus `stream_delta` and `stream_cancel` controls, but it does not define an Artifact-scoped state, command, revision, or AG-UI event contract.

Relevant sources:

- [`server/agents.go`](../../cats-company/server/agents.go)
- [`server/datamodel.go`](../../cats-company/server/datamodel.go)
- [`server/wshandler.go`](../../cats-company/server/wshandler.go)
- [`docs/api/websocket.md`](../../cats-company/docs/api/websocket.md)

## Current Artifact surface

The Platform currently proxies and manages cloud Artifact metadata. The main routes are:

| Route | Auth | Current purpose |
| --- | --- | --- |
| `GET /api/artifacts?status=active|deleted` | User JWT | List Artifacts through the configured index or management service. |
| `GET /api/agents/{agent_uid}/artifacts?status=active|deleted` | User JWT | List an Agent-scoped Artifact collection after `accessibleAgentUser` checks. |
| `DELETE /api/agents/{agent_uid}/artifacts/{artifact_id}` | User JWT | Delete one exact Artifact through the configured management node. |
| `POST /api/agents/{agent_uid}/artifacts/{artifact_id}/restore` | User JWT | Restore one exact Artifact. |
| `GET /api/agents/{agent_uid}/files` | User JWT | Read permitted Agent conversation attachments with cursor pagination. |
| `GET /api/bot/artifact-runtime-config` | Bot API Key | Return server-configured Artifact DNS information to a trusted Bot runtime. |

Current Artifact metadata includes fields such as `id`, `title`, `kind`, `url`, `status`, `publish_version`, `agent_uid`, `agent_name`, `source_title`, and deletion timestamps. The current contract is primarily a publication/index/preview contract.

The implementation lives mainly in [`server/cloud_artifacts.go`](../../cats-company/server/cloud_artifacts.go), [`server/agent_files.go`](../../cats-company/server/agent_files.go), [`server/artifact_nodes.go`](../../cats-company/server/artifact_nodes.go), and route registration in [`server/cmd/server.go`](../../cats-company/server/cmd/server.go).

## Artifact node and secret boundary

CatsCo supports configured Artifact nodes through `CATSCO_ARTIFACT_NODES_JSON` or `CATSCO_ARTIFACT_NODES_FILE`. Node management URLs and management tokens stay on the Platform server, while public Artifact URLs use validated origins and node mappings.

The existing `/api/bot/artifact-runtime-config` response includes DNS credentials for a trusted Bot runtime. That endpoint must not become the authentication path for the new browser SPA or CLI. The new application should use a dedicated Artifact service audience and never send DNS, management, or cloud-provider credentials to generated pages.

## What the new project can reuse

The following CatsCo concepts are useful integration anchors:

1. **Human identity:** map a verified CatsCo `uid`, `account_type`, and `state` to a Workspace membership.
2. **Agent identity:** map a Bot UID and owner relationship to an Agent actor with explicit scopes.
3. **Conversation entry:** link an Artifact task to a P2P or group Topic without making the Topic the Artifact’s state store.
4. **Publication routing:** reuse Artifact node deployment and public URL validation through a server-side adapter.
5. **Notifications:** optionally mirror Artifact events into a CatsCo Topic or WebSocket stream.
6. **Account introspection:** use the account-center Service Token only inside the adapter backend until CatsCo offers a standard OIDC flow.

## Proposed adapter boundary

The standalone application owns its Artifact database, workspace ACLs, Drafts, versions, commands, events, and approvals. A thin CatsCo adapter performs these translations:

```text
CatsCo user JWT or future OIDC claim
        ↓ verify / introspect
Artifact actor {uid, type, owner, workspace roles}

CatsCo Bot UID + delegated grant
        ↓ policy mapping
Artifact Agent actor {agent_id, scopes, expiry}

Artifact event / task
        ↓ optional bridge
CatsCo Topic or WebSocket notification
```

The adapter should not call CatsCo’s database, expose service tokens, or make the Artifact depend on CatsCo message persistence. A later integration can add a standard AG-UI transport without changing the Artifact domain contract.

## Integration phases

### Phase A: independent validation

Run the SPA, Artifact service, and `artifactctl` with a local mock identity and mock Agent. Validate the manifest, command, revision, approval, Draft, and publish flows without touching CatsCo.

### Phase B: transitional CatsCo adapter

Add a backend adapter that accepts a CatsCo user JWT, calls `/api/account/introspect` with a server-side Service Token, and maps the returned `uid`, `account_type`, and `state` to local workspace policy. Keep this adapter behind a feature flag and do not put the Service Token in the browser.

### Phase C: native OIDC/OAuth

Define a CatsCo issuer, authorization code + PKCE for the SPA, and a delegated/device flow for `artifactctl`. Use resource-specific audiences and scopes. Preserve the local workspace ACL because identity claims alone do not express Artifact permissions.

### Phase D: optional CatsCo collaboration bridge

Mirror selected task and approval events into existing Topics or a dedicated WebSocket envelope. Keep the Artifact service as the source of truth for Artifact state and revision history.

## Questions CatsCo must answer before native OAuth

- Which service is the authorization server and issuer?
- Does CatsCo support Authorization Code + PKCE and device authorization for CLI clients?
- Which claims identify a human, Bot, owner, organization, and account state?
- Can CatsCo issue resource-specific audiences and revocable delegated grants?
- How does a disabled or deleted account revoke Artifact sessions and Agent grants?
- Should the Artifact app use a top-level redirect, a same-site session, or a host-mediated token exchange?
- Which existing Bot/Agent relationships should map to Builder, Operator, Reviewer, or Observer roles?

Until these questions have explicit answers, the project should use a mock issuer or a server-side transitional adapter.

The concrete issuer, client, claims, delegation, and revocation proposal is recorded in [Proposed CatsCo OAuth contract](09-cats-company-oauth-contract.md).
