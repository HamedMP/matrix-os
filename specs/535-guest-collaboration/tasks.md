---
description: "Tasks for spec 535 milestones M0 and M1"
---

# Tasks: Machine-Free Collaboration, M0 and M1

**Input**: [plan.md](plan.md), [spec.md](spec.md), [architecture.md](architecture.md), [delivery-plan.md](delivery-plan.md)
**Prerequisites**: plan.md (required), spec.md (required)
**Scope**: M0 and M1 only. M2-M5 tasks come with their own plans.

**Tests**: mandatory (constitution IX). Every implementation task is preceded by a test task in the same PR that fails first. "Real Postgres" means the suite runs with `MATRIX_TEST_POSTGRES_URL`; after A1 merges, CI runs it.

**Organization**: phases map to PR slices. Story labels: **US1** (join with only an account), **US6** (recover and retain control). M0 tasks carry **M0**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- Paths are repository-relative.

## External prerequisites (implemented elsewhere, not re-planned)

| Ref | Issue | Implementation | Needed by |
| --- | --- | --- | --- |
| X1 | #1829 terminal socket 404 on missing dependency | PR #1952 (`codex/fix-collab-terminal-unavailable`, base `main`) | A3, A4, B2 |
| X2 | #1881 Native Mobile direct collaboration transport | PR #1955 (`codex/fix-mobile-collab-direct-transport`, base `main`) | B10a, J13 |
| X3 | #1798 terminal Share on Web Desktop and Electron chrome, Electron `organizationId` for Share controls | PR #1957 (`codex/fix-share-controls-desktop-parity`) and PR #1971 (project Share parity), base `main` | B0 (shared rule), B8, B9, J8 |

Owners of X1-X3 keep their own plans. B0 and B8 reuse the single-membership rule #1957 introduces in `desktop/src/main/auth/active-organization.ts`; if that rule changes before it merges, B0 follows it.

---

## Phase 1: Setup and spikes

**Purpose**: prove undocumented behavior before depending on it.

- [ ] T001 M0 Spike (throwaway, not merged): with `m-e2e-member` (allowlisted, `matrixE2e` flag), confirm `@clerk/testing/playwright` `clerk.signIn({ page, emailAddress })` produces a session on `https://app.matrix-os.com` and `https://preview.matrix-os.com` from the platform auth page; if it fails, confirm the fallback (Backend API `POST /v1/sign_in_tokens`, then `window.Clerk.client.signIn.create({ strategy: "ticket" })` and `window.Clerk.setActive`). Record the working path in the A2 PR body.
- [ ] T002 [P] M0 Spike: run every suite listed by `grep -rl MATRIX_TEST_POSTGRES_URL tests packages` against a local `postgres:16` with a `*_test` database; record failures to scope A1.
- [ ] T003 [P] US1 Spike: confirm Clerk Backend API organization create (`created_by`), membership lookup for an actor (no `slug`: slugs are disabled on the instance), and invitation behavior (`inviter_user_id`, `redirect_url`, `__clerk_ticket` and `__clerk_status` on the redirect), and that Clerk `SignIn`/`SignUp` in the shell consume the ticket. Record in the B4 PR body.
- [ ] T004 [P] M0 Spike: on a disposable `pr-<N>` VPS, confirm which host variables bind a home to its collaboration platform (`packages/gateway/src/collaboration/config.ts:41-52,66-77`), that re-pointing them to the preview platform enrolls the runtime endpoint there, and that file owner, group and mode survive the change. Record in the A0b PR body.

---

## Phase 2: M0 foundation validation and preview gate infrastructure

**Goal**: existing organization collaboration proven live; preview platform able to act as the pre-merge gate; no new user capability.
**Independent test**: the foundation spec runs unattended with the allowlisted identities against a preview VPS connected to the preview platform.

### A0: preview collaboration keys and origins

- [ ] T005 M0 Extend the workflow contract tests (`tests/platform/ci-workflows.test.ts` or a new `tests/platform/preview-platform-workflow.test.ts`) to assert that `preview-platform.yml` binds `MATRIX_COLLABORATION_TICKET_KEYS` from `collaboration-ticket-keys-preview` (never the production secret), sets the active key ID from a preview variable, sets allowed and relay origins to `https://preview.matrix-os.com`, and runs a secret-and-keyring verification step before deploy (fails first).
- [ ] T006 M0 Implement the bindings and verification step in `.github/workflows/preview-platform.yml`; document the one-time secret creation and runner `secretAccessor` grant in `docs/dev/preview-environments.md`.

### A0b: collaboration preview owner and home connection

