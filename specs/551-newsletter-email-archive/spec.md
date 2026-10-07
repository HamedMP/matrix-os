# Feature Specification: Newsletter Reader and Shared Email Archive

**Feature Branch**: `codex/newsletter-email-archive-spec`  
**Created**: 2026-10-07  
**Status**: Draft; implementation follows the gallery merge  
**Input**: Add a newsletter reading app after the App Gallery changes merge; consolidate newsletters from email, use existing Jev classification, clean the inbox, and save historical email locally for reuse by other apps to reduce repeated Pipedream requests.

## User Scenarios & Testing

### User Story 1 — Read subscriptions in one place (Priority: P1)

Install the newsletter reader, choose exact connected accounts and a history range, then read a consolidated library organized by publication. Working app name: **Edition**. Its personality is editorial: generous typography, clear publication covers, a reading queue, and a distraction-free article view within the approved Matrix app family.

**Why this priority**: Newsletters become useful reading rather than inbox clutter.

**Independent Test**: Import a fixture mailbox with newsletters, personal messages, receipts, and ambiguous mail. Inspect the resulting library and verify that uncertain results stay in Review.

**Acceptance Scenarios**:

1. **Given** two selected email accounts, **When** import completes, **Then** newsletters are grouped by publication with sender, subject, received date, original-account attribution, and classification evidence.
2. **Given** conflicting or low-confidence evidence, **When** classification finishes, **Then** the message appears in Review rather than silently entering the confirmed library or cleanup selection.
3. **Given** a saved edition, **When** the user opens, bookmarks, or marks it read, **Then** the reading state survives closing and reopening on another authenticated device.
4. **Given** accounts marked Work and Personal, **When** the filter changes, **Then** the library and unread counts follow that selection without changing data ownership.
5. **Given** a publication incorrectly identified as a newsletter, **When** the user corrects it, **Then** later classifications respect the saved correction and the cleanup plan excludes it.

### User Story 2 — Reuse historical mail without repeated retrieval (Priority: P1)

Save authorized email history once on the user's Matrix computer. Newsletter, spending, travel, and other permitted apps request the retained history rather than independently fetching the same message again.

**Why this priority**: This is shared infrastructure for useful apps and lower connector costs.

**Independent Test**: Import messages, open three authorized consumers, then disconnect the source. Retained messages remain available under the user's selected retention policy, and subsequent historical reads make no upstream message-body requests.

**Acceptance Scenarios**:

1. **Given** a message already saved with complete requested content, **When** another permitted app reads it, **Then** it receives the saved message without an upstream refetch.
2. **Given** new mail, **When** sync resumes, **Then** only changes and missing content are fetched; duplicate delivery does not duplicate the message or reading state.
3. **Given** interrupted import, **When** the user resumes, **Then** saved progress continues without losing previously retained messages.
4. **Given** a lost sync position, **When** recovery runs, **Then** it reconciles the chosen history range without erasing saved content or user corrections.
5. **Given** an app without email permission, **When** it asks for archive content, **Then** access is denied, including when it guesses another account's message identifier.

### User Story 3 — Clean the inbox after saving (Priority: P1)

Review a concrete list of newsletter messages that are safely stored, then archive those messages from the source inbox. Reading state in Edition and read/unread state in the email provider are separate choices.

**Why this priority**: Consolidation should remove inbox clutter while preserving access to the original messages.

**Independent Test**: Select a saved newsletter batch, confirm cleanup, interrupt one upstream operation, and verify per-message confirmed, failed, and unknown results. Undo confirmed operations without changing unrelated messages.

**Acceptance Scenarios**:

1. **Given** confirmed newsletters stored successfully, **When** the user requests cleanup, **Then** a preview shows exact accounts, messages, action, and exclusions before executing the selected batch.
2. **Given** ambiguous, urgent, personal, reply-needed, unsaved, or overridden messages, **When** cleanup is planned, **Then** they remain outside automatic cleanup.
3. **Given** an archive succeeds at the source, **When** the app shows success, **Then** the receipt reflects independent source confirmation and provides an undo action.
4. **Given** an uncertain upstream outcome, **When** the batch resumes, **Then** it reconciles current source labels before retrying or claiming success.
5. **Given** a user-enabled rule for selected publications, **When** new editions arrive, **Then** only messages satisfying the saved rule are archived after durable local saving and fresh account verification.

### User Story 4 — Read comfortably on every Matrix surface (Priority: P2)

Use the same publication library, article view, progress, and actions on Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and Native Mobile.

**Why this priority**: The reader should be useful on a phone and fit the gallery's approved visual style.

**Independent Test**: Save an edition in Web Desktop, reopen it in Native Mobile, read while temporarily disconnected, and reconcile reading state after reconnecting.

**Acceptance Scenarios**:

1. **Given** a narrow phone display, **When** an edition opens, **Then** text, tables, images, and controls fit the reading viewport with adjustable text size and reachable controls.
2. **Given** a cached edition on the device, **When** connectivity is lost, **Then** it remains readable with a visible offline status; uncached content is not presented as downloaded.
3. **Given** pending reading-state changes, **When** connectivity returns, **Then** the changes reconcile without duplication; inbox cleanup waits for an online confirmed operation.
4. **Given** a revoked account, logout, or computer switch, **When** the reader reopens, **Then** it cannot display another owner's cached content.

### Edge Cases

