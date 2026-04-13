# Tasks: App Gallery

**Input**: Design documents from `/specs/058-app-gallery/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included per constitution (TDD is NON-NEGOTIABLE). Write tests FIRST, ensure they FAIL before implementation.

**Organization**: Tasks grouped by user story. US1 and US2 are both P1 and co-dependent (gallery needs published apps; publishing needs a gallery). Foundational phase includes all shared tables so both can proceed.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (US1-US5)

---

## Phase 1: Setup

**Purpose**: Dependencies, configuration, skeleton modules

- [ ] T001 Add Kysely and pg dependencies to packages/platform/package.json (if not already present from 049)
- [ ] T002 [P] Create gallery module directory structure at packages/platform/src/gallery/ with index.ts barrel export
- [ ] T003 [P] Create test directory structure: tests/platform/gallery/ and tests/gateway/gallery/ and tests/shell/gallery/ and tests/e2e/

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database tables, manifest extensions, and core query layer that ALL user stories depend on

**Depends on**: 049 platform Postgres connection + `users` table being available

### Tests

- [ ] T004 [P] Write migration test: verify all 7 gallery tables are created with correct columns, indexes, and FK constraints in tests/platform/gallery/migrations.test.ts
- [ ] T005 [P] Write manifest v2 test: verify new fields (integrations, distribution, permissions) parse and validate correctly in tests/gateway/gallery/app-manifest-v2.test.ts

### Implementation

- [ ] T006 Create Kysely migration for `app_listings` table with tsvector search_vector column, GIN index, and trigger per data-model.md in packages/platform/src/gallery/migrations.ts
- [ ] T007 Create Kysely migration for `app_versions` table with UNIQUE(listing_id, version) per data-model.md in packages/platform/src/gallery/migrations.ts
- [ ] T008 Create Kysely migration for `app_installations` table with UNIQUE(listing_id, user_id, org_id) per data-model.md in packages/platform/src/gallery/migrations.ts
- [ ] T009 [P] Create Kysely migration for `app_reviews` table with UNIQUE(listing_id, reviewer_id) per data-model.md in packages/platform/src/gallery/migrations.ts
- [ ] T010 [P] Create Kysely migration for `security_audits` table per data-model.md in packages/platform/src/gallery/migrations.ts
- [ ] T011 [P] Create Kysely migration for `organizations` and `org_memberships` tables per data-model.md in packages/platform/src/gallery/migrations.ts
- [ ] T012 Extend AppManifest Zod schema with `integrations` (required/optional arrays), `distribution` (visibility, org_id, published_at, listing_id), and formalized `permissions` in packages/gateway/src/app-manifest.ts
- [ ] T013 Export Kysely table type interfaces for all 7 gallery tables from packages/platform/src/gallery/types.ts
- [ ] T014 Run gallery migrations on platform startup in packages/platform/src/main.ts (call migration function after DB connection)

**Checkpoint**: All 7 tables created. Manifest v2 fields validated. No user-facing features yet, but the data layer is ready.

---

## Phase 3: User Story 1 - Browse and Install Public Apps (Priority: P1) -- MVP

**Goal**: Users can open the gallery, browse/search apps, view detail pages, and install apps to their desktop.

**Independent Test**: Seed a listing via DB insert. Open gallery, find it, install it, see it on desktop.

**Depends on**: Phase 2 (tables + manifest). For testing, listings are seeded programmatically (US2 publish flow not required).

### Tests

- [ ] T015 [P] [US1] Write tests for listing query functions (list, search, getBySlug, categories) in tests/platform/gallery/listings.test.ts
- [ ] T016 [P] [US1] Write tests for installation CRUD (create, get, list, delete, increment counter) in tests/platform/gallery/installations.test.ts
- [ ] T017 [P] [US1] Write contract tests for store-api endpoints (GET /api/store/apps, /search, /:author/:slug, /categories) in tests/platform/gallery/store-api.test.ts
- [ ] T018 [P] [US1] Write contract tests for install endpoint (POST /api/apps/install) in tests/gateway/gallery/install-api.test.ts
- [ ] T019 [P] [US1] Write shell component tests for gallery browse and install flow in tests/shell/gallery/store-browse.test.tsx

### Implementation

- [ ] T020 [P] [US1] Implement listing query functions (listPublic, search with tsvector, getByAuthorSlug, listCategories) in packages/platform/src/gallery/listings.ts
- [ ] T021 [P] [US1] Implement installation CRUD (create, getByUserAndListing, listByUser, delete, incrementInstallCount) in packages/platform/src/gallery/installations.ts
- [ ] T022 [US1] Rewrite store API endpoints for Postgres/Kysely: GET /api/store/apps (paginated, filtered), GET /api/store/apps/search (tsvector), GET /api/store/apps/:author/:slug (detail), GET /api/store/categories in packages/platform/src/store-api.ts
- [ ] T023 [US1] Add install API route: POST /api/apps/install -- validate listing, check not already installed, copy files (app-fork.ts installApp), create installation record, provision app DB, return status in packages/gateway/src/server.ts
- [ ] T024 [US1] Modify app-fork.ts installApp to also write `installed_from.listing_id` and `installed_from.version_id` to manifest metadata in packages/gateway/src/app-fork.ts
- [ ] T025 [US1] Add uninstall API route: DELETE /api/apps/:slug/uninstall -- remove files, optionally drop app DB schema, delete installation record, decrement counter in packages/gateway/src/server.ts
- [ ] T026 [US1] Add GET /api/store/installations endpoint (list user's installations with update status) in packages/platform/src/store-api.ts
- [ ] T027 [US1] Create store listing detail page at shell/src/app/store/[author]/[slug]/page.tsx -- SSR, fetch from /api/store/apps/:author/:slug, show description, screenshots, permissions, install button
- [ ] T028 [US1] Create personal app page at shell/src/app/a/[slug]/page.tsx -- authenticated, load installed app, render in iframe or embed
- [ ] T029 [US1] Rewrite shell/src/stores/app-store.ts to fetch listings from /api/store/apps instead of hardcoded catalog. Keep local catalog as fallback for bundled apps only.
- [ ] T030 [US1] Update shell/src/components/app-store/AppStore.tsx to use API-driven store. Link app cards to /store/{author}/{slug} for detail. Show installed status from /api/store/installations.
- [ ] T031 [US1] Create InstallDialog component at shell/src/components/app-store/InstallDialog.tsx -- install target picker (personal/org), permission summary, required integrations list, confirm button
- [ ] T032 [US1] Update shell/src/components/app-store/AppDetail.tsx to show install target options, permissions, and required integrations from manifest

**Checkpoint**: Gallery browse + search + install works end-to-end. Listings are seeded via DB or via US2 publish flow.

---

## Phase 4: User Story 2 - Publish an App to the Gallery (Priority: P1) -- MVP

**Goal**: Developers can submit their apps for publication, pass a security audit, and see them appear in the gallery.

**Independent Test**: Build an app, publish it, audit passes, verify it appears in gallery search results.

**Depends on**: Phase 2 (tables + manifest). Independent of US1 for testing (publish creates the listing record).

### Tests

- [ ] T033 [P] [US2] Write tests for version CRUD (createVersion, getCurrentVersion, listVersions) in tests/platform/gallery/versions.test.ts
- [ ] T034 [P] [US2] Write tests for security audit engine (all 3 layers: manifest, static, sandbox) in tests/platform/gallery/security-audit.test.ts
- [ ] T035 [P] [US2] Write contract tests for publish endpoint (POST /api/apps/:slug/publish) in tests/gateway/gallery/publish-api.test.ts
- [ ] T036 [P] [US2] Write shell component tests for publish dialog in tests/shell/gallery/publish-dialog.test.tsx

### Implementation

- [ ] T037 [P] [US2] Implement version management functions (create, getCurrent, list, setCurrent) in packages/platform/src/gallery/versions.ts
- [ ] T038 [P] [US2] Implement listing creation/update functions (createListing, updateListing, createOrUpdateFromPublish) in packages/platform/src/gallery/listings.ts (extend file from T020)
- [ ] T039 [US2] Implement security audit engine Layer 1 (manifest audit: validate permissions against allowed set, check integration requirements against service registry) in packages/platform/src/gallery/security-audit.ts
- [ ] T040 [US2] Implement security audit engine Layer 2 (static code scan: configurable pattern rules for path traversal, credential access, sandbox escape, dynamic code execution) in packages/platform/src/gallery/security-audit.ts
- [ ] T041 [US2] Implement security audit engine Layer 3 (sandbox policy: map declared permissions to container capabilities, verify coverage) in packages/platform/src/gallery/security-audit.ts
- [ ] T042 [US2] Implement audit orchestrator (run all 3 layers, aggregate findings, write security_audits record, update version audit_status) in packages/platform/src/gallery/security-audit.ts
- [ ] T043 [US2] Add publish API route: POST /api/apps/:slug/publish -- validate manifest (app-publish.ts), create/update listing, create version, run audit, set current version if passed in packages/gateway/src/server.ts
- [ ] T044 [US2] Modify app-publish.ts preparePublishPayload to include new manifest v2 fields (integrations, permissions, visibility) and validate them in packages/gateway/src/app-publish.ts
- [ ] T045 [US2] Add resubmit API route: POST /api/apps/:slug/publish/resubmit -- re-run audit on failed version after developer fixes in packages/gateway/src/server.ts
- [ ] T046 [US2] Add audit results endpoint: GET /api/store/apps/:id/audit -- return latest SecurityAudit for listing author in packages/platform/src/store-api.ts
- [ ] T047 [US2] Create PublishDialog component at shell/src/components/app-store/PublishDialog.tsx -- form for description, category, tags, screenshots, visibility, version, changelog. Submit calls POST /api/apps/:slug/publish.
- [ ] T048 [US2] Create SecurityBadge component at shell/src/components/app-store/SecurityBadge.tsx -- show audit status (passed/pending/failed) with icon
- [ ] T049 [US2] Add "Publish to Gallery" action to app context menu or app settings in shell (triggers PublishDialog for the selected app)

**Checkpoint**: Full publish -> audit -> gallery flow works. Combined with US1, the complete MVP (publish + browse + install) is functional.

---

## Phase 5: User Story 3 - Rate and Review Apps (Priority: P2)

**Goal**: Users who installed an app can leave ratings and text reviews. Aggregate ratings show on listing cards.

**Independent Test**: Install an app (via US1), leave a review, verify it appears on the listing detail page with updated average rating.

**Depends on**: US1 (installations) for the "must have installed" gate.

### Tests

- [ ] T050 [P] [US3] Write tests for review CRUD (submit, update, delete, listByListing, recalcAverage, flagReview, addAuthorResponse) in tests/platform/gallery/reviews.test.ts
- [ ] T051 [P] [US3] Write contract tests for review API endpoints (POST/PUT/DELETE reviews, respond, flag) in tests/platform/gallery/review-api.test.ts
- [ ] T052 [P] [US3] Write shell component tests for review section in tests/shell/gallery/review-section.test.tsx

### Implementation

- [ ] T053 [P] [US3] Implement review query functions (submitReview, updateReview, deleteReview, listByListing with pagination, recalculateAverage, flagReview, addAuthorResponse) in packages/platform/src/gallery/reviews.ts
- [ ] T054 [US3] Add review API endpoints to store-api: POST/PUT/DELETE /api/store/apps/:id/reviews, POST /:reviewId/respond, POST /:reviewId/flag, GET /api/store/apps/:id/reviews with rating distribution in packages/platform/src/store-api.ts
- [ ] T055 [US3] Add installation check middleware: verify reviewer has an active installation for the listing before allowing review submission in packages/platform/src/store-api.ts
- [ ] T056 [US3] Create ReviewSection component at shell/src/components/app-store/ReviewSection.tsx -- rating distribution chart, review list with pagination, submit form (1-5 stars + optional text), author response display, flag button
- [ ] T057 [US3] Integrate ReviewSection into store listing detail page at shell/src/app/store/[author]/[slug]/page.tsx
- [ ] T058 [US3] Update AppCard and AppDetail components to show aggregate rating (avg stars, count) fetched from listing data in shell/src/components/app-store/

**Checkpoint**: Reviews and ratings work end-to-end. Aggregate ratings visible on listing cards.

---

## Phase 6: User Story 4 - Share Apps with Organizations (Priority: P2)

**Goal**: Users create orgs, invite members, and publish/install apps scoped to their organization.

**Independent Test**: Create org, invite member, publish org-private app, verify member sees it and non-member doesn't.

**Depends on**: US1 (install flow) and US2 (publish flow) for org-scoped variants.

### Tests

- [ ] T059 [P] [US4] Write tests for org CRUD (create, get, update, delete, listForUser) in tests/platform/gallery/organizations.test.ts
- [ ] T060 [P] [US4] Write tests for membership management (invite, accept, decline, remove, updateRole, listMembers) in tests/platform/gallery/org-memberships.test.ts
- [ ] T061 [P] [US4] Write contract tests for org API endpoints per contracts/org-api.yaml in tests/platform/gallery/org-api.test.ts
- [ ] T062 [P] [US4] Write tests for org-scoped listing visibility (org-private apps invisible to non-members, visible to members) in tests/platform/gallery/org-visibility.test.ts
- [ ] T063 [P] [US4] Write shell component tests for org picker and org app page in tests/shell/gallery/org-features.test.tsx

### Implementation

- [ ] T064 [P] [US4] Implement org CRUD functions (createOrg, getBySlug, updateOrg, deleteOrg, listForUser) in packages/platform/src/gallery/organizations.ts
- [ ] T065 [P] [US4] Implement membership functions (invite, accept, decline, remove, updateRole, listMembers, getMembership, checkRole) in packages/platform/src/gallery/organizations.ts
- [ ] T066 [US4] Add org API endpoints per contracts/org-api.yaml: POST/GET/PUT/DELETE /api/store/orgs, membership CRUD, accept/decline invitations, GET /api/store/orgs/:orgSlug/apps in packages/platform/src/store-api.ts (or new org-api.ts route file)
- [ ] T067 [US4] Add org membership auth middleware: verify user role meets minimum required role for the endpoint in packages/platform/src/gallery/organizations.ts
- [ ] T068 [US4] Modify listing query functions to filter by visibility: public listings always visible, org-private only visible to org members, unlisted visible to anyone with direct link in packages/platform/src/gallery/listings.ts
- [ ] T069 [US4] Modify publish flow to accept visibility + orgId: when visibility = "organization", validate user has publisher+ role in that org in packages/gateway/src/server.ts (publish route)
- [ ] T070 [US4] Modify install flow to accept orgId as install target: validate user is member of org, set installation.org_id in packages/gateway/src/server.ts (install route)
- [ ] T071 [US4] Create OrgPicker component at shell/src/components/app-store/OrgPicker.tsx -- dropdown of user's orgs for install target and publish visibility selection
- [ ] T072 [US4] Create org app page at shell/src/app/o/[orgSlug]/a/[slug]/page.tsx -- authenticated, verify org membership, load org-scoped app
- [ ] T073 [US4] Add "My Orgs" section to gallery UI showing org-private apps per org in shell/src/components/app-store/AppStore.tsx

**Checkpoint**: Orgs, membership, org-private publishing, and org-scoped installs all work.

---

## Phase 7: User Story 5 - App Updates and Versioning (Priority: P2)

**Goal**: Developers publish updates with changelogs. Users see update badges, can update with data preservation, and roll back if needed.

**Independent Test**: Publish v1.0, install it, publish v1.1 with changelog, verify update badge, update preserving data, roll back to v1.0.

**Depends on**: US1 (install flow) and US2 (publish flow as update).

### Tests

- [ ] T074 [P] [US5] Write tests for version update detection (compare installed version to listing current version) in tests/platform/gallery/update-detection.test.ts
- [ ] T075 [P] [US5] Write contract tests for update/rollback endpoints (POST /api/apps/:slug/update, POST /api/apps/:slug/rollback) in tests/gateway/gallery/update-api.test.ts
- [ ] T076 [P] [US5] Write tests for data snapshot and restore during update/rollback in tests/gateway/gallery/data-preservation.test.ts
- [ ] T077 [P] [US5] Write shell component tests for update badge and changelog display in tests/shell/gallery/update-ui.test.tsx

### Implementation

- [ ] T078 [US5] Implement update detection: compare installation.version_id to listing.current_version_id, mark installations as "update-available" in packages/platform/src/gallery/installations.ts
- [ ] T079 [US5] Implement data snapshot before update: backup app data directory and/or export app DB schema to a snapshot location in packages/gateway/src/app-update.ts (new file)
- [ ] T080 [US5] Add update API route: POST /api/apps/:slug/update -- snapshot data, copy new version files, run DB migrations if schema changed, update installation record in packages/gateway/src/server.ts
- [ ] T081 [US5] Add rollback API route: POST /api/apps/:slug/rollback -- restore data snapshot, copy previous version files, update installation record in packages/gateway/src/server.ts
- [ ] T082 [US5] Modify publish flow to handle updates: when listing already exists and author matches, create new version (not new listing), re-run audit, only set as current if audit passes in packages/gateway/src/server.ts (publish route)
- [ ] T083 [US5] Add version history endpoint: GET /api/store/apps/:id/versions with changelogs in packages/platform/src/store-api.ts
- [ ] T084 [US5] Add update badge indicator to installed app cards and desktop app icons in shell/src/components/app-store/AppCard.tsx and shell/src/components/Desktop.tsx
- [ ] T085 [US5] Add version history and changelog display to store listing detail page in shell/src/app/store/[author]/[slug]/page.tsx
- [ ] T086 [US5] Add "Update" and "Roll Back" buttons to installed app detail view in shell/src/components/app-store/AppDetail.tsx

**Checkpoint**: Full update lifecycle works: publish update -> badge -> update with data preservation -> rollback.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T087 [P] Add auth middleware to all mutating store-api endpoints (Clerk session validation) in packages/platform/src/store-api.ts
- [ ] T088 [P] Add input validation (Zod schemas) for all API request bodies per contracts/ in packages/platform/src/store-api.ts and packages/gateway/src/server.ts
- [ ] T089 [P] Add rate limiting to store API endpoints (prevent abuse of search, review submission, publish) in packages/platform/src/main.ts
- [ ] T090 [P] Add app delisting support: PATCH /api/store/apps/:id/delist -- set status to "delisted", hide from gallery but preserve installations (FR-038) in packages/platform/src/store-api.ts
- [ ] T091 [P] Add app flagging/reporting endpoint: POST /api/store/apps/:id/flag (FR-035) in packages/platform/src/store-api.ts
- [ ] T092 [P] Add Open Graph meta tags to store listing pages for social sharing in shell/src/app/store/[author]/[slug]/page.tsx
- [ ] T093 Write E2E test: full gallery flow (publish -> browse -> install -> review -> update -> rollback) in tests/e2e/gallery-flow.e2e.test.ts
- [ ] T094 Run quickstart.md validation: execute smoke test steps and verify all pass
- [ ] T095 Update public docs at www/content/docs/ with gallery documentation (browsing, publishing, organizations, reviews)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies -- start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 + 049 Postgres being available
- **US1 Browse+Install (Phase 3)**: Depends on Phase 2. Uses seeded data for testing.
- **US2 Publish (Phase 4)**: Depends on Phase 2. Independent of US1 for testing.
- **US3 Reviews (Phase 5)**: Depends on US1 (installations gate)
- **US4 Organizations (Phase 6)**: Depends on US1 (install) + US2 (publish) for org-scoped variants
- **US5 Updates (Phase 7)**: Depends on US1 (install) + US2 (publish as update)
- **Polish (Phase 8)**: Depends on all user stories complete

### User Story Dependencies

```
Phase 2 (Foundation)
    ├── US1 (Browse + Install) ──┐
    └── US2 (Publish + Audit) ───┤
                                 ├── US3 (Reviews) -- needs US1 installations
                                 ├── US4 (Orgs) -- needs US1 install + US2 publish
                                 └── US5 (Updates) -- needs US1 install + US2 publish