- [ ] T007 M0 Write workflow contract tests: with the `preview-collaboration` label (and `preview-vps`), `preview-vps.yml` provisions with `PREVIEW_COLLABORATION_OWNER_USER_ID` and an empty access list from the protected `collaboration-e2e` environment, only for same-repository PRs, asserts the override differs from `PREVIEW_CLERK_USER_ID`, refuses to reuse a `pr-<N>` owned by someone else, and is unchanged without the label; `connect_collaboration_preview` registers the collaboration owner in staging and runs only with `connect_share_preview` for the same PR number and exact head; it preserves owner, group and mode of the host environment file, keeps a bounded rollback copy, restores it on failed health, never prints the file, and never targets a non-preview machine.
- [ ] T008 M0 Implement the label handling in `.github/workflows/preview-vps.yml` and the opt-in input and steps in `.github/workflows/preview-platform.yml` (re-point the variables confirmed by T004, restart the gateway, verify health and runtime-endpoint enrollment on the preview platform); update `docs/dev/preview-environments.md`.

### A1: real-Postgres suites in CI

- [ ] T009 M0 Write `tests/repository/collaboration-postgres-ci.test.ts` asserting that every test file referencing `MATRIX_TEST_POSTGRES_URL` is selected by `scripts/test-collaboration-postgres.sh` and that the CI job is registered in `CI Results` (fails first).
- [ ] T010 M0 Add `scripts/test-collaboration-postgres.sh`: enumerate the files, refuse an empty list, run `pnpm exec vitest run` on them, and fail if any selected test is skipped.
- [ ] T011 M0 Add the `collaboration-postgres` job to `.github/workflows/ci.yml` (`postgres:16` service, `MATRIX_TEST_POSTGRES_URL` naming a `*_test` database, 20 min timeout) and register it in `ci-results` in all four places: `needs`, a `*_RESULT` variable, the summary row and the result loop (`.github/workflows/ci.yml:707-769`); update the exact `needs` assertion in `tests/platform/ci-workflows.test.ts:276`.
- [ ] T012 M0 Fix suites that fail on first real run when the fix is small; otherwise list each in the script's quarantine block with a linked issue, counted in the job summary.

### A2: identity fixture (FR-029)

- [ ] T013 [P] M0 Write `tests/e2e/fixtures/collaboration-identities.e2e.test.ts` (Vitest, picked up by `vitest.e2e.config.ts` like the existing `tests/e2e/fixtures/collaboration-fixture.e2e.test.ts`, which is updated for the new environment): refuses any user ID outside `COLLABORATION_E2E_ALLOWED_USER_IDS` (comma-separated) and any role variable (`COLLABORATION_E2E_{OWNER,MEMBER,OUTSIDER,GUEST}_USER_ID`) not in it; refuses a user whose `public_metadata.matrixE2e` is not `true` or whose primary address is unverified; refuses when `PREVIEW_COLLABORATION_OWNER_USER_ID` differs from `COLLABORATION_E2E_OWNER_USER_ID`; refuses when any allowlisted ID equals `PREVIEW_CLERK_USER_ID` (when provided) and when the collaboration owner does not own `pr-<N>`; never logs tokens; refuses to start if member, guest or outsider has preview access to `pr-<N>`; accepts `preview.matrix-os.com` and `app.matrix-os.com` base URLs only.
- [ ] T014 M0 Implement `tests/e2e/fixtures/collaboration-identities.ts` (Backend API with 10 s timeouts and bounded responses, allowlist and `matrixE2e` guards, environment names from plan D12) and `tests/e2e/fixtures/clerk-sign-in.ts` (path from T001).
- [ ] T015 M0 Rewrite `tests/e2e/fixtures/collaboration.ts` for owner, member, guest and outsider contexts (plus the optional multi-computer member when `COLLABORATION_E2E_MULTI_COMPUTER_MEMBER_USER_ID` is set), with precondition checks through `/api/auth/computers`, `/api/journey` and membership of `COLLABORATION_E2E_ORGANIZATION_ID` (owner `org:admin`, member `org:member`, outsider and guest absent).
- [ ] T016 [P] M0 Implement `tests/e2e/helpers/collaboration-direct-harness.ts` using `createCollaborationDirectApi` with `getHeaders` returning the page's Clerk session token.
- [ ] T017 M0 Update `tests/e2e/collaboration.playwright.config.ts` (global setup, phone project 390x844, desktop project 1440x900, traces without storage state) and add root script `test:e2e:collaboration` running `pnpm --dir shell exec playwright test --config ../tests/e2e/collaboration.playwright.config.ts`, so `@playwright/test` and `@clerk/testing` resolve from `shell/`; add root devDependencies only if resolution fails, then run root `pnpm install`.

### A3: foundation journeys on the direct transport

- [ ] T018 M0 Write `tests/e2e/collaboration/foundation.spec.ts` on the grants model: organization gate (outsider and guest denied for ticket, session, socket and every scope route), project share, downgrade and revoke, relay transparency, membership freshness (denial within 25 s), share inventory, host restart recovery; record machine and subscription counts before and after.
- [ ] T019 M0 Add `tests/e2e/collaboration/journey-assertions.ts` (request recorder for billing, checkout, provisioning and personal-runtime paths; zero-machine and `plan_required` assertions; non-disclosing denial probes).
- [ ] T020 M0 Delete `tests/e2e/collaboration-project.spec.ts` and update the config `testMatch`.

