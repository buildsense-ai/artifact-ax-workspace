# Build and publish lifecycle

Agents can build on the SPA, but build operations must remain versioned and reviewable. The live application should never execute an unreviewed Draft merely because a Builder Agent submitted a change.

## Lifecycle

```text
create Draft
    ↓
inspect current contract and source
    ↓
propose change set
    ↓
validate and preview
    ↓
review / approve
    ↓
publish immutable version
    ↓
pin new use sessions to the version
```

Existing use sessions can finish on their pinned version while a new version is prepared. A service can offer an explicit migration command when a live session needs to move forward.

## Two build modes

The product should distinguish two kinds of building.

### Structured building

An Agent changes a declarative schema, data view, workflow, component configuration, or Region definition. The validator can inspect the complete change set before preview, and the Artifact app remains within a known component and capability vocabulary.

Structured building is the recommended first mode because it limits code execution and makes the AX manifest predictable.

### Code building

An Agent writes JavaScript, HTML, CSS, or other executable source. Code building requires a dedicated sandbox, dependency allowlist, network policy, resource limits, content-security policy, artifact signing, and a human or policy review before publication.

The generated page must not inherit OAuth refresh tokens, CatsCo Service Tokens, Artifact node management tokens, or unrestricted host methods. Build credentials belong to the build service and are removed before the published bundle reaches a browser.

## Validator responsibilities

The validator should check:

- Manifest and command schema validity.
- Stable Artifact and Region identifiers.
- Dependency and bundle size limits.
- Dangerous imports, network egress, and host capability requests.
- Accessibility and keyboard-operability baselines.
- Resource references and provenance metadata.
- Compatibility with the declared contract version.

Validation diagnostics become structured events that a human or Agent can inspect. A failed validation does not mutate the published version.

## Preview

A preview is an isolated execution of a Draft with a distinct version and capability ceiling. The preview can receive synthetic data and mock approvals, but it must not silently call production integrations.

The preview URL, Draft ID, source revision, and validation result form one provenance record. A Reviewer can compare the preview with the current Published version before approving publication.

## Publish and rollback

Publication creates an immutable version and records the approving actor. Rollback points a new release marker at a known-good version; it does not delete history or rewrite events.

Deletion, sharing changes, external side effects, and production network access require explicit capabilities and, where configured, a human approval.

## Builder Agent instructions

An instruction should express the goal and policy, while the CLI exposes the mechanics. A typical Builder instruction can say:

> Inspect the current Artifact contract. Add a review Region with a typed approval command. Keep existing Regions stable, create a Draft, run validation, and stop before publish until a human approves.

The Agent then discovers the current manifest, proposes a change set, previews it, and reports a structured outcome. It does not need a framework-specific prompt or direct access to the browser’s DOM.

## Minimum acceptance scenario

The first useful scenario has one Artifact, one Builder Agent, one human Reviewer, and one Operator. It proves that a Builder can create a Draft, the Reviewer can approve a Published version, and the Operator can interact with that version while an Agent observes and responds to semantic events.
