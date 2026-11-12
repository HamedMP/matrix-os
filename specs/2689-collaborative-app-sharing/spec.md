# Feature Specification: Collaborative App Sharing

**Feature Branch**: 2690-collaborative-app-sharing
**Created**: 2026-11-04
**Status**: Approved for implementation
**Input**: Define when a Matrix app is collaborative and let organization members open and use one live, shared app.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Share and use one live app (Priority: P1)

A member builds a team tracker with saved tasks, chooses **Share app** from that app, and selects an organization. Any current member of that organization, including a guest, can open the app hosted by the creator, see those existing tasks, add another, and see the update. Neither person has to create or join a project, and colleagues do not install copies.

**Why this priority**: This is the first complete outcome that makes an app useful to a team.

**Independent Test**: With two Matrix members and one eligible tracker, share the app, create and edit from both accounts, reload both clients, and confirm one consistent shared record set.

**Acceptance Scenarios**:

1. **Given** an eligible app and two organization members, **when** the creator shares it with their organization, **then** both open the creator-hosted app and see the same existing and new records after reload.
2. **Given** an app with 20 saved tasks, **when** the creator shares it, **then** an invited colleague sees those 20 tasks and edits are reflected in the creator's app data.
3. **Given** a person outside the selected organization, **when** they use a link or guess an app identifier, **then** they cannot discover the shared app's content, assets, or data.
4. **Given** an unavailable service, **when** a member opens or saves, **then** the app explains the problem, preserves unsaved input, and never reports an unconfirmed save as successful.

---

### User Story 2 - Know whether an app is ready (Priority: P1)

An app builder checks readiness before inviting colleagues. The check validates the exact build's declared owner-backed storage, Matrix bridge compatibility, revisioned mutations, change signals, participant identity, and provider policy, and points to changes the builder can make. The live two-account journey remains release qualification rather than a separate credential prerequisite for sharing.

**Why this priority**: A share control that leads to a broken multi-user app damages trust.

**Independent Test**: Check one working tracker and one personal-only app; only the tracker becomes eligible, while the other receives actionable reasons.

**Acceptance Scenarios**:

1. **Given** an app with shared storage, compatible runtime, and verified member operations, **when** its owner checks readiness, **then** Matrix marks that version collaborative and enables sharing.
2. **Given** an app storing records only in the current browser, **when** its owner checks readiness, **then** Matrix blocks live sharing and names the missing capability.
3. **Given** a later app change that breaks its shared contract, **when** readiness is rechecked, **then** new shares stop and current participants see a safe unavailable state until repair; stored data remains intact.

---

### User Story 3 - Work with the organization (Priority: P2)

After the owner shares the app, every current member of the selected organization, including a guest, can use its full app functionality. Every current organization member may share an app they own. There are no additional app-specific roles, member invitations, admin approval, or record-level restrictions. Concurrent edits and membership changes produce clear outcomes instead of silent overwrites.

**Why this priority**: Joining the organization should be sufficient to use the shared app, while leaving it must end access.

**Independent Test**: Share with one organization, let two members use the app without further setup, add a third member, then remove one member and verify access follows current membership.

**Acceptance Scenarios**:

1. **Given** an active organization share, **when** a current member opens the app, **then** they can use its full app functionality without another invite, acceptance step, role choice, or permission prompt.
2. **Given** a person newly joining that organization, **when** membership becomes active, **then** they can find and open the shared app.
3. **Given** two members updating the same item, **when** their changes conflict, **then** the later writer sees a recoverable conflict and neither change disappears silently.
4. **Given** a member leaving the organization, **when** membership ends, **then** their access ends without deleting the owner's app records.

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
- Organization membership does not reveal an app until its owner shares it with that organization. After sharing, every current member has the same app access.
- A link opened before the owner shares the app, after the owner stops sharing, or by an outsider shows a safe access state without internal details.
- Deleting or replacing an app under the same name cannot attach an old organization share to the replacement.
- A successful write whose response is lost can be checked and retried without duplicating a record.
- Offline participants retain unsaved input; offline writes are never claimed as saved.
- A shared app cannot silently use the creator's connected accounts, credentials, or AI spending authority.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix MUST define a collaborative app as an exact app version whose bounded capability declaration matches its immutable build, owner-backed data schema, Matrix bridge/runtime compatibility, revisioned mutation path, participant identity, provider policy, and update propagation. Release qualification MUST prove the resulting path with two normally authenticated Matrix accounts.
- **FR-002**: Readiness MUST name each missing capability, bind to the exact app identity and version, and become invalid after a relevant app or runtime change.
- **FR-003**: Any current organization member MUST be able to share an app they own directly from the app with one selected organization. Creating or sharing a project, obtaining organization-admin approval, choosing per-member grants, or assigning app roles MUST NOT be required.
- **FR-004**: Every current member of the selected organization, including a guest, MUST be able to discover the share in the app launcher alongside their other apps, with a shared icon badge, and open the creator-hosted app without a separate invitation, acceptance step, copied installation, or the creator's personal app session. Shared apps MUST NOT appear as app cards in Chat's shared list. Existing app deep links remain supported.
- **FR-005**: A recipient opening the app MUST see the creator's existing app records and later confirmed changes in that same app database. V1 does not filter individual app records by recipient.
- **FR-006**: Every launch, asset, data read, data write, and update MUST verify that the app is currently shared with the actor's organization and that the actor is a current member. No second app-specific permission check is required.
- **FR-007**: Every current organization member, including a guest, MUST be able to use the app's full declared functionality. Matrix MUST NOT add Viewer/Editor modes, per-member grants, admin approval, or per-record filtering to V1 shared apps.
- **FR-008**: Participants in one instance MUST see the same committed records after reload; active sessions MUST receive a bounded change signal and reconcile without duplicates or lost records.
- **FR-009**: Writes MUST handle retries and concurrent edits without duplicate creations or silent lost updates. Failed or uncertain saves remain visible as unsaved or needing confirmation.
- **FR-010**: The owner MUST be able to see which organization has access, stop sharing the app, and see safe unavailable states. Share and unshare actions MUST be recorded.
- **FR-011**: A shared app MUST receive safe current-participant identity when needed, without raw membership credentials or provider secrets.
- **FR-012**: The app remains hosted by its creator in V1. When the creator's runtime is unavailable, colleagues MUST see a clear unavailable state and MUST recover the same saved work when it returns.
- **FR-013**: App replacement or deletion MUST NOT inherit a prior organization share merely by reusing a slug. The owner remains responsible for the app's saved data and recovery in V1.
- **FR-014**: The share flow MUST explain that existing app records will be visible, that the creator hosts the app and its data, that all current organization members can use it, and what stopping the share does.
- **FR-015**: Public app publication, Gallery installation, and private live sharing MUST be presented as distinct actions and data scopes.

### Key Entities

- **Collaborative app version**: Exact app identity, declaration, and validated readiness result.
- **Shared app access**: One creator-hosted app and its existing database, made available to selected people through a stable share identity.
- **Organization app share**: The owner's exact app identity and the selected organization, with active or stopped status.
- **Participant**: A current organization member attributed to shared changes.
- **Shared record/change**: App content with revision, actor, and confirmed outcome.

### Assumptions and Dependencies

- **Confirmed product decisions**: Collaborative apps are shared directly and independently of projects. Records remain solely owner-owned in the creator's database while the owner delegates revocable use to one organization. Any current organization member may share an app they own, and every current member, including a guest, gets full app access. Choosing the organization is the only sharing decision; there is no admin approval, additional app permission system, app role, per-person grant, acceptance flow, or record filter.
- This feature reuses Matrix organizations, current membership, **Shared with me**, and the owner app catalog. It creates no second login or app permission vocabulary.
- The first implementation must prove through live qualification that owner and recipient launch against the same owner app and database. Both use their normal authenticated Matrix sessions; current organization membership is the only recipient authorization gate, and readiness introduces no synthetic identity or credential source.
- V1 targets Web Canvas, Web Desktop, Electron desktop, and web mobile where owner-built apps already launch. Native Mobile parity is a separate planning decision.
- A later skill may teach builders this contract. Public links, external guests, marketplace distribution, arbitrary custom app servers, cross-organization sharing of one owner database, creator departure while sharing, and Native Mobile parity are outside V1.
- Implementation must use test-first coverage at real identity, authorization, and persistence boundaries and live owner/member/outsider journeys on every affected surface. The implementation plan must include a separate public documentation PR in FinnaAI/matrix-os-site.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a two-member acceptance journey, 100% of the creator's pre-share records and confirmed later creates, edits, and deletes appear to both after reload.
- **SC-002**: At least 95% of active-session changes become visible to the other participant within 5 seconds under supported test conditions.
- **SC-003**: In acceptance testing, 100% of current organization members, including guests, can use the shared app without another permission step, while departed members, outsiders, and wrong-organization users cannot open it.
- **SC-004**: A builder can identify why an ineligible app cannot be shared in one check, and a ready owner can complete sharing in under 2 minutes.
- **SC-005**: Two concurrent members can recover from a conflicting edit without silent data loss in every acceptance run.
- **SC-006**: After a creator-hosted runtime restarts, authorized colleagues can reopen the app and see every confirmed record.