### A4: foundation evidence

- [ ] T021 M0 Run A3 plus handoff journeys 2, 4, 7, 13, 14, 15, 16, 17 on a `preview-collaboration` preview VPS connected to the preview platform (A0, A0b) with X1 deployed. For journeys 13 and 16 only, set the test organization's `public_metadata.collaboration.aiSubmission` to `"members"` through the Backend API and restore owner-only afterwards. Write `specs/535-guest-collaboration/evidence/m0-foundation.md` (commit, bundle version, roles, sanitized outcomes, blocked items with reasons). Release preview traffic and ask whether to delete the preview VPS.

**Checkpoint**: M0 complete when A0-A4 merge and the evidence shows no unexplained failure.

---

## Phase 3: M1 account-only entry (Graphite stack)

**Goal**: Story 1 entry for organization members without billing, provisioning or personal-runtime boot.
**Independent test**: a machine-free member opens `/shared/chat/<id>` on a phone viewport and contributes; the request log shows no billing, checkout, provisioning or personal-runtime call.

### S1: platform routing

- [ ] T022 US1 Write `tests/platform/shared-entry-routing.test.ts`: path-family matcher (valid and adversarial paths); machine-free, provisioning, stopped, entitlement-blocked and preview-host cases reach the auth shell; running entitled computer reaches the VPS; auth-shell failure returns the `503` retry page, never `/?billing=setup`; signup billing handoff unchanged; `/vm/<handle>/shared` unchanged.
- [ ] T023 US1 Implement `packages/platform/src/shared-entry-routing.ts` and the unavailable page; add call sites in `packages/platform/src/session-routing-middleware.ts` only.
- [ ] T024 US1 Set `MATRIX_SHELL_SURFACE=platform` for the auth shell in `scripts/start-platform-cloud-run.sh` and `distro/docker-compose.platform.yml`; extend the nearest existing script test to assert it.

### S2: collaboration frame

- [ ] T025 US1 Write `tests/shell/collaboration-frame.test.tsx`: platform surface renders the frame for every shared page; VPS surface renders `OnboardingGate` + `ShellHome`; the frame issues none of the forbidden requests (plan D2); sign-out closes collaboration sessions; empty, unavailable, host-unavailable and access-removed states render.
- [ ] T026 [P] US1 Write `tests/shell/shared-return-path.test.ts` for `normalizeSharedReturnPath` (open redirects, encoded slashes, `//`, backslashes, over-length, non-shared paths).
- [ ] T027 US1 Implement `shell/src/lib/shell-surface.ts`, `shell/src/lib/shared-return-path.ts`, `shell/src/components/collaboration/CollaborationFrame.tsx` (and header component), and switch `shell/src/app/shared/**/page.tsx` on the surface.
- [ ] T028 US1 Accept validated `redirect_url` in `shell/src/app/sign-in/[[...sign-in]]/page.tsx` and `shell/src/app/sign-up/[[...sign-up]]/page.tsx`.
- [ ] T029 [P] US1 Add `shell/e2e/collaboration-frame.spec.ts` (mocked routes, 390x844 and 1440x900 screenshots) and include it in `shell/playwright.config.ts` `testMatch`.

### S3: app-root landing

- [ ] T030 US1 Write `tests/shell/account-only-landing.test.ts`: redirects to `/shared` only on the platform surface, only in `plan_required`, only when discovery or organizations are non-empty, never on billing entry points or signup handoff; 3 s timeouts fall back to the plan screen.
- [ ] T031 US1 Implement `shell/src/lib/account-only-landing.ts` and the `BootSequence` call site plus the **Open Shared with me** action.

**Checkpoint**: S1 passes the routing-only preview check and S3 (stack head for S1-S3) passes the frame and landing preview check in plan "Preview test plan (pre-merge gate)" step 2. The stack still merges only after the full gate in step 3.

---

## Phase 4: M1 recipient views (FR-025)

**Goal**: every shareable type opens in its own view in the frame and the full OS view.
**Independent test**: J2.

### B6a: files and kind-aware opening

- [ ] T032 [P] US1 Write `tests/ui/collaboration-open-resource.test.tsx`: accepting or opening file, folder, app, project, terminal and Chat items calls the matching opener; no kind falls back to Chat.
- [ ] T033 [P] US1 Write `tests/ui/shared-file-view.test.tsx`: preview limit, download, Contributor edit with `expectedRevision`, conflict keeps local text, shows the server version and offers the conflict copy, Viewer read-only, `resource_missing` state.
- [ ] T034 US1 Implement `openSharedResource` and the new view kinds in `packages/ui/src/collaboration/ChatCollaboration.tsx` (call sites only) and `packages/ui/src/collaboration/recipient-views.ts`; implement `SharedFileView.tsx`.
- [ ] T035 US1 Add `shell/src/app/shared/file/[scopeId]/page.tsx` following the surface split and wire the full OS Chat panel.

