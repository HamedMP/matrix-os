# Feature Specification: Collaborative App Sharing

**Feature Branch**: 2690-collaborative-app-sharing
**Created**: 2026-11-04
**Status**: Draft for product review
**Input**: Define when a Matrix app is collaborative and let organization members open and use one live, shared app.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Share and use one live app (Priority: P1)

A member builds a team tracker, chooses **Share app**, selects an organization and audience, and sees exactly what will be shared. A colleague finds it in **Shared with me**, opens the same instance, adds a task, and both see the task. Colleagues do not install copies.

**Why this priority**: This is the first complete outcome that makes an app useful to a team.

**Independent Test**: With two Matrix members and one eligible tracker, share the app, create and edit from both accounts, reload both clients, and confirm one consistent shared record set.

**Acceptance Scenarios**:

1. **Given** an eligible app and two organization members, **when** the creator shares it with Editor access, **then** both can open one clearly labeled shared instance and see the same new record after reload.
2. **Given** an app with personal records, **when** it is shared, **then** the new shared instance starts empty and never shows those personal records.
3. **Given** a person without a grant or current membership, **when** they use a link or guess an app identifier, **then** they cannot discover its private content, assets, or data.
4. **Given** an unavailable service, **when** a member opens or saves, **then** the app explains the problem, preserves unsaved input, and never reports an unconfirmed save as successful.

---

### User Story 2 - Know whether an app is ready (Priority: P1)

An app builder checks readiness before inviting colleagues. The check explains missing capabilities and points to changes the builder can make. A declaration alone cannot earn the collaborative label when the running app fails a multi-user round trip.

**Why this priority**: A share control that leads to a broken app or leaks personal data damages trust.

**Independent Test**: Check one working tracker and one personal-only app; only the tracker becomes eligible, while the other receives actionable reasons.

**Acceptance Scenarios**:

1. **Given** an app with shared storage, compatible runtime, and verified member operations, **when** its owner checks readiness, **then** Matrix marks that version collaborative and enables sharing.
2. **Given** an app storing records only in the current browser, **when** its owner checks readiness, **then** Matrix blocks live sharing and names the missing capability.
3. **Given** a later app change that breaks its shared contract, **when** readiness is rechecked, **then** new shares stop and current participants see a safe unavailable state until repair; stored data remains intact.

---

### User Story 3 - Control access and concurrent work (Priority: P2)

The share manager sets Viewer or Editor access, changes it, or revokes it. Participants see their effective role. Concurrent edits and lost access produce clear outcomes instead of silent overwrites.

**Why this priority**: Teams need a safe way to correct mistakes and remove access promptly.

**Independent Test**: Grant Viewer, verify reads and denied writes, promote to Editor, save a record, then revoke while the app is open and verify the next operation fails safely.

**Acceptance Scenarios**:

1. **Given** Viewer access, **when** a member attempts any app write, **then** Matrix denies it even if the app UI still shows an edit control.
2. **Given** a role change or revocation, **when** an open app next reads, writes, reconnects, or receives updates, **then** current authority applies.
3. **Given** two Editors updating the same item, **when** their changes conflict, **then** the later writer sees a recoverable conflict and neither change disappears silently.
4. **Given** a member leaving the organization, **when** membership ends, **then** their access ends without deleting organization records.

---

### User Story 4 - Keep the organization app usable (Priority: P2)

The organization keeps using its shared app and data when its creator leaves. An authorized steward can export its data and retire the shared instance without touching personal installations.

**Why this priority**: Team operational data should survive one person's departure.

**Independent Test**: Remove the creator after another member has edited shared records; remaining authorized members can still open and export the instance.

**Acceptance Scenarios**:

1. **Given** an active shared app, **when** the creator leaves, **then** organization data and authorized member access remain available under a designated steward.
2. **Given** a steward retiring the instance, **when** the action completes, **then** new access stops, the action is recorded, and personal app data remains untouched.

### Edge Cases