- A newsletter thread contains a personal reply or a receipt; cleanup selects exact messages rather than indiscriminately archiving the entire thread.
- Forwarded newsletters, multiple aliases, equal message identifiers in different accounts, and duplicate deliveries retain correct provenance.
- Remote images, tracking pixels, scripts, misleading links, and email instructions are untrusted content.
- Large bodies, malformed encodings, missing content, disk exhaustion, and source retention gaps produce explicit partial results.
- Jev is unavailable, classification funding is exhausted, or an inference outcome is unknown; reading saved editions and manual corrections still work.
- Reconnecting a different account invalidates previous source bindings even when the visible account label is unchanged.
- Disconnecting a source, deleting an archived message, deleting an account's retained history, and uninstalling the reader are distinct actions with explicit retention behavior.
- Undo restores only the inbox membership changed by the cleanup operation; it cannot resurrect source messages that were deleted independently.

## Requirements

### Functional Requirements

- **FR-001**: Provide publication library, Latest, Unread, Saved, Review, search, and article views. Show exact source-account attribution in message detail.
- **FR-002**: Reuse existing Jev newsletter evidence and preserve classifications, evidence fingerprints, recipe versions, and manual corrections. Classification alone must never initiate source writes.
- **FR-003**: Show import range, saved count, classification progress, errors, last synchronization, and source coverage independently; never present partial coverage as a complete mailbox archive.
- **FR-004**: Default the first backfill to the last three months. Let the owner explicitly choose older history and expand the range with resumable progress.
- **FR-005**: Provide an owner-controlled shared historical email archive on the Matrix computer with export and deletion. Fetch missing bodies once and reuse retained content across authorized consumers.
- **FR-006**: Keep account and owner boundaries intact, including immutable source identities, Work/Personal filtering, and explicit per-app permissions.
- **FR-007**: Make sync resumable, deduplicate deliveries, retain user corrections, and expose stale or disconnected source state. Repeated sync must not reread unchanged stored bodies.
- **FR-008**: Archive selected confirmed newsletter messages only after successful local saving, current source-binding verification, and a previewed user selection or saved publication rule. Do not trash or delete source mail.
- **FR-009**: Preserve source read/unread labels unless the user separately chooses to synchronize reading state. Record confirmed cleanup outcomes and offer undo.
- **FR-010**: Explain retention and storage usage; warn and stop fetching before exceeding the selected quota. Do not silently evict bookmarked editions or delete retained history to make room.
- **FR-011**: Disable remote email resources by default, sanitize displayed content, preserve original evidence, and prevent email text from supplying instructions or permissions.
- **FR-012**: Support all five Matrix OS views with the same actions and state semantics. Native Mobile must reopen saved content, isolate device caches, and recover its app session.
- **FR-013**: Track upstream message retrievals, reuse, missing-body fetches, sync calls, classification reuse, and billed connector usage when available. Do not promise a dollar saving without observed billing evidence.
- **FR-014**: Let users keep selected historical content after disconnecting a source or choose to purge it. Revoke consumer grants independently from content retention.
- **FR-015**: Keep this follow-up out of the current gallery merge. Implementation begins after the gallery stack lands; public documentation ships in a separate site-repository PR before promotion.

### Key Entities

- **Source account**: owner, immutable connection identity, verified email address, user label, permissions, retention preference, coverage, and sync state.
- **Archived message**: source identity, message/thread identifiers, headers, content, received date, source-label snapshot, integrity fingerprint, retention status, and version.
- **Publication**: sender identity, user-approved grouping, display name, follow/mute preference, and cleanup rule.
- **Classification**: bounded message evidence, Jev scores and provenance, confidence, policy version, and correction history.
- **Reading state**: saved/unread status, progress, highlights where supported, and cross-device revision.
- **Cleanup operation**: exact message selection, original inbox membership, policy/grant evidence, source confirmation, retry state, and undo outcome.
- **Consumer grant**: authorized app installation, permitted source accounts and history range, read scope, and revocation state.

## Success Criteria

### Measurable Outcomes

- **SC-001**: In a manually labeled set of at least 200 mixed messages across two accounts, confirmed-newsletter precision is at least 95%; uncertain cases remain visible for review.
- **SC-002**: Three permitted apps reading the same complete retained history cause zero additional upstream message-body reads; identical content and recipe reuse cause zero additional classification requests.
- **SC-003**: An unchanged incremental sync retrieves no stored message body again; a changed message is retrieved at most once per observed content version, excluding documented upstream retries.
- **SC-004**: Across interruption and replay tests, message, reading-state, and cleanup records remain unique, and no unsaved or excluded message is archived.
- **SC-005**: At least 90% of test users can find and open an unread edition within three interactions from the library.
- **SC-006**: Previously downloaded editions open within one second on the target Native Mobile test device while disconnected; state reconciles on reconnect without crossing owner or computer boundaries.
- **SC-007**: Every confirmed cleanup entry is independently verifiable at the source; undo restores the inbox membership changed by that operation when the source message still exists.
- **SC-008**: Export reproduces retained message content and metadata; deletion removes the selected content and consumer visibility, including device-cache invalidation on the next authenticated contact.

## Dependencies, Assumptions, and Scope

- The complete gallery stack must land in `main`, not merely merge #2269 into its current feature-branch base. This spec does not authorize or claim a gallery merge or deployment.
- Existing Gmail integration is the first supported source. Other email providers, RSS, and saved web articles are later adapters with separate capability and content-fetch qualification.
- Existing Jev classification and funded policy must be live and eligible. Unknown or expired funding is a classified failure state, not permission to use an unrestricted fallback key.
- One shared archive serves newsletters, expenses, and trips through explicit grants. Calendar data keeps its own source lifecycle.
- A Work label filters personal-owner data; it does not transfer mail to an organization.
- Reading metadata persists across devices. Device offline content is an explicit bounded download, not an implicit full-mailbox copy.
- Default account quota for planning: 1 GiB retained email bodies, no automatic attachment download, and configurable history retention. This is a proposed product default to qualify against observed sizes.
- Unsubscribe, destructive source deletion, autonomous mailbox-wide cleanup, paid publication subscriptions, and community publication are outside the first release.