### B6b: folders

- [ ] T036 [P] US1 Write `tests/ui/shared-folder-view.test.tsx` (paging, navigation, Contributor create/rename/delete with revisions, download).
- [ ] T037 US1 Move drive paging from `shell/src/components/file-browser/organization-drive-paging.ts` to `packages/ui/src/collaboration/shared-folder-paging.ts`, update `OrganizationDrivesView.tsx`, implement `SharedFolderView.tsx`, add `shell/src/app/shared/folder/[scopeId]/page.tsx`.

### B6c: app instances

- [ ] T038 [P] US1 Write `tests/ui/shared-app-view.test.tsx`: only `ready` and `scoped` instances render; iframe sandbox has no `allow-same-origin`; bridge rejects messages for other instances and unknown actions; Viewer cannot mutate.
- [ ] T039 US1 Implement `packages/ui/src/collaboration/SharedAppView.tsx` and its bridge; add `shell/src/app/shared/app/[scopeId]/page.tsx`; run react-doctor on `shell` and `packages/ui`.

### B6d: navigable projects

- [ ] T040 [P] US1 Write `tests/gateway/collaboration-project-read-children.test.ts` (project read returns child scope IDs and bounded titles only for resources the reader may open) and `tests/ui/shared-project-view.test.tsx` (navigates to Chat, terminal, file and app).
- [ ] T041 US1 Extend `CollaborationProjectSchema` resources in `packages/contracts/src/collaboration.ts`, `project-sharing.ts` `read()` in `packages/gateway/src/collaboration/`, and rewrite `SharedProjectView` in a new `packages/ui/src/collaboration/SharedProjectView.tsx`.

### S4: frame routing for new views

- [ ] T042 US1 Extend `tests/shell/collaboration-frame.test.tsx` for file, folder, app, project and organization pages; implement the frame navigation and `/shared/organization` page.

---

## Phase 5: M1 organizations (FR-024)

**Goal**: create, switch and invite from Matrix on every surface.
**Independent test**: J7, J8.

### B0: web active organization before B7

- [ ] T043 US1 Write `tests/ui/active-organization.test.ts` for `resolveActiveOrganizationId` (Clerk active organization wins; otherwise exactly one verified membership; otherwise none; loading and failure yield none) and `tests/shell/collaboration-organization.test.tsx` (fetches `/api/organizations` only when Clerk has no active organization, 10 s timeout, E2E bypass unchanged, subtree remounts on change).
- [ ] T044 US1 Implement `packages/ui/src/organizations/active-organization.ts` and use it in `shell/src/lib/collaboration-organization.tsx`.

### B4a: organization create

- [ ] T045 US1 Write `tests/platform/organization-create-routes.test.ts`: auth, `bodyLimit`, strict schema, idempotent create by `clientRequestId`, `setting_up` state when the first reconciliation fails, `GET /api/organizations` includes the caller's `setting_up` rows, `429` with `Retry-After`, Clerk failures mapped to generic `503`, no Clerk text in responses.
- [ ] T046 US1 Write `tests/platform/organization-create-postgres.test.ts` (real Postgres): concurrent creates with one `clientRequestId` create one organization; the creation finisher lists a `created` organization after a failed first reconciliation, adopts a `pending` one found in Clerk, and marks stale rows `failed`; counters never exceed limits under concurrency.
- [ ] T047 US1 Implement `packages/platform/src/organizations/clerk-admin-client.ts` (create and membership lookup), `admin-repository.ts` (request rows and counters), `creation-finisher.ts`, the create route in `admin-routes.ts`, schemas in `packages/contracts/src/organizations.ts`, and registration and timers in `wiring.ts`.

### B4b: member invitations

- [ ] T048 US1 Write `tests/platform/organization-invitation-routes.test.ts`: fresh-admin requirement after reconciliation, `bodyLimit` on POST and DELETE, uniform invite response whether or not the address has an account, idempotent invite per organization and address digest, list visible to admins only, revoke, `429`, generic `503` for Clerk failures.
- [ ] T049 US1 Write `tests/platform/organization-invitation-postgres.test.ts` (real Postgres): concurrent duplicate invites converge on one Clerk invitation; webhook and TTL cleanup remove rows; prune removes expired counters.
- [ ] T050 US1 Implement invitation create, list and revoke in `clerk-admin-client.ts` and `admin-routes.ts`, the HKDF digest and invitation records in `admin-repository.ts`, and invitation webhook cleanup in `routes.ts` and `roles.ts`.

### B7: web Settings, Organization

