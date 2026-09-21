# Feature Specification: Coordinated Desktop/VPS update modal

**Feature Branch**: `codex/desktop-vps-compatibility-plan`
**Created**: 2026-09-21
**Status**: Draft for specification review; product implementation has not started
**Issue**: [OM-287](https://linear.app/matrix-os/issue/OM-287)
**Input**: Adopt the September 21 coordinated stable-release decision, with our delivery focused on the update modal and shared upgrade flow.
**Language**: English-only online review.

## Product scope and decisions

Every stable release coordinates Electron Desktop and VPS bundle availability. Platform remains stable only; Desktop and bundle use stable and canary, with ordinary users on stable and Desktop channel changes restricted to the internal team. Publication, re-pinning stable, and fleet rollout are release-owner responsibilities.

Our scope is the update indicator, modal, eligibility-aware decisions, progress and recovery, and the shared admission required to prevent another Desktop installation entry point bypassing the same preconditions. One Update action starts the necessary cloud-computer update and Desktop preparation. Desktop installation waits for the cloud computer to run a verified compatible version. Restart remains an explicit user action.

Different commits alone must not require an update. A minimum bundle version attached to each Desktop release detects a bundle that is too old; it does not prove reverse compatibility or Platform compatibility. Those results must be supplied by the responsible release/runtime services.

### Included

- Truthful compatible, incompatible, unverified, no-repair, preparing, in-progress, ready-to-restart, failed, and completed states.
- Eligible stable release pairs, exact update targets, current and target Desktop minimum requirements, running-version verification, and safe intermediate combinations.
- One selected cloud computer per initiated operation; bounded progress restoration, retry, and prompt deduplication.
- Consistent installation admission across the indicator, modal, Settings, menus, and installation on quit.
- Presentation of Platform/bundle incompatibility and authorized recovery options.

### Excluded

- Publishing artifacts, re-pinning channels, fleet rollout, customer outreach, or moving canary users to stable.
- Rewriting Desktop packaging/downloading, diagnosing the canary discovery bug, or treating its OTA/full-package hypothesis as established.
- Full capability negotiation, an automatic breaking-change detector, fixed support-duration commitments, and CLI or Native Mobile updater redesign.
- Automatically updating Platform, silently changing channels, automatically downgrading bundles, or modifying owner data.

## User Scenarios & Testing

### User Story 1 — Receive an actionable update notice (Priority: P1)

An ordinary user can understand whether their current setup works and whether an update is actually available to them, without an endless modal that directs them to two components that both say Up to date.

**Why this priority**: Non-actionable interruptions are the immediate reported problem.
**Independent Test**: Supply current compatibility and release-availability combinations without installing anything; check the indicator, modal, recovery view, and Settings agree.

**Acceptance Scenarios**:

1. Given different commits but verified compatibility and no eligible stable update, reconnecting or reopening Desktop produces no required-update modal.
2. Given a compatible setup and a complete eligible stable release pair, the indicator opens the modal only when selected; it does not interrupt work automatically.
3. Given confirmed incompatibility and a safe eligible repair, show one prompt identifying the affected component and a working update action.
4. Given confirmed incompatibility with no eligible repair, explain that no compatible update is currently available and retain recovery options; never offer a dead Update action.
5. Given only inaccessible canary/dev candidates, do not select or expose them to ordinary users.
6. Given a failed check or missing metadata, show an unverified/check-failed state, preserving known restrictions without claiming either compatibility or an upgrade requirement.
7. Given a current setup that works but one paired artifact is unavailable, explicit checking shows Preparing; no actionable upgrade is advertised.

### User Story 2 — Update Desktop and the selected cloud computer together (Priority: P1)

A user starts one update flow and sees both components progress, without discovering a separate cloud update procedure after installing a new Desktop.

**Why this priority**: This is the core workflow agreed at the release meeting.
**Independent Test**: Start one operation with known current and target releases; verify the actual running pair before and after each step, including the intermediate old-Desktop/new-bundle state.

**Acceptance Scenarios**:

1. Given a ready eligible pair and a verified transition, selecting Update binds exact targets and starts the necessary cloud update and Desktop preparation.
2. Given the cloud computer already runs the paired target, skip reinstalling it. Given a newer verified-compatible bundle, retain it without downgrade.
3. Given the cloud bundle meets the Desktop minimum but trails the paired target, update it to that target under this draft's proposed default, subject to transition safety.
4. Given a bundle is installed but its services still run the old version, do not allow Desktop installation or report cloud readiness.
5. Given the cloud computer is healthy and satisfies the target requirements and Desktop is downloaded, offer Restart to finish. Installation must revalidate the same targets and preconditions.
6. Given no safe old-Desktop/new-bundle transition, stop before mutation and explain that the update is not ready; release owners must provide compatible support or a bridge release.
7. Given the same install attempt from Settings, a menu, or quit handling, enforce the identical preconditions.
8. Given both components have restarted into the intended compatible state, complete the operation without requiring matching commits.

### User Story 3 — Recover without repeating successful work (Priority: P1)

A user can minimize the modal, resume after an app restart, or retry a failed step while retaining progress and work.

**Why this priority**: The operation spans separate machines and can complete only partially.
**Independent Test**: Inject a failure before and after cloud acceptance and before Desktop restart; reopen the app and retry.

**Acceptance Scenarios**:

1. Given cloud upgrade or readiness verification fails, retain the Desktop download and pause installation; retry only after reconciling the cloud task.
2. Given cloud succeeded but Desktop failed, retain cloud success and retry Desktop; never automatically roll back the bundle.
3. Given the submission response times out, check the accepted task before another mutation; duplicate clicks cannot create a second conflicting update.
4. Given minimized progress or an app exit, preserve the operation identity and restore actual progress on return; neither action pretends to cancel an accepted cloud job.
5. Given the selected account or cloud computer changes, pending responses cannot modify the new context or authorize installation for it.
6. Given a target is withdrawn or the feed advances, do not silently replace it; re-evaluate a new plan before allowing installation.
7. Given the same dismissed issue after focus, reconnect, commit change, or relaunch, keep it dismissed while retaining access through the indicator/recovery view. A new target or increased impact can justify another prompt.
8. Given completed repair but an unrelated optional update remains, end the repair successfully; optional availability is a separate notice.

### User Story 4 — Understand Platform or reverse-version problems (Priority: P1)

A user receives a correct explanation when an old Desktop cannot use a newer bundle, or a bundle cannot use Platform, rather than being told to update the wrong component.

**Why this priority**: The Desktop minimum alone addresses only the old-bundle direction.
**Independent Test**: Evaluate explicit reverse and Platform incompatibility results, with and without eligible remedies.

**Acceptance Scenarios**:

1. Given a newer bundle incompatible with old Desktop, select a verified Desktop repair; do not mislabel the bundle as too old.
2. Given a Platform/bundle incompatibility, present the responsible service's repair result without offering a Platform installer or an unrelated Desktop reinstall.
3. Given business functionality is blocked, retain authorized update/recovery access. Authentication failure remains an authentication failure.
4. Given an optional feature is unsupported, limit that feature while leaving verified-safe work available. Unsafe core operations remain blocked even if the modal is dismissed.

### User Story 5 — Keep control of work and computer scope (Priority: P2)

A user understands which cloud computer will change and when Desktop will restart, with keyboard-accessible controls and preserved work.

**Independent Test**: Use expanded/collapsed navigation, keyboard-only modal interaction, two connected computers, an unsent draft, and an embedded app.

**Acceptance Scenarios**:

1. Before initiation, identify the selected cloud computer, the components being updated, cloud reconnection, and the later Desktop restart.
2. Closing or minimizing the modal preserves drafts and mounted work; keyboard dismissal returns focus to the originating control or recovery entry.
3. Another cloud computer is never updated without selection. Known conflicts with other supported computers prevent an unsafe global Desktop install; offline does not itself prove incompatibility.
4. With no selected runtime or no way to verify readiness, allow checking/downloading but keep installation waiting with an explanation.
5. Progress changes are accessible without relying on color alone; reduced-motion settings are respected, and the overlay does not shift workspace content.

### Edge Cases

- Legacy Desktop has no minimum mapping; release metadata is malformed, stale, contradictory, or unavailable.
- A channel pointer advances or is revoked during download; one artifact is not available to the user's rollout cohort.
- Bundle version sorting differs from Desktop version sorting; a promoted artifact retains its original dev build label.
- Fleet rollout or another client completes the cloud step before this modal does; a security auto-update changes the runtime mid-operation.
- Request accepted but response lost; cloud services stay unhealthy or offline; authorization expires during an operation.
- Desktop quits with a staged download before cloud verification; install occurs through a non-modal entry.
- Same connection object now represents another runtime; old responses arrive after a user/account switch.
- Installed and running identities differ; multiple supported runtimes have different versions; no cloud computer is selected.

## Requirements

### Functional Requirements

- **FR-001**: Update necessity MUST derive from verified compatibility and user impact, never commit equality or ancestry alone. (Story 1)
- **FR-002**: Ordinary-user targets MUST be filtered by stable membership, entitlement, rollout, supported device, and withdrawal policy before becoming actionable. Internal channel choice MUST require internal authorization. (Story 1)
- **FR-003**: A coordinated stable update MUST bind a consistent release pair and exact artifacts; both must be available to the user before it is advertised as actionable. (Stories 1–2)
- **FR-004**: Evaluate the minimum bundle for both installed and candidate Desktop versions. Missing legacy mapping MUST remain unverified until a tested mapping exists. (Stories 1–2)
- **FR-005**: A minimum comparison MUST NOT override known reverse or Platform incompatibility, or turn an unknown combination into verified-compatible. (Story 4)
- **FR-006**: An update/repair action MUST exist only for an eligible plan that resolves its stated problem through safe intermediate states. (Stories 1–2)
- **FR-007**: Compatible optional updates MUST use an indicator and user-opened modal; confirmed incompatibility may automatically present one actionable notice or a recovery notice. (Story 1)
- **FR-008**: No eligible repair, incomplete publication, failed checks, and missing compatibility information MUST have distinct truthful states. (Story 1)
- **FR-009**: One initiation MUST prepare both components as needed. Desktop installation MUST wait for a healthy running bundle that satisfies the plan, not just installed metadata. (Story 2)
- **FR-010**: The old-Desktop/new-bundle transition and relevant Platform transition MUST be verified before applying the cloud step. Unsafe transitions MUST require a different supported release path. (Stories 2, 4)
- **FR-011**: The draft default is to use the paired stable bundle even if the minimum is already met; skip unchanged or newer verified-compatible installations and prohibit automatic downgrades. (Story 2)
- **FR-012**: Installation MUST revalidate artifact identity, eligibility, selected runtime, and readiness. A changed candidate MUST NOT silently replace the admitted target. (Stories 2–3)
- **FR-013**: Indicator, modal, Settings, menu, and quit-triggered installation MUST share the same final admission, enforced by the trusted installer. (Story 2)
- **FR-014**: The UI MUST identify the selected computer and restart impact before initiation, and retain explicit user control over Desktop restart. (Stories 2, 5)
- **FR-015**: All retries MUST reconcile accepted work and preserve completed steps. Concurrent attempts MUST not launch conflicting updates for one runtime. (Story 3)
- **FR-016**: Minimize, close, crash, and relaunch MUST recover operation identity and actual progress without falsely canceling or replaying accepted cloud work. (Story 3)
- **FR-017**: Late responses and subsequent mutations MUST be scoped to the originating account, runtime, and operation. (Stories 3, 5)
- **FR-018**: Completion MUST verify actual running identities and the relevant compatibility results; unrelated optional updates MUST NOT keep a repair incomplete. (Stories 2–3)
- **FR-019**: Dismissals MUST persist across focus, reconnect, and relaunch for the same problem; changed targets or increased impact may invalidate dismissal. Records MUST be bounded and expire. (Story 3)
- **FR-020**: The system MUST preserve drafts, sessions, and owner data, and MUST NOT automatically roll back bundles or data as compensation. (Stories 3, 5)
- **FR-021**: Block only unsafe or unsupported paths and retain authorized recovery. Dismissing a modal MUST NOT bypass a core compatibility restriction. (Story 4)
- **FR-022**: Platform compatibility MUST be authoritative and actionable through existing authorized recovery, not inferred from Desktop version or authentication errors. (Story 4)
- **FR-023**: An operation MUST target only the selected computer; known cross-runtime conflicts MUST prevent an unsafe Desktop install. Missing runtime evidence MUST not be reported as readiness. (Story 5)
- **FR-024**: All waits MUST terminate or transition to a recoverable timed-out state. Progress/error messages MUST be safe, accessible, and distinguish uncertain outcomes from confirmed failure. (Stories 3, 5)
- **FR-025**: UI semantics MUST be shared wherever these capabilities appear; native installer controls are exclusive to Electron Desktop, with explicit limitations recorded for other surfaces. (Story 5)
- **FR-026**: This specification delivery MUST include an English specification, a quality checklist, and the future public documentation deliverable; it MUST NOT claim implementation, runtime validation, publication, or rollout. (Scope)

### Key Entities

- **Release pair**: immutable association of exact Desktop and bundle targets, publication readiness, audience/channel eligibility, and withdrawal state.
- **Desktop requirement**: the minimum bundle and verified compatibility evidence for a particular Desktop artifact, including tested mappings for older releases.
- **Runtime observation**: stable identity, actual running and installed bundle identities, health, and observation context.
- **Compatibility result**: compatible, incompatible, or unknown for a relationship, with affected scope and a safe reason.
- **Upgrade operation**: originating account/runtime, exact targets, admitted transition, per-component progress, and completion/retry status.
- **Dismissal record**: bounded notice identity by account/runtime/reason/target/severity, with expiry; never a permission to bypass safety.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All specified compatible/no-eligible-update cases produce zero automatic required-update dialogs, including ten successive focus/reconnect events and a relaunch.
- **SC-002**: Every displayed Update or Repair action in the acceptance matrix has a verified eligible target and safe transition; zero inaccessible dev/canary targets reach ordinary users.
- **SC-003**: The normal two-component update needs one initiation and at most one explicit Desktop restart action, without a separate cloud-update procedure.
- **SC-004**: Every tested install entry point prevents Desktop installation while cloud readiness is unverified or insufficient; installed-but-not-running cases never report success.
- **SC-005**: Injected failures at every operation boundary retain successful work and permit reconciliation/retry without duplicate cloud installs, automatic downgrades, or incorrect completion.
- **SC-006**: All runtime/account-switch tests produce zero mutations on an unintended computer and zero stale-context completion notices.
- **SC-007**: All modal dismissal and recovery tests preserve unsent drafts and session state, remain keyboard operable, and avoid moving existing workspace content.
- **SC-008**: All reverse and Platform incompatibility cases identify the correct affected relationship; zero generic Desktop-reinstall demands are used as a substitute.

## Assumptions, ownership, and delivery boundaries

The paired-target rule in FR-011, selected-runtime scope, bundle-first order, and explicit restart are reviewable defaults adopted from the illustrated plan. They are not claims about already-shipped behavior. Release owners must define the supported version set and attest the safe transitions before implementation can be considered shippable; this spec does not invent a support duration.

Our work owns the modal/indicator and shared admission/orchestration. Release, Platform, and Gateway owners supply eligibility, paired readiness, tested minimum mappings, reverse/Platform compatibility, safe transition evidence, and reconciliable update tasks. They also own coordinated publication and fleet rollout. Missing dependencies must remain visible as blockers, never fabricated compatible results.

| Surface | Planned applicability and limitation |
|---|---|
| Electron Desktop | Full indicator/modal, coordinated operation, native restart, shared installation admission |
| Web Desktop | Shared cloud-update/compatibility semantics wherever displayed; no native Desktop installer |
| Web Canvas | Same applicable semantics as Web Desktop; no native Desktop installer |
| Web Mobile | Same applicable cloud status/recovery semantics; no native Desktop installer |
| Native Mobile | Existing cloud status/recovery remains consistent; mobile package-updater redesign deferred |

Surface limitations require reviewer agreement before implementation. No surface is claimed tested by this document-only PR.

## Security, integration, and validation obligations

The required [integration and security boundaries](integration-boundaries.md) define authorization, input validation, bounded I/O, concurrency, recovery, resource cleanup, and the future end-to-end checkpoint. They constrain later implementation without adding endpoints now. Tests precede product changes. Actual signed Desktop installation and a disposable VPS upgrade are required later; fixtures alone are insufficient. Production customer runtime is VPS-native, not Docker deployment.

Future delivery includes a separate public documentation PR in `FinnaAI/matrix-os-site/content/docs/`. Reconcile the existing documentation work tracked by MAT-558; do not publish the draft behavior as already available.

## Related work and specification authority

- [OM-229](https://linear.app/matrix-os/issue/OM-229) / [PR #1626](https://github.com/HamedMP/matrix-os/pull/1626): existing commit-independent compatibility fix; open draft when checked on September 21. Its implementation and reported validation are not this spec's implementation or evidence.
- [OM-238](https://linear.app/matrix-os/issue/OM-238): earlier local-only advisory proposal. This separate draft makes coordinated upgrades explicit; no emergency mitigation is silently reverted.
- [MAT-558](https://linear.app/matrix-os/issue/MAT-558): existing independent-release public documentation needs reconciliation with the new coordinated publication policy.
- [Existing OTA placement spec](../110-desktop-ota-update/spec.md): preserve placement/accessibility intent; its unconditional immediate-install behavior is superseded by admission and explicit restart requirements only when this new design is approved and implemented.
- [Illustrated plan](plan.en.md): supporting design details and diagrams. This specification is the requirements reference; the plan's previously open defaults are adopted above for review.
- [Research](research.md): September 18 source snapshot, not a current production audit. No historical code line or manual protocol constant is sufficient compatibility proof.
