# Feature Specification: App Gallery

**Feature Branch**: `058-app-gallery`  
**Created**: 2026-04-05  
**Status**: Draft (v2)  
**Input**: User description: "Add app gallery (app store) to Matrix OS so users can share what they built with other users. Covers orgs and sharing, security audit, reviews/stars, app updates, and private/group sharing."
**Depends on**: `049-hybrid-integrations` (platform Postgres migration, integration manifest, users table)

## Scope

This spec covers the **app marketplace** and **app lifecycle** for Matrix OS:

- Gallery browsing, search, and discovery
- Publishing with automated security audit
- Installation with explicit install targets (personal, org, shared instance)
- App versioning, updates, and rollback
- Reviews and ratings
- Organization-scoped distribution
- App URL model for deep linking and shareability
- Integration with 049's platform Postgres and integration manifests

**Out of scope** (follow-on specs):

- **Credits and virtual economy** -- deferred to a dedicated spec. All apps are free in this version. The gallery supports a `price` field on listings for forward compatibility, but no credit system is implemented.
- **Shared org instances** -- deferred until org foundations land. The entity model and URL scheme are defined here for forward compatibility, but implementation is a follow-on.

## Cross-Spec Dependencies

### 049 - Platform Integrations (hard ownership boundary)

049 and 058 will be implemented in parallel. To prevent overlapping work, each spec has exclusive table ownership.

**049 owns (platform foundation)**:

- Platform Postgres migration (from current SQLite)
- DB connection, Kysely query builder, migration tooling
- `users` table (id, clerk_id, handle, display_name, email, container_id, plan, status)
- `connected_services` table
- `billing` table
- Service registry (available integrations, their actions/scopes)
- Integration manifest shape (`integrations.required`, `integrations.optional`)

**058 owns (gallery/marketplace domain)**:

- `app_listings` -- marketplace metadata, discovery, publishing
- `app_versions` -- versioned releases, changelogs, audit status
- `app_installations` -- who installed what, at which version, data location
- `app_reviews` -- ratings, text reviews, author responses
- `security_audits` -- per-version audit results and findings
- `organizations` -- named groups with roles (058 owns for now; may move to a platform spec later)
- `org_memberships` -- user-to-org relationships

**049's `apps` table should be renamed to `user_apps`** to avoid confusion. That table tracks local workspace apps (what a user has authored). It is NOT the gallery listing. 058's `app_listings` is the gallery record. A `user_app` may or may not have a corresponding `app_listing` (only if published).

**Foreign key contracts** (for parallel implementation):

- `app_listings.author_id` -> `049.users.id`
- `app_reviews.reviewer_id` -> `049.users.id`
- `app_installations.user_id` -> `049.users.id`
- `app_installations.org_id` -> `058.organizations.id` (nullable)
- `org_memberships.user_id` -> `049.users.id`

**058 reads from 049** (read-only dependencies):

- `users` table for author/reviewer identity
- Service registry for integration validation at publish/install time

**058 does NOT depend on**:

- 049 OAuth connect flows being complete (gallery can ship without working integrations)
- 049 billing being implemented
- 049 event subscriptions / webhook ingestion

**058 minimum unblocker from 049**:

- Postgres connection + migration tooling operational
- `users` table populated (Clerk auth -> user record)
- Service registry readable (even if no OAuth flows work yet)

Once those three are in place, 058 can proceed independently.

### Extension Model Taxonomy

This spec uses the following definitions consistently:

- **App**: User-facing software package with UI, runtime, storage schema, permissions, optional integrations. This is what the gallery lists.
- **Integration**: OAuth-backed connector exposing actions, triggers, and scopes. Owned by 049.
- **Plugin**: Privileged system extension for channels/system hooks. Rare, reviewed, not the default app model.
- **Skill**: Agent behavior/prompt/workflow. No direct runtime privileges by default.

The gallery exclusively deals with **Apps**. Plugins and Skills may get their own distribution mechanisms in future specs.

## App URL Model

Every app concept has a canonical URL. These are product-level routes, not implementation details.