- [ ] T051 [P] US1 Write `tests/ui/organization-settings-panel.test.tsx` and `tests/ui/organization-state.test.ts`: member and admin states, create (including `setting_up`), invite, revoke, switch, loading, empty, error states with allowlisted messages.
- [ ] T052 US1 Implement `packages/ui/src/organizations/{OrganizationSettingsPanel.tsx,organization-client.ts,organization-state.ts}`; register the `organization` section in `shell/src/components/Settings.tsx` with `shell/src/components/settings/OrganizationSection.tsx` using Clerk `setActive`.
- [ ] T053 US1 Add `shell/src/app/shared/organization-invitation/page.tsx` handling `__clerk_status` with Clerk `SignIn`/`SignUp` and a validated redirect to `/shared`.

### B8: Electron organization settings

- [ ] T054 US1 Write desktop tests extending #1957's `tests/desktop/active-organization.test.ts`: persisted selection per credential user among several memberships, re-validated on each refresh, cleared on sign-out and credential swap; renderer section states.
- [ ] T055 US1 Extend `desktop/src/main/auth/active-organization.ts`, add IPC handlers in `desktop/src/main/ipc/handlers.ts` and preload bindings, and add `OrganizationSection.tsx` in `desktop/src/renderer/src/features/settings/sections/` reusing the `packages/ui` panel.

### B10b: Native Mobile organization settings

- [ ] T056 [P] US1 Write Jest tests in `apps/mobile/__tests__/` for the organization request module, `resolveActiveOrganizationId` use, and screen states.
- [ ] T057 US1 Implement `apps/mobile/lib/requests/organizations.ts` and `apps/mobile/app/settings-detail/organization.tsx` with Clerk Expo `setActive`.

---

## Phase 6: M1 correctness and limits (FR-026, FR-027, FR-028)

### B1: file-share conflict detection

- [ ] T058 US6 Write `tests/gateway/collaboration-resource-conflicts.test.ts`: owner in-place edit then stale Contributor write returns `409` with the reconciliation committed (the next read shows the new revision); owner replace-and-rename keeps the share readable and bumps the revision; folder replacement still denies; symlink swap denied; missing path returns `resource_missing`; `EXDEV` refuses with `503`.
- [ ] T059 US6 Write `tests/gateway/collaboration-no-clobber-commit.test.ts` with an injectable filesystem that interleaves owner actions between every commit step: owner rename before the move-aside, between the move-aside and the check, and between the check and the link-in; owner in-place write through an open descriptor. Each case ends with the owner's bytes at the path or in the retained version, the collaborator's bytes at the path or in a conflict copy, and a committed conflict event whenever the collaborator did not win.
- [ ] T060 US6 Write `tests/gateway/collaboration-resource-conflicts-postgres.test.ts` (real Postgres): concurrent Contributor writes and an external change produce exactly one successful write and one committed external-change revision; retained versions respect the per-entry and per-home caps.
- [ ] T061 US6 Implement migration 16 (`content_token`), `reconcileExternalChange`, the no-clobber commit in `owner-resource-driver.ts`, executor changes in `resource-actions.ts` and `resource-catalog.ts`, the in-flight commit registry, and the `DisplacedVersionSweeper` wired in `resource-wiring.ts`.

### B2: unavailable, host offline and access removed

- [ ] T062 US6 Write `tests/gateway/collaboration-missing-dependencies.test.ts` and `tests/platform/collaboration-failure-codes.test.ts` (each optional dependency absent yields `503 unavailable`, never `404`; every error body carries `code`).
- [ ] T063 [P] US6 Write `tests/ui/collaboration-failure-classification.test.ts` (wire to state mapping in plan D8; no reconnect on terminal states).
- [ ] T064 US6 Write lease tests for a machine-free member in `tests/gateway/collaboration-direct-sessions.test.ts` (plan D10: denial after evidence expiry, streams closed within 25 s, renewal after removal fails).
- [ ] T065 US6 Implement `CollaborationFailureCode` in `packages/contracts`, the mapper changes in `packages/gateway/src/collaboration/route-support.ts` and `packages/platform/src/collaboration/{routes,direct-routes}.ts`, and `classifyCollaborationFailure` plus direct-client handling in `packages/ui/src/collaboration/`.

### B3: relay limits for machine-free accounts

- [ ] T066 US6 Write `tests/platform/collaboration-relay-account-limits.test.ts`: classification (owned machines only, cache TTL and cap, failure is stricter); socket cap; `429 relay_limit` at ticket, HTTP relay and upgrade; 110% hard stop; accounts with computers unaffected; environment overrides accepted within bounds and rejected outside them; metadata contains no path beyond route class.
- [ ] T067 US6 Write `tests/platform/collaboration-relay-usage-postgres.test.ts` (real Postgres): additive flush from two meters, bounded overshoot, prune after 35 days, final flush on shutdown.
- [ ] T068 US6 Implement `packages/platform/src/collaboration/relay-usage.ts`, relay admission and byte recording in `relay.ts` and `platform-websocket-upgrade.ts`, wiring in `direct-wiring.ts`, the table in `packages/platform/src/collaboration/database.ts`, and limits plus environment overrides in `packages/contracts` and platform config validation.