- A creator belongs to several organizations: the selected organization is explicit and data never crosses organization boundaries.
- Organization membership alone does not reveal an app unless the owner intentionally grants organization-wide access.
- A link opened before acceptance, after revocation, or by an outsider shows a safe access state without internal details.
- Deleting or replacing an app under the same name cannot attach old grants to the replacement.
- A successful write whose response is lost can be checked and retried without duplicating a record.
- Offline participants retain unsaved input; offline writes are never claimed as saved.
- A shared app cannot silently use the creator's connected accounts, credentials, or AI spending authority.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST define a collaborative app as an exact app version that passes an owner-visible readiness check for authenticated participants, one shared instance, isolated shared storage, enforced roles, safe concurrent writes, and update propagation. A declaration is necessary but insufficient.
- **FR-002**: Readiness MUST name each missing capability, bind to the exact app identity and version, and become invalid after a relevant app or runtime change.
- **FR-003**: An eligible owner MUST be able to share the app directly, select one current organization, and grant current members or the organization audience using existing Viewer and Editor roles.
- **FR-004**: A recipient MUST be able to discover an accepted share in **Shared with me** and open the same instance without installing a copy or receiving the creator's personal app session.
- **FR-005**: New shared instances MUST start with a distinct data space. Existing personal records MUST stay private; any later import requires a separate explicit review.
- **FR-006**: Every launch, asset, data read, data write, and update MUST enforce current organization membership and effective app grant at the service boundary. Organization administrator status alone MUST NOT confer private app access.
- **FR-007**: Viewer MUST be read-only; Editor MAY change shared records within the declared app capability. The UI MUST reflect the effective role but cannot be the authority source.
- **FR-008**: Participants in one instance MUST see the same committed records after reload; active sessions MUST receive a bounded change signal and reconcile without duplicates or lost records.
- **FR-009**: Writes MUST handle retries and concurrent edits without duplicate creations or silent lost updates. Failed or uncertain saves remain visible as unsaved or needing confirmation.
- **FR-010**: The share manager MUST inspect audience and readiness, change roles, revoke access, and see safe unavailable states. Security-sensitive access changes MUST be recorded.
- **FR-011**: A shared app MUST receive safe current-participant identity and effective role when needed, without raw membership credentials or provider secrets.
- **FR-012**: The organization MUST control export and retirement of shared data, and access MUST survive creator departure through explicit stewardship.
- **FR-013**: App replacement or deletion MUST NOT inherit a prior instance's grant merely by reusing a slug. Existing data remains recoverable by authorized stewards.
- **FR-014**: The share flow MUST explain whether personal records are included, who can edit, who owns the shared data, and what revocation does.
- **FR-015**: Public app publication, Gallery installation, and private live sharing MUST be presented as distinct actions and data scopes.

### Key Entities

- **Collaborative app version**: Exact app identity, declaration, and validated readiness result.
- **Shared app instance**: One live app and organization-owned data space with a stable identity and lifecycle.
- **App grant**: An audience and effective Viewer or Editor access to one instance.
- **Participant**: A current organization member attributed to shared changes.
- **Shared record/change**: App content with revision, actor, and confirmed outcome.

### Assumptions and Dependencies

- **Product assumptions for review**: V1 permits direct app sharing as a deliberate exception to the current project-only rule; shared data starts empty; the organization owns the instance and retains it after creator departure. These are the three open discovery decisions.
- This feature reuses Matrix organizations, current membership, Viewer/Editor grants, **Shared with me**, and owner app catalog. It creates no second login or permission vocabulary.
- The first implementation must prove that owner and recipient launch the same shared context. Existing personal app launch and the current scoped app adapter are insufficient evidence by themselves.
- V1 targets Web Canvas, Web Desktop, Electron desktop, and web mobile where owner-built apps already launch. Native Mobile parity is a separate planning decision.
- A later skill may teach builders this contract. Public links, external guests, marketplace distribution, arbitrary custom app servers, and copying personal data are outside V1.
- Implementation must use test-first coverage at real identity, authorization, and persistence boundaries and live owner/member/outsider journeys on every affected surface. The implementation plan must include a separate public documentation PR in FinnaAI/matrix-os-site.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a two-member acceptance journey, 100% of confirmed creates, edits, and deletes appear to both after reload, with no personal record visible in the shared instance.
- **SC-002**: At least 95% of active-session changes become visible to the other participant within 5 seconds under supported test conditions.
- **SC-003**: In acceptance testing, 100% of Viewer writes, revoked-member operations, outsider launches, and wrong-organization launches are denied without app content disclosure.
- **SC-004**: A builder can identify why an ineligible app cannot be shared in one check, and a ready owner can complete sharing in under 2 minutes.
- **SC-005**: Two concurrent Editors can recover from a conflicting edit without silent data loss in every acceptance run.
- **SC-006**: In the creator-departure journey, authorized organization members can still access and export every confirmed shared record.
