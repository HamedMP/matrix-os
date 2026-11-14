# Feature Specification: App Store Publishing

**Feature Branch**: `codex/app-store-spec`
**Created**: 2026-10-18
**Status**: Planned; recovered work requires validation
**Ticket**: [ENG-322](https://linear.app/matrix-os/issue/ENG-322/add-reviewed-community-app-publishing-to-matrix-gallery), assigned to Hamed; Oct Launches
**Stack**: `app-store-publishing`
**Input**: "Users can publish apps to the App Store. Analyze their code, separate what is their own and specialized, make it more general, and ship it. Matrix staff monitor and approve submissions. People rate apps and see downloads, ratings, and the information and integrations an app needs."
**Supersedes**: the publishing, audit, rating and install-count parts of `specs/058-app-gallery` and `specs/039-app-store` (neither was implemented). Orgs, text reviews, paid apps and public web pages remain deferred.
**Builds on**: the shipped Matrix Gallery (`home/apps/app-gallery`, `packages/gateway/src/app-gallery/`, `packages/contracts/src/app-gallery*.ts`).

## Decisions

| Topic | Decision |
| --- | --- |
| Community feedback | 1–5 star ratings plus metrics (downloads, active installs, average rating, rating count). No upvotes or text reviews in this version. |
| Source | Installers receive the full generalized source as the published artifact, so their agent can read, fork and edit the app. Publishers choose a license at submission. |
| Builds | Each installer VPS builds the approved full source locally in an OS-enforced sandbox. A restricted registry broker fetches lockfile-pinned dependencies; install and Vite execution are offline, isolated from host home, credentials, sockets and network. Missing isolation fails closed. The platform never executes submissions or distributes `dist`. |
| Review | Matrix staff approve, request changes, or reject every version. AI and scanners only advise reviewers; nothing is auto-approved. |
| Reviewer identity | Clerk user IDs in `MATRIX_APP_STORE_REVIEWER_CLERK_IDS`, checked by the platform on every review request. |
| Privacy | Snapshot and preparation run on the publisher VPS. After a separate provider disclosure and consent, scrubbed draft source is sent to the owner-selected AI provider. No source is uploaded to the Matrix platform before final submission consent. A scanner cannot guarantee removal of all personal information. |

## Terms

- **Source app**: the publisher's own app at `~/apps/<slug>`. Publishing never modifies it.
- **Draft**: a private, generalized copy of a source app on the publisher's VPS, with scan findings, a change report and a listing draft.
- **Submission / version**: one uploaded draft for a listing. It moves through scan and human review; approval publishes the exact source artifact.
- **Listing**: the public store entry. It points at its current approved version and carries aggregate metrics.
- **Community install**: a listing version installed into an installer's `~/apps/<slug>` with the `community` trust tier.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prepare an app for publishing (Priority: P1)

A publisher opens Gallery → Publish, picks one of their apps, and Matrix prepares a shareable copy. It removes secrets and personal details, turns owner-specific values into first-run settings, replaces real records with sample data, fills in the integrations and permissions the app needs, and drafts the listing. The publisher sees what changed, grouped by kind, and can ask for revisions.

**Why this priority**: Nothing reaches the store without a safe, general copy. This is the step only Matrix can do.

**Independent Test**: With a fixture app that contains a hardcoded email, an API key, a Gmail account label and real seed rows, a draft reaches `ready` with no blocking findings after isolated local build verification. Its report lists each change, and the source app is byte-for-byte unchanged.

**Acceptance Scenarios**:

1. **Given** a publisher with a working app, **When** they choose it in Publish, **Then** a draft is created and progresses through snapshot, scan, generalize and verify, with visible progress.
2. **Given** a draft whose source contains a secret, **When** generalization finishes, **Then** the secret is absent from every draft file and the report records the removal by file and category, without echoing the secret.
3. **Given** a draft with a fixed integration account label, **When** generalization finishes, **Then** the app uses an account chosen at runtime, and the manifest declares the integration and actions.
4. **Given** a draft that still has blocking findings after generalization, **When** the publisher views it, **Then** submit is disabled and each finding shows its file, line and category.
5. **Given** a ready draft, **When** the publisher asks for a revision ("keep my brand name"), **Then** generalization re-runs with that instruction and the report updates.
6. **Given** no compatible AI access, **When** a draft runs, **Then** the deterministic scrub and scan still run, the AI step reports `unavailable`, and the publisher sees what remains to fix by hand.

---

### User Story 2 - Submit a version (Priority: P1)

The publisher reviews the listing (name, tagline, description, category, icon), sets the version and changelog, chooses a license, confirms what will be shared, and submits. The submission appears in "My submissions" with its status.

**Why this priority**: Submission connects the private draft to the shared store.

**Independent Test**: A ready draft submits; the platform stores the bundle, re-scans it, and places the version in the review queue. Repeating the submit request does not create a second version.

**Acceptance Scenarios**:

1. **Given** a ready draft, **When** the publisher submits without ticking consent, **Then** the request is rejected and nothing is uploaded.
2. **Given** consent, **When** the publisher submits, **Then** the bundle uploads, the platform verifies its hash and size, re-runs the scan, and the version reaches `in_review` (or `scan_failed` with findings).
3. **Given** a slug already owned by another publisher, **When** submitting a new listing, **Then** the publisher sees a conflict and can choose another slug.
4. **Given** an existing listing, **When** the same publisher submits a higher semver, **Then** a new version is created for that listing; a lower or equal version is rejected.
5. **Given** a version in review, **When** the publisher withdraws it, **Then** it leaves the queue and the listing's current version is unchanged.

---

### User Story 3 - Review submissions (Priority: P1)

A Matrix staff reviewer opens the **Review** tab in Gallery and sees the queue. The tab appears only for allowlisted reviewers. For each version they see the publisher, listing details, declared integrations, permissions and data tables, scanner findings, the generalization report, the file tree with source viewing, and the difference from the previous approved version. They approve, request changes with a message, or reject. They can also delist or suspend a live listing.

**Why this priority**: The user asked for staff approval before anything is public; installers trust reviewed code.

**Independent Test**: A reviewer approves an `in_review` source version; the same transaction publishes it, updates the current pointer and writes the audit event. It appears in the catalog without a platform build. A non-reviewer gets 403 from every review endpoint.

**Acceptance Scenarios**:

1. **Given** a non-reviewer, **When** they open Gallery, **Then** there is no Review tab, and every review API call returns 403.
2. **Given** a reviewer, **When** they approve a version, **Then** its verified source digest and capabilities are bound to a signed approval and it moves directly to `published`, becoming the listing's current version atomically.
3. **Given** missing signing configuration or invalid source integrity, **When** approval is attempted, **Then** it fails closed and the current listing is unchanged.
4. **Given** a reviewer requesting changes, **When** they submit a message, **Then** the version becomes `changes_requested` and the publisher sees the message.
5. **Given** two reviewers acting on the same version, **When** both submit decisions, **Then** exactly one decision applies and the other gets a conflict.
6. **Given** a live listing, **When** a reviewer suspends it, **Then** it leaves the catalog, existing installs keep working, and installers see a "Removed from the store" notice.
7. **Given** any decision or listing action, **Then** an append-only moderation event records actor, action, target, message and time.

---

### User Story 4 - Discover and install community apps (Priority: P1)

A user opens Gallery and sees a Community section next to Matrix picks. Cards show the publisher, star rating, rating count, downloads and the integrations the app works with. The detail page shows what the app needs (required and optional integrations with their actions, permissions, and the data tables it stores), version, changelog, license and metrics. Installing shows a consent sheet; after consent the app is copied into `~/apps/<slug>` and opens.

**Why this priority**: Publishing has no value without discovery and installation.

**Independent Test**: A published fixture listing installs on a second user's home: source files match the approved digest, the installer builds them locally in isolation, the app opens with sample data, the platform counts one download, and a second install by the same user does not change the count.

**Acceptance Scenarios**:

1. **Given** published listings, **When** a user opens Gallery, **Then** the Community section lists them with publisher, rating, downloads and integrations, with search and category filters.
2. **Given** a listing detail, **When** the user taps Get, **Then** a consent sheet lists every declared integration action, permission and data table before anything is copied.
3. **Given** consent and an available sandbox, **When** the install job builds successfully on the installer VPS and completes, **Then** the app exists in `~/apps/<slug>` (or `<slug>-2` … if the folder is taken), its integration grants are recorded for the declared actions only, and the Gallery shows Open.
4. **Given** a downloaded bundle whose hash differs from the published hash, **When** installing, **Then** the install fails generically and no visible app folder is created.
5. **Given** an installed community app, **When** it runs, **Then** it can use only its own data schema and KV, the integration actions granted at install, and no other gateway endpoint.
6. **Given** a newer approved version, **When** the user views the installed listing, **Then** they see Update; updating verifies and locally builds the new source, keeps their data, and preserves the working old install on failure.
7. **Given** isolation is unavailable or malicious build config attempts host-file/network access, **When** installation runs, **Then** it fails closed, publishes no partial folder and records no successful install metric.
8. **Given** an installation is building, **When** the user reopens Gallery, **Then** a bounded job status endpoint reports queued/building/installed/failed and retry does not start a duplicate build.

---

### User Story 5 - Rate apps and see metrics (Priority: P2)

A user who installed a community app gives it 1–5 stars and can change or remove their rating. Publishers see downloads, active installs, average rating and rating count for each listing in My submissions.

**Why this priority**: Ratings and metrics guide discovery and reward publishers but are not needed for the first install.

**Independent Test**: Two users rate a listing 4 and 2; the listing shows 3.0 from 2 ratings. One user changes to 5; it shows 3.5 from 2. A user who never installed gets 403.

**Acceptance Scenarios**:

1. **Given** an installed listing, **When** the user taps stars, **Then** their rating is saved and the average and count update.
2. **Given** a user who has never installed the listing, **When** they try to rate, **Then** the request is refused and the UI shows Install first.
3. **Given** a publisher, **When** they open My submissions, **Then** each listing shows downloads, active installs, average rating and count.
4. **Given** a publisher, **When** they try to rate their own listing, **Then** the request is refused.

### Edge Cases

- **Source app changes during snapshot**: the snapshot reads through pinned directory handles; a changed or replaced folder fails the draft with "App changed while preparing", and it can be retried.
- **App uses shared default-app code (`../_shared`)**: snapshot refuses imports outside the app folder; the publisher must vendor them.
- **Bundled first-party or installed community apps**: are not offered for publishing (only owner-built apps).
- **Draft abandoned**: drafts expire after 7 days; at most 5 drafts per owner; cleanup removes only the private draft namespace.
- **Publisher deletes their account**: listings are delisted; installs keep working; metrics stop updating.
- **Listing delisted or suspended after install**: installed copy keeps working with a notice; no updates.
- **Install folder conflict**: `<slug>`, then `<slug>-2` … `<slug>-9`; beyond that, a conflict error.
- **Storage schema change in an update**: only additive tables/columns/indexes are accepted at submission; others fail the platform scan.
- **Installer isolation unavailable**: the local job fails with `unavailable`; approval/catalog visibility remain valid. No host execution fallback is allowed. Publisher verification likewise reports unavailable and cannot mark a draft ready.
- **Publisher verification**: uses the same local sandbox as installers, never a direct host `vite` or `pnpm` invocation.
- **Build mismatch**: local output hashes are installer provenance only; local builds can vary by pinned toolchain/platform and are never presented as platform-reviewed bytes.
- **Bundle upload succeeds but finalize fails**: the version stays `awaiting_upload`; retry is idempotent; unfinalized versions and objects are cleaned after 24 hours.
- **Concurrent rating updates**: aggregates update in the same transaction as the rating row using deltas; one rating per user per listing.
- **Repeat install / reinstall**: downloads count unique users; reinstall reactivates the same install record.

## Requirements *(mandatory)*

### Functional Requirements

**Publishing on the publisher's VPS**

- **FR-001**: The gateway MUST list publishable apps: owner apps under `~/apps` with a valid manifest, excluding bundled first-party and community-installed apps.
- **FR-002**: Creating a draft MUST snapshot the app into a private draft namespace (`~/data/app-store`, denied to the owner File API like `data/app-gallery-staging`) through pinned directories, excluding `node_modules`, `dist`, `.git`, `.env*`, build stamps and logs, and enforcing file count and size limits.
- **FR-003**: A deterministic scanner MUST detect secrets, personal details (the owner's name, handle and emails, plus email addresses and phone numbers), owner-specific configuration (absolute home paths, fixed integration account labels, analytics IDs), raw bridge/gateway calls, `localStorage`, dynamic code execution and out-of-folder imports. Findings carry category, severity, file and line; snippets are redacted.
- **FR-004**: After explicit AI-provider consent, a generalization agent MUST work only inside the draft folder (file tools only, every path resolved and confined, no shell, no network, bounded turns and budget). It turns owner constants into first-run settings, replaces fixed account labels with runtime account selection, replaces real records with sample data, removes owner branding, declares integrations and permissions in the manifest, and writes a structured change report and listing draft.
- **FR-005**: After generalization the scanner MUST run again; high-severity findings block submission.
- **FR-006**: The draft MUST pass the store manifest schema and the same OS-isolated local build used by installers before it is `ready`. Missing isolation MUST report `unavailable`; private staging and a scrubbed environment alone are insufficient isolation.
- **FR-007**: The publisher MUST be able to view the change report, per-file differences from the source app, findings, and the listing draft; edit listing fields; and request revisions with instructions.
- **FR-008**: Submission MUST require explicit consent and a license, and MUST package the draft as a deterministic `matrix-app-bundle/1` bundle with a SHA-256.

**Platform intake and review**

- **FR-009**: The platform MUST derive publisher identity from the per-VPS token's handle, never from the request body.
- **FR-010**: The platform MUST issue a size-bounded presigned upload, then on finalize download, verify size and hash, validate the bundle format, re-run the scanner and store-policy checks, and record findings.
- **FR-011**: Listing slugs MUST be globally unique; the first submission claims the slug for that publisher.
- **FR-012**: Versions MUST be semver and strictly increasing per listing.
- **FR-013**: Only allowlisted reviewers MAY read the review queue, version details, bundle files, or record decisions and listing actions.
- **FR-014**: Decisions MUST be compare-and-set on version status and recorded with an append-only moderation event in the same transaction.
- **FR-015**: Approval MUST publish the exact finalized source version directly; the platform MUST NOT execute submitted code, maintain build jobs, accept build callbacks, or store a distributed `dist` artifact.
- **FR-016**: Approval MUST atomically update version/listing status, current pointer, metadata, previous-version supersession and the append-only moderation event. A platform-held Ed25519 key MUST sign the approved source digest and capability/manifest identity; missing keys fail closed.

**Catalog, install and runtime**

- **FR-017**: The catalog MUST list only live listings with a published version, with search, category filter, and sorting by popular, rating or new.
- **FR-018**: Listing details MUST include publisher, version, changelog, license, required and optional integrations with actions, permissions, data tables, downloads, active installs, average rating and rating count.
- **FR-019**: Install MUST require consent to the version's declared capabilities, obtain an authenticated source-only download grant, verify its signature, compressed SHA-256, byte length and per-file hashes, locally build in isolation, and publish the complete staged app with the manifest written last. The platform only records a successful install after local completion.
- **FR-020**: The installer MUST record gateway-owned provenance (listing, version, approved source digest, local output digest, toolchain identity, granted capabilities) outside the app folder, and write integration grants limited to the consented actions.
- **FR-021**: Community apps MUST only reach their own data schema and KV, their granted integration actions, and no other gateway endpoint; enforcement exists in each affected host (Web Desktop, Web Canvas, Web Mobile, Electron Desktop and Native Mobile) and the gateway. Untrusted app frames receive no owner bearer token; server authorization binds the caller to its own app identity.
- **FR-022**: Each installer VPS MUST run fixed local build commands inside OS isolation: registry dependencies fetched by a restricted broker, offline `pnpm install --frozen-lockfile --ignore-scripts`, then offline fixed Vite build. No submitted build/install script or Vite configuration may execute on the owner host. Isolation MUST enforce filesystem/network boundaries, non-root identity, no host sockets, resource limits and teardown. Automatic runtime rebuilds MUST route through the same sandbox or refuse.
- **FR-023**: Users MUST be able to update a community install to the current version, keeping app data.

**Ratings and metrics**

- **FR-024**: A user who has installed a listing MAY set or change one 1–5 star rating and MAY remove it; publishers MAY NOT rate their own listing.
- **FR-025**: Listings MUST maintain downloads (unique installing users), active installs, rating sum and rating count, updated transactionally with the underlying rows.
- **FR-026**: Publishers MUST see their submissions with status, reviewer messages and per-listing metrics.

**Legacy and notifications**

- **FR-027**: The legacy platform `/api/store` routes, which trust body-supplied user IDs, MUST be removed.
- **FR-028**: The publisher MUST receive a notification when a version is approved and published, needs changes, is rejected, or is withdrawn. Local installation failures are shown to the installer, not treated as a failed publication.

### Key Entities

- **Listing**: global slug, publisher, name, tagline, description, category, icon, status (`live`, `delisted`, `suspended`), current version, metrics.
- **Version**: listing, semver, changelog, license, status, manifest summary (integrations, permissions, tables), source bundle key, digest and length; signed approval, scan report, generalization report, reviewer decision.
- **Rating**: listing, user, stars, timestamps; unique per user and listing.
- **Install**: listing, user, installed version, first install, last install, uninstall time; unique per user and listing.
- **Local install job** (installer VPS only): bounded durable status, version/source digest, build result, failure code and timestamps. It is not a platform publication state.
- **Moderation event**: append-only actor, action, target, message, time.
- **Draft** (publisher VPS only): source slug, status, stage, findings, change report, listing draft, created and expiry times.
- **Community install record** (installer VPS only): listing, version, approved source digest, local output digest, toolchain identity, granted capabilities, install folder.

## Security Architecture

### Auth matrix

| Route | Caller | Auth | Notes |
| --- | --- | --- | --- |
| `GET/POST /api/app-store/drafts*`, `GET /api/app-store/publishable-apps` | Gallery app via shell bridge | Owner principal (`MATRIX_USER_ID`/`MATRIX_CLERK_USER_ID`) + Gallery bridge identity | Gateway |
| `GET /api/app-store/listings*`, `POST .../install`, `GET /api/app-store/installs/:jobId`, `POST .../rating`, `GET /api/app-store/submissions*`, `POST /api/app-store/submissions/:id/withdraw` | Gallery app | Owner principal + Gallery identity | Gateway proxies to platform with per-VPS token |
| `GET/POST /api/app-store/review/*` | Gallery Review tab | Owner principal + Gallery identity; platform enforces reviewer allowlist | Gateway proxies |
| `/internal/containers/:handle/app-store/*` | Gateway | `Bearer HMAC(handle, PLATFORM_SECRET)`, timing-safe | Publisher/installer/reviewer = handle's Clerk user |
| `/internal/containers/:handle/app-store/review/*` | Gateway | As above + Clerk ID in `MATRIX_APP_STORE_REVIEWER_CLERK_IDS` | 403 otherwise |
| Presigned R2 PUT/GET | Gateway | Signed URL, 15 min, declared size verified at finalize/download | Keys are server-generated; grants require per-VPS auth |

No unauthenticated store routes exist in this version.

### Input validation

- All bodies, params and query strings are Zod-validated at the route boundary with `bodyLimit` on every mutating route (including DELETE).
- Slugs `^[a-z][a-z0-9-]{2,47}$`; semver strict; IDs are UUIDs; cursors are opaque bounded strings; search ≤ 80 chars.
- Bundle paths are relative POSIX, ≤ 240 chars, ≤ 12 segments, no `.`/`..`/empty segments, no backslashes or control characters; file and total limits enforced while decoding.
- Review decisions and listing actions use discriminated unions keyed by `type`.
- Generalization report and listing drafts written by the agent are parsed with strict, bounded schemas; anything else fails the draft.

### Error policy

Clients receive generic messages and stable codes (`not_found`, `conflict`, `forbidden`, `invalid`, `unavailable`, `limit`). Scanner findings never include matched secret text. Postgres, R2, build and agent errors are logged server-side only.

### Credentials

`PLATFORM_SECRET` (HMAC), R2 credentials, reviewer allowlist and the approval signing private key live in platform env only. Trusted gateway orchestration holds transfer credentials; none enter a submitted-code sandbox. The authenticated platform status response provides a bounded public verification-key ring. App bundles cannot supply trusted keys. The generalization agent uses the owner-selected provider credential only for its SDK launch, with file confinement and no Matrix platform secrets.

### Threats considered

- **Malicious submission**: never executed on the platform; built on each installer VPS inside verified OS isolation with no host credentials/home/network; runtime limited by bridge policy; reviewed by staff. A fixed command alone does not sandbox executable Vite config or dependency code.
- **Prompt injection against AI steps**: the generalization agent is confined to the draft folder and its output is re-scanned; any AI review notes are advisory and cannot change status.
- **Forged identity**: publisher, installer, rater and reviewer identities come from the per-VPS token's handle, never request bodies.
- **Tampered bundles**: exact compressed length/digest and per-file hashes are verified at finalize and install, and the platform signature binds the source digest, version, manifest and consent digest. Local output digests record what that VPS built, not cross-host reproducibility.
- **Rating manipulation**: one rating per user, install required, self-rating refused, per-handle rate limits.

## Integration Wiring

- **Platform startup**: construct repository, bundles object store, reviewer allowlist and signing service; mount per-VPS store and review routes before admin middleware. Run the separate `app-store` migration scope; own and stop the abandoned-upload sweeper. No platform worker or build routes exist.
- **Gateway startup**: construct the authenticated platform client, restricted registry broker and OS-isolated local build service; inject the same service into publisher verification and community install/update. Register draft, catalog, local install-job and review routes. Own and drain local jobs, sweeper and notification poller on shutdown.
- **Kernel**: confined SDK file agent with explicit provider consent, strict tool/path policy and bounded cost. `publish_app` resolves its injected draft service at registration time.
- **Hosts**: import shared store policy into Web and Electron bridges; inspect Native Mobile's distinct broker (`apps/mobile/lib/app-capability-bridge.ts`) and implement its Gallery route support/community restrictions explicitly. No surface inherits qualification from another.
- **Isolation runtime**: use the supported VPS OS sandbox adapter with dedicated UID, mount/user/PID/network namespaces and read-only toolchain; only staging and a verified dependency cache are mounted. Private staging or `spawn({env:{}})` is not an isolation adapter. Unsupported hosts report unavailable.

## Failure Modes

| Component | Timeouts | Concurrency | Crash recovery |
| --- | --- | --- | --- |
| Draft pipeline | Snapshot 30s, scan 30s, agent 10 min, build check 3 min | One active pipeline per draft; max 2 concurrent per owner; at most 5 drafts | `draft.json` written atomically (tmp+rename); on restart, in-flight drafts become `failed` (`interrupted`) and can be retried |
| Platform client | 10s APIs, 60s uploads/downloads | — | Upload/finalize idempotent per draft submission key |
| Finalize | 60s download+scan | CAS `awaiting_upload → scanning` | Sweeper deletes unfinalized versions/objects after 24h |
| Review decisions | — | CAS on status in the `UPDATE` | Transaction writes status + moderation event |
| Local build | Dependency acquisition 5 min; offline install/build 10 min; bounded CPU/memory/PIDs/disk | One build per owner; bounded 16 local jobs, max 2 queued | Kill whole sandbox on timeout/shutdown; interrupted jobs fail recoverably, staging removed; no host fallback |
| Community install | 60s per bundle download | Shares the owner file-mutation coordinator with the Gallery installer | Private staging; manifest last; provenance/grants published under the owner mutation lock; crash reconciliation completes or rolls back publication before exposing Open; old install preserved until successful replacement |
| Ratings/installs | — | Upsert + delta aggregate in one transaction | — |

## Resource Management

- Bundle limits: 512 files, 8 MB per file, 24 MB uncompressed, 16 MB compressed.
- Draft namespace: 5 drafts, 7-day TTL, hourly symlink-safe sweep; diffs capped at 256 KB per file view.
- Gateway in-memory: draft job registry capped at 16 with LRU of finished entries; poller tracks at most 50 submissions.
- Platform: per-handle rate limits (drafts/submissions 10/hour, ratings 60/hour, installs 60/hour) using bounded limiters; review file viewer capped at 512 KB per file.
- Dependency broker: registry-only HTTPS, exact lockfile package URLs and integrity; reject git/file/workspace/remote tarball dependencies, redirects and private/internal addresses. Cache is bounded (2 GiB, 7-day TTL); the build receives a read-only verified snapshot, no shared writable package manager store.
- Third-party data: generalization sends scrubbed draft files to the owner-selected AI provider only after provider-specific consent. This is distinct from final Matrix submission consent.

## Affected Surfaces

| Surface | Change |
| --- | --- |
| Web Desktop, Web Canvas | Gallery (Community, Publish, My submissions, Review tab for reviewers) |
| Electron Desktop | Same apps via the native app bridge allowlist |
| Web Mobile | Same apps via the mobile web app viewer |
| Native Mobile | Installed app runtime exists in `app/app-preview/[app].tsx` and `components/AppRuntimeFrame.tsx`; its separate capability broker needs explicit Gallery support and runtime enforcement. Capture on a supported dev-client/device. N/A requires a precise architectural rationale and recorded reviewer approval; the historical “no app runtime” claim is invalid. |

Every affected surface requires live screenshots and a recording of Publish → Review → Community → install/rating, with exact commit/build, account/fixture limitations and failure states. Attach captures to each relevant PR and Slack `#tech` with ENG-322 and stack links; link the Slack permalink back to the PR. Missing runtime access blocks review readiness. Web testing uses only the Codex in-app browser.

A separate public documentation PR in private `FinnaAI/matrix-os-site` under `content/docs/` is a required deliverable. Local developer docs do not replace it. Recommend product/security/integration-owner review; existing requester approval permits implementation.

## Success Criteria *(mandatory)*

- **SC-001**: A publisher goes from choosing an app to a submitted version in under 10 minutes for a typical app (< 2 MB source).
- **SC-002**: In the fixture suite, 100% of planted secrets and owner emails are absent from submitted bundles.
- **SC-003**: Reviewer decisions take effect in one action; approved source versions appear in the catalog immediately after the approval transaction.
- **SC-004**: A community install completes in within 10 minutes for a typical 5 MB source bundle on a supported VPS; Gallery reports local build progress.
- **SC-005**: Downloads and ratings shown on listings exactly match the underlying rows (verified by repository tests under concurrent writes).
- **SC-006**: A community app cannot reach any gateway endpoint outside its policy (verified separately by Web, Electron, Native Mobile and gateway tests plus live evidence).

## Assumptions

- Platform Postgres, the bundles R2 bucket and per-VPS tokens exist (they do on `main`).
- Supported installer VPSes provide the verified OS sandbox adapter and registry broker. Provisioning this prerequisite is part of rollout, and must not be silently replaced with host process execution.
- Publishers own the rights to what they publish; the license choice and consent text state this.
- Orgs, text reviews, upvotes, paid apps, public `/store` web pages, update rollback and AI-generated screenshots are out of scope.