---

## Phase 7: M1 Electron and Native Mobile entry

### B5: account credential

- [ ] T069 US1 Write `tests/platform/account-credential.test.ts`: device flow issues an account credential only when the account owns no machine; `verifySyncJwt` rejects it; session routing, runtime proxy and `/api/auth/ws-token` reject it; collaboration and organization resolvers accept it; `resolveAppDomainIdentity` accepts it only with `clerkPrincipalOnly` and a relayed direct events or terminal socket opens with it; every other upgrade path refuses it; expiry 1 h.
- [ ] T070 US1 Write desktop tests: an account credential is stored with `handle: null`, header injection targets the platform origin for that credential kind (HTTP and upgrade requests), and sign-out clears it.
- [ ] T071 US1 Implement `packages/platform/src/account-jwt.ts`, the `issueToken` branch in `auth-routes.ts`/`device-flow.ts`, resolver changes in `journey-routes.ts` and `session-routing-identity.ts`, and `desktop/src/main/auth/{auth-service,device-auth,credential-store,header-injection}.ts` support.

### B9: Electron Shared with me without a computer

- [ ] T072 US1 Write renderer tests: a signed-in account credential shows Shared with me and Settings, Organization; no runtime, terminal or file surface is requested; live events connect through the relayed direct socket.
- [ ] T073 US1 Implement the account-only renderer mode using `DesktopChatCollaboration` and the B6 views.

### B10a: Native Mobile account-only entry

- [ ] T074 US1 Write Jest tests: `plan_required` shows **Open Shared with me**; the account-only drawer exposes only Shared and Settings; file and folder screens; app instances open on the web (decision 6).
- [ ] T075 US1 Implement changes in `apps/mobile/app/index.tsx`, `apps/mobile/app/(drawer)/_layout.tsx`, `apps/mobile/components/collaboration/`, and project navigation with child scope IDs.

---

## Phase 8: M1 journeys, evidence and documentation

### S5: M1 journeys

- [ ] T076 US1 Write `tests/e2e/collaboration/account-only.spec.ts` covering J1-J6, J9, J10 at 390x844 and 1440x900 with SC-002 timing.
- [ ] T077 US1 Write `tests/e2e/collaboration/organization.spec.ts` covering J7 (email acceptance as a measured manual step) and J8, plus J12 Electron device approval driven from the signed-in browser context.

### S6: evidence

- [ ] T078 US1 Run S5 as the full pre-merge gate in plan "Preview test plan (pre-merge gate)" step 3; capture J11 and J13 manually; write `specs/535-guest-collaboration/evidence/m1-account-only.md` with the surface matrix and screenshots under `docs/pr-evidence/`. Release preview traffic and ask whether to delete the preview VPS.

### Site docs (separate repository)

- [ ] T079 [P] US1 Open a PR in `FinnaAI/matrix-os-site` under `content/docs/`: joining shared work without a computer, organization create/switch/invite, recipient views, host availability, relay limits, file conflicts and retained versions, and the Native Mobile app-instance limitation. Publish only what S6 verified; public-safe content only.

---

## Dependencies and execution order

- Phase 1 spikes precede the PRs they inform (T001 before A2, T002 before A1, T003 before B4, T004 before A0b).
- A0 and A0b gate every live preview run; A2 and A3 gate the M1 journeys.
- S1 then S2 then S3 merge in order and back to back, because the platform deploys on `main` and serves the auth shell from the same image; they merge only after the S5 full gate passes.
- B-series dependencies: B2 after X1; B6a before B6b-d (shared opener); B0 after X3's rule is settled; B7 after B4 and B0; B8 after B4, B7 and X3; B9 after B5, B6a and X3; B10a after X2 and B6d; B10b after B4 and B0.
- S4 restacks onto `main` after B6a-d and B7 merge; S5 after S4, A0, A0b, A2 and A3; S6 after everything.

## PR slicing map

Sizes are estimates including tests; every PR must stay under 1000 additions and 20 files, and split further if it grows.

