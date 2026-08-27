# Transitional authentication adapter

The standalone Artifact app can reuse a CatsCo login without importing
`cats-company` or copying its JWT signing secret. The optional adapter runs on
the server side, calls the documented account-center introspection endpoint,
and exchanges an active CatsCo user JWT for a short-lived opaque Artifact
session.

This is a transitional boundary, not a claim that CatsCo already exposes a
general OIDC provider. When CatsCo publishes OIDC, replace the introspector;
the Artifact session, bridge, and AX contracts can remain unchanged.

## Flow

```text
Browser/CLI
   │  CatsCo user JWT (one request, never stored by Artifact)
   ▼
Artifact Bridge ── Service <server secret> ──> POST /api/account/introspect
   │
   └── HttpOnly, short-lived artifact_ax_session cookie
       │
       └── session principal + explicit Artifact scopes
```

The browser never receives the CatsCo Service Token. The exchange response
contains only the public principal and session timestamps; the bearer secret
is held in an `HttpOnly` cookie. A non-browser receiver can use the explicit
`Artifact-Session` header after securely obtaining the opaque session value.

## Enable the adapter

Keep the bridge on loopback and configure both values on the server. The
Service Token comes from the CatsCo account-center service-token mechanism; it
must not appear in SPA query parameters, source code, or logs.
For the default account-state recheck, grant that Service Token both
`account.introspect` and `account.users.read` (or use CatsCo's compatible
unscoped token mode).

```bash
export CATSCO_ACCOUNT_CENTER_URL=https://app.catsco.cc
export CATSCO_ACCOUNT_SERVICE_TOKEN='cats_svc_<server-only-secret>'
export AX_BRIDGE_AUTH_SCOPES='artifact:read,artifact:execute'

pnpm exec tsx apps/artifact-bridge/src/serve.ts \
  --port 8788 \
  --token 'local-pairing-token-0123456789' \
  --catsco-account-url "$CATSCO_ACCOUNT_CENTER_URL" \
  --catsco-service-token "$CATSCO_ACCOUNT_SERVICE_TOKEN"
```

The pairing token remains an optional local-process boundary. When it is set,
the exchange request must carry it as `Authorization: Bearer <pairing>` and
must carry the CatsCo JWT separately as `X-CatsCo-User-Token`. This avoids
ambiguous Bearer credentials. Without a pairing token, the loopback bind is
the remaining process boundary and a plain `Authorization: Bearer <CatsCo JWT>`
is accepted for the exchange.

## HTTP surface

| Method and path | Purpose |
| --- | --- |
| `POST /v1/auth/exchange` | Introspect the supplied CatsCo JWT and set the session cookie. |
| `GET /v1/auth/session` | Return the public principal and expiry, or `401`. |
| `POST /v1/auth/logout` | Revoke the opaque session and clear the cookie. |

Example exchange from a host page:

```ts
import { ArtifactAuthClient } from '@artifact-ax/auth';

const auth = new ArtifactAuthClient({
  baseURL: 'http://127.0.0.1:8788',
  credentials: 'include',
});

// Keep the JWT in memory for this call only. The client does not persist it.
await auth.exchange(catsCoUserJwt, localPairingToken);
const session = await auth.current();
```

When the SPA sends bridge requests with the session cookie, construct its
`BridgeClient` with `credentials: 'include'`. The demo transport enables this
with `?bridge_session=1` (or `?bridge_auth=1`) alongside `?bridge=<url>`.

## Authorization boundary

The bridge gives a session the configured scopes (`artifact:read` by default).
Read routes require `artifact:read`; bridge submission and receipt lifecycle
mutations require `artifact:execute` by default. Configure a different
`requiredWriteScope` in an embedding host, or set `requiredScope: null` only
when that host owns the complete policy. A read-only session can inspect the
inbox but cannot submit, acknowledge, complete, or reject a receipt. The bridge
also binds every session request to the canonical `principal.actor_id`:

- a submitted `ContextBundle.actor_id` must match the session actor;
- list and watch responses are filtered to that actor;
- context fetches and receipt mutations cannot address another actor's bundle;
- a pairing-token request is treated as an explicit local operator path and
  bypasses session actor filtering.

The adapter does not infer builder, reviewer, or owner privileges from a
CatsCo `account_type`. Workspace membership and capability policy remain
Artifact-owned. `account_type` only maps to the actor taxonomy (`human`,
`agent`, or a least-assumptive `service` fallback).

## Provider behavior and failure modes

The adapter calls:

```http
POST /api/account/introspect
Authorization: Service <server-only-token>
Content-Type: application/json

{"token":"<CatsCo user JWT>"}
```

An inactive or disabled account at exchange time becomes a safe `401
unauthenticated` response.
Non-2xx provider responses become `503 identity_provider_error`; malformed
provider JSON becomes `502 provider_response_invalid`. The adapter never echoes
the JWT, Service Token, or upstream response body.

Sessions are in memory in this slice and expire after 15 minutes by default
(configurable between one second and 24 hours). The session store is a
replaceable seam; it does not receive or persist the CatsCo JWT. By default,
the adapter rechecks `GET /api/account/users/{uid}` every minute with the
Service Token and revokes the Artifact session when the current CatsCo
`state` is no longer enabled. A host can replace that behavior with the
optional `revalidate_principal` hook.

The user lookup is a current-account-state check, not a substitute for
`/api/account/introspect`: it detects disabled/deleted accounts without
retaining the JWT, but does not prove that a still-enabled JWT was revoked.
Session expiry remains the bound for that token-lifecycle risk until CatsCo
offers a revocation/status interface. Native OAuth/OIDC, PKCE login UI,
durable session storage, refresh-token rotation, CSRF protection for a public
deployment, and CLI device authorization remain later work.

The transitional server is intentionally loopback-only. `ArtifactBridgeServer`
rejects non-loopback bind addresses while this adapter is enabled; a public
deployment should put a native OAuth/OIDC edge and CSRF policy in front of the
bridge instead of exposing the transitional exchange directly.

## Relationship to CatsCo

The observed CatsCo contract is documented in
[`docs/ACCOUNT_CENTER_AUTH.md`](../../cats-company/docs/ACCOUNT_CENTER_AUTH.md)
and [`docs/SERVICE_TOKEN_GUIDE.md`](../../cats-company/docs/SERVICE_TOKEN_GUIDE.md)
in the reference repository. Those files describe the current
`/api/account/introspect` and Service Token behavior. The Artifact workspace
uses them read-only; no CatsCo route, database, or frontend code is changed.
