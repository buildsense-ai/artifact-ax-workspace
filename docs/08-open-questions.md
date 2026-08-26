# Open questions

The project intentionally leaves several decisions open. The questions below identify the choices that materially affect the contract or the CatsCo adapter.

| Priority | Question | Recommended default for discussion |
| --- | --- | --- |
| P0 | Does “build” mean structured app changes, arbitrary code, or both? | Start with structured changes; isolate code building as a separate service. |
| P0 | Which system owns durable business state? | The Artifact domain service owns it; CatsCo remains identity and collaboration infrastructure. |
| P0 | What is the smallest capability gateway? | One CLI with `describe`, `inspect`, `apply`, `watch`, and `publish`. |
| P0 | How are simultaneous Builder changes represented? | Draft branches plus optimistic revision checks. |
| P0 | Which actions require human approval? | Publish, share, delete, external side effects, and production network access. |
| P1 | Does CatsCo become a general OIDC provider? | Define issuer and PKCE/device contracts before depending on them. |
| P1 | Does an Artifact need a CatsCo Topic? | Use Topics for notifications and conversation context, not Artifact state authority. |
| P1 | How much state does an Agent receive? | A task-specific bounded projection with resumable event cursor. |
| P1 | How does a user switch published versions? | Pin sessions by default; offer an explicit migration action. |
| P2 | Does the product need a spatial canvas? | Wait for evidence that Region focus and version comparison are insufficient. |
| P2 | Do we need CRDT editing? | Add it only for proven simultaneous text editing. |

## Decisions to validate with a prototype

1. A mock Agent can discover a manifest and operate a teaching-report SPA with one CLI.
2. A human can approve a command while an Agent waits and then resumes from the same task.
3. Two Builders can create Drafts from one base version without overwriting each other.
4. A CatsCo user can sign in through a server-side transitional adapter without exposing a Service Token.
5. A disabled or revoked actor loses access to both the SPA and CLI without deleting Artifact history.

## Terms that need product agreement

The project uses “Artifact”, “Draft”, “Published version”, “Use session”, “Builder”, “Operator”, and “Workspace” as provisional domain terms. The team should confirm these terms before naming APIs or database tables.

The identity-specific questions and a proposed discovery, claims, scope, and revocation surface are expanded in [Proposed CatsCo OAuth contract](09-cats-company-oauth-contract.md).