| ID | Branch slug | Base | Conventional title | Packages / key files | Est. additions / files | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| A0 | `codex/535-m0-preview-collaboration-keys` | `main` | `ci(preview): give preview platforms collaboration ticket keys and origins` | `.github/workflows/preview-platform.yml`, workflow contract test, `docs/dev/preview-environments.md` | 250 / 3 | owner creates the preview secret; token with `workflow` scope |
| A0b | `codex/535-m0-preview-collaboration-home` | `main` | `ci(preview): connect a preview VPS home to the preview collaboration authority` | `.github/workflows/{preview-vps,preview-platform}.yml`, workflow contract tests, `docs/dev/preview-environments.md` | 700 / 5 | A0, T004; owner creates `PREVIEW_COLLABORATION_OWNER_USER_ID` and the `preview-collaboration` label |
| A1 | `codex/535-m0-postgres-ci` | `main` | `ci(collaboration): run real-Postgres collaboration suites` | `.github/workflows/ci.yml`, `scripts/test-collaboration-postgres.sh`, `tests/repository/`, `tests/platform/ci-workflows.test.ts` | 270 / 5 (plus small suite fixes) | T002; token with `workflow` scope |
| A2 | `codex/535-m0-identity-fixture` | `main` | `test(collaboration): add unattended identity sign-in fixture` | `tests/e2e/fixtures/`, `tests/e2e/helpers/`, `tests/e2e/collaboration.playwright.config.ts`, root `package.json` | 700 / 8 | T001 |
| A3 | `codex/535-m0-foundation-journeys` | A2 (stack parent) | `test(collaboration): rewrite foundation journeys on the direct transport` | `tests/e2e/collaboration/`, delete `tests/e2e/collaboration-project.spec.ts` | 850 / 4 | A2 |
| A4 | `codex/535-m0-evidence` | `main` | `docs(collaboration): record M0 foundation evidence` | `specs/535-guest-collaboration/evidence/` | 200 / 2 | A0, A0b, A1, A3, X1 merged and run |
| S1 | `codex/535-m1-shared-entry-routing` | `main` (stack bottom) | `feat(platform): serve shared destinations without a routed computer` | `packages/platform/src/shared-entry-routing.ts`, `session-routing-middleware.ts` (call sites), `request-routing.ts`, `scripts/start-platform-cloud-run.sh`, `distro/docker-compose.platform.yml`, `tests/platform/` | 550 / 7 | none |
| S2 | `codex/535-m1-collaboration-frame` | S1 | `feat(shell): add the account-only collaboration frame` | `shell/src/app/shared/**`, `shell/src/app/sign-{in,up}`, `shell/src/components/collaboration/`, `shell/src/lib/`, `tests/shell/`, `shell/e2e/` | 850 / 14 | S1 |
| S3 | `codex/535-m1-account-landing` | S2 | `feat(shell): land accounts without a computer on Shared with me` | `shell/src/lib/account-only-landing.ts`, `shell/src/components/BootSequence.tsx` (call site), `tests/shell/` | 300 / 4 | S2 |
| S4 | `codex/535-m1-frame-views` | S3 (restacked on `main` after B6a-d, B7) | `feat(shell): route recipient views and organization settings through the frame` | `shell/src/app/shared/{organization,...}`, `CollaborationFrame.tsx`, `tests/shell/` | 350 / 6 | S3, B6a-d, B7 |
| S5 | `codex/535-m1-account-journeys` | S4 | `test(collaboration): add M1 account-only journeys` | `tests/e2e/collaboration/account-only.spec.ts`, `organization.spec.ts` | 800 / 4 | S4, A0, A0b, A2, A3, B1-B5, B8, B9 |
| S6 | `codex/535-m1-evidence` | S5 | `docs(collaboration): record M1 account-only evidence` | `specs/535-guest-collaboration/evidence/`, `docs/pr-evidence/` | 250 / 10 (mostly images) | S5 gate run, X2 |
| B0 | `codex/535-m1-web-active-organization` | `main` | `fix(shell): use the only organization when none is active` | `packages/ui/src/organizations/active-organization.ts`, `shell/src/lib/collaboration-organization.tsx`, tests | 250 / 4 | X3 rule settled |
| B1 | `codex/535-m1-file-conflicts` | `main` | `feat(collaboration): detect external changes to shared files` | `packages/gateway/src/collaboration/{owner-resource-driver,resource-actions,resource-catalog,resource-wiring,database-migrations}.ts`, `tests/gateway/` | 950 / 9 | none |
| B2 | `codex/535-m1-unavailable-states` | `main` | `fix(collaboration): distinguish unavailable, host offline and removed access` | `packages/contracts`, `packages/gateway/src/collaboration/route-support.ts`, `packages/platform/src/collaboration/{routes,direct-routes}.ts`, `packages/ui/src/collaboration/`, tests | 600 / 11 | X1 |
| B3 | `codex/535-m1-relay-account-limits` | `main` | `feat(platform): bound relay use by accounts without a computer` | `packages/platform/src/collaboration/{relay,relay-usage,direct-wiring,direct-routes,database}.ts`, `platform-websocket-upgrade.ts`, `packages/contracts`, tests | 900 / 10 | none |
| B4a | `codex/535-m1-organization-create` | `main` | `feat(platform): create organizations from Matrix` | `packages/platform/src/organizations/{admin-routes,clerk-admin-client,admin-repository,creation-finisher,wiring}.ts`, `packages/contracts/src/organizations.ts`, tests | 600 / 8 | T003 |
| B4b | `codex/535-m1-organization-invitations` | B4a (stack parent) | `feat(platform): invite organization members from Matrix` | `packages/platform/src/organizations/{admin-routes,clerk-admin-client,admin-repository,routes,roles}.ts`, tests | 650 / 7 | B4a |
| B5 | `codex/535-m1-account-credentials` | `main` | `feat(auth): issue account-only device credentials without a computer` | `packages/platform/src/{account-jwt,auth-routes,device-flow,journey-routes,session-routing-identity}.ts`, `desktop/src/main/auth/`, tests | 850 / 12 | none |
| B6a | `codex/535-m1-file-views` | `main` | `feat(ui): open shared files and route every kind to its own view` | `packages/ui/src/collaboration/{recipient-views,SharedFileView}.ts(x)`, `ChatCollaboration.tsx` (call sites), `shell/src/app/shared/file/`, tests | 700 / 8 | none (B1 for conflict copy, soft) |
| B6b | `codex/535-m1-folder-views` | `main` | `feat(ui): open shared folders in a folder view` | `packages/ui/src/collaboration/{SharedFolderView,shared-folder-paging}.ts(x)`, `shell/src/components/file-browser/OrganizationDrivesView.tsx`, `shell/src/app/shared/folder/`, tests | 700 / 8 | B6a |
| B6c | `codex/535-m1-app-views` | `main` | `feat(ui): open shared app instances in a sandboxed view` | `packages/ui/src/collaboration/SharedAppView.tsx` and bridge, `shell/src/app/shared/app/`, tests | 650 / 6 | B6a |
| B6d | `codex/535-m1-project-navigation` | `main` | `feat(collaboration): make shared projects navigable` | `packages/contracts/src/collaboration.ts`, `packages/gateway/src/collaboration/project-sharing.ts`, `packages/ui/src/collaboration/SharedProjectView.tsx`, tests | 750 / 7 | B6a |
| B7 | `codex/535-m1-organization-settings` | B4b (stack parent) | `feat(shell): add Settings, Organization` | `packages/ui/src/organizations/`, `shell/src/components/Settings.tsx`, `shell/src/components/settings/OrganizationSection.tsx`, `shell/src/app/shared/organization-invitation/`, tests | 850 / 9 | B4, B0 |
| B8 | `codex/535-m1-electron-organizations` | `main` | `feat(desktop): switch organizations and invite members in Electron` | `desktop/src/main/auth/active-organization.ts`, `desktop/src/main/ipc/handlers.ts`, preload, renderer settings section, tests | 700 / 9 | B4, B7, X3 |
| B9 | `codex/535-m1-electron-account-mode` | `main` | `feat(desktop): open Shared with me without a computer` | `desktop/src/renderer/src/features/{collaboration,chat,desktop-shell}/`, tests | 500 / 6 | B5, B6a, X3 |
| B10a | `codex/535-m1-mobile-account-entry` | `main` | `feat(mobile): join shared work without a computer` | `apps/mobile/app/index.tsx`, `app/(drawer)/`, `components/collaboration/`, `__tests__/` | 800 / 10 | X2, B6d |
| B10b | `codex/535-m1-mobile-organizations` | `main` | `feat(mobile): manage organizations on Native Mobile` | `apps/mobile/lib/requests/organizations.ts`, `app/settings-detail/organization.tsx`, `__tests__/` | 500 / 5 | B4, B0 |
| Site | (in `FinnaAI/matrix-os-site`) | site `main` | `docs(collaboration): join shared work without a computer` | `content/docs/` | 300 / 3 | S6 |