- **Personal app**: `/a/{slug}` -- user's installed app, their own data
- **Store listing**: `/store/{author}/{slug}` -- gallery detail page (public)
- **Public run**: `/run/{author}/{slug}` -- try an app without installing (read-only demo, where supported by the app)
- **Org app**: `/o/{orgSlug}/a/{slug}` -- org member accessing an org-scoped app
- **Org shared instance**: `/o/{orgSlug}/a/{slug}/shared` -- shared data instance (future, defined for forward compatibility)

Requirements for all app URLs:

- Deep-linkable and shareable (copy-paste into chat, email, etc.)
- Appear in browser history and support back/forward navigation
- Open as desktop tabs in the shell
- Store listing URLs are publicly accessible (SEO-friendly)
- Personal and org app URLs require authentication

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse and Install Public Apps (Priority: P1)

A user opens the App Gallery and browses available apps by category (productivity, games, utilities, social, etc.). They can search by name or tags, filter by rating or popularity, and view app details including screenshots, description, reviews, and install count. When they find an app they like, they choose an install target and the app appears in their desktop ready to use.

**Why this priority**: The gallery is useless without browsing and installing. This is the core value proposition -- discovery and one-click install.

**Independent Test**: A user with no apps installed can open the gallery, find a published app, install it, and launch it from their desktop.

**Acceptance Scenarios**:

1. **Given** a user with an empty desktop, **When** they open the App Gallery, **Then** they see a curated list of public apps organized by category with search and filters.
2. **Given** a user viewing an app detail page at `/store/{author}/{slug}`, **When** they click "Install", **Then** they choose an install target (personal or org) and the app is provisioned accordingly.
3. **Given** a user searching for "calculator", **When** results load, **Then** they see matching apps ranked by relevance, with name, icon, rating, install count, and short description visible.
4. **Given** a user who already installed an app, **When** they visit that app's gallery page, **Then** they see "Installed" instead of "Install" and can choose to uninstall or open at `/a/{slug}`.
5. **Given** an app that requires integrations (e.g., Gmail), **When** a user installs it, **Then** they are prompted to connect any missing required services before the app activates.

---

### User Story 2 - Publish an App to the Gallery (Priority: P1)

A developer builds an app in their workspace and decides to share it. They submit it for publishing, providing a description, category, tags, and screenshots. The app enters a review queue where it undergoes a multi-layer security audit. Once approved, it appears in the public gallery with a store listing URL. If the audit fails, the developer receives specific feedback on what to fix.

**Why this priority**: Without publishing, there's nothing in the gallery. Publishing and browsing are co-dependent for the marketplace to function.

**Independent Test**: A user with a working app can submit it for review, receive audit results, and upon approval see it appear in the public gallery.

**Acceptance Scenarios**:

1. **Given** a user with a completed app, **When** they choose "Publish to Gallery", **Then** they see a form to add description, category, tags, screenshots, and declared permissions.
2. **Given** a submitted app, **When** the security audit runs, **Then** it performs manifest permission validation, static code analysis, and sandbox policy verification -- returning pass/fail with specific findings.
3. **Given** an app that passes the audit, **When** the review is complete, **Then** the app appears in the public gallery and is accessible at `/store/{author}/{slug}`.
4. **Given** an app that fails the audit, **When** the developer views their submission, **Then** they see specific failure reasons categorized by audit layer and can fix and resubmit.
5. **Given** an app declaring `integrations.required: ["gmail.read"]`, **When** it is published, **Then** the gallery listing shows required integrations and the install flow validates them.

---

### User Story 3 - Rate and Review Apps (Priority: P2)

After using an installed app, a user can leave a star rating (1-5) and an optional text review. Other users see these reviews on the app's gallery page, sorted by most recent. The app author can respond to reviews. Aggregate ratings are displayed on listing cards.

**Why this priority**: Reviews build trust and help users make decisions. Critical for a healthy marketplace but not blocking for initial launch.

**Independent Test**: A user who installed an app can leave a rating/review, and another user browsing the gallery can see that review on the app page.

**Acceptance Scenarios**:

