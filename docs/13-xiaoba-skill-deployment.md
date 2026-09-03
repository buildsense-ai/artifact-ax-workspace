# XiaoBa Skill deployment boundary

## Decision

Deploy this Artifact through two Skills in XiaoBa, not through the standalone
Artifact Bridge:

1. Install the existing cloud-html-artifact platform Skill. It owns the
   Artifact Host task/context/result transport and turns an explicit page
   action into a normal visible Agent turn.
2. Install this repository's lesson-report-artifact domain Skill. It owns
   review reasoning and the bounded teaching-report note payload.

Keep the Artifact Bridge, artifactctl context commands, AG-UI projection, and
transitional bridge auth as local developer/test harnesses only. Do not start,
configure, or deploy them for the XiaoBa path.

The resulting production flow is:

    Person selects report rows and explicitly sends a review request
        -> published SPA requests its declared Cloud task
        -> platform Host creates one normal visible XiaoBa turn
        -> cloud-html-artifact reads the one-shot task packet
        -> lesson-report-artifact reviews bounded context
        -> cloud-html-artifact writes the declared result sink
        -> SPA persists the note and returns an applied receipt

No custom page-to-Agent endpoint, background poller, browser credential,
custom Bridge, or cats-company source change belongs in this flow.

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

The declared task intent (`lesson-report.review-selection.v1`) and result sink
(`lesson-report.agent-notes.upsert.v1`) and their payload schemas are
**unchanged**; the Cloud task payload is a bounded ContextBundle projection
(selections, intent, assessment) and does not carry a final-state summary. The
final state is read from the page context, not the task envelope. No
`artifact-manifest.json` field changed — the change is to the observation
context semantics, documented here and in the lesson-report Skill reference.

## Delivered Skill set

| Layer | Package | Ownership |
| --- | --- | --- |
| Platform | cloud-html-artifact, version 1.4.0 | Existing platform Skill at /Users/pi-dal/Downloads/cloud-html-artifact. It is read-only and is not copied into this repository. |
| Application | lesson-report-artifact | This repository's skill source at skills/lesson-report-artifact and its validated package at skill-packages/lesson-report-artifact.skill. |

Do not introduce a generic artifact-ax Skill yet. The current hosted task has
one concrete business contract, so a generic transport or runtime Skill would
add indirection without a second real consumer.

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

Do not use a direct chat-message API to simulate this test. Do not classify an
ordinary Agent response as a completed application task.

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