**Graphite stacks**:

- Account-only entry stack (the only stack that is truly entry-dependent): `main` -> S1 -> S2 -> S3 -> S4 -> S5 -> S6. S4 is restacked with `gt restack` after B6a-d and B7 merge to `main`.
- Two short dependency stacks for convenience: A2 -> A3, and B4a -> B4b -> B7. "B4" elsewhere means both B4a and B4b. They may instead be opened off `main` after their parent merges.
- All other rows are standalone PRs off `main`. Do not flatten the stack; land it with Graphite one layer at a time.

## Implementation strategy

1. M0 first in parallel: A0 (after the owner creates the preview secret), A1, A2 (after T001), then A0b (after T004) and A3, then A4 once X1 is deployed.
2. Start M1 standalone PRs immediately (B0 once X3's rule is settled, B1, B2 after X1, B3, B4, B5, B6a), then B6b-d, B7.
3. Build S1-S3; run their platform-only preview checks.
4. After the B-series and X-series merge, restack S4-S6, run the full pre-merge gate on S5, record evidence, merge the stack layer by layer, and open the site docs PR.
5. M1 is released only when S6 evidence passes on every surface in the plan's surface table, not when individual PRs merge.

## Notes

- Keep `/home/deploy/matrix-os` on `main`; every PR comes from its own manual worktree.
- Each PR body includes the Invariants section, the surface matrix for user-visible changes, and `Stack: n/m` for stacked layers.
- Wait for current-head Greptile 5/5 before `ready-for-ci`; never loop `gh pr merge` over a stack.
