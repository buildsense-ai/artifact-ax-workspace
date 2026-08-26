# Proposed CatsCo OAuth contract

This document describes the smallest identity contract CatsCo would need to support the independent Artifact application. It is a proposal, not a claim about endpoints that exist today.

## Why a standard contract matters

The Artifact app should reuse CatsCo identity without depending on CatsCo’s database, JWT signing secret, or WebApp implementation. OIDC gives the SPA and CLI a standard way to authenticate; the Artifact service still owns workspace authorization.

## Required issuer surface

CatsCo should publish a stable issuer and discovery document with:

- `issuer` and `jwks_uri`;
- authorization endpoint;
- token endpoint;
- revocation or introspection endpoint;
- supported scopes and response types;
- device authorization endpoint for headless CLI login, if supported.

The SPA uses Authorization Code + PKCE. The CLI uses device authorization or a loopback Authorization Code flow. A backend service uses a confidential client or a server-side introspection path.

## Claims

The ID token and access token should distinguish identity claims from authorization claims. A minimal identity projection is:

```json
{
  "iss": "https://app.catsco.cc",
  "sub": "catsco:user:27",
  "uid": 27,
  "account_type": "human",
  "state": 0,
  "name": "Alice"
}
```

The Artifact service should use `sub` as the stable external identity and treat `uid` as a CatsCo-specific mapping. The service should reject disabled accounts even when a token has not expired.

## Resource audiences and scopes

CatsCo should issue an access token for an explicit Artifact resource, for example `artifact-api`, with scopes such as `artifact:read` or `artifact:edit`. A token for the CatsCo chat API should not automatically authorize Artifact mutation.

The Artifact service maps the external identity and scopes to a local Workspace role. Local ACLs remain the final authorization decision because CatsCo cannot know every Artifact’s Region and capability policy.

## Agent delegation

Builder and Operator Agents need a delegated identity model. A grant should include:

- the human owner or approving principal;
- Agent or Bot UID;
- workspace and Artifact restrictions;
- allowed scopes and capability names;
- expiry and revocation identifiers;
- a displayable consent description.

The Agent CLI should receive a scoped access token or a short-lived exchange token. It should not receive a human refresh token or a broad CatsCo API key.

## Account lifecycle

CatsCo should document how the Artifact service learns about account disablement, logout, password reset, Bot deletion, and grant revocation. The service can use short token lifetimes and introspection as a baseline, then add revocation events or back-channel logout when the product needs faster enforcement.

## Redirect and embedding rules

The standalone SPA should use an exact registered redirect URI and PKCE. It should not accept tokens in query strings or fragments that remain in browser history.

When the SPA appears inside a CatsCo page, the integration should prefer a top-level OAuth redirect or a secure token exchange. It should not rely on third-party cookies or pass a parent JWT through an unvalidated iframe message.

## Transitional path from the current CatsCo API

Until CatsCo exposes this contract, an Artifact backend can accept the current user JWT and call `/api/account/introspect` with a server-side Service Token. The backend maps `uid`, `account_type`, and `state` into a local actor, then issues its own short-lived Artifact session.

This transitional path keeps the browser and CLI independent from CatsCo’s HS256 signing key. It also gives the Artifact service a stable place to add local scopes before native OAuth arrives.

## Acceptance criteria for CatsCo

The OAuth integration is ready when a test client can:

1. Discover the issuer and keys without hard-coded secrets.
2. Sign a human into the SPA using PKCE.
3. Sign a CLI in without copying a browser token.
4. Request an Artifact audience and narrow scopes.
5. Resolve a human and Agent identity with stable claims.
6. Reject disabled accounts and revoked grants.
7. Rotate keys and revoke tokens without changing Artifact data.
