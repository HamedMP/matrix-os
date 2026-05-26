# Data Model: Paid Beta Readiness

## Onboarding Session

Represents one user's first-run or resumed launch onboarding flow.

**Fields**:

- `ownerId`: owner-scoped Matrix user identifier.
- `status`: `not_started`, `in_progress`, `ready`, `degraded`, `blocked`, `complete`.
- `selectedGoalIds`: ordered onboarding goals selected by the user.
- `currentStepId`: active guided setup step.
- `completedStepIds`: completed setup steps.
- `skippedStepIds`: skipped setup steps with reason and unlocked/degraded workflow summary.
- `visualSystemVersion`: Matrix onboarding visual baseline used for the session.
- `completedAt`: timestamp when user reaches ready/complete.
- `updatedAt`: last state update timestamp.

**Validation Rules**:

- `ownerId` is required and must come from the authenticated request principal.
- Only known setup steps may be completed or skipped.
- A session cannot be `complete` while release-critical gates are `blocked`.

## Onboarding Goal

Represents a first-use objective that tailors setup.

**Fields**:

- `id`: stable goal id such as `coding`, `app_building`, `company_brain`, `assistant`.
- `label`: user-facing label.
- `description`: short explanation of what Matrix can do.
- `requiredGateIds`: readiness gates required for this goal.
- `recommendedGateIds`: helpful but skippable gates.
- `optionalGateIds`: later setup gates.

**Validation Rules**:

- Goal ids are allowlisted.
- Goals must map to at least one user-visible workflow.

## Onboarding Visual System

Represents the brand and UX constraints for first-run setup.

**Fields**:

- `version`: visual baseline id tied to the PR #162 direction.
- `palette`: named colors for stone, sage, forest, ember, ink, lichen, and pebble.
- `typography`: approved font roles for body, technical labels, and brand wordmark.
- `motionPolicy`: default motion, reduced-motion fallback, and blocked animation patterns.
- `mediaPolicy`: approved product screenshots/video handling and failure fallback.
- `qaEvidence`: links or artifact identifiers for desktop/mobile visual verification.

**Validation Rules**:

- Reduced-motion fallback is required.
- QA evidence is required before launch readiness can pass.

## Readiness Gate

Represents one release-critical or optional check.

**Fields**:

- `id`: stable gate id.
- `category`: `provisioning`, `shell`, `ux`, `agent`, `coding`, `integration`, `company_brain`, `support_growth`, `entitlement`.
- `criticality`: `release_critical`, `goal_required`, `recommended`, `optional`.
- `status`: `unknown`, `checking`, `pass`, `fail`, `blocked`, `skipped`.
- `message`: safe user-facing status.
- `remediation`: safe next action.
- `owner`: `user`, `operator`, `matrix`.
- `lastCheckedAt`: last check timestamp.
- `evidence`: safe links or artifact references.

**Validation Rules**:

- Release-critical gates must have a remediation owner when not passing.
- Messages must be allowlisted/generic and must not include provider secrets, filesystem paths, raw database errors, or raw provider errors.

## Agent Credential State

Represents agent availability, routing explanation, and Hermes system-agent continuity.

**Fields**:

- `ownerId`: authenticated owner.
- `agent`: `claude`, `codex`, `hermes`.
- `status`: `available`, `missing`, `expired`, `revoked`, `failed`, `not_applicable`.
- `workflows`: workflows this agent can power.
- `degradedWorkflows`: workflows unavailable or degraded while this credential is missing.
- `coordinationRole`: `system_agent`, `core_agent`, `coding_specialist`, or `assistant_specialist`.
- `verifiedAt`: last successful verification timestamp.
- `nextAction`: safe user-facing setup or reconnect action.

**Validation Rules**:

- Hermes must have a valid `available` state for supported system-agent workflows even when Claude and Codex are missing.
- Hermes remains available for supported workflows when Claude and/or Codex are connected; active agent state is additive, not exclusive.
- Claude/Codex verification results must not expose credential details.

## Admin Control Surface

Represents the Matrix settings/admin experience for models, credentials, integrations, automations, activity, and readiness.

