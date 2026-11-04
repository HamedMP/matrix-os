# Feature Specification: Collaborative App Sharing

**Feature Branch**: 2690-collaborative-app-sharing
**Created**: 2026-11-04
**Status**: Draft for product review
**Input**: Define when a Matrix app is collaborative and let organization members open and use one live, shared app.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Share and use one live app (Priority: P1)

A member builds a team tracker with saved tasks, chooses **Share app** from that app, and selects an organization and audience. A colleague opens the app hosted by the creator, sees those existing tasks, adds another, and both see the update. Neither person has to create or join a project, and colleagues do not install copies.

**Why this priority**: This is the first complete outcome that makes an app useful to a team.

**Independent Test**: With two Matrix members and one eligible tracker, share the app, create and edit from both accounts, reload both clients, and confirm one consistent shared record set.

**Acceptance Scenarios**:

1. **Given** an eligible app and two organization members, **when** the creator shares it with Editor access, **then** both open the creator-hosted app and see the same existing and new records after reload.
2. **Given** an app with 20 saved tasks, **when** the creator shares it, **then** an invited colleague sees those 20 tasks and edits are reflected in the creator's app data.
3. **Given** a person without a grant or current membership, **when** they use a link or guess an app identifier, **then** they cannot discover its private content, assets, or data.
4. **Given** an unavailable service, **when** a member opens or saves, **then** the app explains the problem, preserves unsaved input, and never reports an unconfirmed save as successful.

---

### User Story 2 - Know whether an app is ready (Priority: P1)

An app builder checks readiness before inviting colleagues. The check explains missing capabilities and points to changes the builder can make. A declaration alone cannot earn the collaborative label when the running app fails a multi-user round trip.

**Why this priority**: A share control that leads to a broken multi-user app damages trust.

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

### User Story 4 - Understand host availability (Priority: P2)

Colleagues understand that the app and its data are served by the creator's Matrix. They get a clear unavailable state if that host cannot be reached and resume the same work when it returns.

**Why this priority**: A live owner-hosted app must explain when its source is temporarily unavailable.

**Independent Test**: Save a task from a colleague, take the creator's runtime offline, observe the unavailable state, restore it, and confirm the same task is present.

**Acceptance Scenarios**:

1. **Given** an active shared app, **when** the creator's runtime is offline, **then** colleagues see a safe unavailable state and their unsaved input is retained.
2. **Given** that runtime comes back, **when** colleagues reopen the app, **then** they see the same saved app records.

### Edge Cases