```

- **US1 + US2 can run in parallel** after Phase 2 (they test independently with seeded data)
- **US3, US4, US5 can run in parallel** after US1 + US2 (they extend existing flows)

### Within Each User Story

1. Tests FIRST (TDD) -- verify they FAIL
2. Query/CRUD functions (data layer)
3. API endpoints (service layer)
4. Shell components (UI layer)
5. Integration points (cross-package wiring)

---

## Parallel Opportunities

### After Phase 2 completes (2 parallel streams):

```
Stream A: US1 (Browse + Install)
  T015-T019 tests in parallel
  T020-T021 data layer in parallel
  T022-T026 API layer
  T027-T032 shell components

Stream B: US2 (Publish + Audit)
  T033-T036 tests in parallel
  T037-T038 data layer in parallel
  T039-T042 audit engine (sequential layers)
  T043-T049 API + shell
```

### After US1+US2 complete (3 parallel streams):

```
Stream C: US3 (Reviews)     T050-T058
Stream D: US4 (Orgs)        T059-T073
Stream E: US5 (Updates)     T074-T086
```

---

## Implementation Strategy

### MVP First (US1 + US2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (tables, manifest, migrations)
3. Complete Phase 3: US1 Browse + Install
4. Complete Phase 4: US2 Publish + Audit
5. **STOP and VALIDATE**: Publish an app, find it in gallery, install it, verify it works
6. Deploy/demo the MVP

### Incremental Delivery

1. Setup + Foundation -> data layer ready
2. US1 + US2 -> **MVP: working app marketplace** (publish, browse, install)
3. US3 (Reviews) -> marketplace has trust signals
4. US4 (Orgs) -> enterprise/team distribution
5. US5 (Updates) -> app lifecycle management
6. Polish -> production-ready hardening

### Parallel Agent Strategy

With multiple agents on current branch (per CLAUDE.md rules):

1. All agents complete Setup + Foundation together
2. Agent A: US1 (Browse + Install) | Agent B: US2 (Publish + Audit)
3. After both commit: Agent C: US3 | Agent D: US4 | Agent E: US5
4. Each agent commits after completing their phase

---

## Notes

- All mutating endpoints need Clerk auth -- add in Phase 8 if not done per-story
- Store API reads are public (no auth) for discovery/SEO
- Gateway routes (port 4000) handle file operations; Platform routes (port 8080) handle metadata
- Publish endpoint lives on gateway (file access) but creates records on platform (Postgres)
- 049 Postgres is a hard prerequisite -- Phase 2 cannot start without it
- Existing SQLite store tables (`apps_registry`, `app_ratings`, `app_installs`) are deprecated but not deleted
- Commit after each task or logical group per CLAUDE.md agent rules
