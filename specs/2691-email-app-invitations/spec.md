# Feature Specification: Email Invitations for Matrix.page Apps

**Feature Branch**: `2691-email-app-invitations`  
**Created**: 2026-11-09  
**Status**: Draft  
**Tracking**: [ENG-29 — Ship secure Collaboration & Sharing across Matrix OS](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os)  
**Related delivery**: [PR #3200 — app publishing and sharing UI](https://github.com/HamedMP/matrix-os/pull/3200), [ENG-231 — public Matrix.page publishing](https://linear.app/matrix-os/issue/ENG-231/featsites-publish-matrix-apps-on-matrixpage), [ENG-437 — one-time private links](https://linear.app/matrix-os/issue/ENG-437/featsites-add-one-time-private-access-links)  
**Input**: User description: "Add email-based invitations as a third Matrix.page access mode. Publishers specify recipient emails through the sharing UI being built in PR #3200. A recipient opens the shared app's own Matrix.page URL, signs in or signs up through a Clerk-powered component on that URL, bypasses Matrix onboarding and computer provisioning, and receives durable app-scoped access when a verified account email matches an active invitation. Public publishing and one-time links remain separate. The publisher retains ownership; the recipient receives durable access, not a clone or ownership transfer."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Invited recipient enters the app directly (Priority: P1)

A person who does not yet use Matrix receives an email invitation to a specific Matrix.page app. They open the app's own URL, create or use an account in the authentication experience presented there, and enter the shared app immediately after a verified email matches the invitation. They never visit Matrix onboarding and no computer is provisioned.

**Why this priority**: This is the core customer outcome: an external client can use a privately shared app with durable identity and without becoming a full Matrix OS customer.

**Independent Test**: Starting with a new browser profile and no Matrix account, invite `viewer@example.test`, open the delivered app URL, register that address, and verify that the canonical app loads without any onboarding or provisioning request. This detects the faults where authentication loses the app destination, signup triggers the main-product funnel, or client-side email state grants access without authoritative verification.

**Acceptance Scenarios**:

1. **Given** an active email-restricted publication and a pending invitation, **when** a recipient registers on that app URL using the invited email and completes email verification, **then** the invitation is accepted, durable access is attached to that account, and the same app URL loads the complete published app.
2. **Given** the recipient already has an authenticated account containing the invited verified email, **when** they open the app URL, **then** they enter the app without creating another account.
3. **Given** an account has several verified emails and one exactly matches the invitation after case-insensitive normalization, **when** it opens the app URL, **then** it may accept and use the invitation.
4. **Given** the visitor signs in with an account that does not contain the invited verified email, **when** the invitation is checked, **then** access is denied with a safe account-switch action and only a masked invitation hint.
5. **Given** a visitor authenticates successfully, **when** the authentication flow completes, **then** the return destination is the validated Matrix.page app URL and never a client-supplied external URL, Matrix onboarding, billing, or the Matrix desktop.
6. **Given** an invitation is revoked or expires while authentication is in progress, **when** the callback attempts acceptance, **then** no grant is created and the visitor sees a generic unavailable invitation state.

---

### User Story 2 - Publisher invites and manages named viewers (Priority: P1)

The publication owner uses the Share app panel established by PR #3200 to add one or more email addresses, send invitations, inspect delivery and acceptance status, resend failed or expired invitations, and revoke pending or accepted access.

**Why this priority**: The recipient journey is only useful when an owner can safely control who is invited and remove access without changing or republishing the app.

**Independent Test**: From each supported owner surface, invite a valid address, observe its pending state, accept it from a separate account, observe the accepted state, and revoke it. Verify that revocation denies the recipient on the next protected request. This detects the faults where UI state diverges from authoritative access, duplicate submissions create conflicting grants, or revocation protects only the wrapper while leaving content routes open.

**Acceptance Scenarios**:

1. **Given** a published app, **when** its owner selects email-restricted access and submits valid unique addresses, **then** one pending invitation per normalized email is shown without exposing any secret invitation credential.
2. **Given** a duplicate address appears in different letter casing or surrounding whitespace, **when** the owner submits it, **then** the existing invitation is reused or reported rather than creating a second active invitation.
3. **Given** up to 100 addresses are submitted together, **when** some addresses are invalid, duplicate, or exceed policy, **then** the owner receives bounded per-address results and no address is silently dropped.
4. **Given** invitation delivery fails after its authoritative record exists, **when** the owner refreshes the panel, **then** the invitation remains safely retryable with a non-provider-specific delivery state.
5. **Given** an invitation has expired or delivery must be retried, **when** the owner resends it, **then** stale delivery work is cancelled, a new seven-day window begins, and one current invitation remains for that email.
6. **Given** an accepted viewer, **when** the owner revokes access, **then** the invitation and grant become inactive together and all subsequent protected requests fail closed.
7. **Given** an app update or rollback leaves email-restricted access selected, **when** the new version becomes active, **then** current invitations and viewer grants continue to authorize the same publication.

---

### User Story 3 - Accepted viewer returns from any device (Priority: P2)

After accepting once, the viewer can revisit the publication's canonical Matrix.page URL from another browser or device, authenticate with the same account, and regain access without finding the invitation email or accepting again.

**Why this priority**: Email invitations are intended to establish durable person-level access, unlike ENG-437's browser-bound one-time sessions.

**Independent Test**: Accept in browser A, then authenticate as the same account in clean browser B using only the canonical app URL. Verify access in B and rejection for a different account. This detects accidental binding to one browser, one callback token, or email text supplied by the client.

**Acceptance Scenarios**:

1. **Given** an accepted grant, **when** the same account authenticates on the canonical app URL in a clean browser, **then** the app opens without a new invitation.
2. **Given** the accepted account later changes its primary email while retaining the same account identity, **when** it returns, **then** the durable grant remains valid until the publisher revokes it.
3. **Given** another account has learned or received the invitation URL, **when** it authenticates without the invited verified email or accepted account identity, **then** it receives no access.
4. **Given** the accepted account no longer exists or is disabled, **when** its prior browser session requests protected content, **then** access fails closed.

---

### User Story 4 - Existing Matrix.page access modes remain independent (Priority: P2)

Owners continue to choose separately among public access, private one-time links, and private email invitations. Adding email invitations does not reinterpret or weaken either existing mode.

**Why this priority**: Public publishing and one-time links are already shipped behaviors with different identity and security promises.

**Independent Test**: Exercise one public publication, one one-time-link publication, and one email-restricted publication through their complete existing/new journeys. This detects the fault where the new email gate accidentally authenticates public visitors, accepts one-time-link sessions as identities, or exposes an email-restricted artifact through existing public routes.

**Acceptance Scenarios**:

1. **Given** an existing public publication, **when** the feature is deployed, **then** anonymous access continues unchanged and no invitation is required.
2. **Given** an existing one-time-link publication, **when** the feature is deployed, **then** its anonymous claim and browser-session behavior continues unchanged and does not create an email grant.
3. **Given** an owner switches away from email-restricted access, **when** the transition succeeds, **then** pending invitations and accepted grants are revoked and cannot silently return after a later mode change.
4. **Given** an owner unpublishes an email-restricted app, **when** any former viewer requests its wrapper, frame, assets, data, or actions, **then** every route fails closed.

---

### User Story 5 - Complete app access without owner authority (Priority: P3)

An invited viewer sees and uses the whole published app experience, including only the visitor-facing data, forms, and interactions that the publisher explicitly made available. The viewer does not gain ownership, publishing controls, owner submissions, private Matrix tools, credentials, or a copy of the app.

**Why this priority**: "Access as their own" must feel durable and complete to the viewer without confusing access with ownership or leaking the publisher's runtime.

**Independent Test**: With an accepted viewer account, load all published resources and perform one declared visitor interaction, then attempt owner management and private runtime operations. This detects incomplete gating as well as privilege escalation from viewer to owner.

**Acceptance Scenarios**:

1. **Given** an accepted viewer, **when** they load the app, **then** the current published version and declared visitor capabilities work as they do for an authorized visitor.
2. **Given** the same viewer, **when** they attempt publication management, version history, owner submissions, private database access, private AI tools, or owner credentials, **then** every attempt is denied.
3. **Given** a publisher renames the friendly path, **when** an accepted viewer opens the permanent publication URL or the new canonical path, **then** their grant still resolves to the same publication.

### Edge Cases

- An invitation address is syntactically valid but receives no email; the owner can copy/resend the invitation without creating duplicate authority.
- A mail scanner or link preview opens the invitation before the recipient; no invitation is accepted until an authenticated matching account completes acceptance.
- An invitation is forwarded; the URL alone grants nothing, and only an account with the invited verified email may claim it.
- Two sessions for the same matching account try to accept concurrently; exactly one durable grant results and both settle to the same accepted state.
- Two different accounts capable of verifying the same shared-mailbox address race to accept; exactly one account wins and the other is denied unless the owner explicitly re-invites after revocation.
- An account signs in through a provider that supplies no verified email; it must add and verify the invited address before acceptance.
- An account's primary email differs from the invited address but another verified email matches; acceptance succeeds.
- Provider-specific dot removal, plus-address removal, or alias guessing is never used; only trimmed, case-insensitive exact matching is performed.
- The owner submits more than 100 addresses, an oversized request, an excessively long address, or malformed content; the request is rejected before any unbounded work or partial silent success.
- The publication, invitation, grant, recipient account, or access mode changes between landing, authentication, acceptance, and content load; each step revalidates current authority.
- A former viewer has cached app bytes when revoked; new network requests fail, while already delivered bytes cannot be remotely erased.
- Direct requests for a private frame, asset, data operation, or form cannot bypass the viewer grant even when the wrapper was previously loaded.
- Authentication or email delivery is temporarily unavailable; the visitor or owner sees a safe retry state without provider names, raw errors, internal paths, or invitation existence leaks.
- A signed-in user opens an invitation meant for another address; the product supports switching accounts without revealing the full invited address.
- The owner exports or deletes their account; invitation and grant metadata follows the same owner-scoped export, revocation, and erasure guarantees as the publication.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Matrix.page MUST offer email invitations as an access mode distinct from anonymous public access and anonymous one-time private links.
- **FR-002**: A publication MUST have exactly one authoritative access mode at a time: public, private one-time link, or private invited email.
- **FR-003**: Existing publications MUST preserve their current access mode when this feature is introduced; no publication may become email-restricted implicitly.
- **FR-004**: The owner MUST manage email invitations through the Share app experience established by PR #3200 rather than through a second competing sharing panel.
- **FR-005**: The email-invitation controls MUST remain unavailable until the authoritative backend and Matrix.page gate advertise compatible support.
- **FR-006**: The owner MUST be able to submit, paste, and validate up to 100 email addresses in one invitation action, with explicit results for invalid, duplicate, accepted, pending, and policy-rejected addresses.
- **FR-007**: Email addresses MUST be normalized using trimming and case-insensitive comparison only. The system MUST NOT apply provider-specific dot, plus-address, domain-alias, or inferred-equivalence rules.
- **FR-008**: At most one active invitation per normalized email and publication MUST exist. Concurrent or repeated creation MUST converge on that logical singleton without duplicate grants or duplicate active credentials.
- **FR-009**: Pending invitations MUST expire seven days after issuance. Resending MUST begin a new seven-day acceptance period and cancel stale delivery work without duplicating the recipient entry; the Matrix.page app URL itself is not an access credential.
- **FR-010**: Invitation messages MUST identify the app and inviter, contain a link to the intended Matrix.page app, and avoid placing the recipient email, owner credentials, internal identifiers, or private app data in the visible URL.
- **FR-011**: Opening an invitation MUST render the authentication and signup experience within the intended app's Matrix.page URL and branded context.
- **FR-012**: Authentication completion MUST return only to a server-validated destination for the same publication. Client-provided arbitrary return URLs MUST NOT be honored.
- **FR-013**: Invitation signup MUST NOT start Matrix main onboarding, billing, plan selection, developer-tool selection, desktop launch, or computer/VPS provisioning.
- **FR-014**: A recipient identity created only for Matrix.page viewing MUST remain a lightweight viewer identity unless that person later starts full Matrix onboarding through a separate explicit action.
- **FR-015**: Invitation acceptance MUST use authoritative identity data and MUST require at least one currently verified account email that matches the active invitation.
- **FR-016**: The browser, query string, form body, or app code MUST NOT be trusted to assert that an email is verified or belongs to the authenticated person.
- **FR-017**: Invitation acceptance MUST atomically bind one invitation to one authenticated account, create one durable publication grant, and record the accepted state. Competing acceptance attempts MUST produce one winner and no partial grant.
- **FR-018**: After acceptance, authorization MUST be based on the stable authenticated account identity and active publication grant, not on repeatedly matching editable email text.
- **FR-019**: An accepted viewer MUST be able to access the canonical publication from another browser or device after authenticating with the same account.
- **FR-020**: A forwarded invitation URL MUST grant no access by itself. A nonmatching account MUST receive the same coarse denial regardless of whether an invitation exists, expired, was accepted, or was revoked.
- **FR-021**: The mismatch experience MAY reveal only a masked invited-email hint and MUST provide a safe account-switch action.
- **FR-022**: Accepted viewers MUST receive the complete current published app and its explicitly declared visitor capabilities, subject to the existing Matrix.page sandbox and capability boundaries.
- **FR-023**: Email-invited access MUST NOT grant publication ownership, source files, owner management, version controls, owner submissions, owner-private data, private Matrix bridges, owner credentials, or unrestricted runtime access.
- **FR-024**: Every email-restricted wrapper, frame, asset, data, form, and visitor-action request MUST revalidate the active publication, email access mode, authenticated account, and site-scoped grant. Gating only the top-level page is insufficient.
- **FR-025**: Authorization decisions MUST NOT be cached beyond the request. Immutable build bytes may be cached only behind a fresh active-access check.
- **FR-026**: The owner MUST be able to list invitations using bounded pagination and see normalized recipient display, pending/accepted/expired/revoked state, delivery state, and relevant timestamps without access secrets.
- **FR-027**: The owner MUST be able to resend a pending or expired invitation and revoke a pending or accepted recipient.
- **FR-028**: Revoking an accepted recipient MUST deactivate the invitation and grant in one authoritative change and deny every subsequent protected request.
- **FR-029**: Switching away from email-restricted access or unpublishing MUST revoke all pending invitations and accepted grants in the same authoritative transition; switching back MUST NOT restore them.
- **FR-030**: Publishing an update, rolling back a version, or changing a friendly path while retaining email-restricted access MUST preserve valid invitations and grants for the same permanent publication.
- **FR-031**: Invitation creation, acceptance, resend, revocation, mode transitions, and unpublish MUST use conflict-safe writes so stale owners or concurrent recipients cannot overwrite newer state.
- **FR-032**: Invitation creation and delivery MUST use a durable delivery state. A failed or ambiguous email delivery MUST NOT remove the invitation or imply that delivery succeeded, and retries MUST be idempotent.
- **FR-033**: Invitation delivery calls MUST have a maximum 10-second attempt timeout, bounded retries, and generic user-facing errors. Provider names and raw provider failures MUST remain server-side.
- **FR-034**: Mutating requests MUST reject oversized bodies before buffering. Invitation batches MUST accept no more than 100 addresses and no more than 32 KiB of request content; individual addresses MUST respect the standard 254-character maximum.
- **FR-035**: In-memory admission, replay, delivery, and callback tracking MUST be size-capped with eviction. Durable invitation inventories MUST use bounded keyset pagination rather than unbounded reads.
- **FR-036**: Every authentication ticket, callback context, and viewer-session credential MUST be unguessable, publication-bound, time-bounded, excluded from analytics and logs, and invalid after its applicable completion, expiry, revocation, mode change, or unpublish. The emailed Matrix.page URL MUST NOT grant access by possession alone.
- **FR-037**: Invitation and grant data MUST be owner-scoped, exportable, and erasable. Account deletion MUST block new acceptance, revoke existing access, and remove or safely anonymize recipient identity references according to ownership requirements.
- **FR-038**: Audit history MUST record invitation creation, resend, acceptance, revocation, access-mode transitions, and unpublish without storing credentials or copying recipient emails into general analytics.
- **FR-039**: The feature MUST preserve existing public and one-time-link behavior and MUST NOT treat one-time browser sessions as authenticated email identities.
- **FR-040**: Owner controls MUST be supported wherever PR #3200 exposes the Share app panel: Web Desktop, Web Canvas, and Electron Desktop. The recipient Matrix.page journey MUST be responsive on desktop and mobile web.
- **FR-041**: Native Mobile owner management and Matrix main-app discovery of externally shared publications are outside V1 unless separately approved with live evidence.
- **FR-042**: The feature MUST include a separate public documentation change in the `FinnaAI/matrix-os-site` repository explaining the three access modes, recipient signup journey, revocation, and limitations.

### Access and Authorization Matrix

| Interaction | Required authority | Publicly reachable | Required denial behavior |
| --- | --- | --- | --- |
| Read or change publication invitation settings | Existing verified publication owner for the exact runtime and app | No | Generic owner error; no recipient data leakage |
| Create, resend, list, or revoke email invitations | Same verified owner and active exact publication | No | Reject stale revision, foreign publication, invalid batch, or unavailable dependency |
| Open an email-restricted app URL before authentication | Active publication plus valid invitation context, or an existing viewer session | Yes, as a gate only | Show generic sign-in/unavailable state; reveal no app content or invitation existence |
| Complete signup/sign-in for the app | Authenticated account plus server-controlled same-publication return context | Yes | Reject external return targets and stale, replayed, cross-site, or malformed context |
| Accept an email invitation | Authenticated account with a matching verified email plus active site-bound invitation | Yes | Coarse denial without disclosing full email or invitation state |
| Read wrapper, frame, assets, or declared public data | Active email-restricted publication plus active account-bound site grant | Yes, but protected | Fail closed on every route; do not rely on wrapper access alone |
| Submit a declared visitor form or perform a declared visitor action | Same active viewer grant plus existing schema, quota, and admission checks | Yes, but protected | Generic rejection; no owner or provider details |
| Manage publication, versions, owner submissions, or private runtime capabilities | Existing verified publication owner only | No | Viewer identity never elevates to owner authority |

### Integration and Runtime Boundary

The complete journey MUST remain wired as one verifiable chain:

1. PR #3200's Share app panel submits an owner-authorized invitation request for the exact publication.
2. The authoritative invitation registry records the invitation before bounded email delivery begins.
3. The email link opens the intended app's Matrix.page URL. An unauthenticated visitor sees only the app-scoped authentication gate.
4. The authentication service returns a stable account identity and authoritative verified-email set through a server-controlled same-publication callback.
5. Acceptance atomically binds that account to the invitation and publication grant.
6. Matrix.page rechecks the account-bound grant before returning the wrapper, sealed app content, assets, declared data, forms, or actions.
7. The publisher's owner UI reads the same authoritative state for pending, accepted, expired, delivery-failed, and revoked recipients.
8. Revocation, mode change, unpublish, owner deletion, and recipient-account invalidation close access at the same authority boundary.

The implementation plan MUST include a full-path integration test that exercises this chain through real first-party services and durable storage. A client-only fixture, authentication bypass, or test-local replica does not qualify the feature.

### Key Entities

- **Publication Access Policy**: The single active visibility policy for a published app: public, private one-time link, or private invited email. It belongs to one permanent publication and has a conflict-detecting revision.
- **Email Invitation**: Owner-scoped invitation for one normalized email and publication, including lifecycle state, delivery state, issue/expiry/accept/revoke timestamps, inviter, and the accepted account reference when present. Authentication and viewer-session credentials are never part of inventory output.
- **Viewer Grant**: Durable authorization connecting one authenticated account to one publication after successful acceptance. It conveys visitor access only and ends on revocation, access-mode change, unpublish, owner deletion, or invalid recipient identity.
- **Viewer Identity**: A lightweight authenticated account that may access shared Matrix.page apps without a Matrix computer, subscription, onboarding state, or owner privileges.
- **Invitation Delivery Attempt**: Bounded, retryable record of an invitation email attempt. It distinguishes queued, sent/accepted-by-provider, failed, and ambiguous outcomes without exposing provider errors to users.
- **Access Audit Event**: Owner-visible security event for invitation and grant lifecycle changes, excluding secrets and analytics copies of recipient email addresses.

### Assumptions and Dependencies

- PR #3200 remains the source for Share app panel placement and surface integration. This feature enables and extends its disabled email row; it does not replace or rebase that UI work.
- The literal product requirement is that the Clerk sign-in/sign-up component completes on the intended app's own Matrix.page URL. Current Clerk satellite-domain documentation instead describes authentication on the primary domain, so a production-domain spike is a mandatory feasibility gate before implementation. A redirect through Matrix main auth, onboarding, billing, or provisioning is not an accepted fallback; if inline completion cannot be proven, implementation pauses for an explicit product decision.
- One invitation may be accepted by only one account. Shared mailbox recipients coordinate which account claims access; supporting several accounts for one invited email requires separate invitations after an explicit product decision.
- Accepted access is durable until revoked and is not automatically lost when the account's primary email changes.
- The app publisher remains the sole owner. Invited viewers receive no clone, installation, source ownership, or transferable publication rights.
- The existing Matrix.page sandbox, declared visitor data/forms boundary, versioning, update, rollback, and unpublish behavior remain authoritative.
- An email provider and sending domain are configured separately. Delivery availability does not become publication authority.
- Existing publication URLs remain stable. A friendly-path rename does not change the permanent publication identity or grants.

### Out of Scope

- Changing anonymous public publication behavior from ENG-231.
- Changing anonymous one-time link behavior, limits, or browser sessions from ENG-437.
- App cloning, installation into the recipient's Matrix home, ownership transfer, co-publishing, editor roles, or recipient source access.
- Automatically enrolling invited viewers into a Matrix organization.
- Matrix main onboarding, subscription purchase, computer provisioning, desktop installation, or developer-tool setup.
- Private owner database access, arbitrary backend execution, owner AI/provider credentials, or unrestricted Matrix runtime access.
- Custom recipient roles beyond one V1 viewer capability.
- Native Mobile owner invitation management.
- Custom-domain authentication behavior; V1 is scoped to Matrix.page publication URLs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 90% of first-time invited recipients in usability validation can open the invitation, create or use an account, and enter the shared app in under three minutes without assistance.
- **SC-002**: In 100% of tested new-recipient journeys, successful signup returns to the intended shared app and triggers no Matrix onboarding, billing, desktop launch, or computer provisioning step.
- **SC-003**: In 100% of tested mismatch, expired, revoked, replayed, forwarded, cross-site, and direct-content attempts, the visitor receives no protected app content and no unmasked invitation email.
- **SC-004**: Exactly one durable viewer grant results from 100 concurrent acceptance attempts for the same invitation, with no duplicate grant or partial accepted state.
- **SC-005**: An accepted viewer can authenticate from a second clean browser using only the canonical app URL and regain access in under 30 seconds.
- **SC-006**: Revocation, access-mode change, or unpublish denies the former viewer on the next protected request across wrapper, frame, asset, data, form, and action paths, with the denial visible within five seconds of the owner action completing.
- **SC-007**: Owners can submit a batch of 100 invitation addresses and receive an explicit result for every address in under ten seconds, excluding external inbox-delivery time, with no silent truncation or duplicate active invitation.
- **SC-008**: Existing public and one-time-link acceptance journeys remain fully successful in regression qualification, with no new authentication or invitation step.
- **SC-009**: Live evidence demonstrates the owner invitation lifecycle on Web Desktop, Web Canvas, and Electron Desktop, plus recipient signup and use on desktop and mobile Matrix.page, all against the same reviewed build and scenario.
- **SC-010**: Owner export and account erasure validation accounts for 100% of invitation, grant, delivery, and audit records for the tested publication without exposing authentication tickets, viewer-session credentials, or stored hashes.