1. **Given** a user who has installed and used an app, **When** they visit the app's gallery page, **Then** they can submit a 1-5 star rating and optional text review.
2. **Given** an app with multiple reviews, **When** a user views the app detail page, **Then** they see the average rating, total review count, and individual reviews sorted by most recent.
3. **Given** a review on their app, **When** the app author views it, **Then** they can post a public response.
4. **Given** a user who hasn't installed the app, **When** they try to leave a review, **Then** the system prevents it and prompts them to install first.

---

### User Story 4 - Share Apps with a Team or Organization (Priority: P2)

A user creates an organization (e.g., their company) and invites members. They can publish apps visible only to that organization. Organization members see these private apps in a dedicated "My Org" section of the gallery. The org admin controls who can publish and who can install.

**Why this priority**: Enterprise and team use is a key differentiator. Private sharing enables business use cases beyond the public gallery.

**Independent Test**: An org admin can create an org, invite a member, publish a private app, and the member can see and install it while non-members cannot.

**Acceptance Scenarios**:

1. **Given** a user, **When** they create an organization and invite members by email or handle, **Then** invited users receive a notification and can accept to join.
2. **Given** an org member with publish permission, **When** they publish an app with visibility set to "organization", **Then** only org members see it in the gallery.
3. **Given** a non-member, **When** they search or browse the gallery, **Then** org-private apps do not appear in their results.
4. **Given** an org admin, **When** they view org settings, **Then** they can manage members (invite, remove, set roles: admin, publisher, member).
5. **Given** an org member, **When** they access an org-private app, **Then** it loads at `/o/{orgSlug}/a/{slug}` with the org's data scope.

---

### User Story 5 - App Updates and Versioning (Priority: P2)

A developer pushes an update to their published app. Users who installed the app see an "Update available" indicator. They can view a changelog and choose to update. The system preserves user data across updates. If an update causes problems, users can roll back.

**Why this priority**: Apps evolve. Without updates, the gallery becomes stale and developers lose motivation to maintain apps.

**Independent Test**: A developer publishes v1.1 of an app; a user who installed v1.0 sees the update notification, reads the changelog, updates, and retains their data.

**Acceptance Scenarios**:

1. **Given** a developer with a published app, **When** they submit an update with a new version number and changelog, **Then** the update goes through the same security audit as initial publication.
2. **Given** a user with an installed app, **When** a new version is available, **Then** they see an update badge on the app icon and in the gallery.
3. **Given** a user choosing to update, **When** the update installs, **Then** their existing app data (database rows, files) is preserved.
4. **Given** an update that fails the security audit, **When** the developer checks status, **Then** they see the failure reason and the existing published version remains available.
5. **Given** a user who updated and encounters issues, **When** they choose "Roll back", **Then** the previous version is restored along with the data snapshot taken before the update.

---

### Edge Cases

- What happens when a published app's author deletes their account? The app remains in the gallery marked as "unmaintained" with no further updates possible.
- What happens when an org is dissolved? Members are notified, org-private apps become inaccessible. Data is frozen for 30 days then deleted.
- What happens when a user installs an app and the developer later removes it from the gallery? The installed copy continues to work but receives no updates. The installation record persists.
- What happens when an app update breaks user data? The system keeps a pre-update data snapshot; users can roll back to the prior version and its data.
- What happens when two orgs want different configurations of the same app? Each org gets its own installation with independent data scope.
- What happens when a review contains abusive content? Reviews are subject to content moderation; users can flag reviews, and flagged reviews are hidden pending review.
- What happens when a developer tries to publish an app with the same name as an existing one? Slugs must be globally unique; the system suggests alternatives if the desired slug is taken.
- What happens when a required integration is not available? The app installs but shows a "Setup required" state. The user must connect the required service before the app activates.

## Requirements *(mandatory)*

### Functional Requirements

**Gallery & Discovery**

- **FR-001**: System MUST provide a browsable gallery of published apps organized by categories.
- **FR-002**: System MUST support full-text search across app names, descriptions, and tags.
- **FR-003**: System MUST allow filtering by category, rating range, price (free/paid), and sort by popularity, rating, or recency.
- **FR-004**: System MUST display app listing cards showing icon, name, short description, author, rating, install count, and price.
- **FR-005**: System MUST provide a detail page per app at `/store/{author}/{slug}` showing full description, screenshots, reviews, version history, required integrations, and install button.