**Fields**:

- `ownerId`: authenticated owner or authorized operator.
- `sections`: available sections such as `models`, `agents`, `integrations`, `settings`, `automations`, `activity`, and `readiness`.
- `providerCards`: model/provider status cards with configured, missing, failed, managed, and bring-your-own states.
- `configurationState`: save/reload status, last saved timestamp, validation result, and safe error summary.
- `automationState`: tasks, schedules, approvals, recent activity, and health summaries.
- `wizardState`: resumable setup state for reconnecting or recovering interrupted setup.
- `visualPatternSource`: Finna-inspired operational pattern applied through the Matrix PR #162 brand system.

**Validation Rules**:

- Provider cards must not expose raw secrets, provider errors, filesystem paths, or internal platform credentials.
- Setup wizard state must be resumable after reload without repeating destructive or duplicate external actions.
- Automation and activity summaries must be capped, owner-scoped, and safe for browser display.

## Integration Capability

Represents an approved external-service capability an agent may use.

**Fields**:

- `ownerId`: authenticated owner.
- `provider`: user-visible provider family such as GitHub, calendar, email, messaging, or publishing.
- `capability`: discrete action such as `read_repository`, `create_pull_request`, `read_email`, `create_calendar_event`, `draft_social_post`.
- `status`: `connect_required`, `connected`, `approved`, `revoked`, `failed`, `unavailable`.
- `approvedAgentIds`: agents allowed to use this capability.
- `requiresApprovalPerAction`: whether each external action needs user approval.
- `lastUsedAt`: last action timestamp.

**Validation Rules**:

- Externally visible actions require explicit approval by default.
- Capabilities are allowlisted; agents cannot request arbitrary provider actions.

## Agent Action Audit

Represents a safe summary of what an agent did.

**Fields**:

- `id`: stable action id.
- `ownerId`: authenticated owner.
- `agent`: `claude`, `codex`, `hermes`.
- `capability`: approved capability used.
- `status`: `requested`, `approved`, `completed`, `failed`, `denied`.
- `summary`: safe user-visible description.
- `target`: safe destination summary such as repository name, calendar name, or draft destination.
- `createdAt`: request timestamp.
- `completedAt`: completion timestamp.

**Validation Rules**:

- Summary and target are capped and allowlisted for display.
- Raw provider responses are never stored as the user-visible summary.

## Company Context Item

Represents company memory used by Matrix.

**Fields**:

- `id`: stable context id.
- `ownerId`: authenticated owner.
- `type`: `product_decision`, `customer_note`, `support_thread`, `growth_idea`, `social_draft`, `task`, `project_record`.
- `title`: short display title.
- `summary`: safe searchable summary.
- `source`: owner-visible source reference.
- `visibility`: `owner_only`, `authorized_teammates`.
- `updatedAt`: last update timestamp.

**Validation Rules**:

- Normal reads exclude soft-deleted records.
- Access is owner-scoped unless explicit teammate authorization exists.

## Draft Action

Represents a support, growth, or social output awaiting review.

**Fields**:

- `id`: stable draft id.
- `ownerId`: authenticated owner.
- `type`: `support_reply`, `social_post`, `acquisition_message`, `customer_follow_up`.
- `status`: `draft`, `needs_review`, `approved`, `sent`, `rejected`.
- `content`: draft body.
- `uncertainties`: unknowns or sensitive claims flagged before approval.
- `destination`: safe destination summary.
- `createdByAgent`: agent that drafted it.

**Validation Rules**:

- Drafts cannot be externally sent without user approval.
- Uncertainties must be shown before approval when present.

## Entitlement State

Represents launch access and paid entitlement status without owning user data.

**Fields**:

- `ownerId`: authenticated owner.
- `status`: `active`, `missing`, `expired`, `disabled`, `changed`.
- `allowedBehavior`: provisioning/runtime behavior allowed by the current status.
- `effectiveAt`: timestamp.

**Validation Rules**:

- Entitlement denial must not delete or corrupt owner data.
- Existing owner data remains exportable/inspectable.