- A creator belongs to several organizations: the selected organization is explicit. Sharing the same owner data with another organization is outside V1 until its audience and disclosure are designed.
- Organization membership alone does not reveal an app unless the owner intentionally grants organization-wide access.
- A link opened before acceptance, after revocation, or by an outsider shows a safe access state without internal details.
- Deleting or replacing an app under the same name cannot attach old grants to the replacement.
- A successful write whose response is lost can be checked and retried without duplicating a record.
- Offline participants retain unsaved input; offline writes are never claimed as saved.
- A shared app cannot silently use the creator's connected accounts, credentials, or AI spending authority.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST define a collaborative app as an exact app version that passes an owner-visible readiness check for authenticated participants, one creator-hosted app and data store, safe multi-user writes, and update propagation. A declaration is necessary but insufficient.
- **FR-002**: Readiness MUST name each missing capability, bind to the exact app identity and version, and become invalid after a relevant app or runtime change.
- **FR-003**: An eligible owner MUST be able to share the app directly from the app, select one current organization, and grant current members or the organization audience using existing Viewer and Editor roles. Creating, joining, or sharing a project MUST NOT be required.
- **FR-004**: A recipient MUST be able to discover an accepted share in **Shared with me** and open the creator-hosted app without installing a copy or receiving the creator's personal app session.
- **FR-005**: A recipient opening the app MUST see the creator's existing app records and later confirmed changes in that same app database. V1 does not filter individual app records by recipient.
- **FR-006**: Every launch, asset, data read, data write, and update MUST enforce current organization membership and effective app grant at the service boundary. Organization administrator status alone MUST NOT confer private app access.
- **FR-007**: Viewer MUST be read-only; Editor MAY change shared records within the declared app capability. The UI MUST reflect the effective role but cannot be the authority source.
- **FR-008**: Participants in one instance MUST see the same committed records after reload; active sessions MUST receive a bounded change signal and reconcile without duplicates or lost records.
- **FR-009**: Writes MUST handle retries and concurrent edits without duplicate creations or silent lost updates. Failed or uncertain saves remain visible as unsaved or needing confirmation.
- **FR-010**: The share manager MUST inspect audience and readiness, change roles, revoke access, and see safe unavailable states. Security-sensitive access changes MUST be recorded.
- **FR-011**: A shared app MUST receive safe current-participant identity and effective role when needed, without raw membership credentials or provider secrets.
- **FR-012**: The app remains hosted by its creator in V1. When the creator's runtime is unavailable, colleagues MUST see a clear unavailable state and MUST recover the same saved work when it returns.
- **FR-013**: App replacement or deletion MUST NOT inherit a prior share grant merely by reusing a slug. The owner remains responsible for the app's saved data and recovery in V1.
- **FR-014**: The share flow MUST explain that existing app records will be visible, that the creator hosts the app and its data, who can edit, and what revocation does.
- **FR-015**: Public app publication, Gallery installation, and private live sharing MUST be presented as distinct actions and data scopes.

### Key Entities

- **Collaborative app version**: Exact app identity, declaration, and validated readiness result.
- **Shared app access**: One creator-hosted app and its existing database, made available to selected people through a stable share identity.
- **App grant**: An audience and effective Viewer or Editor access to one instance.
- **Participant**: A current organization member attributed to shared changes.
- **Shared record/change**: App content with revision, actor, and confirmed outcome.

### Assumptions and Dependencies

- **Confirmed product decisions**: Collaborative apps are shared directly and independently of projects. Recipients use the creator-hosted app and see its existing database records; V1 has no per-recipient record filtering.
- **Open decision**: Confirm the access boundary for opening the app. The draft currently assumes selected organization members with current grants, but the requester has said there is no extra security gate in V1.
- This feature reuses Matrix organizations, current membership, Viewer/Editor grants, **Shared with me**, and owner app catalog. It creates no second login or permission vocabulary.
- The first implementation must prove that owner and recipient launch against the same owner app and database. Existing asset routes alone are insufficient evidence.
- V1 targets Web Canvas, Web Desktop, Electron desktop, and web mobile where owner-built apps already launch. Native Mobile parity is a separate planning decision.
- A later skill may teach builders this contract. Public links, external guests, marketplace distribution, arbitrary custom app servers, cross-organization sharing of one owner database, and creator-departure transfer are outside V1.
- Implementation must use test-first coverage at real identity, authorization, and persistence boundaries and live owner/member/outsider journeys on every affected surface. The implementation plan must include a separate public documentation PR in FinnaAI/matrix-os-site.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a two-member acceptance journey, 100% of the creator's pre-share records and confirmed later creates, edits, and deletes appear to both after reload.
- **SC-002**: At least 95% of active-session changes become visible to the other participant within 5 seconds under supported test conditions.
- **SC-003**: In acceptance testing, 100% of Viewer writes, revoked-member operations, outsider launches, and wrong-organization launches are denied without app content disclosure.
- **SC-004**: A builder can identify why an ineligible app cannot be shared in one check, and a ready owner can complete sharing in under 2 minutes.
- **SC-005**: Two concurrent Editors can recover from a conflicting edit without silent data loss in every acceptance run.
- **SC-006**: After a creator-hosted runtime restarts, authorized colleagues can reopen the app and see every confirmed record.