**Publishing & Audit**

- **FR-006**: System MUST allow app authors to submit their apps for publication with metadata (description, category, tags, screenshots, declared permissions, required integrations).
- **FR-007**: System MUST run a multi-layer security audit on every submission and update:
  - **Layer 1 - Manifest audit**: validate declared permissions match app category and runtime, flag excessive permission requests
  - **Layer 2 - Static analysis**: scan app files for filesystem escape attempts, unauthorized network access, credential harvesting patterns, known vulnerability patterns
  - **Layer 3 - Sandbox policy**: verify the app's declared permissions can be enforced by the container sandbox at runtime
- **FR-008**: System MUST return specific, actionable failure reasons categorized by audit layer when a submission is rejected.
- **FR-009**: System MUST support app visibility levels: public (everyone), organization (org members only), and unlisted (anyone with a direct link).
- **FR-010**: System MUST enforce globally unique slugs for published apps.
- **FR-011**: System MUST validate declared integration requirements against the 049 service registry at publish time.

**Installation & Lifecycle**

- **FR-012**: System MUST support explicit install targets: "install to me" (personal) or "install to org" (org-scoped).
- **FR-013**: System MUST create an Installation record tracking: user/org, listing, installed version, install date, data location.
- **FR-014**: System MUST prompt users to connect required integrations (per 049) when installing an app that declares them.
- **FR-015**: System MUST notify users when updates are available for their installed apps.
- **FR-016**: System MUST preserve user data when updating an installed app to a new version, creating a pre-update data snapshot.
- **FR-017**: System MUST allow users to roll back to the previous version and restore the pre-update data snapshot.
- **FR-018**: System MUST allow users to uninstall apps, removing the app files but offering to preserve or delete user data.
- **FR-019**: System MUST support semantic versioning for published apps (major.minor.patch).

**App URLs & Navigation**

- **FR-020**: System MUST serve personal installed apps at `/a/{slug}`.
- **FR-021**: System MUST serve store listing pages at `/store/{author}/{slug}` (publicly accessible).
- **FR-022**: System MUST serve org-scoped apps at `/o/{orgSlug}/a/{slug}`.
- **FR-023**: All app URLs MUST be deep-linkable, appear in browser history, support back/forward navigation, and open as desktop tabs.
- **FR-024**: Store listing URLs MUST be publicly accessible for discoverability and sharing.

**Reviews & Ratings**

- **FR-025**: System MUST allow users who have installed an app to submit a 1-5 star rating and optional text review.
- **FR-026**: System MUST prevent users from reviewing apps they have not installed.
- **FR-027**: System MUST allow app authors to post one public response per review.
- **FR-028**: System MUST allow users to flag reviews for moderation.
- **FR-029**: System MUST calculate and display aggregate ratings (average stars, total count) on listing cards.

**Organizations & Sharing**

- **FR-030**: System MUST allow users to create organizations with a name and optional description.
- **FR-031**: System MUST support org member roles: owner, admin, publisher, member.
- **FR-032**: System MUST allow org admins to invite users by handle or email.
- **FR-033**: System MUST scope org-private apps so they are invisible and inaccessible to non-members.

**Security & Moderation**

- **FR-034**: System MUST prevent published apps from accessing other users' data or filesystem outside their sandbox.
- **FR-035**: System MUST support reporting/flagging of apps for policy violations.
- **FR-036**: System MUST preserve installed app functionality if the developer removes the app from the gallery (installation record and local files persist, no further updates).
- **FR-037**: System MUST enforce installation-time permission grants: users explicitly approve the permissions an app declares before installation completes.
- **FR-038**: System MUST support app delisting (removing from gallery while preserving existing installations) as distinct from deletion.

**Forward Compatibility (defined but not implemented in this spec)**

- **FR-039**: Listings MUST support a `price` field (credits) for future monetization. Default: 0 (free).
- **FR-040**: The URL scheme `/o/{orgSlug}/a/{slug}/shared` is reserved for shared org instances in a follow-on spec.

