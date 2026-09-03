# XiaoBa Skill deployment boundary

## Decision

Deploy this Artifact through two Skills in XiaoBa, not through the standalone
Artifact Bridge:

1. Install the existing cloud-html-artifact platform Skill. It owns the
   Artifact Host task/context/result transport and turns an explicit page
   action into a normal visible Agent turn.
2. Install this repository's lesson-report-artifact domain Skill. It owns
   review reasoning, the bounded teaching-report note payload, and the
   bounded UI-document patch proposal.

Keep the Artifact Bridge, artifactctl context commands, AG-UI projection, and
transitional bridge auth as local developer/test harnesses only. Do not start,
configure, or deploy them for the XiaoBa path.

The resulting production flow is two exact task-to-sink mappings, both driven
by an explicit page action and both completing only when the exact result sink
returns an `applied` receipt:

    Person selects report rows and explicitly sends a review request
        -> published SPA requests its declared Cloud task
        -> platform Host creates one normal visible XiaoBa turn
        -> cloud-html-artifact reads the one-shot task packet
        -> lesson-report-artifact reviews bounded context
        -> cloud-html-artifact writes the declared result sink
        -> SPA persists the note and returns an applied receipt

    Person describes a UI change and explicitly requests it
        -> published SPA requests its declared compose-ui task
        -> platform Host creates one normal visible XiaoBa turn
        -> cloud-html-artifact reads the one-shot task packet
        -> lesson-report-artifact proposes a bounded UI-document patch
        -> cloud-html-artifact writes the declared UI proposal sink
        -> SPA stages the patch and returns an applied receipt
        -> a human (not the Agent) applies or discards the patch in the page

No custom page-to-Agent endpoint, background poller, browser credential,
custom Bridge, or cats-company source change belongs in either flow.

### Agent-facing context (final-state-first)

The page exposes `window.catscoArtifact.getContext()` — the OBSERVE/TASK
context that cloud-html-artifact reads — as a **final-state-first** snapshot:
the latest final projection/result summary plus stable refs only
(`semantic_mode: "final-state"`, `state_revision`, `summary`, `filter`,
`visible_rows`, `agent_notes`, and stable selection/node refs). It never
contains intermediate event/state history by default. Intermediate events are
retained for a bounded optional query only
(`getContext({ include_events: true, max_events: N })`, hard-capped), never
automatically injected and never required for a task.

The declared review task (`lesson-report.review-selection.v1`) and its result
sink (`lesson-report.agent-notes.upsert.v1`) and their payload schemas are
**unchanged**; the Cloud review task payload is a bounded ContextBundle
projection (selections, intent, assessment) and does not carry a final-state
summary. The final state is read from the page context, not the task envelope.

The application now declares a second exact task-to-sink mapping:
`lesson-report.compose-ui.v1` → `lesson-report.ui-document-patch.propose.v1`.
The compose-ui task payload is deliberately minimal — the current final UI
document/configuration (compact node/region inventory), the current application
revision/identity, and the user's requested UI intent. It never carries event
history, task refs, writeback refs, or credentials. The page context may expose
compact UI-document metadata (`ui_document`) as **final state**; intermediate
event/state history remains opt-in and bounded (`getContext({ include_events:
true, max_events: N })`), never automatically injected and never required.

A UI patch is **staged only until a human applies or discards it**. The Agent
delivering a `UiDocumentPatch` proposal to the sink causes the page to validate
it (declared schema, document id, base revision, operation constraints, stable
anchors, closed catalog; rejecting raw code/HTML/JS/CSS and
malformed/no-op/stale patches) and durably stage the proposal before returning
the `applied` result receipt. Applying or discarding is a later explicit human
action in the page; the draft is never applied merely because it was delivered.

## Delivered Skill set

| Layer | Package | Ownership |
| --- | --- | --- |
| Platform | cloud-html-artifact, version 1.4.0 | Existing platform Skill at /Users/pi-dal/Downloads/cloud-html-artifact. It is read-only and is not copied into this repository. |
| Application | lesson-report-artifact | This repository's skill source at skills/lesson-report-artifact and its validated package at skill-packages/lesson-report-artifact.skill. It supports exactly two task-to-sink mappings: review-selection → agent-notes and compose-ui → ui-document-patch. |

Do not introduce a generic artifact-ax Skill yet. The current hosted task set
has two concrete business contracts that map to two exact declared tasks, so a
generic transport or runtime Skill would add indirection without a third real
consumer.

## Installation procedure

Use the XiaoBa environment's supported SkillHub/import workflow to publish or
import both immutable Skill versions, then attach those two versions to the
target Agent. Keep the exact SkillHub operation outside this repository until
the target Bot identity and operator credentials are supplied.

Use this repository's lesson-report-artifact source directory as the canonical
source. Use the packaged .skill archive as a validated portable bundle. Do not
assume that a specific XiaoBa/SkillHub import endpoint accepts .skill until the
operator verifies that endpoint's wire format.

Before declaring the deployment ready:

1. Publish the SPA as an immutable Cloud Artifact version with its v3 manifest.
2. Verify that the platform Host is provisioned for that published version.
3. Confirm that both Skills are attached to the same target XiaoBa Agent.
4. In the page, select one or more rows and use the explicit review send.
5. Confirm that one visible Agent turn reads the exact declared task.
6. Confirm that the returned note uses the declared sink and that the page
   returns an application receipt with status applied.
7. In the Builder panel, describe a UI change and use the explicit request.
8. Confirm that one visible Agent turn reads the exact `lesson-report.compose-ui.v1`
   task and writes `lesson-report.ui-document-patch.propose.v1`.
9. Confirm the page returns an application receipt with status applied *and* that
   the proposal is only **staged** (no active-document mutation), then apply or
   discard it as a human, confirming the active document changes/stays.

Do not use a direct chat-message API to simulate this test. Do not classify an
ordinary Agent response as a completed application task, and never treat a
delivered UI patch as applied until a human applies it in the page.

## Facts observed in cats-company

The following are source observations, not changes made by this workspace:

- server/skillhub_proxy.go exposes a fixed-origin SkillHub catalogue proxy and
  server/cmd/server.go mounts it under /api/skillhub/skills.
- server/bot_skill_config.go models Bot Skill references by source, skill ID,
  version, and content hash, and exposes owner/viewer skill metadata routes.
- server/device_connector.go defines capability names for local SkillHub
  workspace, share, finalize, and Bot-switch operations.

These facts support versioned Skill attachment without adding a new Artifact
runtime. They do not prove the exact XiaoBa CLI import command, the target
Bot's entitlement, or live Cloud Host task delivery.

## Deployment assumptions and external prerequisites

- An operator has access to the intended XiaoBa/SkillHub workspace and target
  Agent.
- The existing cloud-html-artifact platform Skill is available in the same
  Agent environment as lesson-report-artifact.
- The Cloud Artifact publisher/Host has been provisioned separately for the
  published page version.

Those prerequisites are deployment configuration, not a reason to modify
cats-company source code or introduce a custom Bridge.