### Key Entities

- **Listing** (`app_listings`): A published app in the gallery. Has metadata (name, slug, description, category, tags, screenshots, price), author (`-> users.id`), visibility level, current version pointer, and aggregate stats (installs, average rating, ratings count). Globally unique slug. The gallery's unit of discovery. Distinct from 049's `user_apps` (local workspace record).

- **Version** (`app_versions`): A specific release of a listing. Has a version number (semver), changelog, audit status (pending/passed/failed), audit findings, and the app bundle reference. Multiple versions per listing; one is marked "current." Previous versions are retained for rollback.

- **Installation** (`app_installations`): The record that a user or org has a specific listing installed. Has: owner (`user_id -> users.id`, nullable `org_id -> organizations.id`), listing reference, installed version, install date, data location reference, and status (active/setup-required/suspended). This is the entity that FR-013 through FR-018 operate on. Distinct from listing (marketplace metadata) and version (code/package).

- **Instance** *(future, no table yet)*: A running data scope for a shared org installation. All org members access the same instance. Defined for forward compatibility; implementation deferred.

- **Review** (`app_reviews`): A user's assessment of a listing. Has star rating (1-5), optional text body, reviewer (`-> users.id`), timestamp. One review per user per listing. Listing author can respond once per review.

- **Organization** (`organizations`): A named group of users. Has a name, slug, description, owner (`-> users.id`), and member list with roles. Can have org-private listings. Owned by 058 for now; may migrate to a platform spec.

- **Org Membership** (`org_memberships`): The relationship between a user and an org. Has user (`-> users.id`), org, role (owner, admin, publisher, member), and join date.

- **Security Audit** (`security_audits`): The multi-layer review of a version submission. Has status (pending, passed, failed), per-layer findings, and timestamp.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can discover and install a public app from the gallery in under 60 seconds (from opening gallery to app appearing on desktop).
- **SC-002**: App publishing submission (filling form + submitting) takes under 3 minutes for a prepared developer.
- **SC-003**: Automated security audit completes within 30 seconds of submission.
- **SC-004**: At least 80% of published apps maintain a 3+ star average rating (indicator of quality bar via audits).
- **SC-005**: Organization members can access org-private apps within seconds of joining the org (no manual provisioning delay).
- **SC-006**: App updates preserve 100% of user data -- zero data loss across version transitions.
- **SC-007**: Gallery search returns relevant results for queries matching app names or tags within 1 second.
- **SC-008**: Gallery supports browsing 1000+ published apps without performance degradation.
- **SC-009**: All app URLs are directly shareable and load the correct content when opened in a new browser session.
- **SC-010**: Installation-time permission grants show users exactly what an app can access before they approve.

## Assumptions

- **Platform Postgres is a prerequisite.** 049 owns the migration from SQLite to Postgres for the platform database. 058 creates its own tables (`app_listings`, `app_versions`, `app_installations`, `app_reviews`, `security_audits`, `organizations`, `org_memberships`) on that Postgres instance. The gallery MUST NOT be built on the existing SQLite platform DB.
- **058 does NOT extend 049's tables.** 058 creates independent tables that reference `049.users.id` via foreign keys. 049's `apps` table (renamed to `user_apps`) tracks local workspace apps; 058's `app_listings` tracks published gallery entries. These are separate concerns.
- **058 owns organizations for now.** Orgs are a gallery-scoped concept in this version (for distribution control). If orgs become a platform-wide concern later, they can be migrated to a platform spec.
- Clerk authentication is the identity provider; the 049 `users` table is the canonical user record.
- The security audit is automated (manifest + static + sandbox verification), not a manual human review process.
- Apps run in sandboxed containers with declared permissions; the audit verifies permission declarations are enforceable.
- Apps declare integration requirements in their manifest; the gallery validates these against 049's service registry (read-only).
- Credits/monetization is deferred. The `price` field exists on listings for forward compatibility but is always 0 in this version.
- Shared org instances are deferred. The URL scheme and entity model are defined but not implemented.
- Organizations are lightweight (no billing, no seats limit for this version); future specs may add enterprise tiers.
